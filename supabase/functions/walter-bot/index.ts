// Edge Function del bot de Walter: webhook de WhatsApp Cloud API y de Messenger,
// tarea de avisos (?tarea=avisos) que llama pg_cron y lo que Walter hace desde
// el panel de Bruwal Chat (?tarea=panel): contestar, borrar charlas, cargar contactos
// y cambiar la foto y los datos del perfil de WhatsApp del bot.
//
// Tablas, claves y cron en schema/62-bot-walter.sql. Desplegar sin verificar JWT
// (Meta no manda uno; la función valida la firma X-Hub-Signature-256):
//   supabase functions deploy walter-bot --no-verify-jwt --project-ref qduguqazpxjjpxjfnkif
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { conPerfil, type Config, esSaludo, type Estado, juntar, nombreDePerfil, norm, procesar, procesarConLectura, type Respuesta } from "./bot.ts";
import { leer, redactar } from "./ia.ts";

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
        if (texto) tareas.push(atender("whatsapp", m.from, texto, m.type === "text", nombres[m.from]));
        else tareas.push(enviar("whatsapp", m.from, [{ text: "Por ahora solo leo mensajes de texto. ¿Me lo escribís?" }]));
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
  await Promise.allSettled(tareas);
  return new Response("ok", { status: 200 }); // Meta reintenta si no recibe 200
});

async function config(): Promise<Config> {
  const { data, error } = await db.from("walter_config").select("data").eq("id", 1).single();
  if (error) throw error;
  return data.data as Config;
}

// libre: el cliente lo escribió (no tocó un botón ni una opción de la lista)
async function atender(canal: Canal, usuario: string, texto: string, libre: boolean, nombrePerfil?: string) {
  try {
    const id = await log(canal, usuario, "entra", texto);
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

    // Walter la está atendiendo desde el panel: el bot guarda el mensaje y no contesta. Si la charla
    // quedó quieta más de 2 días, vuelve a contestar el bot.
    if (conv.data?.bot_pausado && !vieja) {
      await db.from("walter_conversaciones").update({
        pide_humano: true, actualizado: new Date().toISOString(), ...(nombrePerfil ? { nombre_perfil: nombrePerfil } : {}),
      }).eq("canal", canal).eq("usuario", usuario);
      return;
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

    // Lo escrito libremente lo lee Haiku antes, salvo el nombre y la dirección, que se anotan tal cual
    const lectura = libre && !["name", "addr"].includes(estado?.step ?? "")
      ? await leer(await secreto("ANTHROPIC_API_KEY"), texto, estado, cfg) : null;
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
    // El bot arma qué decir y con qué números; Haiku lo dice como lo diría una persona
    await enviar(canal, usuario, await redactar(await secreto("ANTHROPIC_API_KEY"), texto, juntar(r.respuestas)));
  } catch (e) {
    console.error("atender", canal, usuario, e);
  }
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

async function log(canal: Canal, usuario: string, direccion: "entra" | "sale", texto: string, autor?: "bot" | "walter"): Promise<number | null> {
  const { data } = await db.from("walter_mensajes").insert({ canal, usuario, direccion, texto, ...(autor ? { autor } : {}) })
    .select("id").single();
  return data?.id ?? null;
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

  const { data: ult } = await db.from("walter_mensajes").select("creado").eq("canal", canal).eq("usuario", usuario)
    .eq("direccion", "entra").order("id", { ascending: false }).limit(1).maybeSingle();
  if (!ult || Date.now() - new Date(ult.creado).getTime() > VENTANA) {
    return respuesta({
      error: "Pasaron más de 24 horas desde el último mensaje del cliente: WhatsApp no deja escribirle libre hasta que vuelva a escribir.",
      ventana: false,
    }, 409);
  }

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

// Borra la charla y sus mensajes. Los pedidos quedan.
async function panelBorrar(canal: string, usuario: string) {
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
