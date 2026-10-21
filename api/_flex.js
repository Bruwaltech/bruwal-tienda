// Envíos Flex: guardar cada envío en flex_envios.
//
// Lo usan dos caminos, y por eso vive acá y no en ninguno de los dos:
//   - el aviso de Mercado Libre (api/ml-webhook.js), con el tópico
//     `shipments` cada vez que un envío cambia de estado, y con
//     `orders_v2` cuando entra la venta;
//   - el botón "Actualizar desde Mercado Libre" de la pestaña Envíos Flex
//     (accionFlexEnvios en api/mercadolibre.js), que rellena los últimos
//     14 días por si algún aviso se perdió.
// Un solo lugar donde está escrito qué es "un envío Flex" y qué se guarda,
// así los dos caminos no se separan.
//
// No se exporta nada que tire errores para afuera del webhook: guardar el
// envío es un extra. Si falla, la venta igual se tiene que registrar.

const SUPABASE_URL = 'https://qduguqazpxjjpxjfnkif.supabase.co';
const ML_API = 'https://api.mercadolibre.com';

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
  if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + (await r.text()).slice(0, 300));
  if (r.status === 204) return null;
  const texto = await r.text();
  return texto ? JSON.parse(texto) : null;
}

async function pedirAMl(ruta, token) {
  const r = await fetch(ML_API + ruta, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

async function flexHabilitado(slug) {
  const filas = await sb('/rest/v1/store_profiles?slug=eq.' + encodeURIComponent(slug) + '&select=features');
  const f = filas && filas[0] && filas[0].features;
  return !!(f && f.envios_flex === true);
}

// Flex = tipo de logística "self_service" (ver el comentario de Envíos Flex
// en api/mercadolibre.js). Sin X-Format-New el campo es `logistic_type`;
// con él, `logistic.type`.
function esFlex(envio) {
  const tipo = envio && (envio.logistic_type || (envio.logistic && envio.logistic.type));
  return tipo === 'self_service';
}

// La zona del corredor sale del nombre de la ciudad que manda ML. Se compara
// sin tildes ni mayúsculas porque ML no siempre escribe igual ("Capitan
// Bermudez", "Granadero Baigorria", "Puerto Gral. San Martin"). Lo que no es del
// corredor queda en 'otra': es justamente lo que hay que mirar aparte.
function sinTildes(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}
function zonaDeCiudad(ciudad) {
  const c = sinTildes(ciudad);
  if (!c) return null;
  if (c.includes('baigorria')) return 'baigorria';
  if (c.includes('bermudez')) return 'bermudez';
  if (c.includes('san lorenzo')) return 'san_lorenzo';
  if (c.includes('san martin') && (c.includes('puerto') || c.includes('pto'))) return 'puerto_san_martin';
  if (c.includes('rosario')) return 'rosario';
  return 'otra';
}

// La fila de flex_envios a partir de lo que devuelve ML. `costos` puede
// venir null: el envío se guarda igual, sin esos números.
function filaDeEnvio(slug, envio, orden, costos) {
  const historial = envio.status_history || {};
  const destino = envio.receiver_address || (envio.destination && envio.destination.shipping_address) || {};
  const ciudad = (destino.city && destino.city.name) || null;
  const fila = {
    envio_id: String(envio.id),
    store_slug: slug,
    orden_id: orden ? String(orden.id) : (envio.order_id ? String(envio.order_id) : null),
    estado: envio.status || null,
    subestado: envio.substatus || null,
    fecha_venta: (orden && orden.date_created) || envio.date_created || null,
    fecha_entrega: historial.date_delivered || null,
    ciudad: ciudad,
    zona: zonaDeCiudad(ciudad),
    cp: destino.zip_code || null,
    direccion: destino.address_line || null,
    actualizado_en: new Date().toISOString()
  };
  if (orden) {
    fila.total_venta = Number(orden.total_amount) || 0;
    fila.productos = (orden.order_items || []).map((li) => (li.item && li.item.title) || '').filter(Boolean);
  }
  if (costos) {
    const vendedor = (costos.senders || [])[0] || {};
    const comp = vendedor.compensation;
    fila.costo_comprador = costos.receiver && costos.receiver.cost != null ? Number(costos.receiver.cost) : null;
    fila.costo_vendedor = vendedor.cost != null ? Number(vendedor.cost) : null;
    fila.compensacion_vendedor = comp == null ? null
      : Number(typeof comp === 'object' ? comp.amount : comp) || 0;
    fila.costo_bruto = costos.gross_amount != null ? Number(costos.gross_amount) : null;
  }
  return fila;
}

// Upsert por envio_id: ML avisa muchas veces por el mismo envío (cada
// cambio de estado y cada reintento), y cada aviso pisa con lo último.
// Las columnas que no vienen en la fila no se tocan.
async function guardarFilas(filas) {
  if (!filas.length) return;
  // PostgREST exige que todas las filas de un upsert tengan las mismas
  // columnas; se agrupan por forma para no mandar nulls que pisen datos.
  const porForma = new Map();
  filas.forEach((f) => {
    const clave = Object.keys(f).sort().join(',');
    if (!porForma.has(clave)) porForma.set(clave, []);
    porForma.get(clave).push(f);
  });
  for (const grupo of porForma.values()) {
    await sb('/rest/v1/flex_envios?on_conflict=envio_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: grupo
    });
  }
}

// Pide el envío a ML y, si es Flex, lo guarda. Devuelve la fila o null.
// `orden` es opcional: si no viene (aviso de `shipments`), se pide.
async function guardarEnvioFlex(slug, envioId, token, orden) {
  if (!envioId) return null;
  const envio = await pedirAMl('/shipments/' + encodeURIComponent(envioId), token);
  if (!envio || !esFlex(envio)) return null;
  if (!envio.id) envio.id = envioId;

  let o = orden || null;
  if (!o && envio.order_id) o = await pedirAMl('/orders/' + encodeURIComponent(envio.order_id), token);
  const costos = await pedirAMl('/shipments/' + encodeURIComponent(envioId) + '/costs', token);

  const fila = filaDeEnvio(slug, envio, o, costos);
  await guardarFilas([fila]);
  return fila;
}

module.exports = { flexHabilitado, esFlex, zonaDeCiudad, sinTildes, filaDeEnvio, guardarFilas, guardarEnvioFlex };
