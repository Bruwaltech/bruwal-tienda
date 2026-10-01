// Revisión diaria de las suscripciones, sin depender de nadie.
//
// POR QUE EXISTE: hasta ahora la unica forma de enterarse de que un cliente
// se dio de baja era que ESE cliente abriera el panel
// (revisarSuscripcionDeVezEnCuando, una vez por dia). O sea que el que
// cancelaba y dejaba de entrar se quedaba con el plan activo en la base
// para siempre, y nosotros contandolo como si pagara.
//
// Tres cosas hace esto, todas las noches:
//
//   1. Al que dejo de estar autorizado en Mercado Pago le pone la fecha de
//      corte. No se le saca el acceso de golpe: dura hasta el dia del
//      proximo cobro, que es lo que ya pago.
//   2. Al que ya paso esa fecha le pasa el plan a 'cancelado'. Sin esto el
//      panel lo bloqueaba igual, pero en la base seguia figurando como
//      cliente que paga y el padron mentia.
//   3. Al que volvio a suscribirse le saca la fecha de corte.
//
// Y manda un mail con lo que cambio. Enterarse de que alguien se dio de
// baja el dia que pasa -- y no el mes que viene mirando numeros -- es la
// diferencia entre poder llamarlo y perderlo.
//
// NO TOCA NADA SI MERCADO PAGO NO CONTESTA. Un problema de red no puede
// dejar sin sistema a alguien que esta pagando.

const mail = require('./_mail');

const SUPABASE_URL = 'https://qduguqazpxjjpxjfnkif.supabase.co';
const MP_API = 'https://api.mercadopago.com';

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
  if (r.status === 204) return null;
  const texto = await r.text();
  return texto ? JSON.parse(texto) : null;
}

// Una fecha "2026-10-30" leida como medianoche de Argentina.
//
// Leerla como UTC adelanta el corte tres horas: a una pizzeria se le
// cortaba el panel el 30 a las nueve de la noche cuando la fecha decia
// "hasta el 30 inclusive". Mismo criterio que venceEnHoraArgentina en el
// panel.
function venceEnHoraArgentina(fecha) {
  const texto = String(fecha || '').trim();
  const soloDia = /^\d{4}-\d{2}-\d{2}$/.test(texto);
  const d = soloDia ? new Date(texto + 'T00:00:00-03:00') : new Date(texto);
  return isNaN(d) ? null : d;
}

module.exports = async (req, res) => {
  // Vercel manda este header en sus crons cuando CRON_SECRET esta
  // configurado. Sin el secreto el endpoint queda CERRADO: es preferible
  // que la revision no corra a que cualquiera pueda dispararla.
  const secreto = process.env.CRON_SECRET;
  if (!secreto) {
    console.error('Falta CRON_SECRET: la revision no corre.');
    return res.status(503).json({ error: 'Falta CRON_SECRET' });
  }
  if ((req.headers.authorization || '') !== 'Bearer ' + secreto) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  if (!process.env.MP_ACCESS_TOKEN || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Faltan variables de entorno' });
  }

  const cortadas = [], avisadas = [], revividas = [], fallaron = [];

  try {
    const tiendas = await sb('/rest/v1/store_profiles?plan=in.(basic,pro)' +
      '&select=slug,business_name,plan,plan_vence,mp_preapproval_id&limit=500');

    for (const t of tiendas || []) {
      // 2) Ya paso la fecha de corte: se cierra la cuenta.
      //
      // Va antes del resto y no depende de Mercado Pago: la fecha ya estaba
      // decidida, y si MP no contesta igual corresponde cerrarla.
      const vence = t.plan_vence ? venceEnHoraArgentina(t.plan_vence) : null;
      if (vence && !isNaN(vence) && Date.now() >= vence.getTime()) {
        try {
          await sb('/rest/v1/store_profiles?slug=eq.' + encodeURIComponent(t.slug), {
            method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: { plan: 'cancelado', plan_updated_at: new Date().toISOString() }
          });
          cortadas.push({ negocio: t.business_name || t.slug, slug: t.slug, desde: t.plan_vence });
          console.log('Cerrada por vencimiento:', t.slug, '(vencia', t.plan_vence + ')');
        } catch (err) {
          fallaron.push({ slug: t.slug, motivo: String((err && err.message) || err) });
        }
        continue;
      }

      if (!t.mp_preapproval_id) continue;   // plan puesto a mano, no hay que revisar

      // 1 y 3) Que dice Mercado Pago de esa suscripcion.
      let sus = null;
      try {
        const r = await fetch(MP_API + '/preapproval/' + encodeURIComponent(t.mp_preapproval_id),
          { headers: { Authorization: 'Bearer ' + process.env.MP_ACCESS_TOKEN } });
        if (!r.ok) {
          // No se toca nada. Un 500 de MP no puede cortarle el sistema a
          // alguien que esta pagando.
          fallaron.push({ slug: t.slug, motivo: 'Mercado Pago contesto ' + r.status });
          continue;
        }
        sus = await r.json();
      } catch (err) {
        fallaron.push({ slug: t.slug, motivo: String((err && err.message) || err) });
        continue;
      }
      if (!sus || !sus.status) {
        fallaron.push({ slug: t.slug, motivo: 'Respuesta ilegible' });
        continue;
      }

      if (sus.status === 'authorized') {
        // 3) Volvio a estar autorizada y tenia fecha de corte: se la saca.
        if (t.plan_vence) {
          await sb('/rest/v1/store_profiles?slug=eq.' + encodeURIComponent(t.slug), {
            method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: { plan_vence: null, plan_updated_at: new Date().toISOString() }
          });
          revividas.push({ negocio: t.business_name || t.slug, slug: t.slug });
          console.log('Volvio a pagar:', t.slug, '- se le saco la fecha de corte');
        }
        continue;
      }

      // 1) Dejo de estar autorizada. El acceso dura hasta el dia del
      //    proximo cobro, que es el periodo que ya pago.
      const hasta = sus.next_payment_date ||
        (sus.auto_recurring && sus.auto_recurring.next_payment_date) || null;
      const fecha = hasta ? String(hasta).slice(0, 10) : new Date().toISOString().slice(0, 10);

      if (t.plan_vence === fecha) continue;   // ya estaba avisado

      await sb('/rest/v1/store_profiles?slug=eq.' + encodeURIComponent(t.slug), {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: { plan_vence: fecha, plan_updated_at: new Date().toISOString() }
      });
      avisadas.push({
        negocio: t.business_name || t.slug, slug: t.slug,
        estado: sus.status, hasta: fecha
      });
      console.log('Se dio de baja:', t.slug, '(' + sus.status + ') - acceso hasta', fecha);
    }

    // El mail solo sale si cambio algo. Un resumen diario que casi siempre
    // dice "nada" deja de leerse, y el dia que importa tampoco se lee.
    const huboCambios = cortadas.length || avisadas.length || revividas.length;
    if (huboCambios) await avisar({ req, cortadas, avisadas, revividas, fallaron });

    return res.status(200).json({
      ok: true,
      revisadas: (tiendas || []).length,
      cortadas, avisadas, revividas, fallaron
    });
  } catch (err) {
    console.error('revisar-suscripciones', err);
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
};

async function avisar({ req, cortadas, avisadas, revividas, fallaron }) {
  try {
    if (!mail.hayComoMandar()) return;
    const admins = String(process.env.ADMIN_EMAILS || '')
      .split(',').map((x) => x.trim()).filter(Boolean);
    if (!admins.length) return;

    const base = 'https://' + (req.headers['x-forwarded-host'] || req.headers.host);
    const lista = (titulo, filas, pinta) => filas.length
      ? '<h3 style="font-size:15px;margin:18px 0 6px;color:' + pinta + ';">' + titulo + '</h3><ul>' +
        filas.map((f) => '<li>' + f).join('') + '</ul>'
      : '';

    const html =
      '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;' +
           'line-height:1.6;color:#15294D;max-width:560px;">' +
        '<p>Revisión diaria de las suscripciones.</p>' +
        lista('Se dieron de baja', avisadas.map((f) =>
          '<b>' + f.negocio + '</b> — sigue hasta el ' + f.hasta +
          ' <span style="color:#5C6B82;">(' + f.estado + ')</span>'), '#B4451F') +
        lista('Se les cerró la cuenta', cortadas.map((f) =>
          '<b>' + f.negocio + '</b> — vencida desde el ' + f.desde), '#B4451F') +
        lista('Volvieron a pagar', revividas.map((f) => '<b>' + f.negocio + '</b>'), '#1FA088') +
        lista('No se pudieron revisar', fallaron.map((f) =>
          f.slug + ' — ' + f.motivo), '#5C6B82') +
        '<p style="margin-top:18px;"><a href="' + base + '/dashboard/">Abrir el panel</a></p>' +
      '</div>';

    for (const para of admins) {
      await mail.mandar({
        para,
        asunto: avisadas.length
          ? 'Se dio de baja ' + (avisadas.length === 1 ? avisadas[0].negocio : avisadas.length + ' clientes')
          : 'Revisión de suscripciones: ' + (cortadas.length + revividas.length) + ' cambios',
        html
      });
    }
  } catch (err) {
    // El aviso nunca puede hacer fallar la revision, que es lo importante.
    console.warn('No se pudo avisar de la revision:', err && err.message);
  }
}
