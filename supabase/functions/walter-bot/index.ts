// Edge Function del bot de Walter: webhook de WhatsApp Cloud API y de Messenger,
// tarea de avisos (?tarea=avisos) que llama pg_cron y lo que Walter hace desde
// el panel de Bruwal Chat (?tarea=panel): contestar (texto o foto), ver las fotos y audios
// de los clientes (los audios se pasan a texto con Whisper si está TRANSCRIPCION_KEY), mandar audios, borrar charlas, cargar contactos y cambiar la foto y los datos del perfil
// de WhatsApp del bot. Las fotos y audios quedan en el bucket privado walter-media (schema/68)
// y se borran solos a los 30 días (limpiarMedios, con los avisos).
//
// Tablas, claves y cron en schema/62-bot-walter.sql. Desplegar sin verificar JWT
// (Meta no manda uno; la función valida la firma X-Hub-Signature-256):
//   supabase functions deploy walter-bot --no-verify-jwt --project-ref qduguqazpxjjpxjfnkif
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { conPerfil, type Config, cuandoDe, esCoordinar, horarioDe, esPing, esSaludo, type Estado, hechos, juntar, nombreDePerfil, norm, pareceCortado, procesar, procesarConLectura, type Respuesta, tipoSuelto } from "./bot.ts";
import { contarUso, contestar, leer, redactar } from "./ia.ts";
import * as webpush from "jsr:@negrel/webpush@0.5.0";

const env = (k: string, def = "") => Deno.env.get(k) ?? def;
const GRAPH = `https://graph.facebook.com/${env("GRAPH_VERSION", "v21.0")}`;
// Recién arrancada, la función a veces recibe "JWT issued at future" de la base (desfase de reloj): reintentamos.
async function fetchConReintento(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  for (let intento = 1; ; intento++) {
    const res = await fetch(input, init);
    if (res.ok || intento === 3) return res;
    const txt = await res.clone().text();
    if (!/issued at future/i.test(txt)) return res;
    await new Promise((r) => setTimeout(r, 800 * intento));
  }
}
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { global: { fetch: fetchConReintento } });
type Canal = "whatsapp" | "messenger";

// Lo que usa la IA, por día (pestaña Uso del panel). Si falla, no frena al bot.
const sumarUso = (servicio: string, entrada: number, salida = 0) =>
  db.rpc("walter_sumar_uso", { p_servicio: servicio, p_entrada: Math.round(entrada), p_salida: Math.round(salida) })
    .then(({ error }) => { if (error) console.error("uso", error.message); });
// Lo que corre aparte (uso de la IA, avisos al celular): el webhook lo espera antes de terminar
const aparte: PromiseLike<unknown>[] = [];
contarUso((e, s) => { aparte.push(sumarUso("ia", e, s)); });

// Claves: primero los secretos de la Edge Function; si no están, Vault (walter_secreto, solo prefijo walter_).
const cache: Record<string, string> = {};
async function secreto(k: string): Promise<string> {
  if (cache[k]) return cache[k];
  let v = env(k);
  if (!v) {
    const { data, error } = await db.rpc("walter_secreto", { p_nombre: k });
    if (error) console.error("secreto", k, error.message);
    v = (data as string | null) ?? "";
  }
  if (v) cache[k] = v;
  return v;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // 1) Verificación del webhook que hace Meta al configurarlo
  if (req.method === "GET") {
    const vt = await secreto("VERIFY_TOKEN");
    if (url.searchParams.get("hub.mode") === "subscribe" && vt && url.searchParams.get("hub.verify_token") === vt) {
      return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
    }
    return new Response("forbidden", { status: 403 });
  }

  // 2) Avisos programados
  if (url.searchParams.get("tarea") === "avisos") {
    const clave = await secreto("AVISOS_SECRET");
    if (!clave || req.headers.get("x-avisos-secret") !== clave) return new Response("forbidden", { status: 403 });
    const enviados = await enviarAvisos();
    const borrados = await limpiarMedios().catch((e) => (console.error("limpiar medios", e), 0));
    if (borrados) console.log("medios borrados", borrados);
    return Response.json({ enviados });
  }

  // 3) Walter desde el panel: lleva la sesión del usuario, no la firma de Meta
  if (url.searchParams.get("tarea") === "panel") {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const r = await panel(req);
    // Lo que queda corriendo después de contestar (pasar a texto el audio de Walter)
    if (aparte.length) {
      const resto = Promise.allSettled(aparte.splice(0));
      const rt = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
      if (rt) rt.waitUntil(resto);
      else await resto;
    }
    return r;
  }

  // 4) Mensajes entrantes
  const raw = await req.text();
  if (!(await firmaValida(raw, req.headers.get("x-hub-signature-256")))) return new Response("bad signature", { status: 401 });
  const body = JSON.parse(raw);
  const tareas: Promise<void>[] = [];

  if (body.object === "whatsapp_business_account") {
    for (const entry of body.entry ?? []) for (const ch of entry.changes ?? []) {
      const v = ch.value ?? {};
      const nombres: Record<string, string> = {};
      for (const c of v.contacts ?? []) nombres[c.wa_id] = c.profile?.name;
      for (const m of v.messages ?? []) {
        const texto = m.type === "text" ? m.text?.body
          : m.type === "interactive" ? (m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title)
          : m.type === "button" ? m.button?.text : null;
        const md = MEDIA[m.type] ? m[m.type] : null;
        // El id de WhatsApp del mensaje y, si el cliente contestó citando uno, el id del citado
        const wa: Wa = { id: m.id, ctx: m.context?.id };
        if (texto) tareas.push(atender("whatsapp", m.from, texto, m.type === "text", nombres[m.from], undefined, wa));
        else if (md?.id) {
          tareas.push(recibirMedia("whatsapp", m.from, { tipo: MEDIA[m.type], id: md.id, mime: md.mime_type, caption: md.caption, archivo: md.filename }, nombres[m.from], wa));
        } else tareas.push(enviar("whatsapp", m.from, [{ text: "Eso no lo puedo abrir. ¿Me lo escribís?" }]));
      }
    }
  } else if (body.object === "page") {
    for (const entry of body.entry ?? []) for (const ev of entry.messaging ?? []) {
      if (ev.message?.is_echo) continue;
      const texto = ev.message?.quick_reply ? ev.message.text : ev.message?.text ?? ev.postback?.title;
      const libre = !!ev.message?.text && !ev.message?.quick_reply;
      if (texto && ev.sender?.id) tareas.push(atender("messenger", ev.sender.id, texto, libre));
    }
  }
  // Meta reintenta si no recibe 200 enseguida: contestamos ya y atendemos en segundo plano
  // (atender espera unos segundos por si el cliente sigue escribiendo)
  const todo = Promise.allSettled(tareas).then(() => Promise.allSettled(aparte.splice(0)));
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
  if (runtime) runtime.waitUntil(todo);
  else await todo;
  return new Response("ok", { status: 200 });
});

async function config(): Promise<Config> {
  const { data, error } = await db.from("walter_config").select("data").eq("id", 1).single();
  if (error) throw error;
  return data.data as Config;
}

// libre: el cliente lo escribió (no tocó un botón ni una opción de la lista).
// media: la foto (u otro archivo) que trajo ese texto como epígrafe.
async function atender(canal: Canal, usuario: string, texto: string, libre: boolean, nombrePerfil?: string, media?: Media, wa?: Wa) {
  try {
    // Walter tocó "Ver las paradas" en la plantilla de la hoja de ruta: le llega el detalle, sin pasar por el bot
    if (canal === "whatsapp" && !libre && norm(texto) === norm(VER_PARADAS) && await mandarRutaPendiente(usuario)) return;
    const id = await log(canal, usuario, "entra", texto, undefined, media, wa);
    aparte.push(avisarWalter(canal, usuario, texto, nombrePerfil, media));
    // "Hola" y "Buenas" seguidos (o un "Hola" justo después de otro mensaje): contesta solo el primero.
    // Si llegan juntos, el de id menor.
    if (esSaludo(texto) && id) {
      const { count } = await db.from("walter_mensajes").select("id", { count: "exact", head: true })
        .eq("canal", canal).eq("usuario", usuario).eq("direccion", "entra").lt("id", id)
        .gte("creado", new Date(Date.now() - 60e3).toISOString());
      if (count) return;
    }
    await responder(canal, usuario, texto, libre, id, nombrePerfil);
  } catch (e) {
    console.error("atender", canal, usuario, e);
  }
}

// La respuesta del bot al mensaje id (ya guardado). pendiente: Walter le devolvió la charla al bot y este
// mensaje del cliente había quedado sin contestar mientras la atendía él.
async function responder(canal: Canal, usuario: string, texto: string, libre: boolean, id: number | null, nombrePerfil?: string, pendiente = false) {
  const [cfg, conv] = await Promise.all([
    config(),
    db.from("walter_conversaciones").select("estado, actualizado, bot_pausado").eq("canal", canal).eq("usuario", usuario).maybeSingle(),
  ]);
  let estado = (conv.data?.estado ?? null) as Estado | null;
  // Una charla vieja (más de 2 días sin hablar) arranca de cero, con saludo
  const vieja = !!conv.data && Date.now() - new Date(conv.data.actualizado).getTime() > 2 * 86400e3;
  if (vieja) estado = null;

  // Walter la está atendiendo desde el panel (o puso el modo manual para todas): el bot guarda el
  // mensaje y no contesta. Si la charla quedó quieta más de 2 días, vuelve a contestar el bot.
  if ((conv.data?.bot_pausado && !vieja) || cfg.modo === "manual") {
    if (pendiente) return;
    await db.from("walter_conversaciones").upsert({
      canal, usuario, pide_humano: true, actualizado: new Date().toISOString(), ...(nombrePerfil ? { nombre_perfil: nombrePerfil } : {}),
    });
    return;
  }

  // Mensajes seguidos ("hola" / "tengo cobre" / "en Funes"): esperamos un poco y contesta solo el
  // último. Los anteriores sin respuesta van en la charla reciente, y la IA los lee aunque el último sea un botón.
  if (id && pendiente) libre = true;
  else if (id) {
    // "Hola tengo": la frase sigue en el próximo mensaje, se espera un poco más
    // Si va tocando los tipos de la lista uno atrás de otro, también: se contestan todos juntos
    await new Promise((r) => setTimeout(r, pareceCortado(texto) ? ESPERA_CORTADO : tipoSuelto(cfg, texto) ? ESPERA_OPCION : ESPERA_SEGUIDOS));
    const { data: nuevos } = await db.from("walter_mensajes").select("texto")
      .eq("canal", canal).eq("usuario", usuario).eq("direccion", "entra").gt("id", id);
    // Un "hola" o una foto sin texto que llegan después no contestan esto: en ese caso contesta este
    const etiquetas: string[] = Object.values(ETIQUETA);
    if ((nuevos ?? []).some((m) => !esSaludo(String(m.texto)) && !etiquetas.includes(String(m.texto)))) return;
    if (await sinRespuesta(canal, usuario, id)) libre = true;
    // "¿Estás?" mientras el bot contesta (o recién contestó) lo anterior: no hace falta otra respuesta
    if (esPing(texto) && await escribioRecien(canal, usuario, id)) return;
    // Los tipos que tocó antes de este (sin respuesta todavía) se anotan en orden, para pedirle las cantidades de todos
    if (estado && tipoSuelto(cfg, texto)) {
      for (const t of await sinResponder(canal, usuario, id)) if (tipoSuelto(cfg, t)) estado = procesar(estado, t, cfg).estado;
    }
  }

  // Ya anotado: Walter puede haberle cambiado el día en Pedidos, y el bot tiene que decir el que quedó
  if (estado?.step === "done" && estado.d.cuando) {
    const { data: ped } = await db.from("walter_pedidos").select("dia, turno, localidad").eq("canal", canal).eq("usuario", usuario)
      .neq("estado", "cancelado").order("id", { ascending: false }).limit(1).maybeSingle();
    estado = { ...estado, d: { ...estado.d } };
    if (ped?.dia && ped.turno) estado.d.cuando = cuandoDe(cfg, ped.localidad, ped.dia, ped.turno);
    else delete estado.d.cuando;
  }

  // Respuesta al aviso del día o al recordatorio de retiro (SÍ / NO)
  const n = norm(texto);
  // En "¿tenés de otro tipo?" el sí o el no es para el pedido que está armando
  if (/^(si|no|dale|ok|okey|perfecto|listo|joya|de una|confirmo)\b/.test(n) && estado?.step !== "mas") {
    const [{ data: p }, { data: ult }] = await Promise.all([
      db.from("walter_pedidos").select("id, aviso_enviado").eq("canal", canal).eq("usuario", usuario)
        .or("aviso_enviado.not.is.null,aviso_dia.eq.enviado").is("respuesta_aviso", null)
        .order("dia", { ascending: false }).limit(1).maybeSingle(),
      db.from("walter_mensajes").select("texto, creado").eq("canal", canal).eq("usuario", usuario).eq("direccion", "sale")
        .order("id", { ascending: false }).limit(1).maybeSingle(),
    ]);
    // Solo si lo último que le mandamos es el aviso o el recordatorio: un "no" a "¿querés cotizar algo más?" no es un "no puedo".
    // El recordatorio sale como plantilla y no queda en la charla: cuenta si salió después del último mensaje.
    const alAviso = !!p && (!ult || String(ult.texto).includes(AVISO_DIA) ||
      (!!p.aviso_enviado && new Date(p.aviso_enviado).getTime() > new Date(ult.creado).getTime()));
    if (p && alAviso) {
      const si = !n.startsWith("no");
      await db.from("walter_pedidos").update({ respuesta_aviso: si ? "confirmó" : "no puede" }).eq("id", p.id);
      return enviar(canal, usuario, [{
        text: si ? "¡Gracias! Te esperamos. 👍" : "Gracias por avisar. Le aviso al equipo para coordinar otro día.",
      }]);
    }
  }

  // Lo último de la charla, para que la IA no lea cada mensaje suelto (y vea lo que llegó mientras Walter atendía)
  const charla = id ? await charlaReciente(canal, usuario, id) : "";
  const clave = await secreto("ANTHROPIC_API_KEY");
  // Lo escrito libremente lo lee Haiku antes, salvo el nombre y la dirección, que se anotan tal cual
  const lectura = libre && !["name", "addr"].includes(estado?.step ?? "")
    ? await leer(clave, texto, estado, cfg, charla) : null;
  if (lectura) console.log("lectura", JSON.stringify({ step: estado?.step, intencion: lectura.intencion ?? null, campos: Object.keys(lectura) }));
  // Con pistas guardadas de un mensaje anterior, también cuando toca un botón
  const r0 = lectura || estado?.p ? procesarConLectura(estado, texto, cfg, lectura) : procesar(estado, texto, cfg);
  // En WhatsApp el nombre sale del perfil: no hace falta preguntarlo
  const r = conPerfil(r0, nombreDePerfil(nombrePerfil), cfg);
  await db.from("walter_conversaciones").upsert({
    canal, usuario, estado: r.estado, actualizado: new Date().toISOString(), bot_pausado: false,
    ...(nombrePerfil ? { nombre_perfil: nombrePerfil } : {}),
    ...(r.derivar ? { pide_humano: true } : {}),
  });
  if (r.pedido) {
    const p = r.pedido;
    await db.from("walter_pedidos").insert({
      canal, usuario, nombre: p.nombre, localidad: p.loc, material: p.mat, modo: p.modo, tipo: p.tipo, cantidad: p.cant,
      retiro: p.ret, direccion: p.dir, monto: p.monto, tarifa: p.tarifa, prioridad: p.prioridad, ...(p.items ? { items: p.items } : {}),
      // Anotado en el recorrido de su localidad: el día ya se lo dijo el bot, no hace falta el aviso del día
      ...(p.dia && p.turno ? { dia: p.dia, turno: p.turno, estado: "agendado", aviso_dia: "enviado" } : {}),
    });
    // Antes de anotarlo dijo cuándo puede ("hoy estoy entre las 18 y 18:45"): el bot no lo acuerda, lo ve el equipo
    if (id && [texto, ...await sinResponder(canal, usuario, id)].some(esCoordinar)) {
      if (p.dia) {
        const ult = r.respuestas[r.respuestas.length - 1];
        ult.text += "\n\nLo que me dijiste de cuándo te queda bien se lo paso a quien arma los recorridos: si se puede otro día, te avisamos por acá.";
      }
      await db.from("walter_conversaciones").update({ pide_humano: true }).eq("canal", canal).eq("usuario", usuario);
    }
  }
  // Hizo una pregunta: la respuesta va antes de la pregunta en la que estábamos. Si la IA no
  // puede contestarla con lo que sabe el negocio, le avisamos a Walter.
  if (r.consulta) {
    const resp = await contestar(clave, texto, hechos(cfg), charla);
    r.respuestas.splice(Math.max(0, r.respuestas.length - 1), 0, { text: resp ?? "Eso te lo confirma alguien del equipo, ya le aviso." });
    if (!resp) await db.from("walter_conversaciones").update({ pide_humano: true }).eq("canal", canal).eq("usuario", usuario);
  }
  // El bot arma qué decir y con qué números; Haiku lo dice como lo diría una persona
  await enviar(canal, usuario, await redactar(clave, texto, juntar(r.respuestas), charla));
}

// Cuánto espera el bot por si el cliente manda otro mensaje enseguida
const ESPERA_SEGUIDOS = 5000;
const ESPERA_CORTADO = 15000;
const ESPERA_OPCION = 10000;

// Mensajes del cliente de los últimos 2 minutos, antes del actual, que el bot todavía no contestó
async function sinRespuesta(canal: Canal, usuario: string, hastaId: number): Promise<number> {
  const { data: ult } = await db.from("walter_mensajes").select("id").eq("canal", canal).eq("usuario", usuario)
    .eq("direccion", "sale").lt("id", hastaId).order("id", { ascending: false }).limit(1).maybeSingle();
  let q = db.from("walter_mensajes").select("id", { count: "exact", head: true }).eq("canal", canal).eq("usuario", usuario)
    .eq("direccion", "entra").lt("id", hastaId).gte("creado", new Date(Date.now() - 120e3).toISOString());
  if (ult) q = q.gt("id", ult.id);
  const { count } = await q;
  return count ?? 0;
}

// Los textos que mandó el cliente en los últimos 2 minutos, antes del actual y después de la última respuesta, en orden
async function sinResponder(canal: Canal, usuario: string, hastaId: number): Promise<string[]> {
  const { data: ult } = await db.from("walter_mensajes").select("id").eq("canal", canal).eq("usuario", usuario)
    .eq("direccion", "sale").lt("id", hastaId).order("id", { ascending: false }).limit(1).maybeSingle();
  let q = db.from("walter_mensajes").select("texto").eq("canal", canal).eq("usuario", usuario).eq("direccion", "entra")
    .lt("id", hastaId).gte("creado", new Date(Date.now() - 120e3).toISOString()).order("id");
  if (ult) q = q.gt("id", ult.id);
  const { data } = await q;
  return (data ?? []).map((m) => String(m.texto));
}

// El cliente ya había escrito algo en los 2 minutos antes de este mensaje
async function escribioRecien(canal: Canal, usuario: string, hastaId: number): Promise<boolean> {
  const { count } = await db.from("walter_mensajes").select("id", { count: "exact", head: true }).eq("canal", canal).eq("usuario", usuario)
    .eq("direccion", "entra").lt("id", hastaId).gte("creado", new Date(Date.now() - 120e3).toISOString());
  return (count ?? 0) > 0;
}

// Los últimos mensajes antes del actual, del más viejo al más nuevo
async function charlaReciente(canal: Canal, usuario: string, hastaId: number): Promise<string> {
  const { data } = await db.from("walter_mensajes").select("direccion, autor, texto").eq("canal", canal).eq("usuario", usuario)
    .lt("id", hastaId).gte("creado", new Date(Date.now() - 2 * 86400e3).toISOString()).order("id", { ascending: false }).limit(14);
  return (data ?? []).reverse()
    .map((m) => `${m.direccion === "entra" ? "Cliente" : m.autor === "walter" ? "Equipo" : "Bot"}: ${String(m.texto).slice(0, 500)}`).join("\n");
}

async function enviar(canal: Canal, usuario: string, respuestas: Respuesta[]) {
  for (const r of respuestas) {
    const id = await log(canal, usuario, "sale", r.text, "bot");
    const opts = (r.options ?? []).slice(0, canal === "whatsapp" ? 10 : 13);
    if (canal === "whatsapp") {
      // WhatsApp muestra hasta 3 botones; con más opciones (los tipos de moneda) va una lista
      const msg = !opts.length ? { type: "text", text: { body: r.text } }
        : opts.length <= 3
        ? { type: "interactive", interactive: { type: "button", body: { text: r.text.slice(0, 1024) },
            action: { buttons: opts.map((t, i) => ({ type: "reply", reply: { id: "op" + i, title: t.slice(0, 20) } })) } } }
        : { type: "interactive", interactive: { type: "list", body: { text: r.text.slice(0, 1024) },
            action: { button: "Elegir", sections: [{ title: "Opciones", rows: opts.map((t, i) => ({ id: "op" + i, title: t.slice(0, 24) })) }] } } };
      const { id: waId } = await graphEnviar(`${await secreto("WA_PHONE_ID")}/messages`, await secreto("WA_TOKEN"), { messaging_product: "whatsapp", to: usuario, ...msg });
      // Para que Walter pueda contestar citando lo que dijo el bot, y para mostrar las citas del cliente
      if (id && waId) await db.from("walter_mensajes").update({ wa_id: waId }).eq("id", id);
    } else {
      await graph("me/messages", await secreto("FB_PAGE_TOKEN"), {
        recipient: { id: usuario }, messaging_type: "RESPONSE",
        message: { text: r.text, ...(opts.length ? { quick_replies: opts.map((t) => ({ content_type: "text", title: t.slice(0, 20), payload: t })) } : {}) },
      });
    }
  }
}

async function graph(path: string, token: string, payload: unknown) {
  return (await graphError(path, token, payload)) === null;
}

// null si salió; si no, el motivo que da Meta
async function graphError(path: string, token: string, payload: unknown): Promise<string | null> {
  return (await graphEnviar(path, token, payload)).error;
}

// Lo mismo, con el id del mensaje que devuelve WhatsApp (wamid…) cuando salió
async function graphEnviar(path: string, token: string, payload: unknown): Promise<{ error: string | null; id: string | null }> {
  const res = await fetch(`${GRAPH}/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const txt = await res.text();
  if (res.ok) {
    try {
      return { error: null, id: JSON.parse(txt).messages?.[0]?.id ?? null };
    } catch {
      return { error: null, id: null };
    }
  }
  console.error("graph", path, res.status, txt);
  try {
    const e = JSON.parse(txt).error;
    return { error: e?.error_data?.details || e?.message || txt, id: null };
  } catch {
    return { error: txt, id: null };
  }
}

type MediaTipo = "imagen" | "audio" | "video" | "documento" | "sticker";
type Media = { tipo: MediaTipo; path: string | null };
// id de WhatsApp del mensaje y el del mensaje que cita (schema/69)
type Wa = { id?: string | null; ctx?: string | null };

async function log(canal: Canal, usuario: string, direccion: "entra" | "sale", texto: string, autor?: "bot" | "walter", media?: Media, wa?: Wa): Promise<number | null> {
  const { data } = await db.from("walter_mensajes").insert({
    canal, usuario, direccion, texto, ...(autor ? { autor } : {}), ...(media ? { media_tipo: media.tipo, media_path: media.path } : {}),
    ...(wa?.id ? { wa_id: wa.id } : {}), ...(wa?.ctx ? { responde_a: wa.ctx } : {}),
  }).select("id").single();
  return data?.id ?? null;
}

// ---------- Fotos, audios y archivos que manda el cliente ----------
const MEDIA: Record<string, MediaTipo> = { image: "imagen", audio: "audio", video: "video", document: "documento", sticker: "sticker" };
// El texto que queda en la charla (y que lee la IA) cuando no viene con epígrafe
const ETIQUETA: Record<MediaTipo, string> = { imagen: "[Foto]", audio: "[Audio]", video: "[Video]", documento: "[Archivo]", sticker: "[Sticker]" };
const RECIBIDO: Partial<Record<MediaTipo, string>> = {
  imagen: "¡Gracias por la foto! Se la paso al equipo para que la vea y te contesta por acá.",
  audio: "¡Gracias por el audio! Todavía no puedo escucharlos: se lo paso al equipo y te contesta por acá. Si preferís, escribime lo que necesitás y te cotizo ya.",
  video: "¡Gracias por el video! Se lo paso al equipo para que lo vea y te contesta por acá.",
  documento: "¡Gracias por el archivo! Se lo paso al equipo y te contesta por acá.",
};
const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a",
  "audio/aac": "aac", "audio/amr": "amr", "video/mp4": "mp4", "video/3gpp": "3gp", "application/pdf": "pdf",
};
const BUCKET = "walter-media";

// Baja el archivo de Meta (primero el link, después los bytes) y lo guarda en el bucket; null si no se pudo bajar.
// path queda null si se bajó pero no se pudo guardar.
async function guardarMedia(usuario: string, mediaId: string, mime?: string, archivo?: string):
  Promise<{ path: string | null; bytes: Uint8Array<ArrayBuffer>; tipo: string; ext: string } | null> {
  try {
    const auth = { Authorization: `Bearer ${await secreto("WA_TOKEN")}` };
    const info = await fetch(`${GRAPH}/${mediaId}`, { headers: auth });
    const j = await info.json().catch(() => ({}));
    if (!info.ok || !j.url) { console.error("media info", info.status, JSON.stringify(j)); return null; }
    const res = await fetch(j.url, { headers: auth });
    if (!res.ok) { console.error("media bajar", res.status); return null; }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const tipo = String(j.mime_type || mime || "application/octet-stream").split(";")[0].trim();
    const ext = EXT[tipo] ?? archivo?.match(/\.([a-z0-9]{1,5})$/i)?.[1]?.toLowerCase() ?? "bin";
    const path = `${usuario}/${Date.now()}-${mediaId}.${ext}`;
    const { error } = await db.storage.from(BUCKET).upload(path, bytes, { contentType: tipo, upsert: true });
    if (error) console.error("media guardar", error.message);
    return { path: error ? null : path, bytes, tipo, ext };
  } catch (e) {
    console.error("media", e);
    return null;
  }
}

async function recibirMedia(canal: Canal, usuario: string,
  m: { tipo: MediaTipo; id: string; mime?: string; caption?: string; archivo?: string }, nombrePerfil?: string, wa?: Wa) {
  try {
    const bajado = await guardarMedia(usuario, m.id, m.mime, m.archivo);
    const media: Media = { tipo: m.tipo, path: bajado?.path ?? null };
    // Con epígrafe ("tengo estas, ¿cuánto me dan?"): el bot lee el texto como cualquier mensaje
    const caption = m.caption?.trim();
    if (caption) return atender(canal, usuario, caption, true, nombrePerfil, media, wa);
    // Un audio se pasa a texto y se contesta como si lo hubiera escrito. Si no se puede, sigue como antes.
    if (m.tipo === "audio" && bajado) {
      const dicho = await transcribir(bajado.bytes, bajado.tipo, bajado.ext);
      if (dicho) return atender(canal, usuario, dicho, true, nombrePerfil, media, wa);
    }

    const id = await log(canal, usuario, "entra", ETIQUETA[m.tipo], undefined, media, wa);
    aparte.push(avisarWalter(canal, usuario, ETIQUETA[m.tipo], nombrePerfil, media));
    const [cfg, { data: conv }] = await Promise.all([
      config(),
      db.from("walter_conversaciones").select("bot_pausado, actualizado").eq("canal", canal).eq("usuario", usuario).maybeSingle(),
    ]);
    // Walter ve en el panel que le mandaron algo
    await db.from("walter_conversaciones").upsert({
      canal, usuario, pide_humano: true, actualizado: new Date().toISOString(), ...(nombrePerfil ? { nombre_perfil: nombrePerfil } : {}),
    });
    const vieja = !!conv && Date.now() - new Date(conv.actualizado).getTime() > 2 * 86400e3;
    if ((conv?.bot_pausado && !vieja) || cfg.modo === "manual" || !RECIBIDO[m.tipo]) return;
    // Varias fotos seguidas: se contesta una sola vez
    if (id) {
      const { count } = await db.from("walter_mensajes").select("id", { count: "exact", head: true })
        .eq("canal", canal).eq("usuario", usuario).eq("direccion", "entra").not("media_tipo", "is", null).lt("id", id)
        .gte("creado", new Date(Date.now() - 120e3).toISOString());
      if (count) return;
    }
    await enviar(canal, usuario, [{ text: RECIBIDO[m.tipo]! }]);
  } catch (e) {
    console.error("recibirMedia", canal, usuario, e);
  }
}

// Audio a texto con Whisper. TRANSCRIPCION_KEY es la clave de Groq (o de OpenAI con TRANSCRIPCION=openai).
// null si no hay clave, si falla o si el audio no dice nada.
const TRANSCRIPTORES: Record<string, { url: string; modelo: string }> = {
  groq: { url: "https://api.groq.com/openai/v1/audio/transcriptions", modelo: "whisper-large-v3-turbo" },
  openai: { url: "https://api.openai.com/v1/audio/transcriptions", modelo: "gpt-4o-mini-transcribe" },
};
async function transcribir(bytes: Uint8Array<ArrayBuffer>, tipo: string, ext: string): Promise<string | null> {
  const clave = await secreto("TRANSCRIPCION_KEY");
  if (!clave) return null;
  const t = TRANSCRIPTORES[(await secreto("TRANSCRIPCION")) || "groq"] ?? TRANSCRIPTORES.groq;
  try {
    const form = new FormData();
    // WhatsApp manda los audios como ogg (opus); Whisper reconoce el formato por la extensión
    form.append("file", new Blob([bytes], { type: tipo }), `audio.${ext === "bin" ? "ogg" : ext}`);
    form.append("model", t.modelo);
    form.append("language", "es");
    form.append("response_format", "json");
    const res = await fetch(t.url, {
      method: "POST", headers: { Authorization: `Bearer ${clave}` }, body: form, signal: AbortSignal.timeout(15000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { console.error("transcribir", res.status, JSON.stringify(j).slice(0, 300)); return null; }
    const texto = String(j.text ?? "").trim();
    console.log("transcripcion", JSON.stringify({ largo: texto.length }));
    // Segundos aproximados: los audios de WhatsApp (opus) son unos 2 KB por segundo
    await sumarUso("transcripcion", bytes.length / 2000);
    return texto.length >= 2 ? texto.slice(0, 2000) : null;
  } catch (e) {
    console.error("transcribir", e);
    return null;
  }
}

async function firmaValida(raw: string, header: string | null) {
  const secret = await secreto("META_APP_SECRET");
  if (!secret || !header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  const hex = [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
  const got = header.slice(7);
  if (got.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

// ---------- Avisos: turno mañana la noche anterior, turno tarde la mañana del mismo día ----------
function ahoraAR() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  const hoy = `${p.year}-${p.month}-${p.day}`;
  const m = new Date(hoy + "T12:00:00Z"); m.setUTCDate(m.getUTCDate() + 1);
  return { hoy, manana: m.toISOString().slice(0, 10), hhmm: `${p.hour === "24" ? "00" : p.hour}:${p.minute}` };
}

async function enviarAvisos() {
  const cfg = await config();
  const { hoy, manana, hhmm } = ahoraAR();
  const grupos: { dia: string; turno: string; desde: string }[] = [
    { dia: manana, turno: "Mañana", desde: cfg.horaNoche ?? "21:00" },
    { dia: hoy, turno: "Tarde", desde: cfg.horaManana ?? "09:00" },
  ];
  let enviados = 0;
  for (const g of grupos) {
    if (hhmm < g.desde) continue;
    const { data: pedidos } = await db.from("walter_pedidos").select("*")
      .eq("dia", g.dia).eq("turno", g.turno).is("aviso_enviado", null).neq("estado", "cancelado").neq("retiro", "Depósito");
    for (const p of pedidos ?? []) {
      const nombre = String(p.nombre).split(" ")[0];
      const que = /llave/i.test(p.tipo ?? "") ? "las llaves"
        : p.material === "Monedas" ? "las monedas" : "el " + String(p.material).toLowerCase();
      const hs = horarioDe(cfg, p.localidad, p.dia, p.turno);
      const cuando = (g.turno === "Mañana" ? "mañana a la mañana" : "hoy a la tarde") + (hs ? ` (${hs})` : "");
      let ok: boolean;
      if (p.canal === "whatsapp") {
        // Plantilla aprobada en Meta con 3 variables: {{1}} nombre, {{2}} cuándo, {{3}} qué
        ok = await graph(`${await secreto("WA_PHONE_ID")}/messages`, await secreto("WA_TOKEN"), {
          messaging_product: "whatsapp", to: p.usuario, type: "template",
          template: { name: (await secreto("WA_TEMPLATE")) || "aviso_retiro", language: { code: "es_AR" },
            components: [{ type: "body", parameters: [nombre, cuando, que].map((text) => ({ type: "text", text })) }] },
        });
      } else {
        ok = await graph("me/messages", await secreto("FB_PAGE_TOKEN"), {
          recipient: { id: p.usuario }, messaging_type: "MESSAGE_TAG", tag: "CONFIRMED_EVENT_UPDATE",
          message: { text: `Hola ${nombre}, ${cuando} pasamos por ${que}. ¿Nos confirmás que vas a estar? Respondé SÍ o NO.` },
        });
      }
      if (ok) {
        enviados++;
        // El SÍ / NO de este recordatorio vale aunque ya haya contestado el aviso del día
        await db.from("walter_pedidos").update({ aviso_enviado: new Date().toISOString(), respuesta_aviso: null, estado: "agendado" })
          .eq("id", p.id);
      }
    }
  }
  await avisarPorVencer().catch((e) => console.error("avisar por vencer", e));
  return enviados + await avisarDia(hoy, manana);
}

// A las 20 horas del último mensaje de un cliente que espera respuesta, le avisamos a Walter: a las 24
// WhatsApp ya no deja escribirle libre y solo queda el saludo aprobado. Corre cada 15 minutos.
async function avisarPorVencer() {
  const desde = Date.now() - 20 * 3600e3 - 15 * 60e3, hasta = Date.now() - 20 * 3600e3;
  const { data: convs } = await db.from("walter_conversaciones").select("canal, usuario, nombre_perfil")
    .eq("canal", "whatsapp").gte("actualizado", new Date(Date.now() - 2 * 86400e3).toISOString());
  for (const c of convs ?? []) {
    const { data: ult } = await db.from("walter_mensajes").select("direccion, creado, texto").eq("canal", c.canal).eq("usuario", c.usuario)
      .order("id", { ascending: false }).limit(1).maybeSingle();
    const t = ult ? new Date(ult.creado).getTime() : 0;
    if (!ult || ult.direccion !== "entra" || t < desde || t >= hasta) continue;
    // Un 👍 o un "gracias" no espera respuesta
    if (/^(|ok|oka|okey|dale|gracias|muchas gracias|listo|joya|perfecto|genial|buenisimo|de nada|chau)$/.test(norm(String(ult.texto)).replace(/[.,!]/g, "").trim())) continue;
    const vence = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit", hour12: false })
      .format(new Date(t + VENTANA));
    await avisarWalter(c.canal as Canal, c.usuario, `Te escribió hace 20 horas y espera respuesta. Contestale antes de las ${vence}: después WhatsApp solo deja mandarle el saludo.`, c.nombre_perfil ?? undefined);
  }
}

const AVISO_DIA = "Ya tenemos día para pasar a buscar";

// Apenas Walter le pone día y turno a un pedido, se lo decimos al cliente. Solo si la charla sigue
// abierta: Meta deja escribir libre hasta 24 horas después del último mensaje del cliente. Si no,
// le llega solo el recordatorio. Corre después de los recordatorios, que tienen prioridad.
async function avisarDia(hoy: string, manana: string) {
  const { data: pedidos } = await db.from("walter_pedidos").select("*")
    .not("dia", "is", null).not("turno", "is", null).is("aviso_dia", null).is("aviso_enviado", null)
    .gte("dia", hoy).neq("estado", "cancelado").neq("retiro", "Depósito");
  let enviados = 0;
  for (const p of pedidos ?? []) {
    const { data: ult } = await db.from("walter_mensajes").select("creado").eq("canal", p.canal).eq("usuario", p.usuario)
      .eq("direccion", "entra").order("id", { ascending: false }).limit(1).maybeSingle();
    const abierta = !!ult && Date.now() - new Date(ult.creado).getTime() < 23.5 * 3600e3;
    if (abierta) {
      const nombre = String(p.nombre).split(" ")[0];
      const que = /llave/i.test(p.tipo ?? "") ? "las llaves"
        : p.material === "Monedas" ? "las monedas" : "el " + String(p.material).toLowerCase();
      const dia = p.dia === hoy ? "hoy" : p.dia === manana ? "mañana"
        : "el " + new Intl.DateTimeFormat("es-AR", { weekday: "long", day: "numeric", timeZone: "UTC" }).format(new Date(p.dia + "T12:00:00Z"));
      await enviar(p.canal, p.usuario, [{
        text: `¡Hola ${nombre}! ${AVISO_DIA} ${que}: ${dia} a la ${String(p.turno).toLowerCase()}. ¿Te queda bien?`,
        options: ["Sí, me queda bien", "No puedo ese día"],
      }]);
      enviados++;
    }
    await db.from("walter_pedidos").update({ aviso_dia: abierta ? "enviado" : "sin ventana" }).eq("id", p.id);
  }
  return enviados;
}

// ---------- Panel de Bruwal Chat: Walter contesta, borra charlas y carga contactos ----------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const respuesta = (cuerpo: Record<string, unknown>, status = 200) => Response.json(cuerpo, { status, headers: CORS });

// Para retomar una charla que ya venía: no le vuelve a preguntar qué tiene. Plantilla retomar_charla, con
// {{1}} el nombre; mientras Meta no la apruebe, sale primer_contacto.
const SALUDO_RETOMAR = "¡Hola {{1}}! Te escribimos de Punto Metales para seguir con lo que venías hablando con nosotros. " +
  "Respondé este mensaje y lo seguimos por acá.";
// El texto de la plantilla primer_contacto tal como se cargó en Meta (para que el panel muestre lo que le llegó)
const SALUDO_CONTACTO = "¡Hola {{1}}! Te escribimos de Punto Metales: compramos monedas, llaves, cobre y bronce, " +
  "y pasamos a retirar por tu zona. ¿Tenés algo para vender? Respondé este mensaje y te pasamos el precio.";

// Meta deja escribir libre hasta 24 horas después del último mensaje del cliente
const VENTANA = 24 * 3600e3;

async function panel(req: Request): Promise<Response> {
  if (req.method !== "POST") return respuesta({ error: "Método no permitido" }, 405);
  // La sesión del panel: quién es y si está vinculado al cliente de Walter (lo mismo que walter_usuario_habilitado)
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = jwt ? await db.auth.getUser(jwt) : { data: { user: null } };
  if (!u.user) return respuesta({ error: "Tu sesión venció. Volvé a entrar." }, 401);
  const { data: cfgRow } = await db.from("walter_config").select("cliente_id").eq("id", 1).single();
  const { count } = await db.from("cliente_usuarios").select("user_id", { count: "exact", head: true })
    .eq("cliente_id", cfgRow?.cliente_id).eq("user_id", u.user.id);
  if (!count) return respuesta({ error: "Tu usuario no tiene acceso a este panel." }, 403);

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return respuesta({ error: "Pedido inválido" }, 400);
  }
  try {
    // responder_a: el mensaje que Walter cita al contestar (como "Responder" en WhatsApp)
    const cita = typeof b.responder_a === "string" && /^wamid\.[\w=+\/-]{10,200}$/.test(b.responder_a) ? b.responder_a : null;
    if (b.accion === "enviar") return await panelEnviar(String(b.canal), String(b.usuario), String(b.texto ?? "").trim(), cita);
    if (b.accion === "enviar_foto") return await panelEnviarMedio(String(b.canal), String(b.usuario), "imagen", b.foto, String(b.texto ?? "").trim(), cita);
    if (b.accion === "enviar_audio") return await panelEnviarMedio(String(b.canal), String(b.usuario), "audio", b.audio, "", cita);
    if (b.accion === "medios") return await panelMedios(b.paths);
    if (b.accion === "borrar") return await panelBorrar(String(b.canal), String(b.usuario));
    if (b.accion === "contacto") {
      return await panelContacto(String(b.numero ?? ""), String(b.nombre ?? "").trim(), String(b.localidad ?? "").trim(), !!b.saludar);
    }
    if (b.accion === "contestar_pendiente") return await panelPendiente(String(b.canal), String(b.usuario));
    if (b.accion === "retomar") return await panelRetomar(String(b.canal), String(b.usuario));
    if (b.accion === "borrar_pedidos") return await panelBorrarPedidos(b.ids);
    if (b.accion === "perfil") return await panelPerfil();
    if (b.accion === "enviar_ruta") return await panelEnviarRuta(b);
    if (b.accion === "uso") return await panelUso();
    if (b.accion === "push_clave") return respuesta({ ok: true, clave: await clavePush() });
    if (b.accion === "push_alta") return await panelPushAlta(b, u.user.id);
    if (b.accion === "push_baja") {
      await db.from("walter_push").delete().eq("endpoint", String(b.endpoint ?? ""));
      return respuesta({ ok: true });
    }
    if (b.accion === "perfil_guardar") return await panelPerfilGuardar(b);
    return respuesta({ error: "Acción desconocida" }, 400);
  } catch (e) {
    console.error("panel", b.accion, e);
    return respuesta({ error: "No se pudo completar. Probá de nuevo." }, 500);
  }
}

async function panelEnviar(canal: string, usuario: string, texto: string, cita: string | null = null) {
  if (canal !== "whatsapp" && canal !== "messenger") return respuesta({ error: "Canal inválido" }, 400);
  if (!texto) return respuesta({ error: "Escribí el mensaje." }, 400);
  if (texto.length > 4000) return respuesta({ error: "El mensaje es muy largo (hasta 4000 letras)." }, 400);
  const { data: conv } = await db.from("walter_conversaciones").select("usuario").eq("canal", canal).eq("usuario", usuario).maybeSingle();
  if (!conv) return respuesta({ error: "No encontramos esa charla." }, 404);

  if (!(await ventanaAbierta(canal, usuario))) return SIN_VENTANA();

  const { error: motivo, id: waId } = canal === "whatsapp"
    ? await graphEnviar(`${await secreto("WA_PHONE_ID")}/messages`, await secreto("WA_TOKEN"),
      { messaging_product: "whatsapp", to: usuario, type: "text", text: { body: texto }, ...(cita ? { context: { message_id: cita } } : {}) })
    : await graphEnviar("me/messages", await secreto("FB_PAGE_TOKEN"),
      { recipient: { id: usuario }, messaging_type: "RESPONSE", message: { text: texto } });
  if (motivo) return respuesta({ error: "WhatsApp no lo aceptó: " + motivo }, 502);

  await log(canal, usuario, "sale", texto, "walter", undefined, canal === "whatsapp" ? { id: waId, ctx: cita } : undefined);
  // Walter la atiende: el bot se queda callado en esta charla hasta que él se la devuelva
  await db.from("walter_conversaciones").update({ bot_pausado: true, pide_humano: false, actualizado: new Date().toISOString() })
    .eq("canal", canal).eq("usuario", usuario);
  return respuesta({ ok: true });
}

const SIN_VENTANA = () => respuesta({
  error: "Pasaron más de 24 horas desde el último mensaje del cliente: WhatsApp no deja escribirle libre hasta que vuelva a escribir.",
  ventana: false,
}, 409);

async function ventanaAbierta(canal: string, usuario: string) {
  const { data: ult } = await db.from("walter_mensajes").select("creado").eq("canal", canal).eq("usuario", usuario)
    .eq("direccion", "entra").order("id", { ascending: false }).limit(1).maybeSingle();
  return !!ult && Date.now() - new Date(ult.creado).getTime() <= VENTANA;
}

// Una foto o un audio desde el panel: se sube a Meta, sale por el número del bot y queda guardado para verlo en la charla
const SALIDA = {
  imagen: { tipos: /^data:(image\/(?:jpeg|png));base64,(.+)$/, max: 5, nombre: "La foto", formato: "JPG o PNG" },
  audio: { tipos: /^data:(audio\/(?:mpeg|ogg|mp4|aac));base64,(.+)$/, max: 16, nombre: "El audio", formato: "OGG o MP3" },
};
const EXT_SALIDA: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/aac": "aac" };

async function panelEnviarMedio(canal: string, usuario: string, tipo: "imagen" | "audio", archivo: unknown, texto: string, cita: string | null = null) {
  const s = SALIDA[tipo];
  if (canal !== "whatsapp") return respuesta({ error: `${s.nombre} por ahora sale solo por WhatsApp.` }, 400);
  const m = typeof archivo === "string" ? archivo.match(s.tipos) : null;
  if (!m) return respuesta({ error: `${s.nombre} tiene que ser ${s.formato}.` }, 400);
  if (texto.length > 1024) return respuesta({ error: "El texto de la foto va hasta 1024 letras." }, 400);
  const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  if (bytes.length > s.max * 1024 * 1024) return respuesta({ error: `${s.nombre} pesa demasiado (hasta ${s.max} MB).` }, 400);
  const { data: conv } = await db.from("walter_conversaciones").select("usuario").eq("canal", canal).eq("usuario", usuario).maybeSingle();
  if (!conv) return respuesta({ error: "No encontramos esa charla." }, 404);
  if (!(await ventanaAbierta(canal, usuario))) return SIN_VENTANA();

  const ext = EXT_SALIDA[m[1]];
  const phone = await secreto("WA_PHONE_ID"), token = await secreto("WA_TOKEN");
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", m[1]);
  form.append("file", new Blob([bytes], { type: m[1] }), `${tipo === "imagen" ? "foto" : "audio"}.${ext}`);
  const sub = await fetch(`${GRAPH}/${phone}/media`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
  const sj = await sub.json().catch(() => ({}));
  if (!sub.ok || !sj.id) {
    console.error("media salida", tipo, sub.status, JSON.stringify(sj));
    return respuesta({ error: `WhatsApp no aceptó ${tipo === "imagen" ? "la foto" : "el audio"}: ` + (sj.error?.message ?? "no se pudo subir") }, 502);
  }
  // El audio no lleva texto: WhatsApp no lo muestra. El ogg (opus) va como nota de voz: el cliente lo ve
  // con la foto de perfil del negocio y el micrófono, como un audio grabado en WhatsApp.
  const msg = tipo === "imagen"
    ? { type: "image", image: { id: sj.id, ...(texto ? { caption: texto } : {}) } }
    : { type: "audio", audio: { id: sj.id, ...(m[1] === "audio/ogg" ? { voice: true } : {}) } };
  const { error: motivo, id: waId } = await graphEnviar(`${phone}/messages`, token,
    { messaging_product: "whatsapp", to: usuario, ...msg, ...(cita ? { context: { message_id: cita } } : {}) });
  if (motivo) return respuesta({ error: "WhatsApp no lo aceptó: " + motivo }, 502);

  const path = `${usuario}/${Date.now()}-walter.${ext}`;
  const { error } = await db.storage.from(BUCKET).upload(path, bytes, { contentType: m[1] });
  if (error) console.error("media salida guardar", error.message);
  const id = await log(canal, usuario, "sale", texto || ETIQUETA[tipo], "walter", { tipo, path: error ? null : path }, { id: waId, ctx: cita });
  // Lo que dijo Walter en el audio queda como texto, para que el bot sepa qué se habló si después sigue él
  if (tipo === "audio" && id) {
    aparte.push(transcribir(bytes, m[1], ext).then((dicho) => dicho ? db.from("walter_mensajes").update({ texto: dicho }).eq("id", id) : null));
  }
  await db.from("walter_conversaciones").update({ bot_pausado: true, pide_humano: false, actualizado: new Date().toISOString() })
    .eq("canal", canal).eq("usuario", usuario);
  return respuesta({ ok: true });
}

// Las fotos y audios se borran solos a los DIAS_MEDIOS días para no ocupar lugar. El mensaje queda en la
// charla, sin el archivo. Corre con los avisos (cada 15 minutos), de a 200.
const DIAS_MEDIOS = 30;
async function limpiarMedios() {
  const { data } = await db.from("walter_mensajes").select("id, media_path").not("media_path", "is", null)
    .lt("creado", new Date(Date.now() - DIAS_MEDIOS * 86400e3).toISOString()).order("id").limit(200);
  if (!data?.length) return 0;
  const { error } = await db.storage.from(BUCKET).remove(data.map((x) => x.media_path as string));
  if (error) { console.error("limpiar medios", error.message); return 0; }
  await db.from("walter_mensajes").update({ media_path: null }).in("id", data.map((x) => x.id));
  return data.length;
}

// Links por una hora para ver en el panel las fotos y audios de las charlas
async function panelMedios(paths: unknown) {
  const lista = Array.isArray(paths)
    ? [...new Set(paths.filter((p): p is string => typeof p === "string" && /^[\w.-]+\/[\w.-]+$/.test(p)))].slice(0, 200) : [];
  if (!lista.length) return respuesta({ ok: true, urls: {} });
  const { data, error } = await db.storage.from(BUCKET).createSignedUrls(lista, 3600);
  if (error) throw error;
  const urls: Record<string, string> = {};
  for (const x of data ?? []) if (x.path && x.signedUrl) urls[x.path] = x.signedUrl;
  return respuesta({ ok: true, urls });
}

// Borra la charla, sus mensajes y sus fotos y audios. Los pedidos quedan.
async function panelBorrar(canal: string, usuario: string) {
  const { data: medios } = await db.from("walter_mensajes").select("media_path").eq("canal", canal).eq("usuario", usuario)
    .not("media_path", "is", null);
  const paths = (medios ?? []).map((x) => x.media_path as string);
  if (paths.length) {
    const { error } = await db.storage.from(BUCKET).remove(paths);
    if (error) console.error("borrar medios", error.message);
  }
  const m = await db.from("walter_mensajes").delete().eq("canal", canal).eq("usuario", usuario);
  if (m.error) throw m.error;
  const c = await db.from("walter_conversaciones").delete().eq("canal", canal).eq("usuario", usuario);
  if (c.error) throw c.error;
  return respuesta({ ok: true });
}

/** Número de WhatsApp de Argentina como lo usa Meta: 549 + código de área + número (13 dígitos). */
export function numeroAR(entrada: string): string | null {
  let d = entrada.replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("549")) d = d.slice(3);
  else if (d.startsWith("54")) d = d.slice(2);
  if (d.startsWith("0")) d = d.slice(1);
  return d.length === 10 ? "549" + d : null;
}

async function panelContacto(numero: string, nombre: string, localidad: string, saludar: boolean) {
  const usuario = numeroAR(numero);
  if (!usuario) {
    return respuesta({ error: "Revisá el número: código de área sin el 0 y el número sin el 15, por ejemplo 341 5551234." }, 400);
  }
  if (!nombre) return respuesta({ error: "Poné el nombre." }, 400);
  const { data: hay } = await db.from("walter_conversaciones").select("usuario").eq("canal", "whatsapp").eq("usuario", usuario).maybeSingle();
  if (hay) {
    await db.from("walter_conversaciones").update({ nombre_perfil: nombre, ...(localidad ? { localidad } : {}) })
      .eq("canal", "whatsapp").eq("usuario", usuario);
  } else {
    const { error } = await db.from("walter_conversaciones").insert({
      canal: "whatsapp", usuario, nombre_perfil: nombre, localidad: localidad || null, actualizado: new Date().toISOString(),
    });
    if (error) throw error;
  }
  if (!saludar) return respuesta({ ok: true, usuario, existia: !!hay });

  // Para escribirle primero Meta pide una plantilla aprobada: {{1}} es el nombre
  const plantilla = (await secreto("WA_TEMPLATE_CONTACTO")) || "primer_contacto";
  const motivo = await graphError(`${await secreto("WA_PHONE_ID")}/messages`, await secreto("WA_TOKEN"), {
    messaging_product: "whatsapp", to: usuario, type: "template",
    template: { name: plantilla, language: { code: "es_AR" },
      components: [{ type: "body", parameters: [{ type: "text", text: nombre.split(" ")[0] }] }] },
  });
  if (motivo) return respuesta({ ok: true, usuario, existia: !!hay, saludo: false, motivo });
  await log("whatsapp", usuario, "sale", SALUDO_CONTACTO.replace("{{1}}", nombre.split(" ")[0]), "walter");
  return respuesta({ ok: true, usuario, existia: !!hay, saludo: true });
}

// Walter le devolvió la charla al bot: si lo último es del cliente y quedó sin contestar, el bot lo contesta ya
// (con la charla reciente, que incluye lo que escribió Walter). Una foto o un audio sin texto los sigue viendo Walter.
async function panelPendiente(canal: string, usuario: string) {
  if (canal !== "whatsapp" && canal !== "messenger") return respuesta({ error: "Canal inválido" }, 400);
  const { data: conv } = await db.from("walter_conversaciones").select("nombre_perfil, bot_pausado").eq("canal", canal).eq("usuario", usuario).maybeSingle();
  if (!conv) return respuesta({ error: "No encontramos esa charla." }, 404);
  const { data: ult } = await db.from("walter_mensajes").select("id, direccion, texto").eq("canal", canal).eq("usuario", usuario)
    .order("id", { ascending: false }).limit(1).maybeSingle();
  const etiquetas: string[] = Object.values(ETIQUETA);
  if (conv.bot_pausado || !ult || ult.direccion !== "entra" || etiquetas.includes(String(ult.texto)) || !(await ventanaAbierta(canal, usuario))) {
    return respuesta({ ok: true, contesto: false });
  }
  await responder(canal, usuario, String(ult.texto), true, ult.id, conv.nombre_perfil ?? undefined, true);
  await Promise.allSettled(aparte.splice(0));
  return respuesta({ ok: true, contesto: true });
}

// Pasadas las 24 horas WhatsApp solo deja escribirle con una plantilla aprobada: va el saludo
// (primer_contacto) y, cuando el cliente contesta, Walter le vuelve a escribir libre. La charla queda
// pausada para que conteste Walter y no el bot.
async function panelRetomar(canal: string, usuario: string) {
  if (canal !== "whatsapp") return respuesta({ error: "El saludo para retomar sale solo por WhatsApp." }, 400);
  const { data: conv } = await db.from("walter_conversaciones").select("nombre_perfil").eq("canal", canal).eq("usuario", usuario).maybeSingle();
  if (!conv) return respuesta({ error: "No encontramos esa charla." }, 404);
  if (await ventanaAbierta(canal, usuario)) return respuesta({ error: "La charla sigue abierta: escribile directamente." }, 409);
  // Un saludo por día: si ya salió y el cliente no contestó, otro no suma (y Meta cobra cada uno)
  const { data: ult } = await db.from("walter_mensajes").select("texto, creado").eq("canal", canal).eq("usuario", usuario)
    .order("id", { ascending: false }).limit(1).maybeSingle();
  const yaSaludo = [SALUDO_CONTACTO, SALUDO_RETOMAR].some((x) => String(ult?.texto ?? "").endsWith(x.split("{{1}}")[1]));
  if (ult && yaSaludo && Date.now() - new Date(ult.creado).getTime() < VENTANA) {
    return respuesta({ error: "Ya le mandaste el saludo hoy. Cuando conteste vas a poder escribirle." }, 409);
  }
  const nombre = (nombreDePerfil(conv.nombre_perfil ?? "") ?? "").split(" ")[0] || "de nuevo";
  const phone = await secreto("WA_PHONE_ID"), token = await secreto("WA_TOKEN");
  const plantilla = (name: string) => graphEnviar(`${phone}/messages`, token, {
    messaging_product: "whatsapp", to: usuario, type: "template",
    template: { name, language: { code: "es_AR" }, components: [{ type: "body", parameters: [{ type: "text", text: nombre }] }] },
  });
  // Primero la de retomar; si Meta todavía no la tiene aprobada, el saludo de siempre
  let texto = SALUDO_RETOMAR;
  let { error: motivo, id: waId } = await plantilla((await secreto("WA_TEMPLATE_RETOMAR")) || "retomar_charla");
  if (motivo) {
    console.log("retomar_charla no salió, va primer_contacto:", motivo);
    texto = SALUDO_CONTACTO;
    ({ error: motivo, id: waId } = await plantilla((await secreto("WA_TEMPLATE_CONTACTO")) || "primer_contacto"));
  }
  if (motivo) return respuesta({ error: "WhatsApp no lo aceptó: " + motivo }, 502);
  await log(canal, usuario, "sale", texto.replace("{{1}}", nombre), "walter", undefined, { id: waId });
  await db.from("walter_conversaciones").update({ bot_pausado: true, pide_humano: false, actualizado: new Date().toISOString() })
    .eq("canal", canal).eq("usuario", usuario);
  return respuesta({ ok: true });
}

// Borra pedidos de a uno o varios. Va por acá porque el panel solo puede editar pedidos, no borrarlos.
async function panelBorrarPedidos(ids: unknown) {
  const lista = Array.isArray(ids) ? [...new Set(ids.map(Number).filter((x) => Number.isInteger(x) && x > 0))].slice(0, 500) : [];
  if (!lista.length) return respuesta({ error: "Elegí al menos un pedido." }, 400);
  const { data, error } = await db.from("walter_pedidos").delete().in("id", lista).select("id");
  if (error) throw error;
  return respuesta({ ok: true, borrados: (data ?? []).map((x) => x.id) });
}

// ---------- Perfil de WhatsApp del bot: lo que ve el cliente al tocar el nombre ----------
const CAMPOS_PERFIL = "about,address,description,email,profile_picture_url,websites";
// App de Meta del bot (no es secreta): la subida de la foto se hace a nombre de la app
const APP_ID = env("META_APP_ID", "1087600733886252");

async function panelPerfil() {
  const res = await fetch(`${GRAPH}/${await secreto("WA_PHONE_ID")}/whatsapp_business_profile?fields=${CAMPOS_PERFIL}`, {
    headers: { Authorization: `Bearer ${await secreto("WA_TOKEN")}` },
  });
  const txt = await res.text();
  if (!res.ok) {
    console.error("perfil", res.status, txt);
    return respuesta({ error: "WhatsApp no devolvió el perfil. Probá de nuevo." }, 502);
  }
  const p = JSON.parse(txt).data?.[0] ?? {};
  return respuesta({
    ok: true, foto: p.profile_picture_url ?? null, about: p.about ?? "", description: p.description ?? "",
    address: p.address ?? "", email: p.email ?? "", website: p.websites?.[0] ?? "",
  });
}

async function panelPerfilGuardar(b: Record<string, unknown>) {
  const texto = (k: string) => String(b[k] ?? "").trim();
  const about = texto("about"), description = texto("description"), address = texto("address");
  const email = texto("email"), website = texto("website");
  if (about.length > 139) return respuesta({ error: "La frase corta va hasta 139 letras." }, 400);
  if (description.length > 512) return respuesta({ error: "La descripción va hasta 512 letras." }, 400);
  if (address.length > 256) return respuesta({ error: "La dirección va hasta 256 letras." }, 400);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return respuesta({ error: "Revisá el email." }, 400);
  if (website && !/^https?:\/\/\S+\.\S+/.test(website)) return respuesta({ error: "La web tiene que empezar con https://" }, 400);

  // Meta no deja vaciar los campos: se manda solo lo que tiene algo
  const datos: Record<string, unknown> = { messaging_product: "whatsapp" };
  if (about) datos.about = about;
  if (description) datos.description = description;
  if (address) datos.address = address;
  if (email) datos.email = email;
  if (website) datos.websites = [website];

  if (typeof b.foto === "string" && b.foto) {
    const m = b.foto.match(/^data:image\/(jpeg|png);base64,(.+)$/);
    if (!m) return respuesta({ error: "La foto tiene que ser JPG o PNG." }, 400);
    const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    if (bytes.length > 5 * 1024 * 1024) return respuesta({ error: "La foto pesa demasiado (hasta 5 MB)." }, 400);
    const h = await subirFoto(bytes, "image/" + m[1]);
    if (!h.handle) return respuesta({ error: "WhatsApp no aceptó la foto: " + h.motivo }, 502);
    datos.profile_picture_handle = h.handle;
  }
  if (Object.keys(datos).length === 1) return respuesta({ error: "No hay nada para guardar." }, 400);

  const motivo = await graphError(`${await secreto("WA_PHONE_ID")}/whatsapp_business_profile`, await secreto("WA_TOKEN"), datos);
  if (motivo) return respuesta({ error: "WhatsApp no lo aceptó: " + motivo }, 502);
  return respuesta({ ok: true });
}

// Subida en dos pasos de Meta: abre una sesión y manda los bytes; devuelve el handle de la foto
async function subirFoto(bytes: Uint8Array, tipo: string): Promise<{ handle?: string; motivo?: string }> {
  const token = await secreto("WA_TOKEN");
  const s = await fetch(`${GRAPH}/${APP_ID}/uploads?file_length=${bytes.length}&file_type=${encodeURIComponent(tipo)}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}` },
  });
  const sj = await s.json().catch(() => ({}));
  if (!s.ok || !sj.id) {
    console.error("foto sesion", s.status, JSON.stringify(sj));
    return { motivo: sj.error?.message ?? "no se pudo empezar la subida" };
  }
  const u = await fetch(`${GRAPH}/${sj.id}`, {
    method: "POST", headers: { Authorization: `OAuth ${token}`, file_offset: "0", "Content-Type": tipo }, body: bytes as BodyInit,
  });
  const uj = await u.json().catch(() => ({}));
  if (!u.ok || !uj.h) {
    console.error("foto subida", u.status, JSON.stringify(uj));
    return { motivo: uj.error?.message ?? "no se pudo subir" };
  }
  return { handle: uj.h };
}

// ---------- La hoja de ruta, al WhatsApp de Walter ----------
// La arma el panel (paradas en orden, montos, link de Maps) y se la manda a su número personal
// (Precios y ajustes › Tu WhatsApp). Si él escribió al bot en las últimas 24 horas va el detalle
// directo; si no, la plantilla hoja_ruta con el botón VER_PARADAS, y al tocarlo le llega el detalle.
const VER_PARADAS = "Ver las paradas";

async function panelEnviarRuta(b: Record<string, unknown>) {
  const dia = String(b.dia ?? ""), turno = String(b.turno ?? "");
  const texto = String(b.texto ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia) || !["Mañana", "Tarde"].includes(turno)) return respuesta({ error: "Elegí el día y el turno." }, 400);
  if (!texto || texto.length > 4000) return respuesta({ error: "La hoja de ruta es demasiado larga para un mensaje." }, 400);
  const cfg = await config() as Config & { waWalter?: string };
  const numero = numeroAR(cfg.waWalter ?? "");
  if (!numero) return respuesta({ error: "Cargá tu WhatsApp en Precios y ajustes para que te llegue la hoja de ruta.", falta_numero: true }, 400);
  const { data: fila, error } = await db.from("walter_rutas").update({ texto, enviada: null })
    .eq("dia", dia).eq("turno", turno).select("dia").maybeSingle();
  if (error) throw error;
  if (!fila) return respuesta({ error: "Primero aprobá la hoja de ruta." }, 404);

  const phone = await secreto("WA_PHONE_ID"), token = await secreto("WA_TOKEN");
  if (await ventanaAbierta("whatsapp", numero)) {
    const motivo = await graphError(`${phone}/messages`, token, { messaging_product: "whatsapp", to: numero, type: "text", text: { body: texto } });
    if (motivo) return respuesta({ error: "WhatsApp no lo aceptó: " + motivo }, 502);
    await db.from("walter_rutas").update({ enviada: new Date().toISOString() }).eq("dia", dia).eq("turno", turno);
    return respuesta({ ok: true, como: "detalle" });
  }
  // Plantilla aprobada en Meta con 3 variables: {{1}} cuándo, {{2}} paradas, {{3}} efectivo; botón "Ver las paradas"
  const r = (b.resumen ?? {}) as Record<string, unknown>;
  const params = [String(r.cuando ?? dia), String(r.paradas ?? ""), String(r.efectivo ?? "")]
    .map((x) => x.replace(/\s+/g, " ").trim().slice(0, 60) || "-");
  const motivo = await graphError(`${phone}/messages`, token, {
    messaging_product: "whatsapp", to: numero, type: "template",
    template: { name: (await secreto("WA_TEMPLATE_RUTA")) || "hoja_ruta", language: { code: "es_AR" },
      components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }] },
  });
  if (motivo) {
    return respuesta({ error: "No te la pude mandar: Meta todavía no aprobó el mensaje de la hoja de ruta. " +
      "Mientras tanto, mandale cualquier mensaje al bot desde tu WhatsApp y volvé a tocar \"Mandármela por WhatsApp\". (" + motivo + ")" }, 502);
  }
  return respuesta({ ok: true, como: "plantilla" });
}

// La última hoja aprobada que todavía no le llegó: true si se la mandó (y entonces el bot no contesta ese botón)
async function mandarRutaPendiente(usuario: string): Promise<boolean> {
  const cfg = await config() as Config & { waWalter?: string };
  if (numeroAR(cfg.waWalter ?? "") !== usuario) return false;
  const { data: r } = await db.from("walter_rutas").select("dia, turno, texto, enviada").not("texto", "is", null)
    .order("aprobada", { ascending: false }).limit(1).maybeSingle();
  if (!r?.texto) return false;
  const motivo = await graphError(`${await secreto("WA_PHONE_ID")}/messages`, await secreto("WA_TOKEN"),
    { messaging_product: "whatsapp", to: usuario, type: "text", text: { body: r.texto } });
  if (motivo) return false;
  await db.from("walter_rutas").update({ enviada: new Date().toISOString() }).eq("dia", r.dia).eq("turno", r.turno);
  return true;
}

// ---------- Uso del mes (pestaña Uso del panel) ----------
// Lo que pasó en las charlas sale de la base; lo que cobró Meta, de pricing_analytics de la cuenta de WhatsApp;
// la IA, de walter_uso, con el precio de Haiku por millón de tokens.
const PRECIO_IA = { entrada: 0.10, salida: 0.50 }; // USD por millón de tokens (claude-haiku-5-5, prompts cortos)
const PRECIO_TRANSCRIPCION = 0.04 / 3600;           // USD por segundo (Groq whisper-large-v3-turbo)

async function panelUso() {
  const { hoy } = ahoraAR();
  const desde = hoy.slice(0, 8) + "01";
  // Medianoche de Argentina (UTC-3) del primer día del mes
  const inicio = new Date(desde + "T03:00:00Z");
  const cuenta = (q: PromiseLike<{ count: number | null }>) => Promise.resolve(q).then((x) => x.count ?? 0);

  const [entran, bot, walter, pedidos, charlasMes, uso, meta] = await Promise.all([
    cuenta(db.from("walter_mensajes").select("id", { count: "exact", head: true }).eq("direccion", "entra").gte("creado", inicio.toISOString())),
    cuenta(db.from("walter_mensajes").select("id", { count: "exact", head: true }).eq("direccion", "sale").neq("autor", "walter").gte("creado", inicio.toISOString())),
    cuenta(db.from("walter_mensajes").select("id", { count: "exact", head: true }).eq("direccion", "sale").eq("autor", "walter").gte("creado", inicio.toISOString())),
    cuenta(db.from("walter_pedidos").select("id", { count: "exact", head: true }).gte("creado", inicio.toISOString())),
    charlasDelMes(inicio),
    db.from("walter_uso").select("servicio, llamadas, entrada, salida").gte("dia", desde),
    usoMeta(inicio),
  ]);

  let ia = { llamadas: 0, entrada: 0, salida: 0 }, audios = { llamadas: 0, segundos: 0 };
  for (const u of uso.data ?? []) {
    if (u.servicio === "ia") ia = { llamadas: ia.llamadas + u.llamadas, entrada: ia.entrada + Number(u.entrada), salida: ia.salida + Number(u.salida) };
    if (u.servicio === "transcripcion") audios = { llamadas: audios.llamadas + u.llamadas, segundos: audios.segundos + Number(u.entrada) };
  }
  const usdIa = (ia.entrada * PRECIO_IA.entrada + ia.salida * PRECIO_IA.salida) / 1e6;
  return respuesta({
    ok: true, desde, hasta: hoy,
    charlas: charlasMes, mensajes: { entran, bot, walter }, pedidos,
    ia: { ...ia, usd: usdIa },
    audios: { ...audios, usd: audios.segundos * PRECIO_TRANSCRIPCION },
    meta,
  });
}

// Clientes distintos que escribieron este mes (de a 1000 filas: alcanza para meses de varios miles de mensajes)
async function charlasDelMes(inicio: Date): Promise<number> {
  const vistos = new Set<string>();
  for (let desde = 0; desde < 20000; desde += 1000) {
    const { data } = await db.from("walter_mensajes").select("canal, usuario").eq("direccion", "entra")
      .gte("creado", inicio.toISOString()).order("id").range(desde, desde + 999);
    for (const m of data ?? []) vistos.add(m.canal + "|" + m.usuario);
    if (!data || data.length < 1000) break;
  }
  return vistos.size;
}

// Lo que Meta cobró en el mes: mensajes y costo por categoría. null si Meta no lo devuelve.
async function usoMeta(inicio: Date) {
  try {
    const waba = (await secreto("WA_WABA_ID")) || "2197920554457216";
    const s = Math.floor(inicio.getTime() / 1000), e = Math.floor(Date.now() / 1000);
    const campos = `pricing_analytics.start(${s}).end(${e}).granularity(DAILY).dimensions(["PRICING_CATEGORY","PRICING_TYPE"])`;
    const res = await fetch(`${GRAPH}/${waba}?fields=${encodeURIComponent(campos)}`, {
      headers: { Authorization: `Bearer ${await secreto("WA_TOKEN")}` }, signal: AbortSignal.timeout(8000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { console.error("uso meta", res.status, JSON.stringify(j).slice(0, 300)); return null; }
    const puntos = (j.pricing_analytics?.data ?? []).flatMap((d: { data_points?: unknown[] }) => d.data_points ?? []) as
      { volume?: number; cost?: number; pricing_category?: string; pricing_type?: string }[];
    const cat: Record<string, { mensajes: number; costo: number }> = {};
    let mensajes = 0, cobrados = 0, costo = 0;
    for (const p of puntos) {
      const k = String(p.pricing_category ?? "OTRO");
      cat[k] ??= { mensajes: 0, costo: 0 };
      cat[k].mensajes += p.volume ?? 0;
      cat[k].costo += p.cost ?? 0;
      mensajes += p.volume ?? 0;
      costo += p.cost ?? 0;
      if (p.pricing_type === "REGULAR") cobrados += p.volume ?? 0;
    }
    return { mensajes, cobrados, costo, categorias: cat, moneda: "ARS" };
  } catch (e) {
    console.error("uso meta", e);
    return null;
  }
}

// ---------- Avisos al celular o la compu de Walter (Web Push), aunque el panel esté cerrado ----------
// El panel se suscribe con "Activar avisos" (walter_push, schema/72) y el service worker del sitio (/sw.js)
// muestra el aviso. Las claves VAPID van en el secreto VAPID_KEYS (las JWK que exporta @negrel/webpush).
let servidorPush: Promise<webpush.ApplicationServer | null> | null = null;
function push() {
  servidorPush ??= (async () => {
    const jwk = await secreto("VAPID_KEYS");
    if (!jwk) return null;
    const vapidKeys = await webpush.importVapidKeys(JSON.parse(jwk), { extractable: false });
    return await webpush.ApplicationServer.new({ contactInformation: "mailto:administracion@bruwaltech.com", vapidKeys });
  })().catch((e) => { console.error("push claves", e); servidorPush = null; return null; });
  return servidorPush;
}

async function clavePush(): Promise<string | null> {
  const jwk = await secreto("VAPID_KEYS");
  if (!jwk) return null;
  return await webpush.exportApplicationServerKey(await webpush.importVapidKeys(JSON.parse(jwk), { extractable: true }));
}

/** Avisa a todos los aparatos donde Walter activó los avisos. Los que ya no existen se borran. */
async function avisarWalter(canal: Canal, usuario: string, texto: string, nombrePerfil?: string, media?: Media) {
  try {
    const app = await push();
    if (!app) return;
    const { data: subs } = await db.from("walter_push").select("endpoint, p256dh, auth");
    if (!subs?.length) return;
    let titulo = nombrePerfil;
    if (!titulo) {
      const { data: c } = await db.from("walter_conversaciones").select("nombre_perfil").eq("canal", canal).eq("usuario", usuario).maybeSingle();
      titulo = c?.nombre_perfil ?? (canal === "whatsapp" ? "+" + usuario : "Cliente de Messenger");
    }
    const cuerpo = media && Object.values(ETIQUETA).includes(texto)
      ? "Mandó " + ({ imagen: "una foto", audio: "un audio", video: "un video", documento: "un archivo", sticker: "un sticker" }[media.tipo])
      : texto.slice(0, 180);
    const aviso = JSON.stringify({ title: titulo, body: cuerpo, tag: `${canal}:${usuario}`, url: `/chat?charla=${canal}:${usuario}` });
    await Promise.all(subs.map(async (s) => {
      try {
        // Sin Topic: Apple lo rechaza (400 BadWebPushTopic). Los avisos de una misma charla se agrupan por el tag.
        await app.subscribe({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } })
          .pushTextMessage(aviso, { ttl: 6 * 3600, urgency: webpush.Urgency.High });
      } catch (e) {
        // 404 o 410: el aparato se dio de baja (desinstaló, borró los datos del sitio)
        if (e instanceof webpush.PushMessageError && e.isGone()) await db.from("walter_push").delete().eq("endpoint", s.endpoint);
        // Apple y Google dicen el motivo en el cuerpo ({"reason": "BadJwtToken"}, por ejemplo)
        else console.error("push", e instanceof webpush.PushMessageError ? e.toString() + " " + (await e.response.text().catch(() => "")).slice(0, 300) : e);
      }
    }));
  } catch (e) {
    console.error("avisar walter", e);
  }
}

async function panelPushAlta(b: Record<string, unknown>, userId: string) {
  const s = (b.sub ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = typeof s.endpoint === "string" && /^https:\/\/[\w.-]+\//.test(s.endpoint) ? s.endpoint : null;
  const p256dh = typeof s.keys?.p256dh === "string" ? s.keys.p256dh : null;
  const auth = typeof s.keys?.auth === "string" ? s.keys.auth : null;
  if (!endpoint || !p256dh || !auth || endpoint.length > 1000) return respuesta({ error: "El navegador no dio una suscripción válida." }, 400);
  const { error } = await db.from("walter_push").upsert({ endpoint, p256dh, auth, user_id: userId, aparato: String(b.aparato ?? "").slice(0, 120) });
  if (error) throw error;
  return respuesta({ ok: true });
}
