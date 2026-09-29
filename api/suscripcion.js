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

const mail = require('./_mail');

const SUPABASE_URL = 'https://qduguqazpxjjpxjfnkif.supabase.co';
const MP_API = 'https://api.mercadopago.com';

// Version de este archivo. Sube con cada cambio de logica y viaja en cada
// respuesta. Sin esto, cuando algo falla no hay forma de saber si lo que
// esta corriendo tiene el arreglo o es el codigo viejo todavia cacheado:
// se pierde media hora discutiendo contra un fantasma.
const VERSION = 3;

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

// El correo de bienvenida, UNA sola vez por tienda.
//
// La marca se pide ANTES de mandar, con un PATCH que solo agarra si la
// columna sigue vacia. Los dos caminos que activan un plan (este boton y el
// webhook de Mercado Pago) pueden correr con segundos de diferencia; asi
// uno se queda con la marca y el otro no manda nada. El cliente recibe un
// mail, no dos.
//
// No tira hacia afuera por ningun motivo: cuando esto corre el plan YA esta
// activo, y un problema de correo no puede hacer parecer que el pago fallo.
async function mandarBienvenidaUnaVez({ req, slug, para, nombre }) {
  try {
    if (!mail.hayComoMandar() || !para) return false;

    const marcadas = await sb(
      '/rest/v1/store_profiles?slug=eq.' + encodeURIComponent(slug) +
      '&bienvenida_enviada_en=is.null',
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: { bienvenida_enviada_en: new Date().toISOString() }
      });

    // Vacio = la marca ya estaba puesta, o sea que el mail ya salio.
    if (!Array.isArray(marcadas) || !marcadas.length) return false;

    const base = 'https://' + (req.headers['x-forwarded-host'] || req.headers.host);
    return await mail.bienvenida({ base, para, nombre });
  } catch (err) {
    console.warn('No se pudo mandar la bienvenida a', para,
                 String((err && err.message) || err));
    return false;
  }
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
                         '&select=slug,business_name,plan,plan_vence,mp_preapproval_id' +
                         '&order=created_at.asc');
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
async function suscripcionPorEmail(email, slugPropio) {
  const buscado = String(email || '').trim().toLowerCase();
  if (!buscado || !buscado.includes('@')) return null;

  // Las candidatas: autorizadas y de alguno de nuestros planes.
  const candidatas = [];
  for (const planId of Object.keys(PLAN_POR_PREAPPROVAL_ID)) {
    const r = await suscripcionesDelPlan(planId);
    if (!r.ok) continue;
    r.resultados.forEach((p) => { if (p.status === 'authorized') candidatas.push(p); });
  }

  for (const p of candidatas) {
    // Si el email vino en la busqueda se usa y nos ahorramos la consulta,
    // pero en la practica viene null en todas.
    let suyo = String(p.payer_email || '').trim().toLowerCase();

    if (!suyo || !suyo.includes('@')) {
      // Antes de gastar una consulta: si esa suscripcion ya sostiene otra
      // tienda, no hace falta ni preguntar de quien es.
      const yaEsDeOtra = await tiendaQueYaUsaEsaSuscripcion(p.id, slugPropio);
      if (yaEsDeOtra) continue;

      const detalle = await detalleDeSuscripcion(p.id);
      suyo = String((detalle && detalle.payer_email) || '').trim().toLowerCase();
    }

    // Cada intento queda escrito con los dos emails a la vista. Este rescate
    // ya fallo DOS veces repartiendo el pago de uno entre varios, y las dos
    // veces se perdio tiempo adivinando por que. Con el log, la proxima se
    // lee.
    console.log('rescate por email: compara', JSON.stringify(suyo),
                'contra', JSON.stringify(buscado), '| suscripcion', p.id);

    // EL EMAIL DEL PAGADOR TIENE QUE EXISTIR DE VERDAD.
    //
    // Sin esta guarda paso lo peor que puede pasar en un sistema de cobros:
    // UNA suscripcion terminó activando el plan de CUATRO cuentas de cuatro
    // duenios distintos. Tres estaban usando el sistema con el pago de la
    // cuarta.
    //
    // El agujero era comparar dos vacios y darlos por iguales. Si no se
    // pudo averiguar de quien es, no se activa nada: es preferible que el
    // cliente tenga que escribir a soporte antes que darle el pago de otro.
    if (!suyo || !suyo.includes('@')) continue;
    if (suyo === buscado) return p;
  }

  return null;
}

// Antes de atar una suscripcion a una tienda: ¿ya esta atada a OTRA?
//
// Es la segunda red, y es la que de verdad cierra el problema: aunque un
// dia falle la comparacion de emails, una misma suscripcion no puede
// sostener dos cuentas. Devuelve el slug de la duenia, o null si esta libre.
async function tiendaQueYaUsaEsaSuscripcion(preapprovalId, slugPropio) {
  if (!preapprovalId) return null;
  const filas = await sb('/rest/v1/store_profiles?mp_preapproval_id=eq.' +
                         encodeURIComponent(preapprovalId) + '&select=slug&limit=2');
  const otra = (filas || []).find((t) => t.slug !== slugPropio);
  return otra ? otra.slug : null;
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

// ¿Esta suscripcion esta dentro de sus dias de prueba gratis?
//
// El plan Pro tiene 7 dias de prueba configurados en Mercado Pago: el
// cliente se suscribe, deja su tarjeta, y recien al octavo dia le cobran.
// Durante esos 7 dias TIENE que poder usar el sistema -- si no, la prueba
// no existe: dejo la tarjeta y no puede entrar, que es la peor combinacion
// posible.
//
// Mercado Pago lo marca con auto_recurring.free_trial. Mientras el primer
// cobro este en el futuro, esta en prueba.
function enPruebaGratis(p) {
  const ar = (p && p.auto_recurring) || null;
  if (!ar || !ar.free_trial) return false;

  const proximo = p.next_payment_date || ar.next_payment_date || null;
  if (!proximo) return true;   // hay prueba y no sabemos cuando cobra: se le da

  const cuando = new Date(proximo).getTime();
  return isFinite(cuando) && cuando > Date.now();
}

async function suscripcionesDeSlug(slug) {
  const r = await fetch(MP_API + '/preapproval/search?external_reference=' + encodeURIComponent(slug),
    { headers: { Authorization: 'Bearer ' + process.env.MP_ACCESS_TOKEN } });

  const datos = await r.json().catch(() => null);
  if (!r.ok) return { ok: false, status: r.status, crudo: datos };

  // MERCADO PAGO IGNORA ESTE FILTRO. Medido: pidiendo
  // external_reference=vap-sanlo-import devolvio las TRES suscripciones de
  // la cuenta. Como mas abajo se agarra "la primera autorizada", a un
  // cliente nuevo le tocaba la suscripcion de otro, y lo unico que lo freno
  // fue el indice unico de la base.
  //
  // Asi que el filtro se hace aca. Si algun dia Mercado Pago lo respeta,
  // esto no molesta: filtrar lo ya filtrado da la misma lista.
  const todas = (datos && datos.results) || [];
  const suyas = todas.filter((p) => p.external_reference === slug);

  if (todas.length !== suyas.length) {
    console.warn('MP devolvio', todas.length, 'suscripciones para el slug', slug,
                 'y solo', suyas.length, 'lo traen de verdad. Filtrado de este lado.');
  }

  return { ok: true, resultados: suyas };
}

// El detalle de UNA suscripcion.
//
// POR QUE HACE FALTA: la BUSQUEDA no devuelve payer_email -- verificado
// contra la cuenta real, viene null en las tres. El detalle de a una si lo
// trae (es el mismo dato que lee el webhook desde siempre). Sin esto no hay
// ninguna forma de saber de quien es una suscripcion, porque el
// external_reference tampoco llega.
async function detalleDeSuscripcion(id) {
  try {
    const r = await fetch(MP_API + '/preapproval/' + encodeURIComponent(id), {
      headers: { Authorization: 'Bearer ' + process.env.MP_ACCESS_TOKEN }
    });
    if (!r.ok) {
      console.warn('No se pudo leer el detalle de', id, r.status);
      return null;
    }
    return await r.json();
  } catch (err) {
    console.warn('Error leyendo el detalle de', id, err && err.message);
    return null;
  }
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
  // ---- Atar la suscripcion con el ID que devuelve Mercado Pago ----
  //
  // Es el unico camino que NO adivina. Mercado Pago no da forma de saber de
  // quien es una suscripcion (no guarda el external_reference, ignora el
  // filtro de la busqueda, y no devuelve payer_email ni en la busqueda ni
  // en el detalle -- las tres cosas medidas). Pero al terminar el pago
  // devuelve al cliente a nuestra pagina con ?preapproval_id=... y ese ID
  // llega en el navegador del que acaba de pagar, con su sesion abierta.
  //
  // Quien es sale de la sesion. Que suscripcion es sale de la URL. Nada se
  // deduce.
  if ((req.body || {}).accion === 'atar') {
    const pedido = String((req.body || {}).preapproval_id || '').trim();

    // Los ids de Mercado Pago son 32 caracteres hexadecimales. Cualquier
    // otra cosa ni se consulta.
    if (!/^[0-9a-f]{32}$/i.test(pedido)) {
      return res.status(400).json({ error: 'Identificador de suscripcion invalido' });
    }

    const detalle = await detalleDeSuscripcion(pedido);
    if (!detalle || !detalle.id) {
      return res.status(200).json({
        ok: false,
        motivo: 'Mercado Pago no reconoce esa suscripcion. Si acabas de pagar, espera un ' +
                'minuto y volve a entrar.'
      });
    }

    const plan = PLAN_POR_PREAPPROVAL_ID[detalle.preapproval_plan_id];
    if (!plan) {
      console.warn('Intento de atar una suscripcion de un plan desconocido:',
                   pedido, detalle.preapproval_plan_id);
      return res.status(200).json({
        ok: false,
        motivo: 'Esa suscripcion es de un plan que el sistema no reconoce (' +
                detalle.preapproval_plan_id + '). Avisale a soporte con ese codigo.'
      });
    }

    if (detalle.status !== 'authorized') {
      return res.status(200).json({
        ok: false,
        motivo: 'Mercado Pago todavia no confirmo esa suscripcion (figura ' +
                detalle.status + '). Apenas la confirme se activa sola.'
      });
    }

    // GUARDA 1: tiene que ser recien hecha.
    //
    // El ID viaja en una direccion y cualquiera puede escribir una
    // direccion. Con esta ventana, un ID que alguien haya conseguido de
    // otro lado no sirve para nada: para cuando lo tenga, ya vencio.
    const nacio = Date.parse(detalle.date_created || '');
    const horas = isNaN(nacio) ? Infinity : (Date.now() - nacio) / 3600000;
    if (!(horas >= -1 && horas < 6)) {
      console.warn('Se quiso atar una suscripcion vieja:', pedido,
                   'creada hace', Math.round(horas), 'horas, tienda', tienda.slug);
      return res.status(200).json({
        ok: false,
        motivo: 'Esa suscripcion no es de este pago. Si ya pagaste y tu plan sigue sin ' +
                'activarse, escribinos y lo resolvemos a mano.'
      });
    }

    // GUARDA 2: que no sea de otra tienda.
    const yaEsDeOtra = await tiendaQueYaUsaEsaSuscripcion(detalle.id, tienda.slug);
    if (yaEsDeOtra) {
      console.warn('Se quiso atar a', tienda.slug, 'la suscripcion', detalle.id,
                   'que ya es de', yaEsDeOtra);
      return res.status(200).json({
        ok: false,
        motivo: 'Ese pago ya esta asociado a otra cuenta. Si pagaste recien, escribinos ' +
                'y lo revisamos.'
      });
    }

    // GUARDA 3: que la plata haya entrado, o que este dentro de la prueba
    // que le prometimos en el checkout.
    const cobros = cobrosDe(detalle);
    if (!(cobros === null || cobros > 0 || enPruebaGratis(detalle))) {
      const proximo = detalle.next_payment_date ||
        (detalle.auto_recurring && detalle.auto_recurring.next_payment_date) || null;
      return res.status(200).json({
        ok: false,
        esperando_cobro: true,
        proximo_cobro: proximo,
        motivo: 'Tu suscripcion quedo confirmada, pero Mercado Pago todavia no hizo el ' +
                'primer cobro' +
                (proximo ? ' (esta previsto para el ' + String(proximo).slice(0, 10) + ')' : '') +
                '. Apenas entre el pago se te activa el plan solo.'
      });
    }

    try {
      await sb('/rest/v1/store_profiles?slug=eq.' + encodeURIComponent(tienda.slug), {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: {
          plan,
          plan_vence: null,
          mp_preapproval_id: detalle.id,
          plan_updated_at: new Date().toISOString()
        }
      });
    } catch (err) {
      const texto = String((err && err.message) || err);
      if (texto.includes('23505')) {
        return res.status(200).json({
          ok: false,
          motivo: 'Ese pago ya esta asociado a otra cuenta. Si pagaste recien, escribinos ' +
                  'y lo revisamos.'
        });
      }
      console.error('No se pudo atar la suscripcion de', tienda.slug, texto);
      return res.status(200).json({
        ok: false,
        motivo: 'No pudimos activar el plan en este momento. Probá de nuevo en un rato.'
      });
    }

    console.log('Plan activado por el ID de vuelta de Mercado Pago:',
                tienda.slug, '->', plan, '(' + detalle.id + ')');

    // Que quede atada tambien del lado de Mercado Pago. Si el PUT no anda,
    // no importa: ya la tenemos guardada en mp_preapproval_id.
    await marcarSuscripcionConSlug(detalle.id, tienda.slug);

    await mandarBienvenidaUnaVez({
      req, slug: tienda.slug, para: usuario.email, nombre: tienda.business_name
    });

    return res.status(200).json({
      ok: true,
      activado: true,
      atada: true,
      plan,
      antes: tienda.plan
    });
  }

  // ---- Mandarse el correo de bienvenida, para verlo de verdad ----
  //
  // No recibe direccion de destino: sale al email de la sesion y a ninguno
  // mas. Un boton que aceptara un destinatario seria una forma comoda de
  // mandar correo con nuestro dominio a cualquiera.
  //
  // Saltea la marca bienvenida_enviada_en a proposito: es una prueba y tiene
  // que poder repetirse.
  if ((req.body || {}).accion === 'probar-mail') {
    if (!esAdmin(usuario.email)) {
      return res.status(403).json({ error: 'Solo para la cuenta de soporte' });
    }
    if (!mail.hayComoMandar()) {
      return res.status(200).json({
        ok: false,
        motivo: 'Falta RESEND_API_KEY en Vercel. Cargala y hace un redeploy.'
      });
    }

    const base = 'https://' + (req.headers['x-forwarded-host'] || req.headers.host);
    const salio = await mail.bienvenida({
      base,
      para: usuario.email,
      nombre: tienda.business_name || tienda.slug
    });

    return res.status(200).json({
      ok: salio,
      para: usuario.email,
      motivo: salio ? null : 'Resend no lo acepto. Mira los logs de la funcion en Vercel.'
    });
  }

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

    // ---- De quien es cada suscripcion, preguntado de a una ----
    //
    // La busqueda devuelve payer_email en null siempre. Esto pide el
    // detalle, que es el unico lugar donde el dato aparece. Solo para el
    // admin: son una consulta por suscripcion.
    let duenios = null;
    if (admin) {
      duenios = [];
      for (const planId of Object.keys(PLAN_POR_PREAPPROVAL_ID)) {
        const r = await suscripcionesDelPlan(planId);
        if (!r.ok) continue;
        for (const p of r.resultados) {
          if (p.status !== 'authorized') continue;
          if (duenios.some((d) => d.id === p.id)) continue;
          const detalle = await detalleDeSuscripcion(p.id);
          duenios.push({
            id: p.id,
            en_la_busqueda: p.payer_email || null,
            en_el_detalle: (detalle && detalle.payer_email) || null,
            ref: (detalle && detalle.external_reference) || null
          });
        }
      }
    }

    // ---- El cruce de cobranza: quien usa el servicio sin pagarlo ----
    let cobranza = null;
    if (admin) {
      // Las tiendas con plan pago en BRUWAL, con el email de su dueno.
      const conPlan = await sb('/rest/v1/store_profiles?plan=in.(basic,pro)' +
                               '&select=slug,business_name,plan,user_id,mp_preapproval_id&limit=200');

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

        // EL CAMPO QUE FALTABA MIRAR, y daba un falso "no paga" a dos
        // clientes que si pagan: la suscripcion que la tienda YA tiene
        // anotada. Es el unico dato confiable de los tres, porque los
        // otros dos dependen de Mercado Pago:
        //
        //  - external_reference viene vacio SIEMPRE (no lo guarda);
        //  - payer_email no viene en la busqueda de suscripciones.
        //
        // Con el cruce mirando solo esos dos, el panel decia "✗ NO" para
        // todos. Alguien podria haber cortado el servicio a dos clientes
        // al dia por creerle a esa tabla.
        const suya = autorizadas.find((p) =>
          (t.mp_preapproval_id && String(p.id) === String(t.mp_preapproval_id)) ||
          (p.external_reference && p.external_reference === t.slug) ||
          (email && p.payer_email &&
           String(p.payer_email).toLowerCase() === String(email).toLowerCase()));

        cobranza.push({
          negocio: t.business_name || t.slug,
          slug: t.slug,
          plan: t.plan,
          email: email,
          paga: !!suya,
          // Como se supo que paga. Si manana el cruce vuelve a equivocarse,
          // esto dice por cual de los tres caminos entro.
          por: suya
            ? (t.mp_preapproval_id && String(suya.id) === String(t.mp_preapproval_id) ? 'suscripcion guardada'
               : suya.external_reference === t.slug ? 'slug'
               : 'email')
            : null,
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
      version: VERSION,
      diagnostico: true,
      admin: admin,
      duenios: duenios,
      correo_configurado: mail.hayComoMandar(),
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
      en_prueba: enPruebaGratis(p),
      ultimo_cobro: (p.summarized && p.summarized.last_charged_date) || null,
      proximo_cobro: p.next_payment_date ||
        (p.auto_recurring && p.auto_recurring.next_payment_date) || null
    }));

    // El plan se activa cuando la plata ENTRO, no cuando el medio de pago
    // quedo autorizado. cobros === null es "no se pudo saber": ahi se activa
    // igual, porque el dato que falta es nuestro, no una deuda del cliente.
    // Tiene derecho a usar el sistema si ya pago, O si esta dentro de los
    // dias de prueba que le prometimos en el checkout.
    const yaPago = (p) => p.estado === 'authorized' && p.plan &&
                          (p.cobros === null || p.cobros > 0 || p.en_prueba);

    let autorizada = vistas.find(yaPago);

    // Autorizada pero todavia sin cobrar: no se activa, y se dice CUANDO se
    // va a activar. Un "no encontramos tu pago" a alguien que acaba de dejar
    // su tarjeta es la forma mas rapida de perderlo.
    // Autorizada, sin cobrar y SIN prueba: ese es el que espera el primer
    // cobro. El que esta en prueba ya entro por yaPago().
    const esperandoElPrimerCobro = !autorizada &&
      vistas.find((p) => p.estado === 'authorized' && p.plan && p.cobros === 0 && !p.en_prueba);

    // No aparecio por slug. Puede ser que la suscripcion haya nacido SIN el
    // (Mercado Pago no guarda el external_reference que mandamos en el link
    // del plan): se la busca por el email del que paga.
    let rescatadaPorEmail = false;
    if (!autorizada) {
      const porEmail = await suscripcionPorEmail(usuario.email, tienda.slug);
      const planDeEsa = porEmail && PLAN_POR_PREAPPROVAL_ID[porEmail.preapproval_plan_id];
      const cobrosDeEsa = porEmail ? cobrosDe(porEmail) : null;
      // Misma regla que arriba: sin cobro no se activa, salvo que este
      // dentro de los dias de prueba.
      // Aunque el email haya dado juego, si esa suscripcion ya sostiene
      // otra cuenta NO se activa: una suscripcion, una tienda.
      //
      // Esto dejo de ser una precaucion teorica: paso dos veces. La segunda
      // fue un socio probando con la cuenta de la Pañalera, a quien el
      // sistema le ofrecio la suscripcion de Fabricio -- dos emails que no
      // se parecen en nada. Lo unico que lo freno fue el indice de la base.
      const yaEsDeOtra = porEmail
        ? await tiendaQueYaUsaEsaSuscripcion(porEmail.id, tienda.slug)
        : null;

      if (yaEsDeOtra) {
        console.warn('La suscripcion', porEmail.id, 'ya es de', yaEsDeOtra,
                     '- no se activa', tienda.slug);
      } else if (porEmail && planDeEsa &&
          (cobrosDeEsa === null || cobrosDeEsa > 0 || enPruebaGratis(porEmail))) {
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
        version: VERSION,
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
    // La escritura va con red: si la base la rechaza, el cliente NO puede
    // recibir el error crudo de Postgres. Le paso a un vendedor de verdad:
    // apreto "Ya pague" y le aparecio
    //   'Supabase 409: {"code":"23505","details":"Key (mp_preapproval_id)...'
    // Eso no le dice nada y parece que la plataforma se rompio.
    try {
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
    } catch (err) {
      const texto = String((err && err.message) || err);

      // 23505 = la suscripcion ya esta tomada por otra cuenta. Es el indice
      // que impide que un pago sostenga dos tiendas. No es un error del
      // cliente ni de la plataforma: es que ese pago no es suyo.
      if (texto.includes('23505') || texto.includes('store_profiles_una_suscripcion_una_tienda')) {
        console.warn('Se quiso atar a', tienda.slug, 'una suscripcion que ya es de otra cuenta:',
                     autorizada.id);
        return res.status(200).json({
          ok: false,
          suscripcion_de_otro: true,
          suscripciones: vistas,
          motivo: 'El pago que encontramos ya está asociado a otra cuenta, así que no es de ' +
                  'esta tienda. Si pagaste recién, escribinos y lo revisamos: puede ser que hayas ' +
                  'pagado con un mail distinto al de tu cuenta.'
        });
      }

      console.error('No se pudo activar el plan de', tienda.slug, texto);
      return res.status(200).json({
        ok: false,
        suscripciones: vistas,
        motivo: 'No pudimos activar el plan en este momento. Probá de nuevo en un rato o escribinos.'
      });
    }

    console.log('Plan activado a mano desde el panel:', tienda.slug, '->', autorizada.plan);

    // Recien ahora, con el plan ya escrito.
    await mandarBienvenidaUnaVez({
      req,
      slug: tienda.slug,
      para: usuario.email,
      nombre: tienda.business_name
    });

    return res.status(200).json({
      ok: true,
      version: VERSION,
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
