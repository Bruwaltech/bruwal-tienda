// Lee una factura de proveedor (foto o PDF) con IA y devuelve los productos
// detectados para que el vendedor los revise antes de cargarlos al stock.
//
// Este endpoint NUNCA escribe en la base: la carga real de productos la hace
// el dashboard con la sesión del vendedor, exactamente igual que "Importar
// Excel" — acá solo se convierte una foto en datos estructurados.
//
// Gateado a plan Pro del lado del servidor (no solo escondiendo el botón en
// el dashboard, como Caja/Estadísticas/IMEI): a diferencia de esas pantallas,
// cada factura leída es una llamada real y paga a la IA, así que hay que
// frenar el abuso acá y no solo en la interfaz.

const Anthropic = require('@anthropic-ai/sdk');

const SUPABASE_URL = 'https://qduguqazpxjjpxjfnkif.supabase.co';
const PLANES_CON_ACCESO = ['pro', 'cortesia'];

// Vercel corta el body en ~4.5MB en cualquier plan — el frontend comprime
// las fotos antes de mandarlas, pero un PDF pesado puede seguir pasándose.
// Se corta acá con un mensaje claro en vez de dejar que Vercel tire un 413
// genérico sin explicación.
const TAMANO_MAXIMO_BASE64 = 4 * 1024 * 1024;

const anthropic = new Anthropic();

function faltanVariables() {
  return ['ANTHROPIC_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY'].filter((n) => !process.env[n]);
}

async function usuarioDeToken(token) {
  const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { Authorization: 'Bearer ' + token, apikey: process.env.SUPABASE_SERVICE_ROLE_KEY }
  });
  if (!r.ok) return null;
  return r.json();
}

async function tiendaDelUsuario(userId) {
  const r = await fetch(
    SUPABASE_URL + '/rest/v1/store_profiles?user_id=eq.' + encodeURIComponent(userId) + '&select=slug,plan',
    { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY } }
  );
  if (!r.ok) return null;
  const filas = await r.json();
  return filas[0] || null;
}

const HERRAMIENTA = {
  name: 'registrar_factura',
  description: 'Devuelve los datos extraídos de una factura de proveedor: total y cada producto con cantidad, precio unitario e IVA.',
  input_schema: {
    type: 'object',
    properties: {
      proveedor: { type: 'string', description: 'Nombre del proveedor/emisor, si figura' },
      numero_factura: { type: 'string', description: 'Número (y letra, ej. "A 0001-00001234") si figura' },
      fecha: { type: 'string', description: 'Fecha de emisión en formato YYYY-MM-DD, si figura' },
      total: { type: 'number', description: 'Importe total de la factura' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            descripcion: { type: 'string' },
            cantidad: { type: 'number' },
            precio_unitario: { type: 'number', description: 'Precio unitario tal como figura en la factura' },
            iva_porcentaje: { type: 'number', description: 'Porcentaje de IVA de esa línea (21, 10.5, 0, etc). Si no figura por línea, usar el IVA general de la factura.' },
            iva_incluido: { type: 'boolean', description: 'true si precio_unitario ya incluye el IVA, false si es neto' },
            talle: { type: 'string', description: 'Talle/medida de la prenda o calzado si la factura lo distingue (ej. "S", "42"). Dejar vacío si no aplica.' },
            color: { type: 'string', description: 'Color de la prenda, calzado o equipo si la factura lo distingue por línea (ej. "Negro"). Dejar vacío si no aplica.' },
            imeis: {
              type: 'array',
              items: { type: 'string' },
              description: 'Lista de números de IMEI (15 dígitos) de cada unidad de esta línea, si la factura los detalla individualmente. Dejar vacío si la factura no lista IMEI por unidad.'
            }
          },
          required: ['descripcion', 'cantidad', 'precio_unitario']
        }
      }
    },
    required: ['total', 'items']
  }
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método no permitido' }); return; }

  const faltantes = faltanVariables();
  if (faltantes.length) {
    res.status(500).json({ error: 'Faltan variables de entorno: ' + faltantes.join(', ') });
    return;
  }

  const cabeceraAuth = req.headers.authorization || '';
  const token = cabeceraAuth.startsWith('Bearer ') ? cabeceraAuth.slice(7) : '';
  if (!token) { res.status(401).json({ error: 'Sin sesión' }); return; }

  const usuario = await usuarioDeToken(token);
  if (!usuario || !usuario.id) { res.status(401).json({ error: 'Sesión inválida o vencida' }); return; }

  const tienda = await tiendaDelUsuario(usuario.id);
  if (!tienda) { res.status(403).json({ error: 'No se encontró la tienda de este usuario' }); return; }
  if (!PLANES_CON_ACCESO.includes(tienda.plan)) {
    res.status(403).json({ error: 'Cargar stock por factura es parte del plan Pro' });
    return;
  }

  const { archivo_base64, mime_type } = req.body || {};
  if (!archivo_base64 || !mime_type) {
    res.status(400).json({ error: 'Falta el archivo de la factura' });
    return;
  }
  if (archivo_base64.length > TAMANO_MAXIMO_BASE64) {
    res.status(413).json({ error: 'El archivo es muy pesado. Probá con una foto (se comprime sola) o un PDF más liviano.' });
    return;
  }

  const esPdf = mime_type === 'application/pdf';
  const bloqueArchivo = esPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: archivo_base64 } }
    : { type: 'image', source: { type: 'base64', media_type: mime_type, data: archivo_base64 } };

  let respuesta;
  try {
    respuesta = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      tools: [HERRAMIENTA],
      tool_choice: { type: 'tool', name: 'registrar_factura' },
      messages: [{
        role: 'user',
        content: [
          bloqueArchivo,
          {
            type: 'text',
            text: 'Esta es una factura de un proveedor, puede ser de cualquier rubro: electrónica, indumentaria, ' +
              'calzado, comida, etc. Extraé el total y cada producto/línea con su cantidad, precio unitario y ' +
              'porcentaje de IVA. Si la factura es de indumentaria o calzado y distingue talle y/o color por línea ' +
              '(por ejemplo una línea por cada combinación de talle/color de un mismo modelo), extraé esos dos ' +
              'datos por separado del nombre del producto en "talle" y "color" — no los dejes pegados dentro de ' +
              '"descripcion". Si es una factura de electrónica (celulares, tablets) y lista los números de IMEI de ' +
              'cada equipo — a veces en una columna aparte, a veces como una lista de números de 15 dígitos debajo ' +
              'de la línea — extraé todos los IMEI de esa línea en el campo "imeis", uno por unidad; no inventes ' +
              'ni completes IMEI que no estén escritos, y si no hay IMEI individuales dejá la lista vacía. Si un ' +
              'dato no figura o no se puede leer con confianza, dejalo vacío en vez de inventarlo. No conviertas ' +
              'monedas ni recalcules nada, copiá los números tal cual figuran.'
          }
        ]
      }]
    });
  } catch (err) {
    console.error('Error llamando a la IA para leer factura:', err.message);
    res.status(502).json({ error: 'No se pudo leer la factura: ' + err.message });
    return;
  }

  const usoHerramienta = respuesta.content.find((b) => b.type === 'tool_use');
  if (!usoHerramienta) {
    res.status(502).json({ error: 'La IA no devolvió datos reconocibles de la factura. Probá con una foto más clara.' });
    return;
  }

  res.status(200).json({ ok: true, factura: usoHerramienta.input });
};
