// Webhook de WhatsApp Cloud API — BRUWAL Chat/Bot IA
//
// Un unico endpoint atiende a todos los clientes del servicio. Meta manda
// cada mensaje aca junto con el id del numero que lo recibio, y ese id es lo
// que decide de que cliente es la conversacion. Dar de alta un cliente nuevo
// es insertar una fila en public.clientes: no se toca este archivo.
//
// El recorrido de cada mensaje:
//   verificacion de origen -> cliente segun el numero -> historial ->
//   Claude -> herramientas (guardar lead / derivar) -> respuesta
//
// La respuesta se manda ANTES de contestarle 200 a Meta a proposito. En
// Vercel el proceso se corta apenas la funcion responde, asi que si
// contestaramos primero para "liberar" el webhook, el trabajo posterior
// quedaria a medias. Como Meta reintenta si tardamos, la proteccion contra
// respuestas duplicadas es la deduplicacion por id de mensaje, no la rapidez.

const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { REGLAS_COMUNES, TOOLS } = require('./_bot');

const SUPABASE_URL = 'https://qduguqazpxjjpxjfnkif.supabase.co';

// Meta da de baja cada version de la Graph API a los ~2 años. Configurable
// para que ese dia se cambie una variable de entorno y no el codigo.
const GRAPH_VERSION = process.env.WHATSAPP_API_VERSION || 'v21.0';

// Cuantos mensajes previos ve el modelo. Suficiente para que recuerde los
// datos que ya dio el cliente sin arrastrar toda la conversacion.
const MENSAJES_DE_CONTEXTO = 20;

// WhatsApp corta los mensajes de texto en 4096 caracteres.
const LARGO_MAXIMO_WHATSAPP = 4000;

const anthropic = new Anthropic();

// ---------------------------------------------------------------- utilidades

function faltanVariables() {
  return [
    'ANTHROPIC_API_KEY',
    'WHATSAPP_TOKEN',
    'WHATSAPP_VERIFY_TOKEN',
    'WHATSAPP_WEBHOOK_SECRET',
    'SUPABASE_SERVICE_ROLE_KEY'
  ].filter((n) => !process.env[n]);
}

// El cuerpo crudo, sin parsear, porque la firma de Meta se calcula sobre los
// bytes exactos que mando. Si algo ya consumio el stream devolvemos null y el
// control de acceso queda en el secreto de la URL.
async function leerCuerpoCrudo(req) {
  if (req.readableEnded || req.readable === false) return null;
  const trozos = [];
  for await (const trozo of req) trozos.push(trozo);
  return Buffer.concat(trozos);
}

// Comparar secretos con === filtra informacion: corta en el primer caracter
// distinto, y con eso se puede adivinar de a un caracter por vez.
function igualdadSegura(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function firmaValida(crudo, cabecera) {
  const secreto = process.env.WHATSAPP_APP_SECRET;
  if (!secreto || !crudo || !cabecera) return false;
  const esperada =
    'sha256=' + crypto.createHmac('sha256', secreto).update(crudo).digest('hex');
  return igualdadSegura(esperada, cabecera);
}

// ------------------------------------------------------------------ supabase

async function supabase(ruta, opciones = {}) {
  const clave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + ruta, {
    ...opciones,
    headers: {
      apikey: clave,
      Authorization: 'Bearer ' + clave,
      'Content-Type': 'application/json',
      ...(opciones.headers || {})
    }
  });
  if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + (await r.text()));
  return r.status === 204 ? null : r.json();
}

// De que cliente del servicio es este mensaje. Lo decide el numero de WhatsApp
// que lo recibio, no el que lo mando.
//
// Se traen tambien los inactivos, a proposito: sin eso no habria forma de
// distinguir "cliente apagado" de "numero mal configurado", y son dos
// problemas muy distintos de diagnosticar.
async function buscarCliente(phoneNumberId) {
  const filas = await supabase(
    'clientes?wa_phone_number_id=eq.' + encodeURIComponent(phoneNumberId) +
      '&select=id,slug,nombre,activo,mensaje_inactivo,modelo,prompt,' +
      'numero_derivacion,telefono_guardia,' +
      'limite_conversaciones,tope_duro,texto_upgrade,' +
      'aviso_previo_periodo,aviso_limite_periodo,aviso_tope_periodo&limit=1'
  );
  return (Array.isArray(filas) && filas[0]) || null;
}

// true si este mensaje ya se proceso. Meta reintenta cuando tardamos en
// responder, y sin esto el cliente recibiria la misma respuesta dos veces.
async function yaProcesado(idMensaje) {
  const filas = await supabase(
    'wa_mensajes?wa_message_id=eq.' + encodeURIComponent(idMensaje) + '&select=id&limit=1'
  );
  return Array.isArray(filas) && filas.length > 0;
}

async function guardarMensaje(clienteId, telefono, rol, texto, idMensaje) {
  await supabase('wa_mensajes', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      cliente_id: clienteId,
      telefono,
      rol,
      texto,
      wa_message_id: idMensaje || null
    })
  });
}

async function traerHistorial(clienteId, telefono) {
  const filas = await supabase(
    'wa_mensajes?cliente_id=eq.' + clienteId +
      '&telefono=eq.' + encodeURIComponent(telefono) +
      '&select=rol,texto&order=id.desc&limit=' + MENSAJES_DE_CONTEXTO
  );
  // Vienen del mas nuevo al mas viejo para que el limit agarre los ultimos;
  // el modelo los necesita en orden cronologico.
  return (filas || []).reverse().map((f) => ({ role: f.rol, content: f.texto }));
}

// ------------------------------------------------------------ conversaciones

// Una conversacion es una persona hablando dentro de una ventana de 24 horas,
// no un mensaje. Si vuelve a escribir tres dias despues, cuenta como nueva.
const VENTANA_MS = 24 * 60 * 60 * 1000;

// A partir de que porcentaje del plan le avisamos al cliente que se esta
// quedando corto. Antes del 80% el aviso molesta; despues, llega tarde.
const UMBRAL_AVISO = 0.8;

// El mes se corta a medianoche de Argentina, no en UTC: si no, todo lo que
// entra entre las 21 y las 24 del ultimo dia se factura al mes siguiente.
function periodoActual() {
  return new Date()
    .toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' })
    .slice(0, 7);
}

async function contarConversaciones(clienteId, periodo) {
  const r = await supabase('rpc/contar_conversaciones', {
    method: 'POST',
    body: JSON.stringify({ p_cliente: clienteId, p_periodo: periodo })
  });
  return typeof r === 'number' ? r : 0;
}

// Marca en el cliente que ya avisamos de este umbral en este periodo, para no
// repetir el aviso en cada mensaje que entra.
async function marcarAviso(clienteId, columna, periodo) {
  await supabase('clientes?id=eq.' + clienteId, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ [columna]: periodo })
  });
}

// Aviso a quien atiende el negocio. Puede fallar por la ventana de 24 horas de
// WhatsApp; el panel siempre muestra el consumo, asi que no es el unico canal.
async function avisar(cliente, texto) {
  if (!cliente.numero_derivacion) return;
  try {
    await enviarWhatsApp(cliente, cliente.numero_derivacion, texto);
  } catch (err) {
    console.error('No se pudo avisar del consumo:', err.message);
  }
}

// Devuelve { bloqueado } y, de paso, deja registrada la conversacion y manda
// los avisos que correspondan.
async function registrarConversacion(cliente, telefono) {
  const ahora = new Date();
  const periodo = periodoActual();

  const abiertas = await supabase(
    'wa_conversaciones?cliente_id=eq.' + cliente.id +
      '&telefono=eq.' + encodeURIComponent(telefono) +
      '&select=id,ultima_actividad,mensajes&order=ultima_actividad.desc&limit=1'
  );
  const ultima = abiertas && abiertas[0];
  const sigueAbierta = ultima && ahora - new Date(ultima.ultima_actividad) < VENTANA_MS;

  const total = await contarConversaciones(cliente.id, periodo);

  // El freno duro se evalua siempre, incluso dentro de una conversacion ya
  // empezada: si no, una sola conversacion eterna esquivaria el tope.
  if (cliente.tope_duro && total >= cliente.tope_duro) {
    if (cliente.aviso_tope_periodo !== periodo) {
      await marcarAviso(cliente.id, 'aviso_tope_periodo', periodo);
      await avisar(cliente,
        'Se alcanzo el tope de ' + cliente.tope_duro + ' conversaciones de este mes ' +
        'y el asistente dejo de responder para no seguir generando consumo. ' +
        'Escribinos y lo reactivamos.');
      console.error('TOPE DURO alcanzado: cliente=' + cliente.slug +
        ' periodo=' + periodo + ' total=' + total);
    }
    return { bloqueado: true };
  }

  if (sigueAbierta) {
    // Misma conversacion: suma un mensaje pero no cuenta de nuevo contra el plan.
    await supabase('wa_conversaciones?id=eq.' + ultima.id, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        ultima_actividad: ahora.toISOString(),
        mensajes: (ultima.mensajes || 1) + 1
      })
    });
    return { bloqueado: false };
  }

  const limite = cliente.limite_conversaciones;
  const excedente = !!limite && total >= limite;

  await supabase('wa_conversaciones', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      cliente_id: cliente.id,
      telefono,
      periodo,
      iniciada_at: ahora.toISOString(),
      ultima_actividad: ahora.toISOString(),
      excedente
    })
  });

  const nuevoTotal = total + 1;

  if (limite) {
    // Aviso al llegar al limite incluido: de aca en mas se factura excedente.
    if (nuevoTotal >= limite && cliente.aviso_limite_periodo !== periodo) {
      await marcarAviso(cliente.id, 'aviso_limite_periodo', periodo);
      await avisar(cliente,
        'Llegaste a las ' + limite + ' conversaciones incluidas en tu plan este mes. ' +
        'El asistente sigue atendiendo con normalidad; las conversaciones ' +
        'adicionales se facturan aparte.' +
        (cliente.texto_upgrade ? '\n\n' + cliente.texto_upgrade : ''));

    // Aviso previo, antes de que se le termine: es el momento de ofrecer el
    // plan siguiente, cuando todavia puede decidir.
    } else if (nuevoTotal >= Math.floor(limite * UMBRAL_AVISO) &&
               cliente.aviso_previo_periodo !== periodo) {
      await marcarAviso(cliente.id, 'aviso_previo_periodo', periodo);
      await avisar(cliente,
        'Vas ' + nuevoTotal + ' de las ' + limite + ' conversaciones que incluye tu ' +
        'plan este mes: te quedan ' + (limite - nuevoTotal) + '. ' +
        'Al pasarte, el asistente sigue funcionando y las adicionales se facturan aparte.' +
        (cliente.texto_upgrade ? '\n\n' + cliente.texto_upgrade : ''));
    }
  }

  return { bloqueado: false };
}

// ---------------------------------------------------------------- herramientas

// merge-duplicates actualiza la ficha existente en vez de fallar por la clave
// unica (cliente_id, telefono): el bot llama a guardar_lead varias veces por
// conversacion, a medida que consigue cada dato.
async function upsertLead(fila) {
  await supabase('wa_leads?on_conflict=cliente_id,telefono', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ ...fila, updated_at: new Date().toISOString() })
  });
}

async function guardarLead(cliente, telefono, datos) {
  const fila = { cliente_id: cliente.id, telefono };
  const campos = [
    'nombre', 'apellido', 'empresa', 'email', 'ciudad',
    'telefono_alternativo', 'servicio_interes', 'tipo_objetivo', 'notas'
  ];
  for (const c of campos) {
    if (datos[c]) fila[c] = String(datos[c]).slice(0, 500);
  }
  await upsertLead(fila);
  return 'Datos guardados.';
}

async function derivarAHumano(cliente, telefono, datos) {
  await upsertLead({
    cliente_id: cliente.id,
    telefono,
    derivado: true,
    derivado_at: new Date().toISOString(),
    motivo_derivacion: datos.motivo
  });

  if (!cliente.numero_derivacion) {
    console.warn('Cliente ' + cliente.slug + ' sin numero_derivacion: queda solo en el panel');
    return 'Registrado. Queda visible en el panel.';
  }

  // Ojo: WhatsApp solo permite mensajes libres dentro de las 24 horas del
  // ultimo mensaje del destinatario. Si el responsable no le escribio al
  // numero del negocio en las ultimas 24 horas, este envio falla y haria falta
  // una plantilla aprobada por Meta. Por eso no cortamos la conversacion si
  // falla: la derivacion ya quedo guardada.
  try {
    await enviarWhatsApp(
      cliente,
      cliente.numero_derivacion,
      'Nueva consulta para atender\n\n' +
        'Cliente: ' + telefono + '\n' +
        'Motivo: ' + datos.motivo + '\n\n' +
        datos.resumen
    );
  } catch (err) {
    console.error('No se pudo avisar al responsable:', err.message);
    return 'Registrado. El aviso puede demorar.';
  }

  return 'El responsable fue avisado.';
}

async function ejecutarHerramienta(bloque, cliente, telefono) {
  try {
    const salida =
      bloque.name === 'guardar_lead'
        ? await guardarLead(cliente, telefono, bloque.input || {})
        : bloque.name === 'derivar_a_humano'
        ? await derivarAHumano(cliente, telefono, bloque.input || {})
        : 'Herramienta desconocida: ' + bloque.name;

    return { type: 'tool_result', tool_use_id: bloque.id, content: salida };
  } catch (err) {
    console.error('Fallo la herramienta ' + bloque.name + ':', err.message);
    // Le devolvemos el error al modelo en vez de tirar la conversacion: puede
    // seguir atendiendo y avisar que hubo un problema al registrar los datos.
    return {
      type: 'tool_result',
      tool_use_id: bloque.id,
      content: 'No se pudo completar: ' + err.message,
      is_error: true
    };
  }
}

// ------------------------------------------------------------------ whatsapp

async function enviarWhatsApp(cliente, destino, texto) {
  const url =
    'https://graph.facebook.com/' + GRAPH_VERSION + '/' +
    cliente.wa_phone_number_id + '/messages';

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.WHATSAPP_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: destino,
      type: 'text',
      text: { body: texto.slice(0, LARGO_MAXIMO_WHATSAPP) }
    })
  });

  if (!r.ok) throw new Error('WhatsApp ' + r.status + ': ' + (await r.text()));
}

// --------------------------------------------------------------------- claude

const DISCULPA_GENERICA =
  'Disculpe, tuve un inconveniente tecnico y no pude procesar su consulta. ' +
  'Por favor vuelva a escribirme en unos minutos.';

// Dos bloques y no uno solo: el primero es identico para todos los clientes,
// asi que se cachea una vez y lo reusan las conversaciones de todos. El
// segundo se cachea por cliente.
function armarSistema(cliente) {
  let perfil = cliente.prompt;
  if (cliente.telefono_guardia) {
    perfil += '\n\nTelefono de guardia / monitoreo: ' + cliente.telefono_guardia;
  }
  return [
    { type: 'text', text: REGLAS_COMUNES, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: perfil, cache_control: { type: 'ephemeral' } }
  ];
}

// No todos los modelos aceptan los mismos parametros, y mandar uno de mas no
// se degrada: devuelve 400 y el cliente se queda sin respuesta.
//
//   esfuerzo  -> el parametro effort no existe en Haiku 4.5, da error
//   reintento -> el reintento automatico ante rechazo aplica a Opus 5, que es
//                el unico de los tres con clasificadores que puedan rechazar
const PERFILES_MODELO = {
  'claude-haiku-4-5': { esfuerzo: false, reintento: false },
  'claude-sonnet-5':  { esfuerzo: true,  reintento: false },
  'claude-opus-5':    { esfuerzo: true,  reintento: true }
};

// Se apaga solo si la cuenta todavia no tiene habilitado el reintento
// automatico. Empieza encendido y se degrada al primer 400.
let reintentoAutomatico = true;

async function llamarModelo(cliente, mensajes) {
  const modelo = cliente.modelo || 'claude-sonnet-5';
  const perfil = PERFILES_MODELO[modelo] || { esfuerzo: false, reintento: false };

  const parametros = {
    model: modelo,
    // El presupuesto lo comparten el razonamiento y el texto de la respuesta.
    // Aunque un mensaje de WhatsApp es corto, achicarlo demasiado cortaria la
    // respuesta a la mitad.
    max_tokens: 8192,
    system: armarSistema(cliente),
    tools: TOOLS,
    messages: mensajes
  };

  // Esfuerzo bajo: la tarea es atencion comercial guionada, no analisis. Baja
  // la latencia, que en WhatsApp se nota.
  if (perfil.esfuerzo) parametros.output_config = { effort: 'low' };

  // Si un clasificador de seguridad rechaza el pedido, la API reintenta sola
  // con otro modelo en vez de dejar al cliente sin respuesta.
  if (perfil.reintento && reintentoAutomatico) {
    try {
      return await anthropic.beta.messages.create({
        ...parametros,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default'
      });
    } catch (err) {
      if (err && err.status === 400) {
        // La cuenta no tiene la funcion habilitada. Preferimos un bot que
        // atiende sin red de seguridad a un bot que no atiende.
        console.warn('Reintento automatico no disponible, sigo sin el:', err.message);
        reintentoAutomatico = false;
      } else {
        throw err;
      }
    }
  }

  return anthropic.messages.create(parametros);
}

async function responder(cliente, telefono, textoCliente) {
  const mensajes = [
    ...(await traerHistorial(cliente.id, telefono)),
    { role: 'user', content: textoCliente }
  ];

  let respuesta = '';

  // El modelo puede pedir herramientas varias veces seguidas (guardar el lead
  // y despues derivar). El tope evita que un bucle raro consuma tokens sin fin.
  for (let vuelta = 0; vuelta < 4; vuelta++) {
    const r = await llamarModelo(cliente, mensajes);

    if (r.stop_reason === 'refusal') {
      console.warn('Respuesta rechazada:', r.stop_details && r.stop_details.category);
      return 'Prefiero que este tema lo vea una persona del equipo. Ya paso su ' +
        'consulta y se comunican con usted.';
    }

    const texto = r.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (texto) respuesta = texto;

    if (r.stop_reason !== 'tool_use') break;

    // El turno del asistente se guarda completo, con los bloques de tool_use:
    // sin ellos la API rechaza el mensaje siguiente.
    mensajes.push({ role: 'assistant', content: r.content });

    const resultados = [];
    for (const bloque of r.content) {
      if (bloque.type === 'tool_use') {
        resultados.push(await ejecutarHerramienta(bloque, cliente, telefono));
      }
    }
    mensajes.push({ role: 'user', content: resultados });
  }

  return respuesta || DISCULPA_GENERICA;
}

// ------------------------------------------------------------------- webhook

module.exports = async (req, res) => {
  // Meta valida el webhook una sola vez, con un GET, cuando lo configuras.
  if (req.method === 'GET') {
    const q = req.query || {};
    if (
      q['hub.mode'] === 'subscribe' &&
      igualdadSegura(q['hub.verify_token'], process.env.WHATSAPP_VERIFY_TOKEN)
    ) {
      res.statusCode = 200;
      return res.end(String(q['hub.challenge'] || ''));
    }
    res.statusCode = 403;
    return res.end('token invalido');
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end('metodo no permitido');
  }

  const faltan = faltanVariables();
  if (faltan.length) {
    console.error('Faltan variables de entorno:', faltan.join(', '));
    res.statusCode = 500;
    return res.end('sin configurar');
  }

  // Primer control: un secreto en la URL del webhook. Es el que siempre
  // funciona, independientemente de como llegue el cuerpo del pedido.
  if (!igualdadSegura((req.query && req.query.k) || '', process.env.WHATSAPP_WEBHOOK_SECRET)) {
    res.statusCode = 401;
    return res.end('no autorizado');
  }

  // Segundo control: la firma HMAC de Meta, cuando podemos leer el cuerpo
  // crudo. Verificar los bytes exactos es lo unico que prueba que el pedido
  // salio de Meta y no de alguien que averiguo la URL.
  const crudo = await leerCuerpoCrudo(req);
  if (crudo && !firmaValida(crudo, req.headers['x-hub-signature-256'])) {
    console.warn('Firma de Meta invalida');
    res.statusCode = 401;
    return res.end('firma invalida');
  }

  let cuerpo;
  try {
    cuerpo = crudo ? JSON.parse(crudo.toString('utf8')) : req.body;
  } catch (err) {
    res.statusCode = 400;
    return res.end('cuerpo invalido');
  }

  try {
    const valor =
      cuerpo &&
      cuerpo.entry &&
      cuerpo.entry[0] &&
      cuerpo.entry[0].changes &&
      cuerpo.entry[0].changes[0] &&
      cuerpo.entry[0].changes[0].value;

    const mensaje = valor && valor.messages && valor.messages[0];

    // Meta manda tambien avisos de entregado y leido. No son consultas.
    if (!mensaje) {
      res.statusCode = 200;
      return res.end('ok');
    }

    const phoneNumberId = valor.metadata && valor.metadata.phone_number_id;
    const cliente = phoneNumberId ? await buscarCliente(phoneNumberId) : null;

    // Numero que no corresponde a ningun cliente. Casi siempre es un
    // wa_phone_number_id mal cargado en la base o en Meta.
    if (!cliente) {
      console.warn('Mensaje para un numero sin cliente cargado:', phoneNumberId);
      res.statusCode = 200;
      return res.end('sin cliente');
    }
    cliente.wa_phone_number_id = phoneNumberId;

    const telefono = mensaje.from;

    // Cliente apagado: ni una llamada al modelo, cero costo. Es el estado en
    // el que queda todo instalado antes de que el cliente acepte el servicio,
    // y tambien al que se vuelve para pausar a alguien.
    if (!cliente.activo) {
      console.warn('Mensaje para el cliente apagado ' + cliente.slug);
      if (cliente.mensaje_inactivo) {
        await enviarWhatsApp(cliente, telefono, cliente.mensaje_inactivo);
      }
      res.statusCode = 200;
      return res.end('cliente inactivo');
    }

    if (await yaProcesado(mensaje.id)) {
      res.statusCode = 200;
      return res.end('duplicado');
    }

    if (mensaje.type !== 'text') {
      await guardarMensaje(cliente.id, telefono, 'user', '[' + mensaje.type + ']', mensaje.id);
      await enviarWhatsApp(
        cliente,
        telefono,
        'Por ahora solo puedo leer mensajes de texto. Si me escribe su ' +
          'consulta, con gusto lo ayudo.'
      );
      res.statusCode = 200;
      return res.end('ok');
    }

    const textoCliente = (mensaje.text && mensaje.text.body) || '';
    await guardarMensaje(cliente.id, telefono, 'user', textoCliente, mensaje.id);

    // Se cuenta antes de llamar al modelo: de eso depende que se llame o no.
    const { bloqueado } = await registrarConversacion(cliente, telefono);

    if (bloqueado) {
      // Ni una llamada al modelo. Es el unico camino por el que el consumo
      // deja de crecer.
      const aviso = 'Gracias por escribir. En este momento no puedo atenderlo ' +
        'por WhatsApp. Comuniquese por telefono y lo ayudamos enseguida.';
      await enviarWhatsApp(cliente, telefono, aviso);
      await guardarMensaje(cliente.id, telefono, 'assistant', aviso, null);
      res.statusCode = 200;
      return res.end('tope alcanzado');
    }

    const respuesta = await responder(cliente, telefono, textoCliente);

    await enviarWhatsApp(cliente, telefono, respuesta);
    await guardarMensaje(cliente.id, telefono, 'assistant', respuesta, null);

    res.statusCode = 200;
    return res.end('ok');
  } catch (err) {
    console.error('Error procesando el mensaje:', err);
    // 200 igual: con un 500 Meta reintenta el mismo mensaje una y otra vez, y
    // si el error es permanente el cliente recibiria el fallo repetido.
    res.statusCode = 200;
    return res.end('error registrado');
  }
};

// Necesitamos el cuerpo sin parsear para verificar la firma de Meta.
module.exports.config = { api: { bodyParser: false } };
