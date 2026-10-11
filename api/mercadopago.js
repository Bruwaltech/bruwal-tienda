// Cuenta de Mercado Pago de cada tienda: conectarla y leer sus cobros.
//
// No confundir con las suscripciones a BRUWAL (mercadopago-webhook.js,
// suscripcion.js), que usan el token de la cuenta de BRUWAL. Acá cada
// negocio autoriza a la aplicación de BRUWAL por OAuth, igual que con
// Mercado Libre, y nosotros leemos SUS cobros con SU token.
//
// Para qué: que el dueño vea en el panel cuánto cobró por Mercado Pago en
// el mes, cuánto se llevó MP de comisión, cuánto le retuvieron de
// impuestos (Ingresos Brutos y otros) y cuánto le quedó de verdad. Es el
// número que hace falta para saber el costo real de vender.
//
// Variables de entorno (de la aplicación de BRUWAL en Mercado Pago
// Developers, con OAuth habilitado):
//   MP_CLIENT_ID, MP_CLIENT_SECRET
//   MP_REDIRECT_URI (opcional; por defecto https://<host>/api/mp-callback)
//
// Acciones (POST, con el token de sesión de Supabase):
//   estado       -> { conectado, nickname, conectado_en }
//   conectar     -> { url } para autorizar en Mercado Pago
//   desconectar  -> borra la cuenta de la tienda
//   resumen      -> { mes: 'AAAA-MM' } totales del mes
// Y por GET la vuelta de Mercado Pago: /api/mp-callback?code=...&state=...

const crypto = require('crypto');

const SUPABASE_URL = 'https://qduguqazpxjjpxjfnkif.supabase.co';
const MP_API = 'https://api.mercadopago.com';
const MP_AUTH_URL = process.env.MP_AUTH_URL || 'https://auth.mercadopago.com.ar/authorization';
const STATE_VALIDO_MS = 10 * 60 * 1000;

// Tope de cobros que se leen por mes (de a 100). Un negocio chico no
// llega; si alguno pasa, el resumen avisa que está cortado en vez de
// mostrar un número que parece completo y no lo es.
const MAX_PAGINAS = 30;

function faltanVariables() {
  return ['MP_CLIENT_ID', 'MP_CLIENT_SECRET', 'SUPABASE_SERVICE_ROLE_KEY']
    .filter((n) => !process.env[n]);
}

function urlDeRetorno(req) {
  if (process.env.MP_REDIRECT_URI) return process.env.MP_REDIRECT_URI;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return 'https://' + host + '/api/mp-callback';
}

// ---------- Sesión y Supabase (igual que api/mercadolibre.js) ----------

async function usuarioDeToken(token) {
  const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { Authorization: 'Bearer ' + token, apikey: process.env.SUPABASE_SERVICE_ROLE_KEY }
  });
  if (!r.ok) return null;
  return r.json();
}

async function tiendaDelUsuario(userId, slugPedido) {
  const filas = await sb('/rest/v1/store_profiles?user_id=eq.' + encodeURIComponent(userId) +
                         '&select=slug,plan&order=created_at.asc');
  if (!filas || !filas.length) return null;
  if (slugPedido) {
    const suya = filas.find((t) => t.slug === slugPedido);
    if (suya) return suya;
  }
  return filas[0];
}

async function sb(ruta, opciones) {
  const o = opciones || {};
  const r = await fetch(SUPABASE_URL + ruta, {
    method: o.method || 'GET',
    headers: Object.assign({
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json'
    }, o.headers || {}),
    body: o.body ? JSON.stringify(o.body) : undefined
  });
  if (!r.ok) {
    const detalle = await r.text();
    throw new Error('Supabase ' + r.status + ': ' + detalle.slice(0, 300));
  }
  if (r.status === 204) return null;
  const texto = await r.text();
  return texto ? JSON.parse(texto) : null;
}

// ---------- state firmado (mismo esquema que Mercado Libre) ----------

function firmar(texto) {
  return crypto.createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY)
    .update('mp:' + texto).digest('base64url');
}

function armarEstado(slug) {
  const datos = Buffer.from(JSON.stringify({ slug: slug, t: Date.now() })).toString('base64url');
  return datos + '.' + firmar(datos);
}

function leerEstado(state) {
  const partes = String(state || '').split('.');
  if (partes.length !== 2) return null;
  const esperada = Buffer.from(firmar(partes[0]));
  const recibida = Buffer.from(partes[1]);
  if (esperada.length !== recibida.length || !crypto.timingSafeEqual(esperada, recibida)) return null;
  let datos;
  try { datos = JSON.parse(Buffer.from(partes[0], 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!datos || !datos.slug || Date.now() - Number(datos.t || 0) > STATE_VALIDO_MS) return null;
  return datos;
}

// ---------- Tokens ----------

async function pedirToken(parametros) {
  const r = await fetch(MP_API + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(Object.assign({
      client_id: process.env.MP_CLIENT_ID,
      client_secret: process.env.MP_CLIENT_SECRET
    }, parametros))
  });
  const datos = await r.json().catch(() => ({}));
  if (!r.ok || !datos.access_token) {
    throw new Error('Mercado Pago rechazó el token: ' + (datos.message || datos.error || ('HTTP ' + r.status)));
  }
  return datos;
}

function vencimiento(expiresIn) {
  const segundos = Number(expiresIn || 0) || 180 * 24 * 3600;
  return new Date(Date.now() + (segundos - 3600) * 1000).toISOString();
}

async function guardarCuenta(slug, datos, usuario) {
  await sb('/rest/v1/store_mp_cuenta?on_conflict=store_slug', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: [{
      store_slug: slug,
      mp_user_id: String(datos.user_id),
      nickname: (usuario && (usuario.nickname || usuario.email)) || null,
      access_token: datos.access_token,
      refresh_token: datos.refresh_token || null,
      expira_en: vencimiento(datos.expires_in),
      actualizado_en: new Date().toISOString()
    }]
  });
}

async function tokenDeTienda(slug) {
  const filas = await sb('/rest/v1/store_mp_cuenta?store_slug=eq.' + encodeURIComponent(slug) +
                         '&select=mp_user_id,access_token,refresh_token,expira_en');
  const cuenta = filas && filas[0];
  if (!cuenta) return null;
  if (new Date(cuenta.expira_en).getTime() > Date.now()) return { token: cuenta.access_token, mpUserId: cuenta.mp_user_id };
  if (!cuenta.refresh_token) return null;

  // Igual que en ML, el refresh_token se renueva al usarlo: se guardan
  // los dos juntos o la conexión se muere.
  const datos = await pedirToken({ grant_type: 'refresh_token', refresh_token: cuenta.refresh_token });
  await sb('/rest/v1/store_mp_cuenta?store_slug=eq.' + encodeURIComponent(slug), {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: {
      access_token: datos.access_token,
      refresh_token: datos.refresh_token || cuenta.refresh_token,
      expira_en: vencimiento(datos.expires_in),
      actualizado_en: new Date().toISOString()
    }
  });
  return { token: datos.access_token, mpUserId: cuenta.mp_user_id };
}

// ---------- Resumen del mes ----------

// El mes en hora argentina: un cobro del 31 a las 23 h es del 31, no del 1.
function rangoDelMes(mes) {
  if (!/^\d{4}-\d{2}$/.test(String(mes || ''))) throw new Error('Mes inválido');
  const [a, m] = mes.split('-').map(Number);
  const desde = new Date(Date.UTC(a, m - 1, 1, 3, 0, 0));    // 00:00 en Argentina
  const hasta = new Date(Date.UTC(a, m, 1, 3, 0, 0) - 1);
  return { desde: desde.toISOString(), hasta: hasta.toISOString() };
}

function sumar(lista, filtro) {
  return (lista || []).filter(filtro || (() => true)).reduce((s, x) => s + Number(x.amount || 0), 0);
}

// Cuánto se llevó MP de cada cobro, separado en comisión e impuestos.
//
// fee_details trae las comisiones. Los impuestos retenidos (IIBB y otros)
// vienen en charges_details con type 'tax' cuando MP los informa ahí; si
// no, se calculan como lo que falta entre bruto, comisión y neto. Las
// retenciones que MP aplica recién al liberar la plata no siempre figuran
// en el cobro: para el número fiscal exacto está el reporte de
// retenciones de Mercado Pago.
function desglosarCobro(p) {
  const bruto = Number(p.transaction_amount || 0);
  const neto = Number((p.transaction_details || {}).net_received_amount);
  const comision = sumar(p.fee_details);
  const cargos = Array.isArray(p.charges_details) ? p.charges_details : [];
  let impuestos = sumar(cargos, (c) => c.type === 'tax' && (!c.accounts || c.accounts.from === 'collector'));
  if (!impuestos && Number.isFinite(neto)) impuestos = Math.max(0, bruto - comision - neto);
  return {
    bruto: bruto,
    comision: comision,
    impuestos: impuestos,
    neto: Number.isFinite(neto) ? neto : bruto - comision - impuestos
  };
}

async function accionResumen(slug, mes) {
  const cuenta = await tokenDeTienda(slug);
  if (!cuenta) return { conectado: false };
  const token = cuenta.token;

  const { desde, hasta } = rangoDelMes(mes);
  const totales = { cobros: 0, bruto: 0, comision: 0, impuestos: 0, neto: 0, devuelto: 0 };
  const porMedio = {};
  let cortado = false;

  for (let pagina = 0; ; pagina++) {
    if (pagina >= MAX_PAGINAS) { cortado = true; break; }
    const url = MP_API + '/v1/payments/search?sort=date_created&criteria=asc' +
      '&range=date_created&begin_date=' + encodeURIComponent(desde) + '&end_date=' + encodeURIComponent(hasta) +
      '&limit=100&offset=' + (pagina * 100);
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    const datos = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Mercado Pago: ' + (datos.message || ('HTTP ' + r.status)));

    (datos.results || []).forEach((p) => {
      // Solo lo que cobró la tienda: los pagos que HIZO con esa cuenta
      // también aparecen en la búsqueda y no son ventas.
      if (p.collector_id && String(p.collector_id) !== String(cuenta.mpUserId)) return;
      if (p.status === 'refunded' || p.status === 'charged_back') {
        totales.devuelto += Number(p.transaction_amount || 0);
        return;
      }
      if (p.status !== 'approved') return;
      const d = desglosarCobro(p);
      totales.cobros += 1;
      totales.bruto += d.bruto;
      totales.comision += d.comision;
      totales.impuestos += d.impuestos;
      totales.neto += d.neto;
      const medio = p.payment_type_id || 'otro';
      porMedio[medio] = (porMedio[medio] || 0) + d.bruto;
    });

    const total = Number((datos.paging || {}).total || 0);
    if ((pagina + 1) * 100 >= total || !(datos.results || []).length) break;
  }

  const redondear = (n) => Math.round(n * 100) / 100;
  Object.keys(totales).forEach((k) => { totales[k] = redondear(totales[k]); });
  return { conectado: true, mes: mes, totales: totales, por_medio: porMedio, cortado: cortado };
}

// ---------- Conectar / desconectar ----------

async function accionEstado(slug) {
  const filas = await sb('/rest/v1/store_mp_cuenta?store_slug=eq.' + encodeURIComponent(slug) +
                         '&select=nickname,conectado_en');
  const cuenta = filas && filas[0];
  if (!cuenta) return { conectado: false };
  return { conectado: true, nickname: cuenta.nickname, conectado_en: cuenta.conectado_en };
}

function accionConectar(req, slug) {
  return {
    url: MP_AUTH_URL +
      '?client_id=' + encodeURIComponent(process.env.MP_CLIENT_ID) +
      '&response_type=code&platform_id=mp' +
      '&state=' + encodeURIComponent(armarEstado(slug)) +
      '&redirect_uri=' + encodeURIComponent(urlDeRetorno(req))
  };
}

async function accionDesconectar(slug) {
  await sb('/rest/v1/store_mp_cuenta?store_slug=eq.' + encodeURIComponent(slug), {
    method: 'DELETE', headers: { Prefer: 'return=minimal' }
  });
  return { desconectado: true };
}

async function accionCallback(req, res) {
  const volver = (p) => res.writeHead(302, { Location: '/dashboard/?' + new URLSearchParams(p).toString() }).end();
  const { code, state, error } = req.query || {};
  if (error) return volver({ mp: 'error', motivo: String(error).slice(0, 120) });
  if (!code) return volver({ mp: 'error', motivo: 'Mercado Pago no devolvió el código' });
  const estado = leerEstado(state);
  if (!estado) return volver({ mp: 'error', motivo: 'El pedido de conexión venció o no es válido. Probá de nuevo.' });

  try {
    const datos = await pedirToken({ grant_type: 'authorization_code', code: code, redirect_uri: urlDeRetorno(req) });
    let usuario = null;
    try {
      const r = await fetch(MP_API + '/users/me', { headers: { Authorization: 'Bearer ' + datos.access_token } });
      if (r.ok) usuario = await r.json();
    } catch (e) { /* sin nombre, la conexión igual sirve */ }
    await guardarCuenta(estado.slug, datos, usuario);
    return volver({ mp: 'conectado', cuenta: (usuario && (usuario.nickname || '')) || '' });
  } catch (err) {
    return volver({ mp: 'error', motivo: String(err.message || err).slice(0, 160) });
  }
}

// ---------- Entrada ----------

module.exports = async (req, res) => {
  const faltan = faltanVariables();
  if (faltan.length) {
    if (req.method === 'GET') {
      return res.writeHead(302, {
        Location: '/dashboard/?mp=error&motivo=' + encodeURIComponent('Faltan configurar en el servidor: ' + faltan.join(', '))
      }).end();
    }
    return res.status(500).json({ error: 'La conexión con Mercado Pago todavía no está activada. Faltan: ' + faltan.join(', ') });
  }

  if (req.method === 'GET' && (req.query || {}).accion === 'callback') return accionCallback(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const cabecera = req.headers.authorization || '';
  const token = cabecera.startsWith('Bearer ') ? cabecera.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Falta la sesión' });
  const usuario = await usuarioDeToken(token);
  if (!usuario || !usuario.id) return res.status(401).json({ error: 'Sesión inválida' });

  const cuerpo = req.body || {};
  const accion = cuerpo.accion || '';
  const tienda = await tiendaDelUsuario(usuario.id, cuerpo.slug);
  if (!tienda) return res.status(403).json({ error: 'Este usuario no tiene tienda' });

  try {
    if (accion === 'estado') return res.status(200).json(await accionEstado(tienda.slug));
    if (accion === 'conectar') return res.status(200).json(accionConectar(req, tienda.slug));
    if (accion === 'desconectar') return res.status(200).json(await accionDesconectar(tienda.slug));
    if (accion === 'resumen') return res.status(200).json(await accionResumen(tienda.slug, cuerpo.mes));
    return res.status(400).json({ error: 'Acción desconocida' });
  } catch (err) {
    console.error('mercadopago.js', accion, err);
    return res.status(500).json({ error: String(err.message || err) });
  }
};

module.exports._probar = { desglosarCobro, rangoDelMes, armarEstado, leerEstado };
