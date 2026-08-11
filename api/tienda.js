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

  try {
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
