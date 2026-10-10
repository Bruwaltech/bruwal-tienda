// Recibe los errores que anota seguimiento.js en el navegador y los guarda
// en la tabla errores_sitio.
//
// Por qué pasa por acá y no va directo a Supabase: para insertar desde el
// navegador haría falta una política que deje escribir sin estar logueado,
// y con la clave pública cualquiera podría llenar la tabla de basura. Acá
// recortamos todo a un tamaño fijo y guardamos con la service role key.
//
// Siempre responde 204, incluso si algo falla: el navegador no hace nada con
// la respuesta y no queremos que un error al anotar genere otro error.

const SUPABASE_URL = 'https://qduguqazpxjjpxjfnkif.supabase.co';

const TIPOS = ['js', 'promesa', 'red', 'aviso'];

// Solo aceptamos lo que manda nuestro propio sitio (o una vista previa de
// Vercel). No frena a alguien decidido, pero sí a cualquier robot al voleo.
function origenValido(req) {
  const origen = String(req.headers.origin || req.headers.referer || '');
  return /^https:\/\/([a-z0-9-]+\.)*(bruwaltech\.com\.ar|vercel\.app)(\/|$)/i.test(origen);
}

function texto(v, largo) {
  if (v == null) return null;
  const t = String(v).slice(0, largo);
  return t || null;
}

// Por las dudas, aunque seguimiento.js ya los saca: nada de ?parametros
// (el portal de clientes lleva el token en la URL).
function sinQuery(v) {
  return v == null ? v : String(v).replace(/\?[^\s:)'"]*/g, '');
}

function entero(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 && n < 1e7 ? n : null;
}

module.exports = async (req, res) => {
  res.statusCode = 204;
  if (req.method !== 'POST' || !process.env.SUPABASE_SERVICE_ROLE_KEY || !origenValido(req)) {
    return res.end();
  }

  try {
    let datos = req.body;
    // sendBeacon a veces llega como texto aunque diga application/json.
    if (typeof datos === 'string') datos = JSON.parse(datos);
    if (!datos || typeof datos !== 'object') return res.end();

    const tipo = TIPOS.includes(datos.tipo) ? datos.tipo : null;
    const mensaje = texto(datos.mensaje, 500);
    if (!tipo || !mensaje) return res.end();

    const fila = {
      tipo,
      mensaje,
      pagina: texto(sinQuery(datos.pagina), 200),
      fuente: texto(sinQuery(datos.fuente), 300),
      linea: entero(datos.linea),
      columna: entero(datos.columna),
      stack: texto(sinQuery(datos.stack), 2000),
      estado: entero(datos.estado),
      ancho: entero(datos.ancho),
      navegador: texto(req.headers['user-agent'], 300)
    };

    await fetch(SUPABASE_URL + '/rest/v1/errores_sitio', {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(fila)
    });
  } catch (e) {
    console.error('No se pudo anotar el error:', e && e.message);
  }
  return res.end();
};
