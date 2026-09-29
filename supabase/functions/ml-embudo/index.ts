import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Embudo de conversión por publicación de Mercado Libre.
//
// Cruza las VISITAS que da ML con las VENTAS que ya tenemos en
// store_ml_ordenes, y guarda el resultado en store_ml_embudo.
//
// Para qué sirve el cruce, que es lo que ninguno de los dos números dice
// solo:
//   · visitas y ninguna venta      -> el problema es precio, foto o ficha.
//                                     Meterle Ads ahí es tirar la plata.
//   · convierte bien, pocas visitas -> ESA es la que conviene publicitar.
//
// El token de ML nunca sale del servidor.
// Requiere secrets: ML_CLIENT_ID y ML_CLIENT_SECRET.
//
// Desplegar:
//   supabase functions deploy ml-embudo --project-ref qduguqazpxjjpxjfnkif

const ML = "https://api.mercadolibre.com";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Una orden cancelada no es una conversión. Contarla infla el número justo
// en las publicaciones con más problemas, que son las que más cancelan.
const NO_CUENTAN = new Set(["cancelled", "invalid"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 1) Quién llama
    const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: u, error: uErr } = await admin.auth.getUser(jwt);
    if (uErr || !u?.user) return json({ error: "No autenticado" }, 401);

    // 2) Tienda y ventana, verificando que la tienda sea del usuario
    let slug: string | undefined, dias = 30;
    try {
      const body = await req.json();
      slug = body?.store_slug;
      // Se acota a mano: una ventana enorme hace que ML tarde una eternidad
      // y el dato no sirve para decidir nada.
      if (Number(body?.dias) > 0) dias = Math.min(90, Math.max(1, Math.round(Number(body.dias))));
    } catch { /* body vacío */ }

    let q = admin.from("store_profiles").select("slug").eq("user_id", u.user.id);
    if (slug) q = q.eq("slug", slug);
    const { data: tiendas } = await q;
    const tienda = tiendas?.[0]?.slug;
    if (!tienda) return json({ error: "Tienda no encontrada para este usuario" }, 403);

    // 3) Cuenta de ML y refresco del token si está por vencer
    const { data: cuenta } = await admin.from("store_ml_cuenta").select("*").eq("store_slug", tienda).maybeSingle();
    if (!cuenta) return json({ error: "La tienda no tiene Mercado Libre conectado" }, 404);

    let token: string = cuenta.access_token;
    if (new Date(cuenta.expira_en).getTime() - Date.now() < 5 * 60 * 1000) {
      const cid = Deno.env.get("ML_CLIENT_ID"), csec = Deno.env.get("ML_CLIENT_SECRET");
      if (!cid || !csec) return json({ error: "Token vencido y faltan los secrets ML_CLIENT_ID / ML_CLIENT_SECRET" }, 500);
      const r = await fetch(`${ML}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "refresh_token", client_id: cid, client_secret: csec,
          refresh_token: cuenta.refresh_token,
        }),
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

    // 4) Las publicaciones ACTIVAS, no las que vendieron.
    //
    // Esto importa: si la lista saliera de las ventas, las publicaciones
    // que no venden nada -- que son exactamente las que hay que encontrar --
    // no aparecerían nunca.
    const ids: string[] = [];
    for (let off = 0; off < 2000; off += 100) {
      const r = await fetch(`${ML}/users/${cuenta.ml_user_id}/items/search?status=active&limit=100&offset=${off}`, H);
      const d = await r.json();
      if (!r.ok) return json({ error: "Error de ML al listar publicaciones", detalle: d?.message }, 502);
      ids.push(...(d.results || []));
      if (!d.results?.length || ids.length >= (d.paging?.total ?? 0)) break;
    }
    if (!ids.length) return json({ ok: true, tienda, dias, publicaciones: 0, aviso: "La cuenta no tiene publicaciones activas." });

    const hasta = new Date();
    const desde = new Date(hasta.getTime() - dias * 86400000);

    // 5) Visitas por publicación.
    //
    // ML devolvió este endpoint con DOS formas distintas segun la version:
    // un objeto { "MLA123": 45 } y un array [{ item_id, total_visits }].
    // Se aceptan las dos en vez de apostar a una: si mañana cambia, esto
    // sigue andando en lugar de devolver todo en cero sin avisar.
    const visitas: Record<string, number> = {};
    for (let i = 0; i < ids.length; i += 20) {
      const lote = ids.slice(i, i + 20);
      const url = `${ML}/visits/items?ids=${lote.join(",")}` +
                  `&date_from=${desde.toISOString()}&date_to=${hasta.toISOString()}`;
      const r = await fetch(url, H);
      if (!r.ok) continue;                       // sin visitas de ese lote, el resto sigue
      const d = await r.json();

      if (Array.isArray(d)) {
        for (const v of d) {
          const id = v?.item_id ?? v?.id;
          if (id) visitas[id] = Number(v.total_visits ?? v.visits ?? 0) || 0;
        }
      } else if (d && typeof d === "object") {
        for (const [id, v] of Object.entries(d)) {
          visitas[id] = typeof v === "number" ? v : Number((v as any)?.total_visits ?? 0) || 0;
        }
      }
    }

    // 6) Títulos
    const titulos: Record<string, string> = {};
    for (let i = 0; i < ids.length; i += 20) {
      const r = await fetch(`${ML}/items?ids=${ids.slice(i, i + 20).join(",")}&attributes=id,title`, H);
      if (!r.ok) continue;
      for (const it of await r.json()) if (it?.body?.id) titulos[it.body.id] = it.body.title;
    }

    // 7) Ventas, de lo que YA tenemos guardado. No se le vuelve a preguntar
    //    a ML por algo que ya está en nuestra base.
    const { data: ordenes } = await admin
      .from("store_ml_ordenes")
      .select("estado, detalle, creado_en")
      .eq("store_slug", tienda)
      .limit(5000);

    const ventas: Record<string, { ventas: number; unidades: number; facturado: number }> = {};
    for (const o of ordenes || []) {
      if (NO_CUENTAN.has(String(o.estado || "").toLowerCase())) continue;

      // La fecha de la ORDEN, no la de cuando la guardamos: si alguna vez
      // se hace una carga masiva hacia atrás, creado_en sería el día de la
      // carga y metería ventas viejas dentro de la ventana.
      const cuando = Date.parse(o.detalle?.date_created || o.creado_en || "");
      if (isNaN(cuando) || cuando < desde.getTime()) continue;

      const vistos = new Set<string>();
      for (const li of o.detalle?.order_items || []) {
        const id = li?.item?.id;
        if (!id) continue;
        if (!ventas[id]) ventas[id] = { ventas: 0, unidades: 0, facturado: 0 };
        // Una orden con 3 potes es UNA conversión, no tres. Por eso las
        // órdenes se cuentan una sola vez por publicación y las unidades
        // van aparte.
        if (!vistos.has(id)) { ventas[id].ventas += 1; vistos.add(id); }
        ventas[id].unidades += Number(li.quantity) || 0;
        ventas[id].facturado += (Number(li.unit_price) || 0) * (Number(li.quantity) || 0);
      }
    }

    // 8) Guardar. La conversión la calcula la base.
    const hoy = new Date().toISOString().slice(0, 10);
    const filas = ids.map((id) => ({
      store_slug: tienda,
      ml_item_id: id,
      dias,
      fecha_corte: hoy,
      titulo: titulos[id] ?? null,
      visitas: visitas[id] ?? 0,
      ventas: ventas[id]?.ventas ?? 0,
      unidades: ventas[id]?.unidades ?? 0,
      facturado: ventas[id]?.facturado ?? 0,
      actualizado_en: new Date().toISOString(),
    }));

    for (let i = 0; i < filas.length; i += 500) {
      const { error } = await admin.from("store_ml_embudo").upsert(filas.slice(i, i + 500));
      if (error) return json({ error: "Error guardando el embudo", detalle: error.message }, 500);
    }

    const conVisitas = filas.filter((f) => f.visitas > 0).length;
    return json({
      ok: true,
      tienda,
      dias,
      publicaciones: filas.length,
      con_visitas: conVisitas,
      // Si ML no devolvió visitas de ninguna, es un problema del endpoint y
      // no del negocio: hay que decirlo, no mostrar una tabla de ceros.
      aviso: conVisitas === 0
        ? "Mercado Libre no devolvió visitas para ninguna publicación. Puede ser que el endpoint haya cambiado."
        : null,
    });
  } catch (e) {
    return json({ error: "Error inesperado", detalle: String(e) }, 500);
  }
});
