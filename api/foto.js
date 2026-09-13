// Sirve la foto de un producto en un tamaño que las vistas previas acepten.
//
// EL PROBLEMA: WhatsApp no muestra la imagen de la vista previa cuando pesa
// demasiado. Una foto de 1,7 MB (pasa con los PNG, y con cualquier foto que
// no haya pasado por la compresión del panel) hace que el link se comparta
// sin imagen: se ve el título y el precio, y un recuadro vacío.
//
// Supabase sabe achicar la foto, pero SOLO entrega la versión liviana si
// quien la pide dice que acepta webp. Medido con la foto de un producto real:
//
//   Accept: */*                  ->  1.662.332 bytes  (png)
//   Accept: image/webp,image/*   ->     89.176 bytes  (webp)
//
// El robot de WhatsApp manda */*, así que recibe el original pesado. Esta
// función se pone en el medio: pide la versión liviana (diciendo que acepta
// webp, porque nosotros sí) y se la devuelve a quien haya preguntado.
//
// Solo se mete cuando hace falta. Si la foto ya es liviana, manda a buscarla
// al storage y listo: una foto que ya estaba bien no tiene por qué pasar por
// acá ni cambiar de formato.

const SUPABASE_URL = 'https://qduguqazpxjjpxjfnkif.supabase.co';

// Arriba de esto, WhatsApp deja de mostrar la vista previa. El número es
// conservador a propósito: no hay una cifra oficial y el costo de pasarse es
// que la imagen no se vea.
const PESO_MAXIMO = 400 * 1024;

const ANCHO = 1200;

module.exports = async (req, res) => {
  const objeto = String((req.query && req.query.o) || '').trim();

  // Solo rutas de nuestro propio storage. Sin esto, cualquiera podría usar
  // el dominio como proxy para servir lo que quiera, y las imágenes
  // parecerían venir de BRUWAL.
  if (!objeto || objeto.includes('..') || objeto.includes('://') || objeto.startsWith('/')) {
    res.statusCode = 400;
    return res.end('ruta invalida');
  }

  const original = SUPABASE_URL + '/storage/v1/object/public/' + objeto;
  const achicada = SUPABASE_URL + '/storage/v1/render/image/public/' + objeto +
                   '?width=' + ANCHO + '&quality=75';

  try {
    // Cuánto pesa hoy. Es una llamada sin cuerpo, barata.
    const cabeza = await fetch(original, { method: 'HEAD' });
    const pesa = Number(cabeza.headers.get('content-length') || 0);

    if (cabeza.ok && pesa > 0 && pesa <= PESO_MAXIMO) {
      // Ya estaba bien: que la sirva el storage, que para eso está.
      res.statusCode = 302;
      res.setHeader('Location', original);
      res.setHeader('Cache-Control', 'public, s-maxage=86400');
      return res.end();
    }

    const r = await fetch(achicada, { headers: { Accept: 'image/webp,image/*,*/*' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);

    const bytes = Buffer.from(await r.arrayBuffer());

    // Si achicarla no alcanzó, igual se manda: una imagen grande tiene más
    // chances de mostrarse que ninguna.
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/webp');
    res.setHeader('Content-Length', bytes.length);
    // Un día en el borde: la foto de un producto no cambia seguido, y cada
    // visita a la tienda compartida pasa por acá.
    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    res.statusCode = 200;
    return res.end(bytes);
  } catch (err) {
    // Ante cualquier problema, la original. Peor que una foto pesada es
    // ninguna foto.
    res.statusCode = 302;
    res.setHeader('Location', original);
    return res.end();
  }
};
