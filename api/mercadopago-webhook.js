// Webhook de Mercado Pago — activa el plan cuando se autoriza una
// suscripción, y programa la baja cuando se cancela o se pausa, sin
// entrar a Supabase a mano en ninguno de los dos casos.
//
// La cancelación NO corta el acceso de inmediato: Mercado Pago cobra el
// mes por adelantado, así que quien cancela ya pagó ese período. Guardamos
// la fecha hasta la que sigue cubierto en store_profiles.plan_vence, y es
// el dashboard (estadoSuscripcion() en dashboard/index.html) el que decide
// pasar a modo solo-lectura recién cuando esa fecha se cumple — mismo
// mecanismo que ya usa la prueba gratis vencida, nada nuevo del lado del
// front. Si no llega una fecha confiable de Mercado Pago, no tocamos nada
// y queda para revisar a mano: preferimos eso a cortarle el acceso a
// alguien que todavía tiene días pagos.

const crypto = require('crypto');

const SUPABASE_URL = 'https://qduguqazpxjjpxjfnkif.supabase.co';

// El ID del plan de Mercado Pago es fijo, uno por escalón — si el día de
// mañana se recrea un plan (cambia el precio, por ejemplo), hay que
// actualizar este mapa junto con dashboard/index.html.
const PLAN_POR_PREAPPROVAL_ID = {
  '558bf71f6d62460797b95829fc767e0d': 'basic',
  '7f3874b7347b43698e4b9daf92a5405b': 'pro'
};

function faltanVariables() {
  return ['MP_ACCESS_TOKEN', 'MP_WEBHOOK_SECRET', 'SUPABASE_SERVICE_ROLE_KEY']
    .filter((n) => !process.env[n]);
}

function igualdadSegura(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Formato documentado por Mercado Pago para el manifest:
//   id:{data.id en minúsculas};request-id:{x-request-id};ts:{ts};
// HMAC-SHA256 en hex, con la "clave secreta" del webhook como clave.
function firmaValida(dataId, requestId, cabeceraSignature) {
  if (!cabeceraSignature || !dataId || !requestId) return false;

  const partes = {};
  cabeceraSignature.split(',').forEach((p) => {
    const i = p.indexOf('=');
    if (i === -1) return;
    partes[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  if (!partes.ts || !partes.v1) return false;

  const manifest = 'id:' + String(dataId).toLowerCase() + ';request-id:' + requestId + ';ts:' + partes.ts + ';';
  const esperada = crypto.createHmac('sha256', process.env.MP_WEBHOOK_SECRET)
    .update(manifest).digest('hex');

  return igualdadSegura(esperada, partes.v1);
}

async function actualizarStore(slug, campos) {
  const clave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(SUPABASE_URL + '/rest/v1/store_profiles?slug=eq.' + encodeURIComponent(slug), {
    method: 'PATCH',
    headers: {
      apikey: clave,
      Authorization: 'Bearer ' + clave,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(campos)
  });
  if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + (await r.text()));
}

async function consultarPreapproval(id) {
  const r = await fetch('https://api.mercadopago.com/preapproval/' + encodeURIComponent(id), {
    headers: { Authorization: 'Bearer ' + process.env.MP_ACCESS_TOKEN }
  });
  if (!r.ok) throw new Error('Mercado Pago ' + r.status + ': ' + (await r.text()));
  return r.json();
}

module.exports = async (req, res) => {
  // Mercado Pago no exige validar una URL por GET como Meta, pero conviene
  // no fallar si alguien la abre en el navegador para chusmear.
  if (req.method !== 'POST') {
    res.statusCode = 200;
    return res.end('ok');
  }

  const faltan = faltanVariables();
  if (faltan.length) {
    console.error('Faltan variables de entorno:', faltan.join(', '));
    res.statusCode = 500;
    return res.end('sin configurar');
  }

  let cuerpo;
  try {
    cuerpo = (req.body && typeof req.body === 'object') ? req.body : JSON.parse(req.body || '{}');
  } catch (err) {
    res.statusCode = 400;
    return res.end('cuerpo invalido');
  }

  const tipo = cuerpo.type || cuerpo.topic || '';
  const dataId = (cuerpo.data && cuerpo.data.id) || (req.query && (req.query['data.id'] || req.query.id));

  // Solo interesa cuando una suscripción cambia de estado. Los pagos
  // individuales (subscription_authorized_payment) y otros topics se
  // confirman sin hacer nada — Mercado Pago reintenta si no contestamos 200.
  if (tipo !== 'subscription_preapproval' || !dataId) {
    res.statusCode = 200;
    return res.end('ignorado');
  }

  const requestId = req.headers['x-request-id'];
  const firma = req.headers['x-signature'];
  if (!firmaValida(dataId, requestId, firma)) {
    console.warn('Firma de Mercado Pago inválida para', dataId);
    res.statusCode = 401;
    return res.end('firma invalida');
  }

  try {
    const preapproval = await consultarPreapproval(dataId);
    const slug = preapproval.external_reference;
    const plan = PLAN_POR_PREAPPROVAL_ID[preapproval.preapproval_plan_id];

    if (!slug || !plan) {
      console.warn('Preapproval sin slug o plan reconocido:', dataId, slug, preapproval.preapproval_plan_id);
      res.statusCode = 200;
      return res.end('sin slug o plan reconocido');
    }

    if (preapproval.status === 'authorized') {
      // plan_vence en null: si venía de una cancelación anterior y se
      // volvió a suscribir, esto le saca cualquier fecha de baja pendiente.
      await actualizarStore(slug, { plan, plan_vence: null });
      console.log('Plan activado por Mercado Pago:', slug, '->', plan);
      res.statusCode = 200;
      return res.end('ok');
    }

    if (preapproval.status === 'cancelled' || preapproval.status === 'paused') {
      // El acceso sigue hasta la fecha en que hubiera tocado el próximo
      // cobro (eso es lo que ya está pagado). No cambiamos 'plan' acá: el
      // dashboard sigue tratando a la tienda como activa hasta esa fecha.
      const fechaVence = preapproval.next_payment_date ||
        (preapproval.auto_recurring && preapproval.auto_recurring.next_payment_date) || null;

      if (!fechaVence) {
        console.warn('Cancelación sin fecha de próximo cobro — no se tocó nada, revisar a mano:', slug, dataId);
        res.statusCode = 200;
        return res.end('sin fecha, revisar a mano');
      }

      await actualizarStore(slug, { plan_vence: String(fechaVence).slice(0, 10) });
      console.log('Cancelación registrada:', slug, '-> vence', fechaVence);
      res.statusCode = 200;
      return res.end('ok');
    }

    res.statusCode = 200;
    return res.end('sin cambios: ' + preapproval.status);
  } catch (err) {
    console.error('Error procesando el webhook de Mercado Pago:', err);
    // 200 igual: con un error Mercado Pago reintenta el mismo webhook una y
    // otra vez. Si es un problema real, queda en los logs para revisar a mano.
    res.statusCode = 200;
    return res.end('error registrado');
  }
};
