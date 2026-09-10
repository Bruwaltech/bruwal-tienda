// Notificaciones de Mercado Libre: una venta en ML descuenta el stock acá y
// aparece como pedido en el panel.
//
// SOBRE LA SEGURIDAD DE ESTE ENDPOINT, que es distinta a la del webhook de
// Mercado Pago: Mercado Libre NO firma sus notificaciones. No hay HMAC que
// verificar. Entonces del cuerpo que llega no se cree nada: se toman
// únicamente el user_id y el número de orden, y la orden se le PIDE a la API
// de ML con el token de esa tienda. Si el aviso fuera inventado, la orden no
// existe o no es de esa cuenta, y no pasa nada. Esa consulta es la
// validación real.
//
// IDEMPOTENCIA: ML reintenta las notificaciones que fallan y además avisa
// cada vez que la orden cambia de estado, así que la MISMA venta llega
// muchas veces. store_ml_ordenes tiene el id de la orden como clave
// primaria y una marca stock_descontado: el stock se toca una sola vez, la
// primera que la orden aparece pagada. Sin eso, tres avisos de la misma
// venta descontarían tres veces.

const SUPABASE_URL = 'https://qduguqazpxjjpxjfnkif.supabase.co';
const ML_API = 'https://api.mercadolibre.com';

const { tokenDeTienda } = require('./mercadolibre');

function faltanVariables() {
  return ['ML_CLIENT_ID', 'ML_CLIENT_SECRET', 'SUPABASE_SERVICE_ROLE_KEY']
    .filter((n) => !process.env[n]);
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
  if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + (await r.text()).slice(0, 300));
  if (r.status === 204) return null;
  const texto = await r.text();
  return texto ? JSON.parse(texto) : null;
}

// Misma fórmula que claveVariante() en dashboard/index.html. Si cambia allá,
// cambia acá: es lo que une una variante de ML con una combinación de BRUWAL.
function claveDeAtributos(obj) {
  return Object.keys(obj || {}).sort().map((k) => k + ':' + obj[k]).join('~');
}

// ---------- Full ----------
//
// Con Full la unidad sale del dep\u00f3sito de Mercado Libre, no del local, as\u00ed
// que descontarle stock al producto de BRUWAL ser\u00eda restar algo que nunca
// estuvo en el negocio.
//
// Se pregunta por el env\u00edo de la orden y no por lo guardado en el v\u00ednculo
// a prop\u00f3sito: una publicaci\u00f3n puede pasarse a Full cualquier d\u00eda, y el
// v\u00ednculo quedar\u00eda viejo sin que nadie se entere. Si la consulta falla, se
// cae al dato del v\u00ednculo, que es mejor que nada.
async function logisticaDeOrden(orden, token) {
  const idEnvio = orden.shipping && orden.shipping.id;
  if (!idEnvio) return null;
  try {
    const r = await fetch(ML_API + '/shipments/' + encodeURIComponent(idEnvio), {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!r.ok) return null;
    const envio = await r.json();
    return envio.logistic_type || null;
  } catch (e) {
    return null;
  }
}


// ---------- Descontar ----------

// Una linea de la venta que no se pudo emparejar con un producto de BRUWAL.
//
// Se arma con lo que mando Mercado Libre y va SIN product_id a proposito:
// asi el pedido queda registrado con su plata y su detalle, pero ningun
// stock se mueve (aplicarStockDeItem saltea los items sin producto, igual
// que ya hace con las deudas cargadas a mano).
//
// El caso real: la venta entra, y como la publicacion no estaba vinculada,
// no se registraba NADA. La comision si se anotaba. Quedaba el gasto sin la
// venta que lo genero.
function itemSuelto(linea, motivo) {
  return {
    qty: Number(linea.quantity) || 0,
    name: (linea.item && linea.item.title) ||
          ('Publicaci\u00f3n ' + ((linea.item && linea.item.id) || 'de Mercado Libre')),
    price: Number(linea.unit_price) || 0,
    ml_item_id: String((linea.item && linea.item.id) || ''),
    sin_vincular: true,
    motivo: motivo
  };
}

// Devuelve el item para el pedido del panel. Nunca null cuando la linea
// tiene producto y cantidad: si no se puede emparejar, devuelve el item
// suelto para que la venta quede igual.
async function descontarUnItem(slug, linea, resumen, esFull) {
  const itemId = linea.item && linea.item.id;
  const variacionId = linea.item && linea.item.variation_id;
  const cantidad = Number(linea.quantity) || 0;
  if (!itemId || !cantidad) return null;

  const filtroVariacion = variacionId
    ? '&ml_variation_id=eq.' + encodeURIComponent(String(variacionId))
    : '&ml_variation_id=is.null';

  const vinculos = await sb('/rest/v1/store_ml_vinculos?store_slug=eq.' + encodeURIComponent(slug) +
    '&ml_item_id=eq.' + encodeURIComponent(String(itemId)) + filtroVariacion +
    '&select=product_id,variante_local,logistica');

  const vinculo = vinculos && vinculos[0];
  if (!vinculo) {
    // Publicación sin vincular: no se adivina a qué producto pertenece,
    // porque descontarle a otro es peor que no descontar. Pero la venta se
    // registra igual, con la linea tal como la mando Mercado Libre.
    resumen.sinVinculo.push(String(itemId) + (variacionId ? '/' + variacionId : ''));
    return itemSuelto(linea, 'sin vincular');
  }

  const productos = await sb('/rest/v1/store_products?id=eq.' + encodeURIComponent(vinculo.product_id) +
    '&select=id,name,price,stock,tiene_variantes,variantes');
  const producto = productos && productos[0];
  // El vinculo apunta a un producto que ya no existe (lo borraron). Mismo
  // criterio: no hay stock que tocar, pero la venta entro.
  if (!producto) {
    resumen.sinProducto.push(vinculo.product_id);
    return itemSuelto(linea, 'el producto vinculado ya no existe');
  }

  // Full (o el v\u00ednculo dice que esa publicaci\u00f3n va por Full): la venta se
  // registra igual \u2014 ingreso, comisi\u00f3n y pedido \u2014 pero el stock del local
  // no se toca, porque esa unidad no sali\u00f3 de ac\u00e1.
  const porFull = esFull || vinculo.logistica === 'fulfillment';
  if (porFull) {
    resumen.porFull++;
    return {
      product_id: producto.id,
      qty: cantidad,
      name: producto.name,
      price: Number(linea.unit_price) || Number(producto.price) || 0,
      full: true
    };
  }

  let variante = null;

  if (vinculo.variante_local && producto.tiene_variantes && Array.isArray(producto.variantes)) {
    const lista = producto.variantes.map((v) => Object.assign({}, v));
    const i = lista.findIndex((v) => claveDeAtributos(v.atributos) === vinculo.variante_local);
    // La combinacion (talle/color) vinculada ya no esta en el producto.
    if (i < 0) {
      resumen.sinVariante.push(vinculo.variante_local);
      return itemSuelto(linea, 'la variante vinculada ya no existe');
    }

    variante = lista[i].atributos || {};
    lista[i].stock = Math.max(0, (Number(lista[i].stock) || 0) - cantidad);
    await sb('/rest/v1/store_products?id=eq.' + encodeURIComponent(producto.id), {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: { variantes: lista }
    });
  } else {
    const nuevo = Math.max(0, (Number(producto.stock) || 0) - cantidad);
    await sb('/rest/v1/store_products?id=eq.' + encodeURIComponent(producto.id), {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: { stock: nuevo }
    });
  }

  resumen.descontados++;

  // Misma forma que usa el resto del panel para los ítems de un pedido:
  // product_id, qty, name, price y, si corresponde, variante. Con eso
  // Pedidos lo muestra bien y, si se cancela, el stock vuelve solo.
  const item = {
    product_id: producto.id,
    qty: cantidad,
    name: producto.name,
    price: Number(linea.unit_price) || Number(producto.price) || 0
  };
  if (variante) item.variante = variante;
  return item;
}

// Mercado Pago acredita el total MENOS lo que se queda Mercado Libre. El
// vendedor nunca "paga" esa comision: le llega menos plata. Pero la venta
// entra por el bruto, asi que si la comision no se anota en ningun lado,
// Caja y Estadisticas muestran mas ganancia de la que hay.
//
// Se registra una sola vez, junto con el pedido, porque este bloque solo se
// ejecuta la primera vez que la orden aparece pagada.
async function registrarComision(slug, orden) {
  const lineas = (orden.order_items || []);
  // sale_fee se asume POR UNIDAD, igual que en el panel. Si con una venta
  // real resulta ser por linea, hay que sacar el "* cantidad" en los dos
  // lados: aca y en costosDeOrdenMl() del dashboard.
  let comision = 0;
  lineas.forEach((li) => {
    comision += (Number(li.sale_fee) || 0) * (Number(li.quantity) || 0);
  });
  comision = Math.round(comision * 100) / 100;
  if (comision <= 0) return 0;

  const fecha = (orden.date_created || new Date().toISOString()).slice(0, 10);

  await sb('/rest/v1/store_gastos', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: [{
      store_slug: slug,
      concepto: 'Comisi\u00f3n Mercado Libre \u2014 Orden ' + orden.id,
      categoria: 'Comisiones Mercado Libre',
      monto: comision,
      moneda: 'ARS',
      monto_original: comision,
      cotizacion: 1,
      fecha: fecha,
      medio_pago: 'Descontado por Mercado Libre',
      notas: 'Registrada sola desde la venta de Mercado Libre. No se paga aparte: ' +
             'Mercado Pago acredita el total menos esta comisi\u00f3n.'
    }]
  });

  return comision;
}

async function registrarPedido(slug, orden, items, resumen) {
  // Solo si Mercado Libre mando una orden sin lineas, que no deberia pasar.
  // Antes esto se cumplia tambien cuando ninguna linea estaba vinculada, y
  // ahi se perdia la venta entera.
  if (!items.length) return null;

  const comprador = (orden.buyer && (orden.buyer.nickname || orden.buyer.first_name)) || 'Mercado Libre';

  // customer_phone: 'scanner' es el centinela de "sin teléfono" que ya leen
  // Pedidos, Fiado y el estado de cuenta. Una venta de ML no trae teléfono
  // del comprador, así que usa el mismo contrato que la venta de mostrador.
  const filas = await sb('/rest/v1/orders', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: [{
      store_slug: slug,
      customer_name: 'Mercado Libre — ' + comprador,
      customer_phone: 'scanner',
      items: items,
      total: Number(orden.total_amount) || 0,
      // `aclaraciones`, NO `notes`. Esa columna no existe y nunca existio:
      // el insert fallaba con PGRST204 y se perdia la venta ENTERA, todas
      // las veces. Es la misma columna que usa el checkout de la tienda.
      aclaraciones: 'Venta de Mercado Libre. Orden ' + orden.id +
             (resumen.porFull ? '. Enviada por Full: no se descont\u00f3 stock del local.' : '') +
             // Que quede escrito en el pedido: la venta esta registrada pero
             // el stock de esas lineas NO se movio, y hay que ajustarlo a
             // mano o vincular la publicacion para la proxima.
             (resumen.sinVinculo.length
               ? '. OJO: no se descont\u00f3 stock de ' + resumen.sinVinculo.length +
                 (resumen.sinVinculo.length === 1 ? ' publicaci\u00f3n sin vincular (' : ' publicaciones sin vincular (') +
                 resumen.sinVinculo.join(', ') + '). Vincul\u00e1 la publicaci\u00f3n para que se descuente sola.'
               : '') +
             (resumen.sinProducto.length
               ? '. El producto vinculado ya no existe: ' + resumen.sinProducto.join(', ') + '.'
               : '') +
             (resumen.sinVariante.length
               ? '. La variante vinculada ya no existe: ' + resumen.sinVariante.join(', ') + '.'
               : '')
    }]
  });

  return (filas && filas[0] && filas[0].id) || null;
}

// Registrar una orden de Mercado Libre en BRUWAL: descontar el stock, crear
// el pedido y anotar la comision.
//
// Vive en su propia funcion porque la usan DOS caminos: el aviso de Mercado
// Libre, que es lo normal, y el rescate a mano desde el panel para las
// ventas que no hayan quedado registradas. Un solo lugar donde esta escrito
// que significa "registrar una venta", asi los dos caminos no se separan.
async function registrarOrdenEnBruwal(slug, orden, token) {
  const resumen = { descontados: 0, porFull: 0, comision: 0, sinVinculo: [], sinProducto: [], sinVariante: [] };
  const items = [];

  const logistica = await logisticaDeOrden(orden, token);
  const esFull = logistica === 'fulfillment';

  for (const linea of (orden.order_items || [])) {
    const item = await descontarUnItem(slug, linea, resumen, esFull);
    if (item) items.push(item);
  }

  const idPedido = await registrarPedido(slug, orden, items, resumen);
  resumen.comision = await registrarComision(slug, orden);

  return { resumen: resumen, items: items, idPedido: idPedido };
}


// ---------- Entrada ----------

module.exports = async (req, res) => {
  // A Mercado Libre siempre se le contesta rápido. Un 200 significa
  // "recibido"; cualquier otra cosa hace que reintente, y para eso están los
  // 500 de más abajo: para los errores que SÍ conviene reintentar.
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const faltan = faltanVariables();
  if (faltan.length) {
    console.error('ml-webhook: faltan variables', faltan);
    return res.status(500).json({ error: 'Faltan variables de entorno' });
  }

  const aviso = req.body || {};
  const topico = aviso.topic || aviso.Topic;

  // Solo ventas. El resto de los tópicos se acepta y se ignora, para que ML
  // no los reintente en loop si algún día se activan de más.
  if (topico !== 'orders_v2') return res.status(200).json({ ignorado: topico || 'sin topico' });

  const recurso = String(aviso.resource || '');
  const idOrden = recurso.split('/').filter(Boolean).pop();
  if (!idOrden) return res.status(200).json({ ignorado: 'sin resource' });

  try {
    const tiendas = await sb('/rest/v1/store_ml_cuenta?ml_user_id=eq.' +
      encodeURIComponent(String(aviso.user_id)) + '&select=store_slug');
    const tienda = tiendas && tiendas[0];
    // Aviso de una cuenta que no está conectada a ninguna tienda: no es un
    // error nuestro y reintentarlo no va a cambiar nada.
    if (!tienda) return res.status(200).json({ ignorado: 'cuenta no conectada' });

    const slug = tienda.store_slug;
    const token = await tokenDeTienda(slug);
    if (!token) return res.status(200).json({ ignorado: 'sin token' });

    // Acá está la validación: la orden se la pedimos a ML, no la creemos del
    // cuerpo del aviso.
    const r = await fetch(ML_API + '/orders/' + encodeURIComponent(idOrden), {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (r.status === 404 || r.status === 403) {
      return res.status(200).json({ ignorado: 'orden inaccesible (' + r.status + ')' });
    }
    if (!r.ok) throw new Error('ML ' + r.status + ' al leer la orden');
    const orden = await r.json();

    const previas = await sb('/rest/v1/store_ml_ordenes?ml_order_id=eq.' +
      encodeURIComponent(String(orden.id)) + '&select=ml_order_id,stock_descontado');
    const previa = previas && previas[0];

    const pagada = orden.status === 'paid';

    // Ya la vimos: solo se refresca el estado. El stock NO se vuelve a tocar.
    if (previa) {
      await sb('/rest/v1/store_ml_ordenes?ml_order_id=eq.' + encodeURIComponent(String(orden.id)), {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: { estado: orden.status, detalle: orden, actualizado_en: new Date().toISOString() }
      });
      return res.status(200).json({ ok: true, repetida: true, stock_descontado: previa.stock_descontado });
    }

    let resumen = { descontados: 0, porFull: 0, comision: 0, sinVinculo: [], sinProducto: [], sinVariante: [] };
    let items = [];
    let idPedido = null;

    if (pagada) {
      const hecho = await registrarOrdenEnBruwal(slug, orden, token);
      resumen = hecho.resumen;
      items = hecho.items;
      idPedido = hecho.idPedido;
    }

    await sb('/rest/v1/store_ml_ordenes', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: [{
        ml_order_id: String(orden.id),
        store_slug: slug,
        estado: orden.status,
        // "se resolvi\u00f3 bien": se descont\u00f3, o no correspond\u00eda porque es Full.
        stock_descontado: pagada && (resumen.descontados > 0 || resumen.porFull > 0),
        sin_vincular: resumen.sinVinculo.length > 0,
        logistica: pagada ? (resumen.porFull ? 'fulfillment' : 'propio') : null,
        order_id: idPedido,
        total: Number(orden.total_amount) || 0,
        comprador: (orden.buyer && orden.buyer.nickname) || null,
        detalle: orden
      }]
    });

    return res.status(200).json({
      ok: true,
      pagada: pagada,
      descontados: resumen.descontados,
      por_full: resumen.porFull,
      comision: resumen.comision,
      sin_vinculo: resumen.sinVinculo.length
    });
  } catch (err) {
    // Un 500 hace que Mercado Libre reintente, que es lo que queremos si el
    // que falló fue Supabase o la propia API de ML.
    console.error('ml-webhook', idOrden, err);
    return res.status(500).json({ error: String(err.message || err) });
  }
};

// La usa el rescate de ventas desde el panel (ver api/mercadolibre.js).
module.exports.registrarOrdenEnBruwal = registrarOrdenEnBruwal;
