// Webhook de Mercado Pago — activa el plan solo con que la suscripción
// se autorice, sin entrar a Supabase a mano cada vez que alguien paga.
//
// Cubre nada más el evento que importa para esto: subscription_preapproval
// con status 'authorized'. Bajar el plan cuando alguien cancela NO es
// automático a propósito — es una decisión que se sigue tomando a mano,
// mismo criterio que ya usa el resto de la app (la tienda pública sigue
// online al vencer la prueba, no se castiga de más "por las dudas").

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

async function actualizarPlan(slug, plan) {
  const clave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(SUPABASE_URL + '/rest/v1/store_profiles?slug=eq.' + encodeURIComponent(slug), {
    method: 'PATCH',
    headers: {
      apikey: clave,
      Authorization: 'Bearer ' + clave,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify({ plan })
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

    if (preapproval.status !== 'authorized') {
      res.statusCode = 200;
      return res.end('sin cambios: ' + preapproval.status);
    }

    const slug = preapproval.external_reference;
    const plan = PLAN_POR_PREAPPROVAL_ID[preapproval.preapproval_plan_id];

    if (!slug || !plan) {
      console.warn('Preapproval autorizada sin slug o plan reconocido:', dataId, slug, preapproval.preapproval_plan_id);
      res.statusCode = 200;
      return res.end('sin slug o plan reconocido');
    }

    await actualizarPlan(slug, plan);

    console.log('Plan activado por Mercado Pago:', slug, '->', plan);
    res.statusCode = 200;
    return res.end('ok');
  } catch (err) {
    console.error('Error procesando el webhook de Mercado Pago:', err);
    // 200 igual: con un error Mercado Pago reintenta el mismo webhook una y
    // otra vez. Si es un problema real, queda en los logs para revisar a mano.
    res.statusCode = 200;
    return res.end('error registrado');
  }
};
