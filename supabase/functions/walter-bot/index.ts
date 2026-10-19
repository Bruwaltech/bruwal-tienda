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
import { conPerfil, type Config, esSaludo, type Estado, hechos, juntar, nombreDePerfil, norm, procesar, procesarConLectura, type Respuesta } from "./bot.ts";
import { contestar, leer, redactar } from "./ia.ts";

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
    return panel(req);
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
        if (texto) tareas.push(atender("whatsapp", m.from, texto, m.type === "text", nombres[m.from]));
        else if (md?.id) {
          tareas.push(recibirMedia("whatsapp", m.from, { tipo: MEDIA[m.type], id: md.id, mime: md.mime_type, caption: md.caption, archivo: md.filename }, nombres[m.from]));
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
  const todo = Promise.allSettled(tareas);
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
async function atender(canal: Canal, usuario: string, texto: string, libre: boolean, nombrePerfil?: string, media?: Media) {
  try {
    const id = await log(canal, usuario, "entra", texto, undefined, media);
    // "Hola" y "Buenas" seguidos (o un "Hola" justo después de otro mensaje): contesta solo el primero.
    // Si llegan juntos, el de id menor.
    if (esSaludo(texto) && id) {
      const { count } = await db.from("walter_mensajes").select("id", { count: "exact", head: true })
        .eq("canal", canal).eq("usuario", usuario).eq("direccion", "entra").lt("id", id)
        .gte("creado", new Date(Date.now() - 60e3).toISOString());
      if (count) return;
    }
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
      await db.from("walter_conversaciones").upsert({
        canal, usuario, pide_humano: true, actualizado: new Date().toISOString(), ...(nombrePerfil ? { nombre_perfil: nombrePerfil } : {}),
      });
      return;
    }

    // Mensajes seguidos ("hola" / "tengo cobre" / "en Funes"): esperamos un poco y contesta solo el
    // último. Los anteriores sin respuesta van en la charla reciente, y la IA los lee aunque el último sea un botón.
    if (id) {
      await new Promise((r) => setTimeout(r, ESPERA_SEGUIDOS));
      const { data: nuevos } = await db.from("walter_mensajes").select("texto")
        .eq("canal", canal).eq("usuario", usuario).eq("direccion", "entra").gt("id", id);
      // Un "hola" o una foto sin texto que llegan después no contestan esto: en ese caso contesta este
      const etiquetas: string[] = Object.values(ETIQUETA);
      if ((nuevos ?? []).some((m) => !esSaludo(String(m.texto)) && !etiquetas.includes(String(m.texto)))) return;
      if (await sinRespuesta(canal, usuario, id)) libre = true;
    }

    // Respuesta al aviso del día o al recordatorio de retiro (SÍ / NO)
    const n = norm(texto);
    if (/^(si|no|dale|ok|okey|perfecto|listo|joya|de una|confirmo)\b/.test(n)) {
      const { data: p } = await db.from("walter_pedidos").select("id").eq("canal", canal).eq("usuario", usuario)
        .or("aviso_enviado.not.is.null,aviso_dia.eq.enviado").is("respuesta_aviso", null)
        .order("dia", { ascending: false }).limit(1).maybeSingle();
      if (p) {
        const si = !n.startsWith("no");
        await db.from("walter_pedidos").update({ respuesta_aviso: si ? "confirmó" : "no puede" }).eq("id", p.id);
        return enviar(canal, usuario, [{
          text: si ? "¡Gracias! Te esperamos. 👍" : "Gracias por avisar. Le paso a Walter para coordinar otro día.",
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
        retiro: p.ret, direccion: p.dir, monto: p.monto, tarifa: p.tarifa, prioridad: p.prioridad,
      });
    }
    // Hizo una pregunta: la respuesta va antes de la pregunta en la que estábamos. Si la IA no
    // puede contestarla con lo que sabe el negocio, le avisamos a Walter.
    if (r.consulta) {
      const resp = await contestar(clave, texto, hechos(cfg), charla);
      r.respuestas.splice(Math.max(0, r.respuestas.length - 1), 0, { text: resp ?? "Eso te lo confirma Walter, ya le aviso." });
      if (!resp) await db.from("walter_conversaciones").update({ pide_humano: true }).eq("canal", canal).eq("usuario", usuario);
    }
    // El bot arma qué decir y con qué números; Haiku lo dice como lo diría una persona
    await enviar(canal, usuario, await redactar(clave, texto, juntar(r.respuestas), charla));
  } catch (e) {
    console.error("atender", canal, usuario, e);
  }
}

// Cuánto espera el bot por si el cliente manda otro mensaje enseguida
const ESPERA_SEGUIDOS = 5000;

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

// Los últimos mensajes antes del actual, del más viejo al más nuevo
async function charlaReciente(canal: Canal, usuario: string, hastaId: number): Promise<string> {
  const { data } = await db.from("walter_mensajes").select("direccion, autor, texto").eq("canal", canal).eq("usuario", usuario)
    .lt("id", hastaId).gte("creado", new Date(Date.now() - 2 * 86400e3).toISOString()).order("id", { ascending: false }).limit(8);
  return (data ?? []).reverse()
    .map((m) => `${m.direccion === "entra" ? "Cliente" : m.autor === "walter" ? "Walter" : "Bot"}: ${String(m.texto).slice(0, 300)}`).join("\n");
}

async function enviar(canal: Canal, usuario: string, respuestas: Respuesta[]) {
  for (const r of respuestas) {
    await log(canal, usuario, "sale", r.text, "bot");
    const opts = (r.options ?? []).slice(0, canal === "whatsapp" ? 10 : 13);
    if (canal === "whatsapp") {
      // WhatsApp muestra hasta 3 botones; con más opciones (los tipos de moneda) va una lista
      const msg = !opts.length ? { type: "text", text: { body: r.text } }
        : opts.length <= 3
        ? { type: "interactive", interactive: { type: "button", body: { text: r.text.slice(0, 1024) },
            action: { buttons: opts.map((t, i) => ({ type: "reply", reply: { id: "op" + i, title: t.slice(0, 20) } })) } } }
        : { type: "interactive", interactive: { type: "list", body: { text: r.text.slice(0, 1024) },
            action: { button: "Elegir", sections: [{ title: "Opciones", rows: opts.map((t, i) => ({ id: "op" + i, title: t.slice(0, 24) })) }] } } };
      await graph(`${await secreto("WA_PHONE_ID")}/messages`, await secreto("WA_TOKEN"), { messaging_product: "whatsapp", to: usuario, ...msg });
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
  const res = await fetch(`${GRAPH}/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  if (res.ok) return null;
  const txt = await res.text();
  console.error("graph", path, res.status, txt);
  try {
    const e = JSON.parse(txt).error;
    return e?.error_data?.details || e?.message || txt;
  } catch {
    return txt;
  }
}

type MediaTipo = "imagen" | "audio" | "video" | "documento" | "sticker";
type Media = { tipo: MediaTipo; path: string | null };

async function log(canal: Canal, usuario: string, direccion: "entra" | "sale", texto: string, autor?: "bot" | "walter", media?: Media): Promise<number | null> {
  const { data } = await db.from("walter_mensajes").insert({
    canal, usuario, direccion, texto, ...(autor ? { autor } : {}), ...(media ? { media_tipo: media.tipo, media_path: media.path } : {}),
  }).select("id").single();
  return data?.id ?? null;
}

// ---------- Fotos, audios y archivos que manda el cliente ----------
const MEDIA: Record<string, MediaTipo> = { image: "imagen", audio: "audio", video: "video", document: "documento", sticker: "sticker" };
// El texto que queda en la charla (y que lee la IA) cuando no viene con epígrafe
const ETIQUETA: Record<MediaTipo, string> = { imagen: "[Foto]", audio: "[Audio]", video: "[Video]", documento: "[Archivo]", sticker: "[Sticker]" };
const RECIBIDO: Partial<Record<MediaTipo, string>> = {
  imagen: "¡Gracias por la foto! Se la paso a Walter para que la vea y te contesta por acá.",
  audio: "¡Gracias por el audio! Todavía no puedo escucharlos: se lo paso a Walter y te contesta por acá. Si preferís, escribime lo que necesitás y te cotizo ya.",
  video: "¡Gracias por el video! Se lo paso a Walter para que lo vea y te contesta por acá.",
  documento: "¡Gracias por el archivo! Se lo paso a Walter y te contesta por acá.",
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
  m: { tipo: MediaTipo; id: string; mime?: string; caption?: string; archivo?: string }, nombrePerfil?: string) {
  try {
    const bajado = await guardarMedia(usuario, m.id, m.mime, m.archivo);
    const media: Media = { tipo: m.tipo, path: bajado?.path ?? null };
    // Con epígrafe ("tengo estas, ¿cuánto me dan?"): el bot lee el texto como cualquier mensaje
    const caption = m.caption?.trim();
    if (caption) return atender(canal, usuario, caption, true, nombrePerfil, media);
    // Un audio se pasa a texto y se contesta como si lo hubiera escrito. Si no se puede, sigue como antes.
    if (m.tipo === "audio" && bajado) {
      const dicho = await transcribir(bajado.bytes, bajado.tipo, bajado.ext);
      if (dicho) return atender(canal, usuario, dicho, true, nombrePerfil, media);
    }

    const id = await log(canal, usuario, "entra", ETIQUETA[m.tipo], undefined, media);
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
      const cuando = g.turno === "Mañana" ? "mañana a la mañana" : "hoy a la tarde";
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
  return enviados + await avisarDia(hoy, manana);
}

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
        text: `¡Hola ${nombre}! Ya tenemos día para pasar a buscar ${que}: ${dia} a la ${String(p.turno).toLowerCase()}. ¿Te queda bien?`,
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
    if (b.accion === "enviar") return await panelEnviar(String(b.canal), String(b.usuario), String(b.texto ?? "").trim());
    if (b.accion === "enviar_foto") return await panelEnviarMedio(String(b.canal), String(b.usuario), "imagen", b.foto, String(b.texto ?? "").trim());
    if (b.accion === "enviar_audio") return await panelEnviarMedio(String(b.canal), String(b.usuario), "audio", b.audio, "");
    if (b.accion === "medios") return await panelMedios(b.paths);
    if (b.accion === "borrar") return await panelBorrar(String(b.canal), String(b.usuario));
    if (b.accion === "contacto") {
      return await panelContacto(String(b.numero ?? ""), String(b.nombre ?? "").trim(), String(b.localidad ?? "").trim(), !!b.saludar);
    }
    if (b.accion === "perfil") return await panelPerfil();
    if (b.accion === "perfil_guardar") return await panelPerfilGuardar(b);
    return respuesta({ error: "Acción desconocida" }, 400);
  } catch (e) {
    console.error("panel", b.accion, e);
    return respuesta({ error: "No se pudo completar. Probá de nuevo." }, 500);
  }
}

async function panelEnviar(canal: string, usuario: string, texto: string) {
  if (canal !== "whatsapp" && canal !== "messenger") return respuesta({ error: "Canal inválido" }, 400);
  if (!texto) return respuesta({ error: "Escribí el mensaje." }, 400);
  if (texto.length > 4000) return respuesta({ error: "El mensaje es muy largo (hasta 4000 letras)." }, 400);
  const { data: conv } = await db.from("walter_conversaciones").select("usuario").eq("canal", canal).eq("usuario", usuario).maybeSingle();
  if (!conv) return respuesta({ error: "No encontramos esa charla." }, 404);

  if (!(await ventanaAbierta(canal, usuario))) return SIN_VENTANA();

  const motivo = canal === "whatsapp"
    ? await graphError(`${await secreto("WA_PHONE_ID")}/messages`, await secreto("WA_TOKEN"),
      { messaging_product: "whatsapp", to: usuario, type: "text", text: { body: texto } })
    : await graphError("me/messages", await secreto("FB_PAGE_TOKEN"),
      { recipient: { id: usuario }, messaging_type: "RESPONSE", message: { text: texto } });
  if (motivo) return respuesta({ error: "WhatsApp no lo aceptó: " + motivo }, 502);

  await log(canal, usuario, "sale", texto, "walter");
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
  audio: { tipos: /^data:(audio\/(?:mpeg|ogg|mp4|aac));base64,(.+)$/, max: 16, nombre: "El audio", formato: "MP3" },
};
const EXT_SALIDA: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/aac": "aac" };

async function panelEnviarMedio(canal: string, usuario: string, tipo: "imagen" | "audio", archivo: unknown, texto: string) {
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
  // El audio no lleva texto: WhatsApp no lo muestra
  const msg = tipo === "imagen"
    ? { type: "image", image: { id: sj.id, ...(texto ? { caption: texto } : {}) } }
    : { type: "audio", audio: { id: sj.id } };
  const motivo = await graphError(`${phone}/messages`, token, { messaging_product: "whatsapp", to: usuario, ...msg });
  if (motivo) return respuesta({ error: "WhatsApp no lo aceptó: " + motivo }, 502);

  const path = `${usuario}/${Date.now()}-walter.${ext}`;
  const { error } = await db.storage.from(BUCKET).upload(path, bytes, { contentType: m[1] });
  if (error) console.error("media salida guardar", error.message);
  await log(canal, usuario, "sale", texto || ETIQUETA[tipo], "walter", { tipo, path: error ? null : path });
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
