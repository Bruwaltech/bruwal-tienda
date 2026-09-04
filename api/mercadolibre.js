// Conexión de la cuenta de Mercado Libre de una tienda.
//
// Por qué esto vive en el servidor y no en el dashboard: renovar el token
// de ML exige el client_secret de la aplicación, y el access_token dura
// solo 6 horas. Un secret en el navegador es un secret público, así que
// todo lo que toca la API de ML pasa por acá. El panel nunca ve un token:
// pregunta "¿está conectada?" y le contestamos sí o no.
//
// Ojo con el refresh_token: Mercado Libre lo invalida en cada uso y
// devuelve uno nuevo. Si no se guarda el nuevo, la conexión se muere y hay
// que volver a autorizar a mano. Por eso renovarToken() escribe SIEMPRE los
// dos tokens juntos.
//
// Acciones (POST, con el token de sesión de Supabase en Authorization):
//   estado        -> { conectado, nickname, ml_user_id, conectado_en }
//   conectar      -> { url } para mandar al vendedor a autorizar en ML
//   desconectar   -> borra la cuenta de la tienda
//   publicaciones -> las publicaciones activas de la cuenta, con su stock
//   publicidad    -> campañas de Product Ads y sus métricas, si la cuenta
//                    las tiene habilitadas
// Y una por GET, que es la que abre Mercado Libre al volver:
//   callback     -> /api/ml-callback?code=...&state=...

const crypto = require('crypto');

const SUPABASE_URL = 'https://qduguqazpxjjpxjfnkif.supabase.co';
const ML_API = 'https://api.mercadolibre.com';

// El dominio de autorización es POR PAÍS (.com.ar, .com.br, .com.mx...).
// Queda en variable de entorno para no tener que tocar código si mañana se
// conecta una cuenta de otro país: el valor exacto lo muestra Mercado Libre
// en la ficha de la aplicación, en developers.mercadolibre.com.ar.
const ML_AUTH_URL = process.env.ML_AUTH_URL || 'https://auth.mercadolibre.com.ar/authorization';

// El state vale 10 minutos: es el tiempo de ir a ML, loguearse y aceptar.
const STATE_VALIDO_MS = 10 * 60 * 1000;

function faltanVariables() {
  return ['ML_CLIENT_ID', 'ML_CLIENT_SECRET', 'SUPABASE_SERVICE_ROLE_KEY']
    .filter((n) => !process.env[n]);
}

// La URL de retorno tiene que ser EXACTAMENTE la que está cargada en la
// aplicación de Mercado Libre, si no ML rechaza la autorización. Sin query
// string a propósito (varios proveedores de OAuth no la aceptan): el
// rewrite de vercel.json manda /api/ml-callback a este archivo.
function urlDeRetorno(req) {
  if (process.env.ML_REDIRECT_URI) return process.env.ML_REDIRECT_URI;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return 'https://' + host + '/api/ml-callback';
}

// ---------- Sesión del vendedor ----------

async function usuarioDeToken(token) {
  const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { Authorization: 'Bearer ' + token, apikey: process.env.SUPABASE_SERVICE_ROLE_KEY }
  });
  if (!r.ok) return null;
  return r.json();
}

async function tiendaDelUsuario(userId) {
  const filas = await sb('/rest/v1/store_profiles?user_id=eq.' + encodeURIComponent(userId) + '&select=slug,plan');
  return (filas && filas[0]) || null;
}

// ---------- Supabase con service role (salta RLS) ----------

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

// ---------- state firmado ----------
//
// El state hace dos cosas: dice a qué tienda pertenece la autorización
// cuando ML nos devuelve el control, y evita que alguien invente ese
// regreso con la tienda de otro. Va firmado con HMAC usando la service
// role key, que es un secreto que solo existe en el servidor.

function firmar(texto) {
  return crypto.createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY)
    .update(texto).digest('base64url');
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
  if (esperada.length !== recibida.length) return null;
  if (!crypto.timingSafeEqual(esperada, recibida)) return null;

  let datos;
  try {
    datos = JSON.parse(Buffer.from(partes[0], 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!datos || !datos.slug) return null;
  if (Date.now() - Number(datos.t || 0) > STATE_VALIDO_MS) return null;
  return datos;
}

// ---------- Tokens de Mercado Libre ----------

async function pedirTokenAMl(parametros) {
  const cuerpo = new URLSearchParams(Object.assign({
    client_id: process.env.ML_CLIENT_ID,
    client_secret: process.env.ML_CLIENT_SECRET
  }, parametros));

  const r = await fetch(ML_API + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: cuerpo.toString()
  });

  const datos = await r.json().catch(() => ({}));
  if (!r.ok || !datos.access_token) {
    const motivo = datos.message || datos.error_description || datos.error || ('HTTP ' + r.status);
    throw new Error('Mercado Libre rechazó el token: ' + motivo);
  }
  return datos;
}

function vencimiento(expiresIn) {
  // Se guarda un minuto antes de lo que dice ML, para no usar un token
  // justo en el segundo en que expira.
  const segundos = Number(expiresIn || 0) || 21600;
  return new Date(Date.now() + (segundos - 60) * 1000).toISOString();
}

async function guardarCuenta(slug, datos, ml) {
  await sb('/rest/v1/store_ml_cuenta?on_conflict=store_slug', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: [{
      store_slug: slug,
      ml_user_id: String(datos.user_id),
      nickname: (ml && ml.nickname) || null,
      access_token: datos.access_token,
      refresh_token: datos.refresh_token,
      expira_en: vencimiento(datos.expires_in),
      actualizado_en: new Date().toISOString()
    }]
  });
}

async function cuentaDeTienda(slug) {
  const filas = await sb('/rest/v1/store_ml_cuenta?store_slug=eq.' + encodeURIComponent(slug) +
                         '&select=store_slug,ml_user_id,access_token,refresh_token,expira_en');
  return (filas && filas[0]) || null;
}

// Devuelve un access_token usable, renovándolo si hace falta. La exporta el
// webhook, que necesita hablar con ML sin que haya nadie mirando.
async function tokenDeTienda(slug) {
  const cuenta = await cuentaDeTienda(slug);
  if (!cuenta) return null;

  if (new Date(cuenta.expira_en).getTime() > Date.now()) return cuenta.access_token;

  const datos = await pedirTokenAMl({
    grant_type: 'refresh_token',
    refresh_token: cuenta.refresh_token
  });

  // El refresh_token viejo ya no sirve: ML lo quema al usarlo. Guardar el
  // nuevo no es opcional.
  await sb('/rest/v1/store_ml_cuenta?store_slug=eq.' + encodeURIComponent(slug), {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: {
      access_token: datos.access_token,
      refresh_token: datos.refresh_token || cuenta.refresh_token,
      expira_en: vencimiento(datos.expires_in),
      actualizado_en: new Date().toISOString()
    }
  });

  return datos.access_token;
}

// ---------- Leer la cuenta ----------

async function pedirAMl(ruta, token) {
  const r = await fetch(ML_API + ruta, { headers: { Authorization: 'Bearer ' + token } });
  const datos = await r.json().catch(() => null);
  if (!r.ok) {
    const motivo = (datos && (datos.message || datos.error)) || ('HTTP ' + r.status);
    // El 403 de ML casi siempre es un permiso que no se tildó al crear la
    // aplicación, no un problema del token. Decirlo ahorra media hora.
    const ayuda = r.status === 403
      ? ' (revisá los permisos de la aplicación en el DevCenter de Mercado Libre)'
      : '';
    throw new Error('Mercado Libre: ' + motivo + ayuda);
  }
  return datos;
}

// Se traen de a 50 y como mucho 4 páginas. No es capricho: cada página son
// dos llamadas a ML y la función tiene un tope de tiempo. Si la cuenta tiene
// más, se avisa en vez de cortar en silencio.
const PAGINAS_MAXIMAS = 4;
const POR_PAGINA = 50;

function atributo(item, id) {
  const lista = (item && item.attributes) || [];
  const encontrado = lista.find((a) => a && a.id === id);
  return (encontrado && (encontrado.value_name || encontrado.value_id)) || '';
}

function nombreDeVariante(variacion) {
  const combos = (variacion && variacion.attribute_combinations) || [];
  return combos.map((c) => c.value_name).filter(Boolean).join(' / ');
}

// Los atributos de la variante como { Talle: 'M', Color: 'Rojo' }, que es
// la misma forma que usa el panel para sus combinaciones. Así el vínculo
// entre una variante de ML y una de BRUWAL se puede hacer comparando
// valores en vez de pedirle a alguien que los empareje de a uno.
function atributosDeVariante(variacion) {
  const combos = (variacion && variacion.attribute_combinations) || [];
  const salida = {};
  combos.forEach((c) => {
    const nombre = c && (c.name || c.id);
    const valor = c && (c.value_name || c.value_id);
    if (nombre && valor) salida[String(nombre)] = String(valor);
  });
  return salida;
}

// secure_url primero: la tienda se sirve por https y una imagen http la
// bloquea el navegador sin decir nada.
function fotosDeItem(item) {
  return ((item && item.pictures) || [])
    .map((f) => (f && (f.secure_url || f.url)) || '')
    .filter(Boolean);
}

async function accionPublicaciones(slug) {
  const cuenta = await cuentaDeTienda(slug);
  if (!cuenta) return { conectado: false, publicaciones: [] };

  const token = await tokenDeTienda(slug);
  const ids = [];
  let total = 0;

  for (let pagina = 0; pagina < PAGINAS_MAXIMAS; pagina++) {
    const busqueda = await pedirAMl(
      '/users/' + encodeURIComponent(cuenta.ml_user_id) + '/items/search?status=active' +
      '&limit=' + POR_PAGINA + '&offset=' + (pagina * POR_PAGINA), token);

    total = (busqueda.paging && busqueda.paging.total) || ids.length;
    (busqueda.results || []).forEach((id) => ids.push(id));
    if (!busqueda.results || busqueda.results.length < POR_PAGINA) break;
  }

  // El detalle se pide de a 20, que es el máximo del multiget de ML.
  const publicaciones = [];
  for (let i = 0; i < ids.length; i += 20) {
    const lote = ids.slice(i, i + 20);
    const detalle = await pedirAMl('/items?ids=' + lote.join(',') +
      '&attributes=id,title,price,available_quantity,status,permalink,variations,attributes,seller_custom_field,pictures', token);

    (detalle || []).forEach((fila) => {
      const item = fila && fila.body;
      if (!item) return;
      publicaciones.push({
        id: item.id,
        titulo: item.title || '',
        precio: item.price,
        stock: item.available_quantity,
        estado: item.status,
        permalink: item.permalink || '',
        sku: item.seller_custom_field || atributo(item, 'SELLER_SKU'),
        gtin: atributo(item, 'GTIN'),
        fotos: fotosDeItem(item),
        variantes: (item.variations || []).map((v) => ({
          id: String(v.id),
          nombre: nombreDeVariante(v),
          atributos: atributosDeVariante(v),
          stock: v.available_quantity,
          sku: v.seller_custom_field || '',
          gtin: ''
        }))
      });
    });
  }

  return {
    conectado: true,
    total: total,
    hay_mas: total > ids.length,
    publicaciones: publicaciones
  };
}


// ---------- Publicidad (Product Ads) ----------
//
// Ojo con dos cosas antes de construir nada encima de esto:
//  1. La cuenta tiene que tener Publicidad activada desde Mercado Libre
//     (Gestión de publicaciones → Campaña de publicidad). Si no, la API
//     contesta que no hay anunciantes aunque los permisos estén bien.
//  2. La documentación que encontramos lista Product Ads para Brasil,
//     México y Chile y no menciona Argentina. Puede estar vieja; esta
//     función existe justamente para salir de la duda con la cuenta real
//     en vez de suponer.
//
// Por eso devuelve el status y el cuerpo tal como vinieron cuando falla: el
// número exacto es lo que dice si es "no lo tenés activado" (404), "te
// falta permiso" (403) o "acá no existe".

async function pedirAAds(ruta, token) {
  const r = await fetch(ML_API + ruta, {
    headers: { Authorization: 'Bearer ' + token, 'Api-Version': '1' }
  });
  const datos = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, datos: datos };
}

async function accionPublicidad(slug) {
  const cuenta = await cuentaDeTienda(slug);
  if (!cuenta) return { conectado: false };

  const token = await tokenDeTienda(slug);
  const anunciantes = await pedirAAds('/advertising/advertisers?product_id=PADS', token);

  if (!anunciantes.ok) {
    return {
      conectado: true,
      disponible: false,
      status: anunciantes.status,
      motivo: anunciantes.status === 404
        ? 'La cuenta no tiene Publicidad (Product Ads) habilitada, o no está disponible para Argentina.'
        : anunciantes.status === 403
          ? 'Falta el permiso de Publicidad en la aplicación de Mercado Libre.'
          : 'Mercado Libre contestó ' + anunciantes.status + ' al pedir los anunciantes.',
      crudo: anunciantes.datos
    };
  }

  const lista = (anunciantes.datos && (anunciantes.datos.advertisers || anunciantes.datos.results)) || [];
  if (!lista.length) {
    return {
      conectado: true,
      disponible: false,
      motivo: 'La cuenta está conectada pero no figura como anunciante. Se activa desde Mercado Libre → Gestión de publicaciones → Campaña de publicidad.',
      crudo: anunciantes.datos
    };
  }

  const anunciante = lista[0];
  const idAnunciante = anunciante.advertiser_id || anunciante.id;

  const campanas = await pedirAAds(
    '/advertising/product_ads/campaigns?advertiser_id=' + encodeURIComponent(idAnunciante) +
    '&metrics_summary=true&limit=50', token);

  return {
    conectado: true,
    disponible: true,
    anunciante: {
      id: idAnunciante,
      nombre: anunciante.account_name || anunciante.site_id || ''
    },
    campanas_ok: campanas.ok,
    campanas_status: campanas.status,
    // Crudo a propósito: todavía no sabemos con qué nombres vienen las
    // métricas en esta cuenta, y prefiero mostrarlas tal cual una vez a
    // inventar una tabla con campos que capaz no existen.
    campanas: campanas.datos
  };
}


// ---------- Acciones ----------

async function accionEstado(slug) {
  const filas = await sb('/rest/v1/store_ml_cuenta?store_slug=eq.' + encodeURIComponent(slug) +
                         '&select=ml_user_id,nickname,conectado_en');
  const cuenta = filas && filas[0];
  if (!cuenta) return { conectado: false };
  return {
    conectado: true,
    nickname: cuenta.nickname,
    ml_user_id: cuenta.ml_user_id,
    conectado_en: cuenta.conectado_en
  };
}

function accionConectar(req, slug) {
  const url = ML_AUTH_URL +
    '?response_type=code' +
    '&client_id=' + encodeURIComponent(process.env.ML_CLIENT_ID) +
    '&redirect_uri=' + encodeURIComponent(urlDeRetorno(req)) +
    '&state=' + encodeURIComponent(armarEstado(slug));
  return { url: url };
}

async function accionDesconectar(slug) {
  await sb('/rest/v1/store_ml_cuenta?store_slug=eq.' + encodeURIComponent(slug), {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' }
  });
  return { desconectado: true };
}

// Vuelta desde Mercado Libre. Termina siempre en el panel con un cartel,
// nunca mostrando un JSON: del otro lado hay una persona, no un programa.
async function accionCallback(req, res) {
  const volverAlPanel = (parametros) =>
    res.writeHead(302, { Location: '/dashboard/?' + new URLSearchParams(parametros).toString() }).end();

  const { code, state, error } = req.query || {};
  if (error) return volverAlPanel({ ml: 'error', motivo: String(error).slice(0, 120) });
  if (!code) return volverAlPanel({ ml: 'error', motivo: 'Mercado Libre no devolvió el código' });

  const datosEstado = leerEstado(state);
  if (!datosEstado) return volverAlPanel({ ml: 'error', motivo: 'El pedido de conexión venció o no es válido. Probá de nuevo.' });

  try {
    const datos = await pedirTokenAMl({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: urlDeRetorno(req)
    });

    // El nickname es para que el vendedor vea a qué cuenta se conectó. Si
    // falla, no se cae la conexión: es un dato de adorno.
    let ml = null;
    try {
      const r = await fetch(ML_API + '/users/me', { headers: { Authorization: 'Bearer ' + datos.access_token } });
      if (r.ok) ml = await r.json();
    } catch (e) { /* sin nickname, la conexión igual sirve */ }

    await guardarCuenta(datosEstado.slug, datos, ml);
    return volverAlPanel({ ml: 'conectado', cuenta: (ml && ml.nickname) || '' });
  } catch (err) {
    return volverAlPanel({ ml: 'error', motivo: String(err.message || err).slice(0, 160) });
  }
}

// ---------- Entrada ----------

module.exports = async (req, res) => {
  const faltan = faltanVariables();
  if (faltan.length) {
    // El callback llega desde el navegador del vendedor: mejor mandarlo al
    // panel con el motivo que dejarlo mirando un JSON de error.
    if (req.method === 'GET') {
      return res.writeHead(302, {
        Location: '/dashboard/?ml=error&motivo=' + encodeURIComponent('Faltan configurar en el servidor: ' + faltan.join(', '))
      }).end();
    }
    return res.status(500).json({ error: 'Faltan variables de entorno: ' + faltan.join(', ') });
  }

  if (req.method === 'GET' && (req.query || {}).accion === 'callback') {
    return accionCallback(req, res);
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const cabecera = req.headers.authorization || '';
  const token = cabecera.startsWith('Bearer ') ? cabecera.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Falta la sesión' });

  const usuario = await usuarioDeToken(token);
  if (!usuario || !usuario.id) return res.status(401).json({ error: 'Sesión inválida' });

  const tienda = await tiendaDelUsuario(usuario.id);
  if (!tienda) return res.status(403).json({ error: 'Este usuario no tiene tienda' });

  const cuerpo = req.body || {};
  const accion = cuerpo.accion || '';

  try {
    if (accion === 'estado') return res.status(200).json(await accionEstado(tienda.slug));
    if (accion === 'conectar') return res.status(200).json(accionConectar(req, tienda.slug));
    if (accion === 'desconectar') return res.status(200).json(await accionDesconectar(tienda.slug));
    if (accion === 'publicaciones') return res.status(200).json(await accionPublicaciones(tienda.slug));
    if (accion === 'publicidad') return res.status(200).json(await accionPublicidad(tienda.slug));
    return res.status(400).json({ error: 'Acción desconocida' });
  } catch (err) {
    console.error('mercadolibre.js', accion, err);
    return res.status(500).json({ error: String(err.message || err) });
  }
};

// Lo usa el webhook de órdenes.
module.exports.tokenDeTienda = tokenDeTienda;
