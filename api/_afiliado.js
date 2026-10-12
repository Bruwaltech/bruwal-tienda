// Panel del afiliado, para la página pública afiliado.html.
//
// Con guion bajo adelante para que Vercel no lo cuente como una función
// aparte: el plan tiene un tope de 12 y ya estaban todas usadas. Lo atiende
// api/estado-cuenta.js (los dos son portales públicos por token), y
// vercel.json manda /api/afiliado hacia ahí.
//
// Mismo esquema que api/estado-cuenta.js: el token viaja al servidor, se
// resuelve con la service role key y se devuelve solo lo de ese afiliado.
// Los pedidos salen SIN nombre ni teléfono del cliente: el afiliado tiene
// que saber qué vendió y cuánto cobra, no a quién le vendió la tienda.

const SUPABASE_URL = 'https://qduguqazpxjjpxjfnkif.supabase.co';

// Cuántos meses hacia atrás se muestran venta por venta. Alcanza para ver
// la evolución sin mandar el historial entero de un afiliado viejo; el
// total desde que empezó sí suma todo.
const MESES_DE_HISTORIAL = 6;

function faltanVariables() {
  return ['SUPABASE_SERVICE_ROLE_KEY'].filter((n) => !process.env[n]);
}

async function consultar(ruta) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + ruta, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY
    }
  });
  if (!r.ok) throw new Error('Supabase respondió ' + r.status);
  return r.json();
}

// Mes en hora de Buenos Aires ('2026-10'): un pedido del 31 a las 23 h no
// puede caer en el mes siguiente porque el servidor corre en UTC.
const mesAR = (fecha) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit'
}).format(new Date(fecha)).slice(0, 7);

// Igual que el panel del dueño (baseDeComision en dashboard/index.html):
// los productos cobrados, sin envío y con el descuento del código restado.
function baseDeComision(o) {
  const productos = (o.items || []).reduce((s, it) => s + Number(it.price || 0) * Number(it.qty || 0), 0);
  const base = (productos || Number(o.total || 0)) - Number(o.afiliado_descuento || 0);
  return Math.max(0, base);
}

// Los pedidos viejos no tienen estado y cuentan como confirmados, igual
// que en el panel (estadoPedido en dashboard/index.html).
const estadoDe = (o) => o.estado || 'confirmado';

// El manifest para instalar el panel en el celular. Uno por afiliado: el
// start_url lleva su token, así el ícono abre su panel. Como el id del
// manifest sale del start_url, dos afiliados en el mismo teléfono son dos
// apps distintas.
async function manifestDelPanel(res, token) {
  const afiliados = await consultar(
    'store_afiliados?token=eq.' + token + '&activo=is.true&select=store_slug&limit=1');
  if (!afiliados.length) return res.status(404).json({ error: 'Este link no está activo.' });
  const tiendas = await consultar('store_profiles?slug=eq.' + encodeURIComponent(afiliados[0].store_slug) +
                                  '&select=business_name&limit=1');
  const negocio = ((tiendas[0] && tiendas[0].business_name) || 'BRUWAL').trim();

  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  return res.status(200).send(JSON.stringify({
    name: 'Mi panel de afiliado · ' + negocio,
    short_name: negocio.length <= 12 ? negocio : 'Mi panel',
    description: 'Tus ventas y comisiones como afiliado de ' + negocio + '.',
    lang: 'es-AR',
    start_url: '/afiliado.html?t=' + token,
    scope: '/afiliado.html',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#F4F7FB',
    theme_color: '#15294D',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
  }));
}

module.exports = async (req, res) => {
  const faltan = faltanVariables();
  if (faltan.length) {
    return res.status(500).json({ error: 'Falta configurar: ' + faltan.join(', ') });
  }

  const token = String((req.query && req.query.t) || '').trim();
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return res.status(400).json({ error: 'Link inválido' });
  }

  try {
    if (req.query.manifest) return await manifestDelPanel(res, token);

    const afiliados = await consultar(
      'store_afiliados?token=eq.' + token + '&activo=is.true' +
      '&select=store_slug,codigo,nombre,comision_pct,descuento_pct&limit=1'
    );

    // Mismo mensaje para "no existe" y "pausado": no confirmamos que el
    // link existió alguna vez.
    if (!afiliados.length) {
      return res.status(404).json({ error: 'Este link no está activo. Pedile uno nuevo al negocio.' });
    }

    const a = afiliados[0];
    const desde = new Date();
    desde.setMonth(desde.getMonth() - MESES_DE_HISTORIAL);
    const mesDesde = mesAR(desde);

    const [tiendas, pedidos] = await Promise.all([
      consultar('store_profiles?slug=eq.' + encodeURIComponent(a.store_slug) +
                '&select=business_name,phone,image_url&limit=1'),
      consultar('orders?store_slug=eq.' + encodeURIComponent(a.store_slug) +
                '&afiliado_codigo=eq.' + encodeURIComponent(a.codigo) +
                '&select=created_at,items,total,estado,mp_pago_id,afiliado_comision_pct,afiliado_descuento' +
                '&order=created_at.desc')
    ]);

    const ventas = pedidos
      .filter((o) => estadoDe(o) !== 'cancelado')
      .map((o) => {
        const base = baseDeComision(o);
        return {
          fecha: o.created_at,
          mes: mesAR(o.created_at),
          // 'pendiente' = el cliente mandó el pedido pero el negocio todavía
          // no lo confirmó. Se muestra, pero no suma a lo cobrado. Pagado
          // por Mercado Pago ya cuenta: el panel lo confirma solo cuando el
          // dueño lo abre, y el afiliado no tiene por qué esperar a eso.
          confirmado: estadoDe(o) !== 'pendiente' || !!o.mp_pago_id,
          productos: (o.items || []).map((it) => ({
            nombre: it.name || it.label || 'Producto',
            cantidad: Number(it.qty || 1)
          })),
          vendido: Math.round(base),
          comision: Math.round(base * Number(o.afiliado_comision_pct || 0) / 100)
        };
      });

    // Desde que empezó: solo lo confirmado, igual que los totales del mes.
    const total = { ventas: 0, vendido: 0, comision: 0 };
    ventas.filter((v) => v.confirmado).forEach((v) => {
      total.ventas += 1;
      total.vendido += v.vendido;
      total.comision += v.comision;
    });

    const recientes = ventas.filter((v) => v.mes >= mesDesde);
    const porMes = {};
    recientes.forEach((v) => {
      const m = porMes[v.mes] || (porMes[v.mes] = { mes: v.mes, ventas: 0, vendido: 0, comision: 0, por_confirmar: 0 });
      if (v.confirmado) {
        m.ventas += 1;
        m.vendido += v.vendido;
        m.comision += v.comision;
      } else {
        m.por_confirmar += 1;
      }
    });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      negocio: tiendas[0] || {},
      afiliado: {
        nombre: a.nombre,
        codigo: a.codigo,
        comision_pct: Number(a.comision_pct),
        descuento_pct: Number(a.descuento_pct),
        slug: a.store_slug
      },
      mes_actual: mesAR(new Date()),
      meses: Object.values(porMes).sort((x, y) => (x.mes < y.mes ? 1 : -1)),
      total,
      ventas: recientes,
      generado: new Date().toISOString()
    });
  } catch (e) {
    return res.status(500).json({ error: 'No pudimos traer tus ventas. Probá de nuevo en un momento.' });
  }
};
