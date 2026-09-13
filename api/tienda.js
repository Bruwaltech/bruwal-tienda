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

// Las fotos de nuestro storage se sirven por /api/foto, que las entrega en
// un tamaño que las vistas previas aceptan: WhatsApp no muestra la imagen
// cuando pesa de más, y ahí el link se comparte con un recuadro vacío.
//
// Una foto de otro lado (alguna cargada por URL) se deja tal cual: no
// tenemos por qué hacer de proxy de imágenes ajenas.
const EN_NUESTRO_STORAGE = '/storage/v1/object/public/';

function paraVistaPrevia(url, base) {
  const corte = String(url || '').indexOf(EN_NUESTRO_STORAGE);
  if (corte === -1) return url;
  const objeto = String(url).slice(corte + EN_NUESTRO_STORAGE.length);
  return base + '/api/foto?o=' + encodeURIComponent(objeto);
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
      // Los campos de siempre y los que se fueron sumando, separados a
      // proposito: PostgREST rechaza la consulta ENTERA si UNO solo del
      // select no existe (42703). Con los dos grupos aparte se puede
      // reintentar sin los nuevos y que la vista previa salga igual.
      const CAMPOS_BASE = 'name,description,price,precio_oferta,image_url,imagenes,mostrar_precio,solo_interno';
      const CAMPOS_EXTRA = 'stock,tipo,ml_nota,ml_opiniones';

      const pedirProducto = (campos) => fetch(
        SUPABASE_URL + '/rest/v1/store_products' +
        '?id=eq.' + encodeURIComponent(idProducto) +
        '&store_slug=eq.' + encodeURIComponent(slug) +
        '&select=' + campos,
        { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY } }
      ).then((r) => r.json()).catch(() => null);

      // Las dos consultas juntas: el nombre del negocio va en la vista
      // previa y pedirlo despues seria un viaje mas contra el reloj de la
      // funcion.
      const [filasPrimeras, filasTienda] = await Promise.all([
        pedirProducto(CAMPOS_BASE + ',' + CAMPOS_EXTRA),
        fetch(SUPABASE_URL + '/rest/v1/store_profiles?slug=eq.' + encodeURIComponent(slug) +
              '&select=business_name', {
          headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }
        }).then((r) => r.json()).catch(() => null)
      ]);

      // Si algun campo nuevo no existe todavia en esta base, se vuelve a
      // pedir con los de siempre. Una migracion pendiente puede dejar la
      // vista previa mas pobre; no puede dejarla rota.
      const filasProd = Array.isArray(filasPrimeras) ? filasPrimeras : await pedirProducto(CAMPOS_BASE);

      const prod = Array.isArray(filasProd) ? filasProd[0] : null;
      const nombreTienda = (Array.isArray(filasTienda) && filasTienda[0] && filasTienda[0].business_name) || '';

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

        // El precio EN EL TITULO. La bajada la corta cada aplicacion donde
        // quiere, el titulo no: si el precio esta solo abajo, la mitad de
        // las veces no se ve. Y el precio es lo que hace que alguien abra.
        const tituloCrudo = (prod.name || 'Producto') +
          (precioTexto !== 'Consultar precio' ? ' \u2014 ' + precioTexto : '');

        // Lo que de verdad decide una compra, en orden de peso.
        const partes = [];

        if (oferta > 0 && lista > 0 && oferta < lista) {
          partes.push('\u00a1OFERTA! Antes $' + lista.toLocaleString('es-AR'));
        }
        // "Sin stock" no se dice: en una vista previa espanta antes de que
        // el cliente vea el producto, y para cuando la abre puede haber
        // entrado mercaderia. Solo se habla cuando hay algo bueno que decir.
        const esServicio = (prod.tipo || 'producto') === 'servicio';
        if (!esServicio && Number(prod.stock) > 0) partes.push('Disponible');

        if (prod.ml_nota && Number(prod.ml_opiniones) > 0) {
          partes.push('\u2b50 ' + Number(prod.ml_nota).toFixed(1).replace('.', ',') +
                      ' (' + Number(prod.ml_opiniones) + ')');
        }
        if (prod.description) partes.push(String(prod.description).slice(0, 120));
        if (nombreTienda) partes.push('En ' + nombreTienda);

        const titulo = escapar(tituloCrudo);
        const bajada = escapar(partes.join(' \u00b7 '));

        html = html
          .replace(/(<meta property="og:title" content=")[^"]*(")/,       '$1' + titulo + '$2')
          .replace(/(<meta property="og:description" content=")[^"]*(")/, '$1' + bajada + '$2')
          .replace(/(<meta property="og:url" content=")[^"]*(")/,
                   '$1' + base + '/' + escapar(slug) + '?p=' + escapar(idProducto) + '$2')
          .replace(/<title>[^<]*<\/title>/, '<title>' + titulo + '</title>');

        // og:type product y el precio aparte: Facebook y Telegram los leen
        // y muestran el precio como dato, no como texto suelto.
        // REEMPLAZA el que ya trae el HTML, no agrega otro: con dos
        // og:site_name el robot se queda con el primero, que decia BRUWAL.
        // El dueño de la vista previa es el negocio, no nosotros.
        if (nombreTienda) {
          html = html.replace(/(<meta property="og:site_name" content=")[^"]*(")/,
                              '$1' + escapar(nombreTienda) + '$2');
        }
        if (precioTexto !== 'Consultar precio') {
          html = html.replace('<meta property="og:title"',
            '<meta property="product:price:amount" content="' + vigente + '">\n  ' +
            '<meta property="product:price:currency" content="ARS">\n  ' +
            '<meta property="og:title"');
        }

        if (foto) {
          // Las medidas fijas de 1200x630 son de la imagen de BRUWAL: una
          // foto de producto casi nunca tiene esa forma, y declararlas mal
          // hace que WhatsApp la recorte o la estire.
          html = html
            .replace(/(<meta property="og:image" content=")[^"]*(")/, '$1' + escapar(paraVistaPrevia(foto, base)) + '$2')
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
        // El logo del negocio; si no cargó ninguno, la imagen de BRUWAL.
        // Por /api/foto igual que las de producto: un logo pesado deja la
        // vista previa de la tienda sin imagen, con el mismo resultado.
        const imagen = tienda.image_url
          ? escapar(paraVistaPrevia(tienda.image_url, base))
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
