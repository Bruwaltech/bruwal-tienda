// Genera la vista previa de cada tienda para cuando se comparte el link.
//
// Por qué existe esto: el robot de WhatsApp (y el de Facebook, Telegram,
// Google) NO ejecuta JavaScript. Lee el HTML tal como sale del servidor.
// Como tienda.html decide qué tienda mostrar recién al ejecutarse en el
// navegador, el robot nunca veía el nombre ni el logo del negocio.
//
// Esta función se mete en el medio: busca la tienda, reemplaza las
// etiquetas og: del HTML y lo devuelve ya armado. El navegador de una
// persona sigue recibiendo exactamente la misma página de siempre.

const SUPABASE_URL = 'https://qduguqazpxjjpxjfnkif.supabase.co';
const SUPABASE_KEY = 'sb_publishable_xYt7UXHADSkLyWt4uIRl1w_Ka6WdSbN';

// El nombre y la descripción los escribe el vendedor: si no los escapamos,
// unas comillas podrían romper el HTML o inyectar contenido.
function escapar(texto) {
  return String(texto || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = async (req, res) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const base = 'https://' + host;
  const slug = String((req.query && req.query.slug) || '').trim();

  let html = '';

  try {
    // La página base, desde el mismo despliegue
    const resp = await fetch(base + '/tienda.html');
    html = await resp.text();
  } catch (err) {
    // Sin la página base no hay nada que hacer: que siga el camino normal
    res.setHeader('Location', '/tienda.html?slug=' + encodeURIComponent(slug));
    res.statusCode = 302;
    return res.end();
  }

  // ?p=<id> es un link a UN producto (el boton Compartir de la ficha). La
  // vista previa tiene que mostrar la foto y el precio de ESE articulo, no
  // el logo de la tienda: compartido en un estado, la foto es todo.
  const idProducto = String((req.query && req.query.p) || '').trim();

  try {
    if (slug && idProducto) {
      const consultaProd = SUPABASE_URL + '/rest/v1/store_products' +
        '?id=eq.' + encodeURIComponent(idProducto) +
        '&store_slug=eq.' + encodeURIComponent(slug) +
        '&select=name,description,price,precio_oferta,image_url,imagenes,mostrar_precio,solo_interno';

      const rp = await fetch(consultaProd, {
        headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }
      });
      const filasProd = await rp.json();
      const prod = Array.isArray(filasProd) ? filasProd[0] : null;

      // solo_interno son repuestos que el duenio usa desde el panel y que
      // nunca deberian poder comprarse: tampoco se comparten.
      if (prod && !prod.solo_interno) {
        const lista = Number(prod.price || 0);
        const oferta = Number(prod.precio_oferta || 0);
        const vigente = (oferta > 0 && lista > 0 && oferta < lista) ? oferta : lista;

        const precioTexto = (prod.mostrar_precio === false || !vigente)
          ? 'Consultar precio'
          : '$' + vigente.toLocaleString('es-AR');

        const foto = (Array.isArray(prod.imagenes) && prod.imagenes.length)
          ? prod.imagenes[0]
          : (prod.image_url || null);

        const titulo = escapar(prod.name || 'Producto');
        const bajada = escapar(
          precioTexto + (prod.description ? ' \u2014 ' + String(prod.description).slice(0, 140) : '')
        );

        html = html
          .replace(/(<meta property="og:title" content=")[^"]*(")/,       '$1' + titulo + '$2')
          .replace(/(<meta property="og:description" content=")[^"]*(")/, '$1' + bajada + '$2')
          .replace(/(<meta property="og:url" content=")[^"]*(")/,
                   '$1' + base + '/' + escapar(slug) + '?p=' + escapar(idProducto) + '$2')
          .replace(/<title>[^<]*<\/title>/, '<title>' + titulo + '</title>');

        if (foto) {
          // Las medidas fijas de 1200x630 son de la imagen de BRUWAL: una
          // foto de producto casi nunca tiene esa forma, y declararlas mal
          // hace que WhatsApp la recorte o la estire.
          html = html
            .replace(/(<meta property="og:image" content=")[^"]*(")/, '$1' + escapar(foto) + '$2')
            .replace(/<meta property="og:image:width" content="[^"]*">\s*/, '')
            .replace(/<meta property="og:image:height" content="[^"]*">\s*/, '');
        }

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
        res.statusCode = 200;
        return res.end(html);
      }
      // Si el producto no existe seguimos de largo y se comparte la tienda.
    }

    if (slug) {
      const consulta = SUPABASE_URL + '/rest/v1/store_profiles' +
        '?slug=eq.' + encodeURIComponent(slug) +
        '&select=business_name,description,image_url';

      const r = await fetch(consulta, {
        headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }
      });

      const filas = await r.json();
      const tienda = Array.isArray(filas) ? filas[0] : null;

      if (tienda) {
        const titulo = escapar(tienda.business_name || 'Tienda');
        const bajada = escapar(
          tienda.description
            ? tienda.description + ' — Mirá el catálogo y pedí por WhatsApp.'
            : 'Mirá el catálogo y pedí por WhatsApp.'
        );
        // El logo del negocio; si no cargó ninguno, la imagen de BRUWAL
        const imagen = tienda.image_url
          ? escapar(tienda.image_url)
          : base + '/og-tienda.png';

        html = html
          .replace(/(<meta property="og:title" content=")[^"]*(")/,       '$1' + titulo + '$2')
          .replace(/(<meta property="og:description" content=")[^"]*(")/, '$1' + bajada + '$2')
          .replace(/(<meta property="og:image" content=")[^"]*(")/,       '$1' + imagen + '$2')
          .replace(/(<meta property="og:url" content=")[^"]*(")/,         '$1' + base + '/' + escapar(slug) + '$2')
          .replace(/<title>[^<]*<\/title>/, '<title>' + titulo + '</title>');

        // El logo suele ser cuadrado, no 1200x630: sacamos las medidas
        // fijas para que WhatsApp no lo estire.
        if (tienda.image_url) {
          html = html
            .replace(/<meta property="og:image:width" content="[^"]*">\s*/, '')
            .replace(/<meta property="og:image:height" content="[^"]*">\s*/, '')
            .replace('<meta name="twitter:card" content="summary_large_image">',
                     '<meta name="twitter:card" content="summary">');
        }
      }
    }
  } catch (err) {
    // Si Supabase no responde servimos la página igual, con las etiquetas
    // genéricas. Una vista previa sin personalizar es mucho mejor que un
    // link roto.
    console.error('No se pudo personalizar la vista previa:', err);
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Cache corto: si el vendedor cambia su logo, se refleja en minutos
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  res.statusCode = 200;
  res.end(html);
};
