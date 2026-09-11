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

// Con Pro un duenio puede tener varios negocios, asi que hay que trabajar
// sobre el que esta MIRANDO, no sobre el primero que aparezca.
//
// El navegador manda el slug pero NO se le cree: se busca entre las tiendas
// de ESE usuario. Mandar un slug ajeno no da acceso a nada — simplemente no
// aparece en la lista y se cae a la suya.
//
// Y el order no es decorativo: sin el, Postgres devuelve las filas en
// cualquier orden y el fallback podria elegir una distinta de la que muestra
// el panel.
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
      '&attributes=id,title,price,available_quantity,status,permalink,variations,attributes,seller_custom_field,pictures,shipping', token);

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
        // 'fulfillment' = Full: las unidades est\u00e1n en el dep\u00f3sito de ML y
        // una venta de esa publicaci\u00f3n no toca el stock del local.
        logistica: (item.shipping && item.shipping.logistic_type) || null,
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

// La version del encabezado cambia segun el recurso: los anunciantes andan
// con 1 y las campanas con 2. Por eso es un parametro y no una constante.
async function pedirAAds(ruta, token, version) {
  const r = await fetch(ML_API + ruta, {
    headers: { Authorization: 'Bearer ' + token, 'Api-Version': version || '1' }
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
  const siteAnunciante = anunciante.site_id || 'MLA';

  // Por que fallaba: Mercado Ads deprecio los endpoints viejos y desde el
  // 26 de febrero de 2026 devuelven 404. No era la cuenta ni el permiso --
  // la consulta de anunciantes andaba bien y trajo advertiser_id 1616315.
  // El 404 decia "No static resource advertising/product_ads/campaigns",
  // que es el servidor avisando que esa direccion ya no existe.
  //
  // Los actuales viven bajo /marketplace/, llevan el SITE del anunciante
  // (MLA en Argentina) y terminan en /search, que es obligatorio:
  //   /marketplace/advertising/MLA/advertisers/1616315/product_ads/campaigns/search
  //
  // Igual se prueban varias formas en orden y gana la primera que conteste.
  // Ya nos mudaron esto una vez; la lista de candidatas se banca la
  // proxima sin salir a adivinar. Los intentos se devuelven para que, si
  // ninguna anda, se vea QUE se probo y QUE contesto cada una.
  const baseAds = '/marketplace/advertising/' + encodeURIComponent(siteAnunciante) +
                  '/advertisers/' + encodeURIComponent(idAnunciante) + '/product_ads/campaigns';
  const baseViejo = '/advertising/advertisers/' + encodeURIComponent(idAnunciante) + '/product_ads/campaigns';
  // Como se piden las metricas, segun la documentacion de Product Ads:
  //  - `metrics` es una lista separada por comas. SIN ese parametro no viene
  //    ninguna metrica, que es exactamente lo que nos pasaba antes.
  //  - date_from y date_to son obligatorias cuando se piden metricas.
  //  - el rango no puede ir mas de 90 dias para atras.
  // Ademas Mercado Libre actualiza estos numeros a las 10 de la manana
  // (GMT-3): el dia de hoy siempre viene incompleto.
  const hoy = new Date();
  const hasta = hoy.toISOString().slice(0, 10);
  const desde = new Date(hoy.getTime() - 29 * 86400000).toISOString().slice(0, 10);
  const METRICAS = 'clicks,prints,ctr,cost,cpc,acos,cvr,roas,units_quantity,total_amount,direct_amount,indirect_amount';
  const conMetricas = '/search?limit=50&date_from=' + desde + '&date_to=' + hasta +
                      '&metrics=' + METRICAS;

  const candidatas = [
    { ruta: baseAds + conMetricas,          version: '2' },
    { ruta: baseAds + '/search?limit=50',   version: '2' },
    { ruta: baseAds + '/search?limit=50',   version: '1' },
    { ruta: baseAds + '?limit=50',          version: '2' },
    { ruta: baseViejo + '/search?limit=50', version: '2' },
    { ruta: '/advertising/product_ads/campaigns?advertiser_id=' +
            encodeURIComponent(idAnunciante) + '&limit=50', version: '1' }
  ];

  const intentos = [];
  let campanas = null;
  for (const c of candidatas) {
    const r = await pedirAAds(c.ruta, token, c.version);
    intentos.push({ ruta: c.ruta, version: c.version, status: r.status });
    campanas = r;
    campanas.ruta = c.ruta;
    campanas.version = c.version;
    if (r.ok) break;
  }

  return {
    conectado: true,
    disponible: true,
    anunciante: {
      id: idAnunciante,
      site: siteAnunciante,
      nombre: anunciante.account_name || anunciante.site_id || ''
    },
    // Crudo del anunciante: si algo vuelve a fallar, los nombres de campo
    // reales se leen de una vez en vez de ir sacando capturas.
    anunciante_crudo: anunciante,
    campanas_ok: campanas.ok,
    campanas_status: campanas.status,
    campanas_ruta: campanas.ruta,
    campanas_version: campanas.version,
    intentos: intentos,
    // Crudo a propósito: todavía no sabemos con qué nombres vienen las
    // métricas en esta cuenta, y prefiero mostrarlas tal cual una vez a
    // inventar una tabla con campos que capaz no existen.
    campanas: campanas.datos
  };
}


// Pausar o activar una campana. Este endpoint NO esta en la documentacion
// publica -- la parte de escritura pide login de Mercado Libre -- asi que se
// prueban las formas conocidas igual que con la lectura.
//
// Dos cuidados, porque esto toca plata del negocio:
//  1. Se manda SOLO el campo status. Nada de mandar el objeto entero, que
//     podria pisar el presupuesto sin que nadie lo haya pedido.
//  2. Despues se RELEE la campana y se devuelve el estado que quedo segun la
//     API, no el que pedimos. Si la pantalla dice "pausada" es porque
//     Mercado Libre lo confirmo, no porque nosotros lo supusimos.
async function accionPublicidadEstado(slug, campanaId, estado) {
  if (estado !== 'active' && estado !== 'paused') {
    return { ok: false, motivo: 'Estado invalido.' };
  }

  const cuenta = await cuentaDeTienda(slug);
  if (!cuenta) return { ok: false, motivo: 'La tienda no tiene Mercado Libre conectado.' };

  const token = await tokenDeTienda(slug);
  const anunciantes = await pedirAAds('/advertising/advertisers?product_id=PADS', token);
  const lista = (anunciantes.datos && (anunciantes.datos.advertisers || anunciantes.datos.results)) || [];
  if (!lista.length) return { ok: false, motivo: 'La cuenta no figura como anunciante.' };

  const anunciante = lista[0];
  const idAnunciante = anunciante.advertiser_id || anunciante.id;
  const site = anunciante.site_id || 'MLA';
  const id = encodeURIComponent(campanaId);

  const candidatas = [
    { ruta: '/marketplace/advertising/' + encodeURIComponent(site) + '/advertisers/' +
            encodeURIComponent(idAnunciante) + '/product_ads/campaigns/' + id, version: '2' },
    { ruta: '/advertising/advertisers/' + encodeURIComponent(idAnunciante) +
            '/product_ads/campaigns/' + id, version: '2' },
    { ruta: '/advertising/product_ads/campaigns/' + id, version: '1' }
  ];

  const intentos = [];
  let ultima = null;
  for (const c of candidatas) {
    const r = await fetch(ML_API + c.ruta, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Api-Version': c.version
      },
      body: JSON.stringify({ status: estado })
    });
    const datos = await r.json().catch(() => null);
    intentos.push({ ruta: c.ruta, version: c.version, status: r.status });
    ultima = { ok: r.ok, status: r.status, datos: datos, ruta: c.ruta };
    if (r.ok) break;
  }

  if (!ultima || !ultima.ok) {
    return {
      ok: false,
      motivo: 'Mercado Libre no acepto el cambio.',
      status: ultima && ultima.status,
      intentos: intentos,
      crudo: ultima && ultima.datos
    };
  }

  // La confirmacion sale de releer, no de suponer.
  const relectura = await pedirAAds(
    '/marketplace/advertising/' + encodeURIComponent(site) + '/advertisers/' +
    encodeURIComponent(idAnunciante) + '/product_ads/campaigns/search?limit=50', token, '2');
  const campanas = (relectura.datos && relectura.datos.results) || [];
  const encontrada = campanas.find(c => String(c.id) === String(campanaId));

  return {
    ok: true,
    ruta: ultima.ruta,
    estado_pedido: estado,
    estado_real: encontrada ? encontrada.status : null,
    campana: encontrada || null,
    intentos: intentos
  };
}


// ---------- Cruce de stock con Mercado Libre ----------

// Como esta cada publicacion VINCULADA en Mercado Libre. Solo las
// vinculadas: el resto no se puede comparar contra nada del catalogo local.
async function accionStockEnMl(slug) {
  const cuenta = await cuentaDeTienda(slug);
  if (!cuenta) return { conectado: false };

  const token = await tokenDeTienda(slug);

  const vinculos = await sb('/rest/v1/store_ml_vinculos?store_slug=eq.' + encodeURIComponent(slug) +
                            '&select=ml_item_id,ml_variation_id,product_id,variante_local');
  if (!vinculos || !vinculos.length) return { conectado: true, ok: true, vinculos: [], publicaciones: [] };

  // Una publicacion con variantes tiene un vinculo por variante: se piden los
  // ids UNICOS, si no se consulta la misma publicacion cinco veces.
  const ids = [...new Set(vinculos.map((v) => String(v.ml_item_id)))];

  const publicaciones = [];
  for (let i = 0; i < ids.length; i += 20) {
    const lote = ids.slice(i, i + 20);
    const detalle = await pedirAMl('/items?ids=' + lote.join(',') +
      '&attributes=id,title,status,available_quantity,permalink,variations,shipping', token);
    (detalle || []).forEach((d) => {
      const b = d.body || d;
      if (!b || !b.id) return;
      publicaciones.push({
        id: String(b.id),
        titulo: b.title,
        estado: b.status,
        cantidad: Number(b.available_quantity) || 0,
        link: b.permalink || null,
        // Con Full el stock vive en el deposito de Mercado Libre: el del
        // local no tiene por que coincidir y compararlos seria dar una
        // alarma falsa todos los dias.
        full: !!(b.shipping && b.shipping.logistic_type === 'fulfillment'),
        variantes: (b.variations || []).map((v) => ({
          id: String(v.id),
          cantidad: Number(v.available_quantity) || 0
        }))
      });
    });
  }

  return { conectado: true, ok: true, vinculos: vinculos, publicaciones: publicaciones };
}

// Mandar a Mercado Libre el stock que dice BRUWAL.
//
// Solo se toca available_quantity, nada mas: mandar el objeto entero podria
// pisar precio, titulo o atributos sin que nadie lo haya pedido.
async function accionSincronizarStock(slug, itemId, variacionId, cantidad) {
  if (!itemId) return { ok: false, motivo: 'Falta la publicacion.' };
  const qty = Math.max(0, Math.floor(Number(cantidad)));
  if (!isFinite(qty)) return { ok: false, motivo: 'Cantidad invalida.' };

  const cuenta = await cuentaDeTienda(slug);
  if (!cuenta) return { ok: false, motivo: 'La tienda no tiene Mercado Libre conectado.' };

  // Que la publicacion sea de ESTA tienda: se exige que exista el vinculo.
  // Sin esto, alguien podria mandar un id ajeno y tocarle el stock a otro.
  const vinculos = await sb('/rest/v1/store_ml_vinculos?store_slug=eq.' + encodeURIComponent(slug) +
                            '&ml_item_id=eq.' + encodeURIComponent(String(itemId)) + '&select=ml_item_id&limit=1');
  if (!vinculos || !vinculos.length) {
    return { ok: false, motivo: 'Esa publicacion no esta vinculada a esta tienda.' };
  }

  const token = await tokenDeTienda(slug);

  // Con variantes el stock vive en la variante, no en la publicacion: mandar
  // available_quantity arriba con variaciones cargadas lo rechaza ML.
  const cuerpo = variacionId
    ? { variations: [{ id: Number(variacionId), available_quantity: qty }] }
    : { available_quantity: qty };

  const r = await fetch(ML_API + '/items/' + encodeURIComponent(itemId), {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(cuerpo)
  });

  const datos = await r.json().catch(() => null);
  if (!r.ok) {
    const motivo = (datos && (datos.message || datos.error)) || ('HTTP ' + r.status);
    return { ok: false, motivo: 'Mercado Libre no acepto el cambio: ' + motivo, crudo: datos };
  }

  // Se confirma releyendo, no suponiendo.
  const leido = variacionId
    ? (datos.variations || []).find((v) => String(v.id) === String(variacionId))
    : datos;

  return {
    ok: true,
    pedida: qty,
    quedo: leido ? (Number(leido.available_quantity) || 0) : null,
    estado: datos.status || null
  };
}


// ---------- Lo que cobra Mercado Libre por fuera de la venta ----------
//
// Hay costos que no viven en la orden: el almacenamiento y la gestion de
// FULL, y la publicidad. Se facturan por periodo. Calcular el margen solo
// con la comision los deja afuera y la ganancia sale mejor de lo que es.
//
// Estos dos ya estan contados VENTA POR VENTA (sale_fee y costo_envio), asi
// que si se restara la factura entera se descontarian dos veces. Se marcan
// para poder separarlos.
const YA_CONTADO_POR_VENTA = ['CV', 'CXD'];

async function accionFacturacion(slug) {
  const cuenta = await cuentaDeTienda(slug);
  if (!cuenta) return { conectado: false };

  const token = await tokenDeTienda(slug);

  let periodos;
  try {
    periodos = await pedirAMl('/billing/integration/monthly/periods?group=ML&document_type=BILL&limit=6', token);
  } catch (e) {
    // La facturacion necesita permisos propios en la aplicacion de ML. Se
    // dice, en vez de mostrar una pantalla vacia sin explicacion.
    return { conectado: true, ok: false, motivo: String(e.message || e) };
  }

  const lista = (periodos && periodos.results) || [];
  if (!lista.length) return { conectado: true, ok: true, periodos: [], cargos: [] };

  // El mas reciente. `key` es el primer dia del mes y es lo que piden los
  // demas endpoints.
  const actual = lista[0];

  let detalle;
  try {
    detalle = await pedirAMl('/billing/integration/periods/key/' +
      encodeURIComponent(actual.key) + '/summary/details', token);
  } catch (e) {
    return { conectado: true, ok: false, motivo: String(e.message || e), periodo: actual };
  }

  const incluye = (detalle && detalle.bill_includes) || {};
  const cargos = (incluye.charges || []).map((c) => ({
    concepto: c.label,
    tipo: c.type,
    monto: Number(c.amount) || 0,
    // Si ya se descuenta venta por venta, se marca para no restarlo de nuevo.
    yaContado: YA_CONTADO_POR_VENTA.includes(c.type)
  }));

  const bonificaciones = (incluye.bonuses || []).map((b) => ({
    concepto: b.label, tipo: b.type, monto: Number(b.amount) || 0
  }));

  return {
    conectado: true,
    ok: true,
    periodo: {
      desde: actual.period && actual.period.date_from,
      hasta: actual.period && actual.period.date_to,
      key: actual.key,
      estado: actual.period_status,
      total: Number(actual.amount) || 0
    },
    cargos: cargos,
    bonificaciones: bonificaciones,
    // Lo que NO esta en la ganancia por venta: publicidad, FULL y cualquier
    // concepto nuevo que ML agregue. Es el numero que faltaba.
    fueraDeLaVenta: cargos.filter((c) => !c.yaContado).reduce((s, c) => s + c.monto, 0)
  };
}


// ---------- Calidad de las publicaciones ----------
//
// Cuantas publicaciones se miran de una. Cada una es UNA llamada a ML, y la
// funcion tiene un tope de tiempo: pedir 200 la haria expirar y no
// devolveria nada. Con 30 alcanza para ver el panorama y decidir que tocar.
const CALIDAD_MAXIMA = 30;
const CALIDAD_EN_PARALELO = 6;

// Saca de la respuesta de ML solo lo que falta hacer. La estructura viene
// anidada en tres niveles (buckets -> variables -> rules) y lo util esta
// abajo de todo, en `wordings`: el consejo escrito, el texto del boton y el
// link que lleva derecho a la pantalla de ML donde se arregla.
function pendientesDePerformance(datos) {
  const pendientes = [];
  (datos.buckets || []).forEach((b) => {
    (b.variables || []).forEach((v) => {
      (v.rules || []).forEach((r) => {
        if (r.status === 'COMPLETED') return;
        const w = r.wordings || {};
        if (!w.title) return;
        pendientes.push({
          clave: v.key || r.key,
          grupo: b.title || b.key,
          consejo: w.title,
          boton: w.label || null,
          link: w.link || null,
          // progress viene 0..1; sirve para ordenar por lo mas incompleto.
          avance: Number(r.progress) || 0
        });
      });
    });
  });
  return pendientes;
}

async function accionCalidadPublicaciones(slug) {
  const cuenta = await cuentaDeTienda(slug);
  if (!cuenta) return { conectado: false };

  const token = await tokenDeTienda(slug);

  const busqueda = await pedirAMl(
    '/users/' + encodeURIComponent(cuenta.ml_user_id) +
    '/items/search?status=active&limit=' + CALIDAD_MAXIMA, token);

  const ids = (busqueda.results || []).slice(0, CALIDAD_MAXIMA);
  const total = (busqueda.paging && busqueda.paging.total) || ids.length;
  if (!ids.length) return { conectado: true, ok: true, total: 0, items: [] };

  // Los titulos no vienen en /performance: se piden aparte con el multiget,
  // que trae 20 de una. Sin el titulo la lista serian codigos MLA sueltos.
  const titulos = {};
  for (let i = 0; i < ids.length; i += 20) {
    const lote = ids.slice(i, i + 20);
    const detalle = await pedirAMl('/items?ids=' + lote.join(',') +
      '&attributes=id,title,permalink,thumbnail', token);
    (detalle || []).forEach((d) => {
      const b = d.body || d;
      if (b && b.id) titulos[b.id] = { titulo: b.title, link: b.permalink, foto: b.thumbnail };
    });
  }

  // De a 6: en serie tarda demasiado y todas juntas es pedirle a ML 30
  // llamadas en el mismo instante, que es la forma mas rapida de comerse un
  // 429 por limite de uso.
  const items = [];
  for (let i = 0; i < ids.length; i += CALIDAD_EN_PARALELO) {
    const lote = ids.slice(i, i + CALIDAD_EN_PARALELO);
    const resultados = await Promise.all(lote.map(async (id) => {
      try {
        const p = await pedirAMl('/item/' + encodeURIComponent(id) + '/performance', token);
        const info = titulos[id] || {};
        return {
          id: id,
          titulo: info.titulo || id,
          link: info.link || null,
          foto: info.foto || null,
          puntaje: Number(p.score) || 0,
          nivel: p.level_wording || p.level || null,
          pendientes: pendientesDePerformance(p)
        };
      } catch (e) {
        // Una publicacion que falla no puede tumbar el informe entero.
        return { id: id, titulo: (titulos[id] || {}).titulo || id, error: String(e.message || e) };
      }
    }));
    resultados.forEach((r) => items.push(r));
  }

  // Agrupado por tipo de consejo: "12 publicaciones necesitan mas fotos" se
  // actua mucho mejor que la misma frase repetida doce veces.
  const porConsejo = {};
  items.forEach((it) => {
    (it.pendientes || []).forEach((p) => {
      if (!porConsejo[p.clave]) porConsejo[p.clave] = { clave: p.clave, grupo: p.grupo, consejo: p.consejo, cuantas: 0 };
      porConsejo[p.clave].cuantas++;
    });
  });

  const niveles = {};
  items.forEach((it) => { if (it.nivel) niveles[it.nivel] = (niveles[it.nivel] || 0) + 1; });

  return {
    conectado: true,
    ok: true,
    total: total,
    revisadas: items.length,
    niveles: niveles,
    resumen: Object.values(porConsejo).sort((a, b) => b.cuantas - a.cuantas),
    items: items.sort((a, b) => (a.puntaje || 0) - (b.puntaje || 0))   // las peores primero
  };
}


// ---------- Rescate de ventas ----------
//
// Por que existe: una venta de Mercado Libre puede no quedar registrada. Si
// el aviso no llega, o llega y se procesa mal, esa plata no aparece en
// ningun lado y nadie se entera hasta que no cierran las cuentas.
//
// Y no se arregla sola: store_ml_ordenes tiene el id de la orden como clave,
// asi que cuando Mercado Libre reintenta, el webhook entra por la rama "esta
// ya la vi" y solo refresca el estado. Sin esto, una venta perdida se
// perdia para siempre.

async function ordenesRecientesDeMl(cuenta, token) {
  // Mercado Libre movio esta busqueda de lugar mas de una vez; se prueban
  // las formas conocidas y gana la primera que conteste, igual que con las
  // campanas de publicidad.
  const seller = encodeURIComponent(String(cuenta.ml_user_id));
  const candidatas = [
    '/orders/search?seller=' + seller + '&order.status=paid&sort=date_desc&limit=50',
    '/orders/search?seller=' + seller + '&sort=date_desc&limit=50',
    '/orders/search/recent?seller=' + seller + '&limit=50'
  ];

  const intentos = [];
  for (const ruta of candidatas) {
    const r = await fetch(ML_API + ruta, { headers: { Authorization: 'Bearer ' + token } });
    const datos = await r.json().catch(() => null);
    intentos.push({ ruta: ruta, status: r.status });
    if (r.ok && datos && Array.isArray(datos.results)) {
      return { ok: true, ordenes: datos.results, ruta: ruta, intentos: intentos };
    }
  }
  return { ok: false, ordenes: [], intentos: intentos };
}

async function accionVentasFaltantes(slug) {
  const cuenta = await cuentaDeTienda(slug);
  if (!cuenta) return { conectado: false };

  const token = await tokenDeTienda(slug);
  const traidas = await ordenesRecientesDeMl(cuenta, token);
  if (!traidas.ok) {
    return { conectado: true, ok: false, motivo: 'No se pudieron leer las ventas de Mercado Libre.', intentos: traidas.intentos };
  }

  // Lo que BRUWAL tiene anotado de esas ordenes. order_id null significa que
  // se vio la venta pero nunca se convirtio en un pedido: esa es la perdida.
  const anotadas = await sb('/rest/v1/store_ml_ordenes?store_slug=eq.' + encodeURIComponent(slug) +
                            '&select=ml_order_id,order_id&limit=500');
  const porId = {};
  (anotadas || []).forEach((f) => { porId[String(f.ml_order_id)] = f; });

  const ventas = traidas.ordenes
    .filter((o) => o.status === 'paid')
    .map((o) => {
      const fila = porId[String(o.id)];
      return {
        id: String(o.id),
        fecha: o.date_created || o.date_closed || null,
        total: Number(o.total_amount) || 0,
        comprador: (o.buyer && (o.buyer.nickname || o.buyer.first_name)) || null,
        productos: (o.order_items || []).map((li) => ({
          titulo: (li.item && li.item.title) || '',
          cantidad: Number(li.quantity) || 0
        })),
        vista: !!fila,
        registrada: !!(fila && fila.order_id)
      };
    });

  return {
    conectado: true,
    ok: true,
    ventas: ventas,
    faltan: ventas.filter((v) => !v.registrada).length
  };
}

async function accionImportarVenta(slug, mlOrderId) {
  if (!mlOrderId) return { ok: false, motivo: 'Falta el numero de orden.' };

  const cuenta = await cuentaDeTienda(slug);
  if (!cuenta) return { ok: false, motivo: 'La tienda no tiene Mercado Libre conectado.' };

  const token = await tokenDeTienda(slug);

  // La orden se le pide a Mercado Libre con el token de ESTA tienda: si la
  // orden fuera de otra cuenta, la API no la devuelve. Esa es la validacion.
  const r = await fetch(ML_API + '/orders/' + encodeURIComponent(mlOrderId), {
    headers: { Authorization: 'Bearer ' + token }
  });
  if (!r.ok) return { ok: false, motivo: 'Mercado Libre no devolvio esa orden (' + r.status + ').' };
  const orden = await r.json();

  if (orden.status !== 'paid') {
    return { ok: false, motivo: 'Esa orden todavia no figura pagada en Mercado Libre (' + orden.status + ').' };
  }

  const previas = await sb('/rest/v1/store_ml_ordenes?ml_order_id=eq.' +
                           encodeURIComponent(String(orden.id)) + '&select=ml_order_id,order_id');
  const previa = previas && previas[0];

  // Con pedido ya creado no se toca: importarla de nuevo duplicaria la venta
  // Y volveria a descontar el stock.
  if (previa && previa.order_id) {
    return { ok: false, ya: true, motivo: 'Esa venta ya esta registrada en BRUWAL.' };
  }

  // El require va ACA adentro, no arriba del archivo: ml-webhook.js hace
  // require de este mismo archivo, y pedirselo en la carga daria un modulo a
  // medio armar. Adentro de la funcion los dos ya terminaron de cargar.
  const { registrarOrdenEnBruwal } = require('./ml-webhook');
  const hecho = await registrarOrdenEnBruwal(slug, orden, token, cuenta.ml_user_id);

  const fila = {
    estado: orden.status,
    stock_descontado: hecho.resumen.descontados > 0 || hecho.resumen.porFull > 0,
    costo_envio: hecho.resumen.envio,
    sin_vincular: hecho.resumen.sinVinculo.length > 0,
    logistica: hecho.resumen.porFull ? 'fulfillment' : 'propio',
    order_id: hecho.idPedido,
    total: Number(orden.total_amount) || 0,
    comprador: (orden.buyer && orden.buyer.nickname) || null,
    detalle: orden
  };

  if (previa) {
    await sb('/rest/v1/store_ml_ordenes?ml_order_id=eq.' + encodeURIComponent(String(orden.id)), {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: Object.assign({ actualizado_en: new Date().toISOString() }, fila)
    });
  } else {
    await sb('/rest/v1/store_ml_ordenes', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: [Object.assign({ ml_order_id: String(orden.id), store_slug: slug }, fila)]
    });
  }

  return {
    ok: true,
    order_id: hecho.idPedido,
    total: Number(orden.total_amount) || 0,
    descontados: hecho.resumen.descontados,
    por_full: hecho.resumen.porFull,
    comision: hecho.resumen.comision,
    envio: hecho.resumen.envio,
    sin_vinculo: hecho.resumen.sinVinculo
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

  const cuerpo = req.body || {};
  const accion = cuerpo.accion || '';

  const tienda = await tiendaDelUsuario(usuario.id, cuerpo.slug);
  if (!tienda) return res.status(403).json({ error: 'Este usuario no tiene tienda' });

  try {
    if (accion === 'estado') return res.status(200).json(await accionEstado(tienda.slug));
    if (accion === 'conectar') return res.status(200).json(accionConectar(req, tienda.slug));
    if (accion === 'desconectar') return res.status(200).json(await accionDesconectar(tienda.slug));
    if (accion === 'publicaciones') return res.status(200).json(await accionPublicaciones(tienda.slug));
    if (accion === 'publicidad') return res.status(200).json(await accionPublicidad(tienda.slug));
    if (accion === 'stock_ml') return res.status(200).json(await accionStockEnMl(tienda.slug));
    if (accion === 'sincronizar_stock') {
      return res.status(200).json(await accionSincronizarStock(
        tienda.slug, cuerpo.item_id, cuerpo.variacion_id, cuerpo.cantidad));
    }
    if (accion === 'facturacion') return res.status(200).json(await accionFacturacion(tienda.slug));
    if (accion === 'calidad') return res.status(200).json(await accionCalidadPublicaciones(tienda.slug));
    if (accion === 'ventas_faltantes') return res.status(200).json(await accionVentasFaltantes(tienda.slug));
    if (accion === 'importar_venta') {
      const cuerpo = req.body || {};
      return res.status(200).json(await accionImportarVenta(tienda.slug, cuerpo.ml_order_id));
    }
    if (accion === 'publicidad_estado') {
      const cuerpo = req.body || {};
      return res.status(200).json(
        await accionPublicidadEstado(tienda.slug, cuerpo.campana_id, cuerpo.estado));
    }
    return res.status(400).json({ error: 'Acción desconocida' });
  } catch (err) {
    console.error('mercadolibre.js', accion, err);
    return res.status(500).json({ error: String(err.message || err) });
  }
};

// Lo usa el webhook de órdenes.
module.exports.tokenDeTienda = tokenDeTienda;
