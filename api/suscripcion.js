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
  '7f3874b7347b43698e4b9daf92a5405b': 'pro',
  // "Promo Bruwal": el plan Pro a $40.000 en vez de $70.000. NO figura en
  // el modal de planes a proposito -- se pasa por WhatsApp a quien se le
  // ofrece. Pero el id TIENE que estar aca igual: si no, el cliente paga,
  // la suscripcion queda autorizada en Mercado Pago, y el sistema no sabe
  // que plan darle. Le pasaria justo el dia que se le corta el acceso.
  '069a67b8a5c84460ae58975932328106': 'pro'
};

// Quien puede ver datos de OTRAS tiendas. Sale de una variable de entorno
// y no del codigo: el dia que cambie no hay que tocar el repositorio.
//
// Sin la variable no hay admin. Es el lado seguro para equivocarse: peor que
// no poder ver el cruce es que un cliente vea los datos de los demas.
function esAdmin(email) {
  const lista = String(process.env.ADMIN_EMAILS || '')
    .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  return !!email && lista.includes(String(email).toLowerCase());
}

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

// El slug lo manda el navegador pero se verifica contra las tiendas de ESE
// usuario: mandar uno ajeno no activa nada. Ver el comentario largo en
// api/mercadolibre.js.
async function tiendaDelUsuario(userId, slugPedido) {
  const filas = await sb('/rest/v1/store_profiles?user_id=eq.' + encodeURIComponent(userId) +
                         '&select=slug,plan,plan_vence,mp_preapproval_id&order=created_at.asc');
  if (!filas || !filas.length) return null;

  if (slugPedido) {
    const suya = filas.find((t) => t.slug === slugPedido);
    if (suya) return suya;
  }
  return filas[0];
}

// Todas las suscripciones que Mercado Pago tenga con este slug como
// referencia. El slug viaja en external_reference desde el link del panel.
// TODAS las suscripciones de un plan nuestro, sin filtrar por slug.
//
// Sirve para contestar la unica pregunta que importa cuando alguien "pago y
// no se activo": esa suscripcion, ¿existe en Mercado Pago? ¿Con que estado?
// ¿Y trae el external_reference que nosotros mandamos en el link?
async function suscripcionesDelPlan(planId) {
  const r = await fetch(MP_API + '/preapproval/search?preapproval_plan_id=' +
                        encodeURIComponent(planId) + '&limit=50',
    { headers: { Authorization: 'Bearer ' + process.env.MP_ACCESS_TOKEN } });

  const datos = await r.json().catch(() => null);
  if (!r.ok) return { ok: false, status: r.status, crudo: datos };
  return { ok: true, resultados: (datos && datos.results) || [] };
}

// Le escribe nuestro slug a una suscripcion que nacio sin el. Es lo que
// convierte el arreglo en definitivo: la proxima vez se encuentra por
// external_reference, como siempre debio ser.
//
// Si falla no se corta nada: el plan se activa igual y a lo sumo la proxima
// vez hay que volver a encontrarla por email.
async function marcarSuscripcionConSlug(preapprovalId, slug) {
  try {
    const r = await fetch(MP_API + '/preapproval/' + encodeURIComponent(preapprovalId), {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + process.env.MP_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ external_reference: slug })
    });
    if (!r.ok) {
      console.warn('No se pudo escribir el external_reference en', preapprovalId, r.status);
      return false;
    }
    console.log('Suscripcion', preapprovalId, 'quedo atada a', slug);
    return true;
  } catch (err) {
    console.warn('Error escribiendo el external_reference:', err && err.message);
    return false;
  }
}

// La suscripcion de quien esta pidiendo, buscada por el EMAIL con el que
// paga. Es el camino de rescate para las que nacieron sin slug.
//
// El email viene de la sesion de Supabase, no del navegador: nadie puede
// pedir el plan de otro diciendo que es su email.
async function suscripcionPorEmail(email) {
  if (!email) return null;

  for (const planId of Object.keys(PLAN_POR_PREAPPROVAL_ID)) {
    const r = await suscripcionesDelPlan(planId);
    if (!r.ok) continue;
    const suya = r.resultados.find((p) =>
      p.status === 'authorized' &&
      String(p.payer_email || '').toLowerCase() === String(email).toLowerCase());
    if (suya) return suya;
  }
  return null;
}

// ¿Esta suscripcion YA COBRO alguna vez?
//
// 'authorized' en Mercado Pago significa que el medio de pago quedo
// autorizado, NO que la plata entro. Con un dia de cobro fijo, alguien se
// suscribe el 22 y el primer debito cae el 10 del mes siguiente: autorizado
// y sin pagar un peso. El plan no puede activarse ahi.
//
// El dato sale de `summarized.charged_quantity`, que Mercado Pago devuelve
// en cada suscripcion.
//
// SI ESE CAMPO NO VIENE se devuelve null, y quien llama lo trata como "no se
// puede saber" y activa igual. Es a proposito: bloquear a alguien que
// autorizo el pago porque a nosotros nos falta un dato seria peor que el
// problema que se quiere evitar.
function cobrosDe(p) {
  const s = p && p.summarized;
  if (!s || s.charged_quantity === undefined || s.charged_quantity === null) return null;
  return Number(s.charged_quantity) || 0;
}

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

  // El plan es POR TIENDA: hay que verificar la suscripcion de la que se esta
  // mirando, no la del primer negocio que tenga el usuario.
  const tienda = await tiendaDelUsuario(usuario.id, (req.body || {}).slug);
  if (!tienda) return res.status(403).json({ error: 'Este usuario no tiene tienda' });

  // ---- Revisar que el que tiene plan SIGA pagando ----
  //
  // Sin esto el ciclo queda abierto por la mitad: al pagar se activa, pero
  // si despues deja de pagar nadie se entera nunca. El webhook de Mercado
  // Pago podria avisar, pero su propia documentacion dice que la
  // configuracion de webhooks no aplica a Suscripciones, asi que ese aviso
  // puede no llegar jamas.
  //
  // Solo se revisa a quien tiene mp_preapproval_id, o sea a quien se activo
  // POR Mercado Pago. Al que le pusiste el plan a mano (paga por
  // transferencia, es una cortesia) no se lo toca: cortarle a ese seria
  // peor que no cortar a nadie.
  if ((req.body || {}).accion === 'revisar') {
    if (!tienda.mp_preapproval_id) {
      return res.status(200).json({ ok: true, revisado: false,
        motivo: 'Este plan no lo sostiene una suscripcion de Mercado Pago.' });
    }

    const r = await fetch(MP_API + '/preapproval/' + encodeURIComponent(tienda.mp_preapproval_id),
      { headers: { Authorization: 'Bearer ' + process.env.MP_ACCESS_TOKEN } });

    // Si Mercado Pago no contesta, NO se toca nada. Un problema de red no
    // puede dejar sin sistema a alguien que esta pagando.
    if (!r.ok) {
      return res.status(200).json({ ok: true, revisado: false,
        motivo: 'Mercado Pago contesto ' + r.status + '. No se cambio nada.' });
    }

    const sus = await r.json().catch(() => null);
    if (!sus || !sus.status) {
      return res.status(200).json({ ok: true, revisado: false,
        motivo: 'Respuesta ilegible de Mercado Pago. No se cambio nada.' });
    }

    if (sus.status === 'authorized') {
      return res.status(200).json({ ok: true, revisado: true, sigue: true,
        proximo_cobro: sus.next_payment_date || null });
    }

    // Dejo de estar autorizada. El acceso NO se corta de golpe: dura hasta
    // la fecha del proximo cobro que ya estaba paga. Mismo criterio que usa
    // el webhook cuando alguien cancela.
    const hasta = sus.next_payment_date ||
      (sus.auto_recurring && sus.auto_recurring.next_payment_date) || null;
    const fecha = hasta ? String(hasta).slice(0, 10) : new Date().toISOString().slice(0, 10);

    if (tienda.plan_vence === fecha) {
      return res.status(200).json({ ok: true, revisado: true, sigue: false, fecha: fecha, ya: true });
    }

    await sb('/rest/v1/store_profiles?slug=eq.' + encodeURIComponent(tienda.slug), {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: { plan_vence: fecha, plan_updated_at: new Date().toISOString() }
    });

    console.log('Suscripcion', sus.status, 'en', tienda.slug, '- acceso hasta', fecha);
    return res.status(200).json({ ok: true, revisado: true, sigue: false,
      estado: sus.status, fecha: fecha });
  }

  // ---- Modo diagnostico: mira y cuenta, no toca nada ----
  if ((req.body || {}).accion === 'diagnostico') {
    // Un cliente comun ve SOLO lo suyo. Antes veia el email y el monto de
    // todos los demas, que es de lo peor que puede filtrar una plataforma
    // de cobros.
    const admin = esAdmin(usuario.email);
    const porPlan = {};
    let conSlug = 0, sinSlug = 0;

    for (const [planId, nombre] of Object.entries(PLAN_POR_PREAPPROVAL_ID)) {
      const r = await suscripcionesDelPlan(planId);
      if (!r.ok) {
        porPlan[nombre] = { error: 'Mercado Pago contesto ' + r.status, crudo: r.crudo };
        continue;
      }
      const mias = r.resultados.filter((p) =>
        admin ||
        p.external_reference === tienda.slug ||
        String(p.payer_email || '').toLowerCase() === String(usuario.email || '').toLowerCase());

      porPlan[nombre] = mias.map((p) => {
        const ref = p.external_reference || '';
        if (ref) conSlug++; else sinSlug++;
        return {
          id: p.id,
          estado: p.status,
          // La pregunta del millon: ¿llego el slug que mandamos en el link?
          external_reference: ref || null,
          es_de_esta_tienda: ref === tienda.slug,
          // El email es la llave de rescate cuando no hay slug: si no
          // coincide con el de la cuenta, hay que atarla a mano.
          payer_email: p.payer_email || null,
          cobros: cobrosDe(p),
          ultimo_cobro: (p.summarized && p.summarized.last_charged_date) || null,
          desde: p.date_created || null,
          proximo_cobro: p.next_payment_date ||
            (p.auto_recurring && p.auto_recurring.next_payment_date) || null,
          monto: (p.auto_recurring && p.auto_recurring.transaction_amount) || null,
          // Si el plan tuviera prueba gratis, el primer cobro se difiere y
          // desde afuera se ve como "se suscribio y no le cobraron".
          prueba_gratis: (p.auto_recurring && p.auto_recurring.free_trial) || null
        };
      });
    }

    // ---- El cruce de cobranza: quien usa el servicio sin pagarlo ----
    let cobranza = null;
    if (admin) {
      // Las tiendas con plan pago en BRUWAL, con el email de su dueno.
      const conPlan = await sb('/rest/v1/store_profiles?plan=in.(basic,pro)' +
                               '&select=slug,business_name,plan,user_id&limit=200');

      // Todas las suscripciones de nuestros planes, con su email.
      const suscripciones = [];
      for (const planId of Object.keys(PLAN_POR_PREAPPROVAL_ID)) {
        const r = await suscripcionesDelPlan(planId);
        if (r.ok) r.resultados.forEach((p) => suscripciones.push(p));
      }
      const autorizadas = suscripciones.filter((p) => p.status === 'authorized');

      cobranza = [];
      for (const t of (conPlan || [])) {
        // El email del dueno, para poder cruzar cuando la suscripcion nacio
        // sin slug (que es el caso de casi todas).
        let email = null;
        try {
          const u = await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + encodeURIComponent(t.user_id), {
            headers: {
              apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
              Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY
            }
          });
          if (u.ok) { const d = await u.json(); email = d && d.email; }
        } catch (e) { /* sin el email, el cruce por slug igual sirve */ }

        const suya = autorizadas.find((p) =>
          p.external_reference === t.slug ||
          (email && String(p.payer_email || '').toLowerCase() === String(email).toLowerCase()));

        cobranza.push({
          negocio: t.business_name || t.slug,
          slug: t.slug,
          plan: t.plan,
          email: email,
          paga: !!suya,
          suscripcion: suya ? suya.id : null,
          monto: suya && suya.auto_recurring ? suya.auto_recurring.transaction_amount : null,
          proximo_cobro: suya ? (suya.next_payment_date ||
            (suya.auto_recurring && suya.auto_recurring.next_payment_date) || null) : null
        });
      }
      cobranza.sort((a, b) => (a.paga === b.paga) ? 0 : (a.paga ? 1 : -1));
    }

    return res.status(200).json({
      ok: true,
      diagnostico: true,
      admin: admin,
      cobranza: cobranza,
      tienda: tienda.slug,
      plan_en_bruwal: tienda.plan,
      con_slug: conSlug,
      sin_slug: sinSlug,
      // El veredicto, en una linea, para no tener que interpretar el JSON.
      veredicto: (conSlug + sinSlug) === 0
        ? 'Mercado Pago no tiene NINGUNA suscripcion de estos planes.'
        : (conSlug === 0
            ? 'HAY suscripciones pero NINGUNA trae el slug: Mercado Pago no guarda el ' +
              'external_reference que mandamos en el link, y por eso no las encontramos.'
            : 'El external_reference SI llega (' + conSlug + ' de ' + (conSlug + sinSlug) + ').'),
      por_plan: porPlan
    });
  }

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
      cobros: cobrosDe(p),
      ultimo_cobro: (p.summarized && p.summarized.last_charged_date) || null,
      proximo_cobro: p.next_payment_date ||
        (p.auto_recurring && p.auto_recurring.next_payment_date) || null
    }));

    // El plan se activa cuando la plata ENTRO, no cuando el medio de pago
    // quedo autorizado. cobros === null es "no se pudo saber": ahi se activa
    // igual, porque el dato que falta es nuestro, no una deuda del cliente.
    const yaPago = (p) => p.estado === 'authorized' && p.plan &&
                          (p.cobros === null || p.cobros > 0);

    let autorizada = vistas.find(yaPago);

    // Autorizada pero todavia sin cobrar: no se activa, y se dice CUANDO se
    // va a activar. Un "no encontramos tu pago" a alguien que acaba de dejar
    // su tarjeta es la forma mas rapida de perderlo.
    const esperandoElPrimerCobro = !autorizada &&
      vistas.find((p) => p.estado === 'authorized' && p.plan && p.cobros === 0);

    // No aparecio por slug. Puede ser que la suscripcion haya nacido SIN el
    // (Mercado Pago no guarda el external_reference que mandamos en el link
    // del plan): se la busca por el email del que paga.
    let rescatadaPorEmail = false;
    if (!autorizada) {
      const porEmail = await suscripcionPorEmail(usuario.email);
      const planDeEsa = porEmail && PLAN_POR_PREAPPROVAL_ID[porEmail.preapproval_plan_id];
      const cobrosDeEsa = porEmail ? cobrosDe(porEmail) : null;
      // Misma regla que arriba: sin cobro no se activa.
      if (porEmail && planDeEsa && (cobrosDeEsa === null || cobrosDeEsa > 0)) {
        autorizada = {
          id: porEmail.id,
          estado: porEmail.status,
          plan: planDeEsa,
          plan_id: porEmail.preapproval_plan_id,
          desde: porEmail.date_created || null,
          proximo_cobro: porEmail.next_payment_date ||
            (porEmail.auto_recurring && porEmail.auto_recurring.next_payment_date) || null
        };
        rescatadaPorEmail = true;
        vistas.push(autorizada);

        // Que no haga falta el rescate la proxima vez.
        await marcarSuscripcionConSlug(porEmail.id, tienda.slug);
      }
    }

    if (!autorizada) {
      // Una suscripción autorizada de un plan que no está en el mapa es el
      // caso peligroso: el cliente paga y nadie se entera de por qué no se
      // activa. Se dice con nombre y apellido.
      const desconocida = vistas.find((p) => p.estado === 'authorized' && !p.plan);
      return res.status(200).json({
        ok: false,
        plan_actual: tienda.plan,
        suscripciones: vistas,
        esperando_cobro: !!esperandoElPrimerCobro,
        proximo_cobro: esperandoElPrimerCobro ? esperandoElPrimerCobro.proximo_cobro : null,
        motivo: esperandoElPrimerCobro
          ? 'Tu suscripción está confirmada, pero Mercado Pago todavía no hizo el primer cobro' +
            (esperandoElPrimerCobro.proximo_cobro
              ? ' (está previsto para el ' + String(esperandoElPrimerCobro.proximo_cobro).slice(0, 10) + ')'
              : '') +
            '. Apenas entre el pago se te activa el plan solo.'
          : desconocida
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
      body: {
        plan: autorizada.plan,
        plan_vence: null,
        // De QUE suscripcion vino este plan. Es lo que despues permite
        // revisarla: sin esto no hay forma de saber si un plan activo lo
        // sostiene un debito automatico o lo puso alguien a mano, y por lo
        // tanto no se puede cortar al que dejo de pagar sin arriesgarse a
        // cortarle tambien al que paga por transferencia.
        mp_preapproval_id: autorizada.id || null,
        plan_updated_at: new Date().toISOString()
      }
    });

    console.log('Plan activado a mano desde el panel:', tienda.slug, '->', autorizada.plan);

    return res.status(200).json({
      ok: true,
      activado: true,
      plan: autorizada.plan,
      antes: tienda.plan,
      por_email: rescatadaPorEmail,
      suscripciones: vistas
    });
  } catch (err) {
    console.error('suscripcion.js', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
};
