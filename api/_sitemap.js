// Sitemap para Google: la portada, las páginas legales y una URL por tienda.
//
// Con guion bajo adelante para que Vercel no lo cuente como una función
// aparte (el plan tiene un tope de 12 y ya están todas usadas). Lo atiende
// api/tienda.js, y vercel.json manda /sitemap.xml hacia ahí.
//
// Las tiendas salen de store_profiles con la clave pública: es lo mismo que
// ya muestra el mapa de la portada a cualquiera.

const SUPABASE_URL = 'https://qduguqazpxjjpxjfnkif.supabase.co';
const SUPABASE_KEY = 'sb_publishable_xYt7UXHADSkLyWt4uIRl1w_Ka6WdSbN';

const FIJAS = [
  '/',
  '/legal/terminos.html',
  '/legal/privacidad.html',
  '/legal/cookies.html',
  '/legal/devoluciones.html',
  '/legal/arrepentimiento.html'
];

function escaparXml(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = async (req, res, base) => {
  let slugs = [];
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/store_profiles?select=slug&slug=not.is.null&order=slug&limit=5000',
      { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY } }
    );
    const filas = r.ok ? await r.json() : [];
    if (Array.isArray(filas)) slugs = filas.map((f) => f.slug).filter(Boolean);
  } catch (err) {
    // Sin Supabase el sitemap sale igual, con las páginas fijas.
    console.error('Sitemap sin tiendas:', err);
  }

  const urls = FIJAS.concat(slugs.map((s) => '/' + encodeURIComponent(s)));
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((u) => '  <url><loc>' + escaparXml(base + u) + '</loc></url>').join('\n') +
    '\n</urlset>\n';

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  res.statusCode = 200;
  res.end(xml);
};
