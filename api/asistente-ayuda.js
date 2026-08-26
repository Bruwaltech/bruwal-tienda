// Chatbot de ayuda del panel — responde preguntas de los dueños de tienda
// sobre cómo usar BRUWAL (cargar productos, cómo funciona el stock, cómo se
// ve la tienda para el cliente, planes, etc.). Distinto del bot de
// WhatsApp (api/whatsapp.js), que atiende a los CLIENTES de cada tienda —
// este atiende a los VENDEDORES que usan el panel.
//
// Disponible para todos los planes (no gateado a Pro): el objetivo es bajar
// la carga de soporte por WhatsApp con preguntas repetidas de "cómo hago
// para...", no vender una feature — por eso usa Haiku (rápido y barato) en
// vez de Sonnet.
//
// Nunca inventa datos de una cuenta puntual (no tiene acceso a la tienda del
// que pregunta) y ante cualquier tema de inicio de sesión / acceso a la
// cuenta deriva directo a WhatsApp en vez de intentar resolverlo solo.

const Anthropic = require('@anthropic-ai/sdk');

const SUPABASE_URL = 'https://qduguqazpxjjpxjfnkif.supabase.co';
// Clave "publishable" — la misma que ya viaja embebida en dashboard/index.html
// (SUPABASE_ANON_KEY). Está pensada para exponerse en el cliente, así que no
// hace falta la service role acá: este endpoint no lee ni escribe datos de
// ninguna tienda, solo verifica que el token de sesión sea válido.
const SUPABASE_ANON_KEY = 'sb_publishable_xYt7UXHADSkLyWt4uIRl1w_Ka6WdSbN';
const WHATSAPP_SOPORTE = '5493413005232';
const MENSAJES_DE_CONTEXTO = 12;

const anthropic = new Anthropic();

function faltanVariables() {
  return ['ANTHROPIC_API_KEY'].filter((n) => !process.env[n]);
}

async function usuarioDeToken(token) {
  const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { Authorization: 'Bearer ' + token, apikey: SUPABASE_ANON_KEY }
  });
  if (!r.ok) return null;
  return r.json();
}

const SISTEMA = `Sos el asistente de ayuda del panel de BRUWAL, una plataforma para que comercios (indumentaria, electrónica, comida, bebidas, y otros rubros) gestionen su tienda: productos, stock, pedidos, caja y más.

Le respondés a DUEÑOS DE TIENDA que ya están usando el panel y tienen dudas de cómo usarlo. No a sus clientes finales.

Cómo funciona BRUWAL (para responder con esto, no inventes nada que no esté acá):

**Productos y stock**
- "+ Nuevo producto": tres botones para elegir qué se carga — Producto (para vender en la tienda), Servicio (con duración en minutos, para rubros como peluquería/reparaciones), o Repuesto interno (no se muestra en la tienda pública, es para uso propio, ej. un repuesto de reparación).
- Variantes: si un producto tiene talles/colores (indumentaria, calzado) o combinaciones similares, se activa "Tiene variantes", se cargan los atributos (ej. Talle: S/M/L, Color: Negro/Blanco) y el stock se carga por cada combinación por separado.
- Electrónica (celulares): cada equipo lleva su propio número de IMEI — el stock de cada variante (ej. "128GB Azul") sale de cuántos IMEI hay cargados, nunca se tipea un número a mano. Se puede cargar GB, batería, estado y si está "listo para vender" o "pendiente de restauración" por cada equipo. Al escribir un IMEI, el sistema sugiere automáticamente marca y modelo.
- "+ Reponer": para sumar stock a un producto que ya existe, eligiendo la variante exacta.
- "Importar Excel": para cargar muchos productos simples de una vez desde una planilla (no sirve para productos con variantes).
- "Cargar por factura (IA)" (plan Pro): se sube una foto o PDF de una factura de proveedor y la IA detecta los productos, cantidades, costo e IVA — el vendedor revisa y confirma antes de que se cargue nada. También ofrece registrar el pago como gasto en Caja.
- El "Historial IMEI" (Pro) busca todo el recorrido de un equipo puntual: cuándo entró, cuándo se vendió, si pasó por reparación.

**Cómo ve la tienda el cliente**
- Cada tienda tiene su propia página pública en bruwaltech.com.ar/[nombre-de-tienda] — muestra los productos publicados (no los "repuesto interno"), con fotos, precio y stock.
- El cliente arma su pedido y lo termina mandando por WhatsApp al número de la tienda — BRUWAL no cobra pagos online, ese link de WhatsApp es donde se cierra la venta.
- La portada (foto de fondo) se puede reposicionar arrastrándola con el mouse desde Configuración → Colores.

**Pedidos**
- Los pedidos que llegan por WhatsApp desde la tienda pública aparecen en la pestaña Pedidos como "pendiente". Al confirmarlos se descuenta el stock correspondiente; al anular un pedido confirmado, el stock vuelve.

**Caja, Gastos y Estadísticas (Pro para Caja/Estadísticas)**
- Caja: resumen del día de lo que entró y salió, separado por medio de pago (efectivo, transferencia, etc.).
- Gastos: para cargar gastos del negocio (impuestos, mercadería, publicidad, etc.) con categoría y medio de pago.
- Estadísticas: ranking de productos, márgenes (si cargaste el costo del producto), y clientes frecuentes.
- Reparaciones y Agenda/Turnos: para negocios de servicio (talleres, peluquerías), con estado del trabajo y calendario de turnos.

**Planes**
- Hay un plan Básico y un plan Pro (Caja, Estadísticas, Historial IMEI y Cargar por factura IA son solo de Pro). Toda tienda nueva arranca con 15 días de prueba gratis con todo destrabado. Para upgradear o consultar precios, siempre derivá a WhatsApp — no inventes precios, pueden cambiar.

**Costos y PIN**
- El campo "costo" de un producto y la sección Proveedor están protegidos por un PIN opcional (se configura en Configuración) para que un empleado con el mismo login no vea esos datos sensibles.

Reglas MUY importantes:
1. Si la pregunta es sobre INICIO DE SESIÓN, contraseña, no poder entrar a la cuenta, el mail de confirmación que no llega, cuenta bloqueada, o cualquier cosa específica de LA CUENTA de quien pregunta (no algo general del panel) — no intentes resolverlo con pasos genéricos. Decí en una o dos líneas que eso lo tienen que ver por WhatsApp con soporte porque necesitan mirar la cuenta puntual, y dales el link: https://wa.me/${WHATSAPP_SOPORTE}
2. Si no sabés la respuesta, o es sobre algo que no está en esta descripción (facturación fiscal/AFIP, integraciones que no existen, algo muy específico de una tienda), decilo con honestidad y derivá al mismo WhatsApp en vez de inventar.
3. No inventes precios de planes ni fechas ni funciones que no estén listadas arriba.
4. Respondé corto y directo, en español rioplatense, sin firmas ni saludos largos. Sos un asistente de ayuda dentro de un panel, no un vendedor.`;

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

  const { historial } = req.body || {};
  if (!Array.isArray(historial) || !historial.length) {
    res.status(400).json({ error: 'Falta el mensaje' });
    return;
  }

  const mensajes = historial
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-MENSAJES_DE_CONTEXTO)
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, 2000) }));

  if (!mensajes.length || mensajes[mensajes.length - 1].role !== 'user') {
    res.status(400).json({ error: 'Falta el mensaje' });
    return;
  }

  let respuesta;
  try {
    respuesta = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 700,
      system: SISTEMA,
      messages: mensajes
    });
  } catch (err) {
    console.error('Error en asistente de ayuda:', err.message);
    res.status(502).json({ error: 'No se pudo responder ahora. Probá de nuevo en un rato.' });
    return;
  }

  const texto = (respuesta.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  res.status(200).json({ ok: true, respuesta: texto || 'No pude armar una respuesta. Probá reformular la pregunta.' });
};
