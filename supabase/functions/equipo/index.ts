import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Usuarios del equipo: cada empleado entra al panel con SU usuario y contraseña.
//
// Las cuentas se crean ACA y no en el navegador porque hace falta la service
// role (crear un usuario ya confirmado, sin mandar mail, y poder bloquearlo).
// Antes de tocar nada se verifica que quien llama sea el DUEÑO de la tienda.
//
// La tabla y las politicas estan en schema/60-equipo-usuarios.sql.
//
// El login del empleado no es un mail: es local + usuario + contraseña. Por
// debajo Supabase necesita un email, asi que se arma uno que nunca recibe
// correo, a partir del id de la tienda (no del slug: el slug se puede cambiar
// en Configuracion y el login dejaria de andar). La misma cuenta la repite el
// panel en emailDeEquipo() — si se cambia aca, cambiarla alla.
//
// Para desplegar:
//   supabase functions deploy equipo --project-ref qduguqazpxjjpxjfnkif
//
// Acciones (POST, JSON): listar | crear | clave | activo | borrar

const DOMINIO_EQUIPO = "equipo.bruwaltech.com.ar";
const PLANES_CON_EQUIPO = ["pro", "cortesia"];
const ROLES = ["encargado", "cajero", "cocina", "personalizado"];
const PERMISOS = ["vender", "pedidos", "cocina", "fiado", "caja", "productos", "anular", "reparaciones", "turnos"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// "Juan Pérez" -> "juanperez". Mismo criterio que normalizarUsuarioEquipo()
// del panel, para que lo que se ve en pantalla sea lo que se guarda.
function normalizarUsuario(u: unknown): string {
  return String(u ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, 30);
}

function emailDeEquipo(usuario: string, storeId: string): string {
  return `${usuario}.${storeId.replace(/-/g, "")}@${DOMINIO_EQUIPO}`;
}

// Solo se guardan permisos conocidos y en true: un jsonb con basura no rompe
// las politicas (comparan contra 'true'), pero tampoco tiene por que entrar.
function limpiarPermisos(p: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (p && typeof p === "object") {
    for (const k of PERMISOS) if ((p as Record<string, unknown>)[k] === true) out[k] = true;
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // 1) Quien llama
    const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: u, error: uErr } = await admin.auth.getUser(jwt);
    if (uErr || !u?.user) return json({ error: "Tu sesión venció. Volvé a entrar." }, 401);

    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* body vacio */ }
    const accion = String(body.accion || "");
    const slug = String(body.store_slug || "");
    if (!slug) return json({ error: "Falta la tienda." }, 400);

    // 2) Tiene que ser el DUEÑO. Un encargado no puede crear usuarios: si
    //    pudiera, se daria a si mismo (o a otro) mas permisos de los que tiene.
    const { data: tienda } = await admin.from("store_profiles")
      .select("id, slug, plan, business_name")
      .eq("slug", slug).eq("user_id", u.user.id).maybeSingle();
    if (!tienda) return json({ error: "Solo el dueño del local puede manejar los usuarios del equipo." }, 403);

    // Un miembro existente, siempre buscado DENTRO de esta tienda: asi un
    // dueño no puede tocar el usuario de otro local pasando su id.
    const miembroDeLaTienda = async (id: unknown) => {
      if (!id) return null;
      const { data } = await admin.from("store_miembros").select("*")
        .eq("id", String(id)).eq("store_slug", slug).maybeSingle();
      return data;
    };

    // ---------------------------------------------------------------- listar
    if (accion === "listar") {
      const { data: miembros, error } = await admin.from("store_miembros").select("*")
        .eq("store_slug", slug).order("created_at", { ascending: true });
      if (error) return json({ error: "No se pudo leer el equipo." }, 500);
      // La ultima vez que entro cada uno: sirve para ver quien usa el sistema.
      const conAcceso = await Promise.all((miembros || []).map(async (m) => {
        const { data } = await admin.auth.admin.getUserById(m.user_id);
        return { ...m, ultimo_ingreso: data?.user?.last_sign_in_at || null };
      }));
      return json({ miembros: conAcceso });
    }

    // ----------------------------------------------------------------- crear
    if (accion === "crear") {
      if (!PLANES_CON_EQUIPO.includes(tienda.plan)) {
        return json({ error: "Los usuarios del equipo son parte del plan Pro." }, 402);
      }
      const usuario = normalizarUsuario(body.usuario);
      const nombre = String(body.nombre || "").trim().slice(0, 60);
      const password = String(body.password || "");
      const rol = ROLES.includes(String(body.rol)) ? String(body.rol) : "cajero";
      const permisos = limpiarPermisos(body.permisos);

      if (!nombre) return json({ error: "Poné el nombre de la persona." }, 400);
      if (!/^[a-z0-9][a-z0-9._-]{1,29}$/.test(usuario)) {
        return json({ error: "El usuario tiene que tener entre 2 y 30 letras o números, sin espacios." }, 400);
      }
      if (password.length < 6) return json({ error: "La contraseña tiene que tener al menos 6 caracteres." }, 400);
      if (!Object.keys(permisos).length) return json({ error: "Elegí al menos una cosa que pueda hacer." }, 400);

      const { data: repetido } = await admin.from("store_miembros").select("id")
        .eq("store_slug", slug).eq("usuario", usuario).maybeSingle();
      if (repetido) return json({ error: `Ya hay alguien con el usuario "${usuario}" en este local.` }, 409);

      // El empleado de la solapa Empleados (horas, reloj). Si no viene uno,
      // se crea, asi la misma persona queda en los dos lados.
      let empleadoId = body.empleado_id ? String(body.empleado_id) : null;
      if (empleadoId) {
        const { data: emp } = await admin.from("store_empleados").select("id")
          .eq("id", empleadoId).eq("store_slug", slug).maybeSingle();
        if (!emp) empleadoId = null;
      }
      if (!empleadoId) {
        const { data: emp } = await admin.from("store_empleados")
          .insert({ store_slug: slug, nombre, rol, activo: true })
          .select("id").single();
        empleadoId = emp?.id || null;
      }

      const { data: creado, error: cErr } = await admin.auth.admin.createUser({
        email: emailDeEquipo(usuario, tienda.id),
        password,
        email_confirm: true,                       // no se manda ningun mail
        app_metadata: { bruwal_equipo: { store_slug: slug } },   // el usuario no puede editarlo
        user_metadata: { nombre, es_equipo: true },
      });
      if (cErr || !creado?.user) {
        const m = (cErr?.message || "").toLowerCase();
        if (m.includes("already") || m.includes("registered")) {
          return json({ error: `El usuario "${usuario}" ya existe. Probá con otro.` }, 409);
        }
        if (m.includes("password")) return json({ error: "Esa contraseña no sirve: probá una más larga o menos común." }, 400);
        return json({ error: "No se pudo crear la cuenta.", detalle: cErr?.message }, 500);
      }

      const { data: miembro, error: mErr } = await admin.from("store_miembros").insert({
        store_slug: slug, user_id: creado.user.id, empleado_id: empleadoId,
        usuario, nombre, rol, permisos, activo: true,
      }).select("*").single();

      if (mErr) {
        // Sin la fila del equipo la cuenta no sirve para nada: se borra para
        // no dejar un usuario huerfano que despues ocupe el nombre.
        await admin.auth.admin.deleteUser(creado.user.id);
        return json({ error: "No se pudo guardar el usuario. Probá de nuevo.", detalle: mErr.message }, 500);
      }
      return json({ miembro });
    }

    // ----------------------------------------------------------------- clave
    if (accion === "clave") {
      const m = await miembroDeLaTienda(body.miembro_id);
      if (!m) return json({ error: "No encontramos a esa persona en tu local." }, 404);
      const password = String(body.password || "");
      if (password.length < 6) return json({ error: "La contraseña tiene que tener al menos 6 caracteres." }, 400);
      const { error } = await admin.auth.admin.updateUserById(m.user_id, { password });
      if (error) return json({ error: "No se pudo cambiar la contraseña.", detalle: error.message }, 500);
      return json({ ok: true });
    }

    // ---------------------------------------------------------------- activo
    // Pausar no borra nada: corta el acceso a los datos al instante (las
    // politicas miran `activo`) y bloquea la cuenta para que no pueda volver
    // a entrar. Reactivar deja todo como estaba.
    if (accion === "activo") {
      const m = await miembroDeLaTienda(body.miembro_id);
      if (!m) return json({ error: "No encontramos a esa persona en tu local." }, 404);
      const activo = body.activo === true;
      const { error: bErr } = await admin.auth.admin.updateUserById(m.user_id, {
        ban_duration: activo ? "none" : "876000h",
      });
      if (bErr) return json({ error: "No se pudo cambiar el acceso.", detalle: bErr.message }, 500);
      const { error } = await admin.from("store_miembros").update({ activo }).eq("id", m.id);
      if (error) return json({ error: "No se pudo cambiar el acceso.", detalle: error.message }, 500);
      return json({ ok: true, activo });
    }

    // ---------------------------------------------------------------- borrar
    // Las ventas que hizo NO se borran: el nombre queda en orders.vendedor.
    // El empleado de la solapa Empleados tampoco (tiene sus horas).
    if (accion === "borrar") {
      const m = await miembroDeLaTienda(body.miembro_id);
      if (!m) return json({ error: "No encontramos a esa persona en tu local." }, 404);
      const { error } = await admin.auth.admin.deleteUser(m.user_id);   // borra la fila por cascade
      if (error) return json({ error: "No se pudo quitar el acceso.", detalle: error.message }, 500);
      await admin.from("store_miembros").delete().eq("id", m.id);       // por las dudas
      return json({ ok: true });
    }

    return json({ error: "Acción desconocida." }, 400);
  } catch (e) {
    return json({ error: "Error inesperado.", detalle: String((e as Error)?.message || e) }, 500);
  }
});
