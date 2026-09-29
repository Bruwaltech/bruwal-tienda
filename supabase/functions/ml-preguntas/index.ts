import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Sincroniza las preguntas de compradores de Mercado Libre de una tienda
// hacia public.store_ml_preguntas. El token de ML nunca sale del servidor.
// Requiere secrets: ML_CLIENT_ID y ML_CLIENT_SECRET (para refrescar el token).
//
// ----------------------------------------------------------------------
// ESTA ES LA COPIA VERSIONADA de la funcion que ya corre en produccion
// (slug ml-preguntas, verify_jwt = true, bajada de la base el 2026-09-29).
//
// Para desplegar cambios:
//   supabase functions deploy ml-preguntas --project-ref qduguqazpxjjpxjfnkif
//
// OJO: si alguien la edita desde el panel de Supabase, esta copia queda
// vieja sin que nadie se entere. Antes de tocarla conviene bajarla:
//   supabase functions download ml-preguntas --project-ref qduguqazpxjjpxjfnkif
// ----------------------------------------------------------------------

const ML = "https://api.mercadolibre.com";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // 1) Quién llama (JWT del usuario logueado en Bruwal)
    const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: u, error: uErr } = await admin.auth.getUser(jwt);
    if (uErr || !u?.user) return json({ error: "No autenticado" }, 401);

    // 2) Tienda: la indicada en el body, verificando que sea del usuario
    let slug: string | undefined;
    try { slug = (await req.json())?.store_slug; } catch { /* body vacío */ }
    let q = admin.from("store_profiles").select("slug").eq("user_id", u.user.id);
    if (slug) q = q.eq("slug", slug);
    const { data: tiendas } = await q;
    const tienda = tiendas?.[0]?.slug;
    if (!tienda) return json({ error: "Tienda no encontrada para este usuario" }, 403);

    // 3) Cuenta ML y refresco del token si venció
    const { data: cuenta } = await admin.from("store_ml_cuenta").select("*").eq("store_slug", tienda).maybeSingle();
    if (!cuenta) return json({ error: "La tienda no tiene Mercado Libre conectado" }, 404);
    let token: string = cuenta.access_token;
    if (new Date(cuenta.expira_en).getTime() - Date.now() < 5 * 60 * 1000) {
      const cid = Deno.env.get("ML_CLIENT_ID"), csec = Deno.env.get("ML_CLIENT_SECRET");
      if (!cid || !csec) return json({ error: "Token vencido y faltan los secrets ML_CLIENT_ID / ML_CLIENT_SECRET" }, 500);
      const r = await fetch(`${ML}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: cid, client_secret: csec, refresh_token: cuenta.refresh_token }),
      });
      const t = await r.json();
      if (!r.ok || !t.access_token) return json({ error: "No se pudo refrescar el token de ML", detalle: t?.message || t?.error }, 502);
      token = t.access_token;
      await admin.from("store_ml_cuenta").update({
        access_token: t.access_token,
        refresh_token: t.refresh_token ?? cuenta.refresh_token,
        expira_en: new Date(Date.now() + (t.expires_in ?? 21600) * 1000).toISOString(),
        actualizado_en: new Date().toISOString(),
      }).eq("store_slug", tienda);
    }
    const H = { headers: { Authorization: `Bearer ${token}` } };

    // 4) Todas las preguntas del vendedor (paginado de a 50)
    const preguntas: any[] = [];
    for (let off = 0; off < 5000; off += 50) {
      const r = await fetch(`${ML}/questions/search?seller_id=${cuenta.ml_user_id}&api_version=4&limit=50&offset=${off}`, H);
      const d = await r.json();
      if (!r.ok) return json({ error: "Error de ML al traer preguntas", detalle: d?.message, traidas: preguntas.length }, 502);
      preguntas.push(...(d.questions || []));
      if (!d.questions?.length || off + 50 >= (d.total ?? 0)) break;
    }

    // 5) Títulos de las publicaciones (multiget de a 20)
    const ids = [...new Set(preguntas.map((p) => p.item_id))];
    const titulos: Record<string, string> = {};
    for (let i = 0; i < ids.length; i += 20) {
      const r = await fetch(`${ML}/items?ids=${ids.slice(i, i + 20).join(",")}&attributes=id,title`, H);
      if (!r.ok) continue;
      for (const it of await r.json()) if (it?.body?.id) titulos[it.body.id] = it.body.title;
    }

    // 6) Guardar
    const filas = preguntas.map((p) => ({
      ml_question_id: String(p.id),
      store_slug: tienda,
      ml_item_id: p.item_id,
      titulo_item: titulos[p.item_id] ?? null,
      fecha: p.date_created,
      pregunta: p.text,
      respuesta: p.answer?.text ?? null,
      estado: p.status,
      sincronizado_en: new Date().toISOString(),
    }));
    for (let i = 0; i < filas.length; i += 500) {
      const { error } = await admin.from("store_ml_preguntas").upsert(filas.slice(i, i + 500));
      if (error) return json({ error: "Error guardando preguntas", detalle: error.message }, 500);
    }

    return json({ ok: true, tienda, preguntas: filas.length, publicaciones: ids.length });
  } catch (e) {
    return json({ error: "Error inesperado", detalle: String(e) }, 500);
  }
});
