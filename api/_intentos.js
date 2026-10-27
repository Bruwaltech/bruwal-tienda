// De quién es una suscripción que llegó sin dueño, por el "Suscribirme".
//
// Con guion bajo adelante para que Vercel no lo cuente como una función
// aparte (tope de 12). Lo usan api/suscripcion.js y el webhook.
//
// POR QUE EXISTE: Mercado Pago no nos dice de quién es una suscripción
// que nace del link de un plan. No guarda el external_reference, casi
// nunca da el email del que paga, y si paga desde una cuenta de MP con
// otro mail (la del negocio, la de la pareja) ni el email sirve. El único
// camino exacto era el ID que vuelve en la dirección al terminar de pagar,
// y ese se pierde si el cliente paga desde la app de MP en el celular y
// no vuelve al panel. Pasó con JACI y con Sirius el mismo día: pagaron,
// apretaron "Ya pagué" diez veces y el plan no se activó.
//
// Lo que SÍ sabemos es quién apretó "Suscribirme" y cuándo. Si en las
// horas previas a una suscripción UNA sola tienda fue a pagar ese plan,
// es de ella. Si fueron dos o más, no se adivina: queda para atar a mano,
// como hasta ahora.

const SUPABASE_URL = 'https://qduguqazpxjjpxjfnkif.supabase.co';

// Cuánto antes de la suscripción puede estar el clic. Cargar la tarjeta
// lleva minutos, pero entre el clic y el pago puede haber una llamada, un
// "lo hago a la noche"... Más largo no: cuanto más ancha la ventana, más
// fácil que caigan dos tiendas y no se pueda decidir.
const VENTANA_ANTES_MS = 6 * 3600000;
// Y un margen después, por si los relojes de MP y de la base no coinciden.
const MARGEN_DESPUES_MS = 15 * 60000;

async function sb(ruta, opciones) {
  const o = opciones || {};
  const clave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(SUPABASE_URL + ruta, {
    method: o.method || 'GET',
    headers: Object.assign({
      apikey: clave,
      Authorization: 'Bearer ' + clave,
      'Content-Type': 'application/json'
    }, o.headers || {}),
    body: o.body ? JSON.stringify(o.body) : undefined
  });
  if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + (await r.text()).slice(0, 300));
  if (r.status === 204 || r.status === 201) return null;
  const texto = await r.text();
  return texto ? JSON.parse(texto) : null;
}

async function registrar(slug, plan) {
  await sb('/rest/v1/store_intentos_pago', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: { slug, plan }
  });
}

// La tienda a la que le corresponde la suscripción, o null.
//
// `sus` es la suscripción de Mercado Pago (hace falta id y date_created) y
// `plan` el nuestro ('basic' / 'pro'). Nunca tira: si algo falla, null, y
// se sigue por el camino de siempre.
async function slugPorIntento(sus, plan) {
  try {
    if (!sus || !sus.id || !plan) return null;
    const nacio = Date.parse(sus.date_created || '');
    if (isNaN(nacio)) return null;

    const desde = new Date(nacio - VENTANA_ANTES_MS).toISOString();
    const hasta = new Date(nacio + MARGEN_DESPUES_MS).toISOString();
    const filas = await sb('/rest/v1/store_intentos_pago?select=slug,usado_por' +
      '&plan=eq.' + encodeURIComponent(plan) +
      '&creado=gte.' + encodeURIComponent(desde) +
      '&creado=lte.' + encodeURIComponent(hasta) + '&limit=200') || [];

    // Un intento que ya se usó para OTRA suscripción no cuenta: esa tienda
    // ya tiene la suya. Si es esta misma, sí (el webhook y "Ya pagué"
    // pueden llegar a preguntar los dos).
    const libres = filas.filter((f) => !f.usado_por || f.usado_por === sus.id);
    const tiendas = [...new Set(libres.map((f) => f.slug))];

    console.log('rescate por intento:', sus.id, plan, 'nacio', sus.date_created,
                '| tiendas que fueron a pagar:', JSON.stringify(tiendas));

    return tiendas.length === 1 ? tiendas[0] : null;
  } catch (err) {
    console.warn('No se pudo buscar por intento de pago:', err && err.message);
    return null;
  }
}

// Que ese intento ya no sirva para otra suscripción.
async function marcarUsado(slug, preapprovalId, plan) {
  try {
    await sb('/rest/v1/store_intentos_pago?slug=eq.' + encodeURIComponent(slug) +
             '&plan=eq.' + encodeURIComponent(plan) + '&usado_por=is.null', {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: { usado_por: preapprovalId }
    });
  } catch (err) {
    console.warn('No se pudo marcar el intento como usado:', err && err.message);
  }
}

module.exports = { registrar, slugPorIntento, marcarUsado };
