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

// ---------- Descontar ----------

// Devuelve el item para el pedido del panel, o null si esa línea de la venta
// no tiene con qué corresponderse acá.
async function descontarUnItem(slug, linea, resumen) {
  const itemId = linea.item && linea.item.id;
  const variacionId = linea.item && linea.item.variation_id;
  const cantidad = Number(linea.quantity) || 0;
  if (!itemId || !cantidad) return null;

  const filtroVariacion = variacionId
    ? '&ml_variation_id=eq.' + encodeURIComponent(String(variacionId))
    : '&ml_variation_id=is.null';

  const vinculos = await sb('/rest/v1/store_ml_vinculos?store_slug=eq.' + encodeURIComponent(slug) +
    '&ml_item_id=eq.' + encodeURIComponent(String(itemId)) + filtroVariacion +
    '&select=product_id,variante_local');

  const vinculo = vinculos && vinculos[0];
  if (!vinculo) {
    // Publicación sin vincular: se anota y se sigue. No se adivina a qué
    // producto pertenece, porque descontarle a otro es peor que no descontar.
    resumen.sinVinculo.push(String(itemId) + (variacionId ? '/' + variacionId : ''));
    return null;
  }

  const productos = await sb('/rest/v1/store_products?id=eq.' + encodeURIComponent(vinculo.product_id) +
    '&select=id,name,price,stock,tiene_variantes,variantes');
  const producto = productos && productos[0];
  if (!producto) { resumen.sinProducto.push(vinculo.product_id); return null; }

  let variante = null;

  if (vinculo.variante_local && producto.tiene_variantes && Array.isArray(producto.variantes)) {
    const lista = producto.variantes.map((v) => Object.assign({}, v));
    const i = lista.findIndex((v) => claveDeAtributos(v.atributos) === vinculo.variante_local);
    if (i < 0) { resumen.sinVariante.push(vinculo.variante_local); return null; }

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
      notes: 'Venta de Mercado Libre. Orden ' + orden.id +
             (resumen.sinVinculo.length ? '. Sin vincular: ' + resumen.sinVinculo.join(', ') : '')
    }]
  });

  return (filas && filas[0] && filas[0].id) || null;
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

    const resumen = { descontados: 0, comision: 0, sinVinculo: [], sinProducto: [], sinVariante: [] };
    let items = [];
    let idPedido = null;

    if (pagada) {
      for (const linea of (orden.order_items || [])) {
        const item = await descontarUnItem(slug, linea, resumen);
        if (item) items.push(item);
      }
      idPedido = await registrarPedido(slug, orden, items, resumen);
      resumen.comision = await registrarComision(slug, orden);
    }

    await sb('/rest/v1/store_ml_ordenes', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: [{
        ml_order_id: String(orden.id),
        store_slug: slug,
        estado: orden.status,
        stock_descontado: pagada && resumen.descontados > 0,
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
