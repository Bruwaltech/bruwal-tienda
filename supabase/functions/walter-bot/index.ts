// Edge Function del bot de Walter: webhook de WhatsApp Cloud API y de Messenger,
// y tarea de avisos (?tarea=avisos) que llama pg_cron.
//
// Tablas, claves y cron en schema/62-bot-walter.sql. Desplegar sin verificar JWT
// (Meta no manda uno; la función valida la firma X-Hub-Signature-256):
//   supabase functions deploy walter-bot --no-verify-jwt --project-ref qduguqazpxjjpxjfnkif
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { type Config, type Estado, norm, procesar, type Respuesta } from "./bot.ts";

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

  // 3) Mensajes entrantes
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
        if (texto) tareas.push(atender("whatsapp", m.from, texto, nombres[m.from]));
        else tareas.push(enviar("whatsapp", m.from, [{ text: "Por ahora solo leo mensajes de texto. ¿Me lo escribís?" }]));
      }
    }
  } else if (body.object === "page") {
    for (const entry of body.entry ?? []) for (const ev of entry.messaging ?? []) {
      if (ev.message?.is_echo) continue;
      const texto = ev.message?.quick_reply ? ev.message.text : ev.message?.text ?? ev.postback?.title;
      if (texto && ev.sender?.id) tareas.push(atender("messenger", ev.sender.id, texto));
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

async function atender(canal: Canal, usuario: string, texto: string, nombrePerfil?: string) {
  try {
    await log(canal, usuario, "entra", texto);
    const [cfg, conv] = await Promise.all([
      config(),
      db.from("walter_conversaciones").select("estado, actualizado").eq("canal", canal).eq("usuario", usuario).maybeSingle(),
    ]);
    let estado = (conv.data?.estado ?? null) as Estado | null;
    // Una charla vieja (más de 2 días sin hablar) arranca de cero, con saludo
    if (conv.data && Date.now() - new Date(conv.data.actualizado).getTime() > 2 * 86400e3) estado = null;

    // Respuesta a un aviso de retiro (SÍ / NO)
    const n = norm(texto);
    if (/^(si|no)\b/.test(n)) {
      const { data: p } = await db.from("walter_pedidos").select("id").eq("canal", canal).eq("usuario", usuario)
        .not("aviso_enviado", "is", null).is("respuesta_aviso", null).order("dia", { ascending: false }).limit(1).maybeSingle();
      if (p) {
        const si = n.startsWith("si");
        await db.from("walter_pedidos").update({ respuesta_aviso: si ? "confirmó" : "no puede" }).eq("id", p.id);
        return enviar(canal, usuario, [{
          text: si ? "¡Gracias! Te esperamos. 👍" : "Gracias por avisar. Le paso a Walter para coordinar otro día.",
        }]);
      }
    }

    const r = procesar(estado, texto, cfg);
    await db.from("walter_conversaciones").upsert({
      canal, usuario, estado: r.estado, actualizado: new Date().toISOString(),
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
    await enviar(canal, usuario, r.respuestas);
  } catch (e) {
    console.error("atender", canal, usuario, e);
  }
}

async function enviar(canal: Canal, usuario: string, respuestas: Respuesta[]) {
  for (const r of respuestas) {
    await log(canal, usuario, "sale", r.text);
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
  const res = await fetch(`${GRAPH}/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error("graph", path, res.status, await res.text());
  return res.ok;
}

async function log(canal: Canal, usuario: string, direccion: "entra" | "sale", texto: string) {
  await db.from("walter_mensajes").insert({ canal, usuario, direccion, texto });
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
        await db.from("walter_pedidos").update({ aviso_enviado: new Date().toISOString(), estado: "agendado" }).eq("id", p.id);
      }
    }
  }
  return enviados;
}
