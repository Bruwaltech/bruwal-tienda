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
  '7f3874b7347b43698e4b9daf92a5405b': 'pro',
  // "Promo Bruwal": el plan Pro a $40.000 en vez de $70.000. NO figura en
  // el modal de planes a proposito -- se pasa por WhatsApp a quien se le
  // ofrece. Pero el id TIENE que estar aca igual: si no, el cliente paga,
  // la suscripcion queda autorizada en Mercado Pago, y el sistema no sabe
  // que plan darle. Le pasaria justo el dia que se le corta el acceso.
  '069a67b8a5c84460ae58975932328106': 'pro'
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

// El slug de la tienda que cumpla el filtro, o null.
async function buscarStore(filtro) {
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/store_profiles?' + filtro + '&select=slug&limit=1', {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY
      }
    });
    if (!r.ok) return null;
    const filas = await r.json();
    return (Array.isArray(filas) && filas[0] && filas[0].slug) || null;
  } catch (err) {
    return null;
  }
}

// La tienda de quien paga, buscada por su email. Es el rescate para las
// suscripciones que nacieron sin external_reference.
async function slugPorEmail(email) {
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/admin/users?per_page=200', {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY
      }
    });
    if (!r.ok) return null;
    const datos = await r.json();
    const usuarios = (datos && datos.users) || [];
    const buscado = String(email).toLowerCase();
    const u = usuarios.find((x) => String(x.email || '').toLowerCase() === buscado);
    if (!u) return null;
    return await buscarStore('user_id=eq.' + encodeURIComponent(u.id));
  } catch (err) {
    return null;
  }
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

  // El topico puede venir en el cuerpo (formato nuevo) o en la direccion
  // (formato viejo: ?topic=preapproval&id=123). Se miraba solo el cuerpo, asi
  // que un aviso IPN entraba como sin topico y se contestaba "ignorado".
  const tipo = cuerpo.type || cuerpo.topic ||
               (req.query && (req.query.type || req.query.topic)) || '';
  const dataId = (cuerpo.data && cuerpo.data.id) || (req.query && (req.query['data.id'] || req.query.id));

  // Solo interesa cuando una suscripción cambia de estado. Los pagos
  // individuales (subscription_authorized_payment) y otros topics se
  // confirman sin hacer nada — Mercado Pago reintenta si no contestamos 200.
  //
  // Se aceptan los DOS nombres porque Mercado Pago tiene dos formatos de
  // aviso y manda uno u otro segun como quedo dada de alta la integracion:
  //   Webhooks (nuevo):  {"type": "subscription_preapproval", ...}
  //   IPN (viejo):       ?topic=preapproval&id=123
  // Aceptando solo el primero, el segundo se contestaba 200 "ignorado" y el
  // plan no se activaba nunca. Peor: Mercado Pago lo cuenta como entregado,
  // asi que el problema no se ve por ningun lado.
  const TOPICOS_SUSCRIPCION = ['subscription_preapproval', 'preapproval'];
  if (!TOPICOS_SUSCRIPCION.includes(tipo) || !dataId) {
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
    const plan = PLAN_POR_PREAPPROVAL_ID[preapproval.preapproval_plan_id];

    // Mercado Pago NO guarda el external_reference que mandamos en la URL
    // del checkout cuando la suscripcion nace del link de un plan: medido
    // contra la cuenta real, todas venian con el campo vacio. Sin este
    // rescate, el aviso de un cliente que cancela no se puede atribuir a
    // ninguna tienda y se pierde -- o sea que nunca se le cortaria.
    //
    // Se busca por dos caminos: la suscripcion ya anotada en la tienda, y
    // el email del que paga.
    let slug = preapproval.external_reference;

    if (!slug && dataId) {
      const porId = await buscarStore('mp_preapproval_id=eq.' + encodeURIComponent(dataId));
      if (porId) slug = porId;
    }
    if (!slug && preapproval.payer_email) {
      const porMail = await slugPorEmail(preapproval.payer_email);
      if (porMail) slug = porMail;
    }

    if (!slug || !plan) {
      console.warn('Preapproval sin slug o plan reconocido:', dataId, slug, preapproval.preapproval_plan_id);
      res.statusCode = 200;
      return res.end('sin slug o plan reconocido');
    }

    if (preapproval.status === 'authorized') {
      // 'authorized' significa que el medio de pago quedo autorizado, NO que
      // la plata entro. Con un dia de cobro fijo alguien se suscribe el 22 y
      // el primer debito cae el 10 del mes siguiente: autorizado y sin pagar
      // un peso. El plan no se activa hasta que cobro al menos una vez.
      //
      // summarized.charged_quantity lo dice. Si ese campo NO viene, se
      // activa igual: el dato que falta es nuestro, no una deuda del
      // cliente, y dejar afuera a alguien que autorizo el pago es peor.
      const resumen = preapproval.summarized || {};
      const cobros = (resumen.charged_quantity === undefined || resumen.charged_quantity === null)
        ? null
        : Number(resumen.charged_quantity) || 0;

      // El plan Pro tiene 7 dias de prueba configurados en Mercado Pago:
      // el cliente deja la tarjeta y recien al octavo dia le cobran.
      // Durante esos dias TIENE que poder usar el sistema, si no la prueba
      // no existe -- dejo la tarjeta y no puede entrar.
      const ar = preapproval.auto_recurring || {};
      const proximo = preapproval.next_payment_date || ar.next_payment_date || null;
      const enPrueba = !!ar.free_trial &&
        (!proximo || new Date(proximo).getTime() > Date.now());

      if (cobros === 0 && !enPrueba) {
        console.log('Suscripcion autorizada pero todavia sin cobrar:', slug,
                    '- primer cobro', preapproval.next_payment_date || '(sin fecha)');
        res.statusCode = 200;
        return res.end('autorizada, esperando el primer cobro');
      }

      // plan_vence en null: si venía de una cancelación anterior y se
      // volvió a suscribir, esto le saca cualquier fecha de baja pendiente.
      await actualizarStore(slug, {
        plan,
        plan_vence: null,
        mp_preapproval_id: dataId || null,
        plan_updated_at: new Date().toISOString()
      });
      console.log('Plan activado por Mercado Pago:', slug, '->', plan,
                  '(' + (enPrueba ? 'en prueba gratis'
                       : cobros === null ? 'sin dato de cobros'
                       : cobros + ' cobros') + ')');
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
