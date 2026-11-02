// Aviso al cliente cuando Mercado Pago no pudo cobrar la cuota.
//
// QUE PASA CUANDO UN COBRO FALLA: Mercado Pago no da de baja la suscripcion
// al primer rechazo. La deja 'authorized' y reintenta el cobro unos dias
// despues (el "cobro" es un authorized_payment, que pasa a 'recycling' y
// trae next_retry_date). Mientras tanto nosotros no tocamos el plan: el
// cliente sigue usando el sistema. Si al final Mercado Pago da de baja la
// suscripcion, el webhook / la revision diaria ya la manejan como una baja
// comun (fecha de corte).
//
// Lo que faltaba es que el cliente se entere. Mercado Pago le manda algo
// generico, o nada; el mail de BRUWAL le dice que paso, cuando reintenta y
// que hacer. UNO por intento fallido: la marca vive en
// suscripcion_avisos_cobro (schema/97) con clave (cobro, reintento).
//
// Lo llaman dos lados, y por eso la marca: el webhook (al instante, si en
// Mercado Pago esta prendido el aviso de "pagos recurrentes") y la revision
// diaria (red de seguridad si ese aviso no llega).
//
// NUNCA tira una excepcion hacia afuera: un problema con el mail no puede
// romper el webhook ni la revision.

const mail = require('./_mail');

const SUPABASE_URL = 'https://qduguqazpxjjpxjfnkif.supabase.co';
const MP_API = 'https://api.mercadopago.com';

// Solo se avisan rechazos recientes. Sin esto, el dia que se sube este
// cambio la revision diaria le mandaria un mail a cualquiera que haya
// tenido un rechazo hace meses y ya lo haya resuelto.
const DIAS_RECIENTE = 4;

const NOMBRE_PLAN = { basic: 'Básico', pro: 'Pro' };

function cabecerasSb(extra) {
  const clave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return Object.assign({
    apikey: clave,
    Authorization: 'Bearer ' + clave,
    'Content-Type': 'application/json'
  }, extra || {});
}

function esRechazado(cobro) {
  return !!(cobro && cobro.payment && cobro.payment.status === 'rejected' &&
            cobro.status !== 'processed');
}

function esReciente(cobro) {
  const f = new Date(cobro.last_modified || cobro.date_created || 0).getTime();
  return !isNaN(f) && Date.now() - f < DIAS_RECIENTE * 86400000;
}

// "jueves 5 de noviembre", en hora de Argentina.
function fechaLinda(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return d.toLocaleDateString('es-AR', {
    weekday: 'long', day: 'numeric', month: 'long',
    timeZone: 'America/Argentina/Buenos_Aires'
  });
}

function pesos(n) {
  const v = Number(n);
  if (!v) return 'la cuota del mes';
  return '$' + v.toLocaleString('es-AR', { maximumFractionDigits: 0 });
}

function textoReintento(cobro) {
  const fecha = cobro.status === 'recycling' && cobro.next_retry_date
    ? fechaLinda(cobro.next_retry_date) : null;
  if (fecha) {
    return 'No tenés que hacer nada para que lo vuelva a intentar: Mercado Pago ' +
           'va a reintentar el cobro automáticamente el ' + fecha + '. ' +
           'Si para ese día la tarjeta tiene saldo, se cobra solo.';
  }
  return 'Mercado Pago ya hizo los reintentos de esta cuota y no pudo cobrarla. ' +
         'Para no perder el acceso, cambiá el medio de pago o escribinos y lo resolvemos juntos.';
}

async function tiendaDeSuscripcion(preapprovalId) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/store_profiles?mp_preapproval_id=eq.' +
                        encodeURIComponent(preapprovalId) +
                        '&select=slug,business_name,plan,user_id&limit=1',
                        { headers: cabecerasSb() });
  if (!r.ok) return null;
  const filas = await r.json().catch(() => null);
  return (Array.isArray(filas) && filas[0]) || null;
}

async function emailDelDuenio(userId) {
  const r = await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + encodeURIComponent(userId),
                        { headers: cabecerasSb() });
  if (!r.ok) return null;
  const d = await r.json().catch(() => null);
  return (d && d.email) || null;
}

// Pone la marca. true si la puso esta llamada (o sea, si hay que mandar);
// false si ya estaba o si no se pudo escribir -- en la duda, no se manda,
// porque un mail de cobranza repetido es peor que uno que sale al otro dia.
async function marcar(cobroId, intento, slug) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/suscripcion_avisos_cobro', {
    method: 'POST',
    headers: cabecerasSb({ Prefer: 'resolution=ignore-duplicates,return=representation' }),
    body: JSON.stringify({ cobro_id: String(cobroId), intento, slug })
  });
  if (!r.ok) {
    console.warn('No se pudo marcar el aviso de cobro', cobroId, r.status,
                 (await r.text().catch(() => '')).slice(0, 200));
    return false;
  }
  const filas = await r.json().catch(() => null);
  return Array.isArray(filas) && filas.length > 0;
}

// Si el mail no salio, se saca la marca para que lo intente la proxima vez.
async function desmarcar(cobroId, intento) {
  await fetch(SUPABASE_URL + '/rest/v1/suscripcion_avisos_cobro?cobro_id=eq.' +
              encodeURIComponent(String(cobroId)) + '&intento=eq.' + intento, {
    method: 'DELETE', headers: cabecerasSb()
  }).catch(() => {});
}

// Copia corta para los admins: enterarse el dia que pasa es lo que permite
// llamar al cliente antes de perderlo.
async function avisarAdmins({ negocio, slug, para, cobro, intento }) {
  const admins = String(process.env.ADMIN_EMAILS || '')
    .split(',').map((x) => x.trim()).filter(Boolean);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const reintento = cobro.status === 'recycling' && cobro.next_retry_date
    ? 'Mercado Pago reintenta el ' + fechaLinda(cobro.next_retry_date) + '.'
    : 'Mercado Pago no informa otro reintento.';
  const html =
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;' +
         'line-height:1.6;color:#15294D;max-width:560px;">' +
      '<p>Mercado Pago rechazó el cobro de <b>' + esc(negocio) + '</b> (' + esc(slug) + '), ' +
      pesos(cobro.transaction_amount) + '. Intento ' + (intento + 1) + '.</p>' +
      '<p>Motivo: ' + esc((cobro.payment && cobro.payment.status_detail) || 'sin detalle') + '. ' +
      reintento + '</p>' +
      '<p>Ya se le mandó el aviso a ' + esc(para) + '.</p>' +
    '</div>';
  for (const a of admins) {
    await mail.mandar({ para: a, asunto: 'Cobro rechazado: ' + negocio, html });
  }
}

// El corazon. Recibe un authorized_payment de Mercado Pago tal cual viene.
// Devuelve un texto corto con lo que hizo, para el log / la respuesta.
async function procesarCobro({ base, cobro }) {
  try {
    if (!esRechazado(cobro)) return 'no rechazado';
    if (!esReciente(cobro)) return 'rechazo viejo';
    if (!mail.hayComoMandar()) return 'sin Resend';

    const tienda = await tiendaDeSuscripcion(cobro.preapproval_id);
    if (!tienda) {
      console.warn('Cobro rechazado de una suscripcion sin tienda:', cobro.preapproval_id, cobro.id);
      return 'sin tienda';
    }

    const intento = Number(cobro.retry_attempt) || 0;
    if (!(await marcar(cobro.id, intento, tienda.slug))) return 'ya avisado';

    const para = await emailDelDuenio(tienda.user_id);
    if (!para) { await desmarcar(cobro.id, intento); return 'sin email'; }

    const html = await mail.armarPlantilla(base, 'cobro-rechazado.html', {
      NOMBRE: tienda.business_name || 'qué tal',
      PLAN: NOMBRE_PLAN[tienda.plan] || tienda.plan || '',
      MONTO: pesos(cobro.transaction_amount),
      CUANDO_REINTENTA: textoReintento(cobro),
      LINK_PANEL: base + '/dashboard',
      WHATSAPP: '5493413005232'
    }).catch((err) => {
      console.error('Plantilla de cobro rechazado:', String((err && err.message) || err));
      return null;
    });

    const salio = html && await mail.mandar({
      para,
      asunto: 'No pudimos cobrar tu plan de BRUWAL',
      html
    });
    if (!salio) { await desmarcar(cobro.id, intento); return 'no salio'; }

    await avisarAdmins({ negocio: tienda.business_name || tienda.slug, slug: tienda.slug,
                         para, cobro, intento });
    console.log('Aviso de cobro rechazado enviado:', tienda.slug, 'cobro', cobro.id, 'intento', intento);
    return 'avisado';
  } catch (err) {
    console.warn('Aviso de cobro rechazado:', String((err && err.message) || err));
    return 'error';
  }
}

// Para el webhook: llega solo el id del cobro.
async function procesarCobroPorId({ base, id }) {
  const r = await fetch(MP_API + '/authorized_payments/' + encodeURIComponent(id),
    { headers: { Authorization: 'Bearer ' + process.env.MP_ACCESS_TOKEN } });
  if (!r.ok) throw new Error('Mercado Pago ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return procesarCobro({ base, cobro: await r.json() });
}

// Para la revision diaria: todos los cobros de una suscripcion. Devuelve
// cuantos avisos salieron.
async function revisarSuscripcion({ base, preapprovalId }) {
  try {
    const r = await fetch(MP_API + '/authorized_payments/search?preapproval_id=' +
                          encodeURIComponent(preapprovalId) + '&limit=50',
      { headers: { Authorization: 'Bearer ' + process.env.MP_ACCESS_TOKEN } });
    if (!r.ok) return 0;
    const datos = await r.json().catch(() => null);
    let avisados = 0;
    for (const cobro of (datos && datos.results) || []) {
      if (!esRechazado(cobro) || !esReciente(cobro)) continue;
      if ((await procesarCobro({ base, cobro })) === 'avisado') avisados++;
    }
    return avisados;
  } catch (err) {
    return 0;
  }
}

module.exports = { procesarCobro, procesarCobroPorId, revisarSuscripcion,
                   _probar: { esRechazado, esReciente, textoReintento, pesos } };
