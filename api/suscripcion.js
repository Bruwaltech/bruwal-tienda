// Verificar una suscripción contra Mercado Pago y activar el plan.
//
// POR QUÉ EXISTE: el plan se activa solo cuando llega el webhook de Mercado
// Pago (api/mercadopago-webhook.js). Si ese aviso no llega — firma mal
// configurada, la URL sin dar de alta en MP, el tópico sin suscribir, o un
// error de red — el cliente PAGA y el panel lo sigue tratando como vencido.
// Y no se arregla solo: Mercado Pago no reintenta para siempre.
//
// Pasó de verdad: un cliente se suscribió al plan Basic y le figuraba todo
// bloqueado. En la base ninguna tienda tenía plan 'basic'.
//
// SOBRE LA SEGURIDAD, que es lo primero que hay que mirar en algo que
// habilita un plan pago: acá no se le cree NADA a quien llama. El slug sale
// de la sesión de Supabase (no de lo que mande el navegador), y el plan sale
// de lo que contesta Mercado Pago para ESE slug. Si MP no dice que hay una
// suscripción autorizada, no se activa nada. O sea: no se puede usar para
// darse un plan a uno mismo.

const SUPABASE_URL = 'https://qduguqazpxjjpxjfnkif.supabase.co';
const MP_API = 'https://api.mercadopago.com';

// El mismo mapa que usa el webhook. Si algún día se recrea un plan en
// Mercado Pago (cambia el precio y sale un id nuevo), hay que actualizar los
// DOS lugares: acá y en api/mercadopago-webhook.js.
const PLAN_POR_PREAPPROVAL_ID = {
  '558bf71f6d62460797b95829fc767e0d': 'basic',
  '7f3874b7347b43698e4b9daf92a5405b': 'pro'
};

function faltanVariables() {
  return ['MP_ACCESS_TOKEN', 'SUPABASE_SERVICE_ROLE_KEY'].filter((n) => !process.env[n]);
}

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

async function usuarioDeToken(token) {
  const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { Authorization: 'Bearer ' + token, apikey: process.env.SUPABASE_SERVICE_ROLE_KEY }
  });
  if (!r.ok) return null;
  return r.json();
}

async function tiendaDelUsuario(userId) {
  const filas = await sb('/rest/v1/store_profiles?user_id=eq.' + encodeURIComponent(userId) +
                         '&select=slug,plan,plan_vence');
  return (filas && filas[0]) || null;
}

// Todas las suscripciones que Mercado Pago tenga con este slug como
// referencia. El slug viaja en external_reference desde el link del panel.
async function suscripcionesDeSlug(slug) {
  const r = await fetch(MP_API + '/preapproval/search?external_reference=' + encodeURIComponent(slug),
    { headers: { Authorization: 'Bearer ' + process.env.MP_ACCESS_TOKEN } });

  const datos = await r.json().catch(() => null);
  if (!r.ok) return { ok: false, status: r.status, crudo: datos };
  return { ok: true, resultados: (datos && datos.results) || [] };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const faltan = faltanVariables();
  if (faltan.length) {
    return res.status(500).json({ error: 'Faltan variables de entorno: ' + faltan.join(', ') });
  }

  const cabecera = req.headers.authorization || '';
  const token = cabecera.startsWith('Bearer ') ? cabecera.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Falta la sesión' });

  const usuario = await usuarioDeToken(token);
  if (!usuario || !usuario.id) return res.status(401).json({ error: 'Sesión inválida' });

  const tienda = await tiendaDelUsuario(usuario.id);
  if (!tienda) return res.status(403).json({ error: 'Este usuario no tiene tienda' });

  try {
    const busqueda = await suscripcionesDeSlug(tienda.slug);
    if (!busqueda.ok) {
      return res.status(200).json({
        ok: false,
        motivo: 'Mercado Pago contestó ' + busqueda.status + ' al buscar la suscripción.',
        crudo: busqueda.crudo
      });
    }

    // Lo que se ve, tal cual, aunque no sirva para activar: si alguien pagó y
    // quedó en "pending", eso hay que poder leerlo en vez de recibir un "no
    // encontramos nada" que no explica nada.
    const vistas = busqueda.resultados.map((p) => ({
      id: p.id,
      estado: p.status,
      plan: PLAN_POR_PREAPPROVAL_ID[p.preapproval_plan_id] || null,
      plan_id: p.preapproval_plan_id,
      desde: p.date_created || null,
      proximo_cobro: p.next_payment_date ||
        (p.auto_recurring && p.auto_recurring.next_payment_date) || null
    }));

    const autorizada = vistas.find((p) => p.estado === 'authorized' && p.plan);

    if (!autorizada) {
      // Una suscripción autorizada de un plan que no está en el mapa es el
      // caso peligroso: el cliente paga y nadie se entera de por qué no se
      // activa. Se dice con nombre y apellido.
      const desconocida = vistas.find((p) => p.estado === 'authorized' && !p.plan);
      return res.status(200).json({
        ok: false,
        plan_actual: tienda.plan,
        suscripciones: vistas,
        motivo: desconocida
          ? 'Hay una suscripción autorizada pero su plan (' + desconocida.plan_id +
            ') no está en la lista del sistema. Avisale a soporte con este código.'
          : (vistas.length
              ? 'Mercado Pago tiene la suscripción pero todavía no figura autorizada.'
              : 'Mercado Pago no encontró ninguna suscripción para esta tienda.')
      });
    }

    // Ya estaba bien: no se escribe de gusto.
    if (tienda.plan === autorizada.plan && !tienda.plan_vence) {
      return res.status(200).json({
        ok: true, ya: true, plan: autorizada.plan, suscripciones: vistas
      });
    }

    // plan_vence en null: si venía de una baja anterior y volvió a
    // suscribirse, esto le saca la fecha de corte pendiente. Mismo criterio
    // que el webhook.
    await sb('/rest/v1/store_profiles?slug=eq.' + encodeURIComponent(tienda.slug), {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: { plan: autorizada.plan, plan_vence: null }
    });

    console.log('Plan activado a mano desde el panel:', tienda.slug, '->', autorizada.plan);

    return res.status(200).json({
      ok: true,
      activado: true,
      plan: autorizada.plan,
      antes: tienda.plan,
      suscripciones: vistas
    });
  } catch (err) {
    console.error('suscripcion.js', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
};
