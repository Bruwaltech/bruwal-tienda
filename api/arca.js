// Facturación electrónica con ARCA (ex AFIP).
//
// Cómo está armado: BRUWAL tiene UN certificado de ARCA, a nombre de la
// CUIT de Bruwaltech (ARCA_CUIT). Cada negocio, una sola vez, le delega a
// esa CUIT el web service de factura electrónica desde su clave fiscal y
// crea un punto de venta "Web Services". Desde ahí pedimos el CAE en su
// nombre: el certificado es el nuestro, la CUIT que va en cada pedido es
// la del negocio. El negocio no maneja certificados ni claves.
//
// Por qué en el servidor: la clave privada del certificado firma pedidos
// en nombre de TODOS los negocios. No sale nunca de las variables de
// entorno de Vercel.
//
// Por ahora emite Factura C (monotributo), que es lo que usan los negocios
// de BRUWAL hoy. Responsable inscripto (A/B, con IVA discriminado) queda
// para cuando haga falta: la tabla ya lo frena con un check.
//
// Variables de entorno:
//   ARCA_CERT     certificado (PEM) que dio ARCA para la CUIT de Bruwaltech
//   ARCA_KEY      clave privada (PEM) con la que se generó el pedido
//   ARCA_CUIT     CUIT de Bruwaltech, la que reciben las delegaciones
//   ARCA_ENTORNO  'produccion' o 'homologacion' (por defecto homologación,
//                 para que nadie emita facturas reales sin querer)
//
// Acciones (POST, con el token de sesión de Supabase en Authorization):
//   estado      -> datos fiscales guardados + si ARCA nos deja facturar
//   guardar     -> guarda los datos fiscales del negocio
//   emitir      -> { order_id, receptor? } pide el CAE de esa venta
//   comprobante -> { order_id } el comprobante ya emitido de esa venta

const forge = require('node-forge');

const SUPABASE_URL = 'https://qduguqazpxjjpxjfnkif.supabase.co';

const PRODUCCION = process.env.ARCA_ENTORNO === 'produccion';
const URL_WSAA = PRODUCCION
  ? 'https://wsaa.afip.gov.ar/ws/services/LoginCms'
  : 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms';
const URL_WSFE = PRODUCCION
  ? 'https://servicios1.afip.gov.ar/wsfev1/service.asmx'
  : 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx';

const FACTURA_C = 11;
const DOC_SIN_IDENTIFICAR = 99;
const DOC_DNI = 96;
const DOC_CUIT = 80;
const CONSUMIDOR_FINAL = 5;

// RG 5700/2025: desde $10.000.000 hay que identificar al consumidor final
// (DNI o CUIT). Queda en variable por si ARCA lo actualiza.
const TOPE_SIN_IDENTIFICAR = Number(process.env.ARCA_TOPE_CONSUMIDOR_FINAL || 10000000);

function faltanVariables() {
  return ['ARCA_CERT', 'ARCA_KEY', 'ARCA_CUIT', 'SUPABASE_SERVICE_ROLE_KEY']
    .filter((n) => !process.env[n]);
}

// Vercel guarda los PEM a veces con "\n" literales en vez de saltos de
// línea. forge no los lee así.
function pem(texto) {
  return String(texto || '').replace(/\\n/g, '\n');
}

// ---------- Sesión del vendedor (igual que api/mercadolibre.js) ----------

async function usuarioDeToken(token) {
  const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { Authorization: 'Bearer ' + token, apikey: process.env.SUPABASE_SERVICE_ROLE_KEY }
  });
  if (!r.ok) return null;
  return r.json();
}

// El slug lo manda el navegador pero no se le cree: se busca entre las
// tiendas de ESE usuario.
async function tiendaDelUsuario(userId, slugPedido) {
  const filas = await sb('/rest/v1/store_profiles?user_id=eq.' + encodeURIComponent(userId) +
                         '&select=slug,plan&order=created_at.asc');
  if (!filas || !filas.length) return null;
  if (slugPedido) {
    const suya = filas.find((t) => t.slug === slugPedido);
    if (suya) return suya;
  }
  return filas[0];
}

async function sb(ruta, opciones) {
  const o = opciones || {};
  const r = await fetch(SUPABASE_URL + ruta, {
    method: o.method || 'GET',
    headers: Object.assign({
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json'
    }, o.headers || {}),
    body: o.body ? JSON.stringify(o.body) : undefined
  });
  if (!r.ok) {
    const detalle = await r.text();
    const error = new Error('Supabase ' + r.status + ': ' + detalle.slice(0, 300));
    error.status = r.status;
    error.detalle = detalle;
    throw error;
  }
  if (r.status === 204) return null;
  const texto = await r.text();
  return texto ? JSON.parse(texto) : null;
}

// ---------- XML sin librerías ----------
//
// Las respuestas de ARCA son chicas y siempre tienen la misma forma. Un
// parser entero sería una dependencia más para leer cinco etiquetas.

function etiqueta(xml, nombre) {
  const m = String(xml).match(new RegExp('<(?:\\w+:)?' + nombre + '>([\\s\\S]*?)</(?:\\w+:)?' + nombre + '>'));
  return m ? m[1].trim() : null;
}

function todas(xml, nombre) {
  const re = new RegExp('<(?:\\w+:)?' + nombre + '>([\\s\\S]*?)</(?:\\w+:)?' + nombre + '>', 'g');
  const lista = [];
  let m;
  while ((m = re.exec(String(xml)))) lista.push(m[1]);
  return lista;
}

function desescapar(texto) {
  return String(texto)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function escaparXml(texto) {
  return String(texto)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Code + Msg de los <Err> y <Obs> que devuelve wsfe.
function mensajesDe(xml, contenedor) {
  return todas(xml, contenedor).map((bloque) => ({
    codigo: Number(etiqueta(bloque, 'Code')),
    mensaje: desescapar(etiqueta(bloque, 'Msg') || '')
  }));
}

// ---------- WSAA: el ticket de acceso ----------

function firmarTra(servicio) {
  const ahora = Date.now();
  const tra =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<loginTicketRequest version="1.0"><header>' +
      '<uniqueId>' + Math.floor(ahora / 1000) + '</uniqueId>' +
      // Diez minutos para cada lado: si el reloj de ARCA y el de Vercel no
      // coinciden por unos segundos, el pedido igual entra.
      '<generationTime>' + new Date(ahora - 10 * 60 * 1000).toISOString() + '</generationTime>' +
      '<expirationTime>' + new Date(ahora + 10 * 60 * 1000).toISOString() + '</expirationTime>' +
    '</header><service>' + servicio + '</service></loginTicketRequest>';

  const certificado = forge.pki.certificateFromPem(pem(process.env.ARCA_CERT));
  const clave = forge.pki.privateKeyFromPem(pem(process.env.ARCA_KEY));

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(tra, 'utf8');
  p7.addCertificate(certificado);
  p7.addSigner({
    key: clave,
    certificate: certificado,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() }
    ]
  });
  p7.sign();
  return forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes());
}

async function pedirTicketDeAcceso(servicio) {
  const sobre =
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ' +
    'xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">' +
    '<soapenv:Header/><soapenv:Body><wsaa:loginCms><wsaa:in0>' + firmarTra(servicio) +
    '</wsaa:in0></wsaa:loginCms></soapenv:Body></soapenv:Envelope>';

  const r = await fetch(URL_WSAA, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '""' },
    body: sobre
  });
  const xml = await r.text();

  const falla = etiqueta(xml, 'faultstring');
  if (falla) {
    // ARCA no da un ticket nuevo mientras el anterior siga vivo. Si llegamos
    // acá es porque se perdió el guardado (o lo pidieron dos funciones a la
    // vez): no queda otra que esperar a que venza.
    if (/ya posee un TA valido/i.test(falla)) {
      throw new Error('ARCA ya entregó un acceso que no quedó guardado. Probá de nuevo en unos minutos.');
    }
    throw new Error('ARCA rechazó el acceso: ' + desescapar(falla));
  }

  const respuesta = desescapar(etiqueta(xml, 'loginCmsReturn') || '');
  const token = etiqueta(respuesta, 'token');
  const sign = etiqueta(respuesta, 'sign');
  const vence = etiqueta(respuesta, 'expirationTime');
  if (!token || !sign) throw new Error('ARCA no devolvió el acceso (HTTP ' + r.status + ')');
  return { token: token, sign: sign, expira_en: new Date(vence).toISOString() };
}

// Un solo ticket para todos los negocios: es del certificado de BRUWAL.
async function ticketDeAcceso() {
  const servicio = 'wsfe-' + (PRODUCCION ? 'produccion' : 'homologacion');
  const filas = await sb('/rest/v1/arca_acceso?servicio=eq.' + servicio + '&select=token,sign,expira_en');
  const guardado = filas && filas[0];
  // Cinco minutos de margen para no usar uno que vence en el medio del pedido.
  if (guardado && new Date(guardado.expira_en).getTime() - 5 * 60 * 1000 > Date.now()) return guardado;

  const nuevo = await pedirTicketDeAcceso('wsfe');
  await sb('/rest/v1/arca_acceso?on_conflict=servicio', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: [Object.assign({ servicio: servicio }, nuevo)]
  });
  return nuevo;
}

// ---------- WSFE: factura electrónica ----------

async function llamarWsfe(metodo, cuitNegocio, cuerpo) {
  const acceso = await ticketDeAcceso();
  const sobre =
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ' +
    'xmlns:ar="http://ar.gov.afip.dif.FEV1/"><soapenv:Header/><soapenv:Body>' +
    '<ar:' + metodo + '>' +
      '<ar:Auth><ar:Token>' + acceso.token + '</ar:Token><ar:Sign>' + acceso.sign + '</ar:Sign>' +
      '<ar:Cuit>' + cuitNegocio + '</ar:Cuit></ar:Auth>' +
      (cuerpo || '') +
    '</ar:' + metodo + '></soapenv:Body></soapenv:Envelope>';

  const r = await fetch(URL_WSFE, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: '"http://ar.gov.afip.dif.FEV1/' + metodo + '"'
    },
    body: sobre
  });
  const xml = await r.text();
  const falla = etiqueta(xml, 'faultstring');
  if (falla) throw new Error('ARCA: ' + desescapar(falla));
  return xml;
}

// Los errores de ARCA están pensados para un programador. Los dos que va a
// ver un negocio que recién arranca se traducen a qué tiene que hacer.
function errorParaPersonas(errores) {
  const texto = errores.map((e) => e.codigo + ': ' + e.mensaje).join(' | ');
  if (/lista de relaciones|no se encuentra autorizado|no autorizado a/i.test(texto)) {
    return 'Tu CUIT todavía no le delegó la factura electrónica a BRUWAL en ARCA. ' +
           'Fijate los pasos en Configuración → Facturación ARCA. (' + texto + ')';
  }
  if (/punto de venta/i.test(texto)) {
    return 'El punto de venta no está habilitado para "Web Services" en ARCA. ' +
           'Creá uno de ese tipo y cargá su número en Configuración. (' + texto + ')';
  }
  return 'ARCA no autorizó el comprobante: ' + texto;
}

async function ultimoNumero(cuit, puntoVenta, tipo) {
  const xml = await llamarWsfe('FECompUltimoAutorizado', cuit,
    '<ar:PtoVta>' + puntoVenta + '</ar:PtoVta><ar:CbteTipo>' + tipo + '</ar:CbteTipo>');
  const errores = mensajesDe(xml, 'Err');
  if (errores.length) throw new Error(errorParaPersonas(errores));
  return Number(etiqueta(xml, 'CbteNro') || 0);
}

function fechaArca(fecha) {
  // La fecha del comprobante es la de Argentina, no la de Vercel (UTC):
  // una venta a las 22 h saldría con fecha de mañana.
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(fecha || new Date());
  return p; // AAAA-MM-DD
}

function importe(n) {
  return (Math.round(Number(n) * 100) / 100).toFixed(2);
}

async function solicitarCae(config, comprobante) {
  const total = importe(comprobante.total);
  const detalle =
    '<ar:FeCAEReq>' +
      '<ar:FeCabReq><ar:CantReg>1</ar:CantReg><ar:PtoVta>' + config.punto_venta + '</ar:PtoVta>' +
        '<ar:CbteTipo>' + comprobante.tipo + '</ar:CbteTipo></ar:FeCabReq>' +
      '<ar:FeDetReq><ar:FECAEDetRequest>' +
        '<ar:Concepto>1</ar:Concepto>' +                       // 1 = productos
        '<ar:DocTipo>' + comprobante.doc_tipo + '</ar:DocTipo>' +
        '<ar:DocNro>' + comprobante.doc_nro + '</ar:DocNro>' +
        '<ar:CbteDesde>' + comprobante.numero + '</ar:CbteDesde>' +
        '<ar:CbteHasta>' + comprobante.numero + '</ar:CbteHasta>' +
        '<ar:CbteFch>' + comprobante.fecha.replace(/-/g, '') + '</ar:CbteFch>' +
        // Factura C: todo va como neto, sin IVA discriminado.
        '<ar:ImpTotal>' + total + '</ar:ImpTotal>' +
        '<ar:ImpTotConc>0</ar:ImpTotConc>' +
        '<ar:ImpNeto>' + total + '</ar:ImpNeto>' +
        '<ar:ImpOpEx>0</ar:ImpOpEx>' +
        '<ar:ImpTrib>0</ar:ImpTrib>' +
        '<ar:ImpIVA>0</ar:ImpIVA>' +
        '<ar:MonId>PES</ar:MonId>' +
        '<ar:MonCotiz>1</ar:MonCotiz>' +
        // RG 5616: la condición frente al IVA del receptor es obligatoria.
        '<ar:CondicionIVAReceptorId>' + comprobante.receptor_condicion + '</ar:CondicionIVAReceptorId>' +
      '</ar:FECAEDetRequest></ar:FeDetReq>' +
    '</ar:FeCAEReq>';

  const xml = await llamarWsfe('FECAESolicitar', config.cuit, detalle);
  const errores = mensajesDe(xml, 'Err').concat(mensajesDe(xml, 'Obs'));
  const resultado = etiqueta(xml, 'Resultado');
  if (resultado !== 'A') {
    const error = new Error(errorParaPersonas(errores.length ? errores : [{ codigo: 0, mensaje: 'Resultado ' + resultado }]));
    error.codigos = errores.map((e) => e.codigo);
    throw error;
  }
  const vto = etiqueta(xml, 'CAEFchVto');
  return {
    cae: etiqueta(xml, 'CAE'),
    cae_vto: vto ? vto.slice(0, 4) + '-' + vto.slice(4, 6) + '-' + vto.slice(6, 8) : null
  };
}

// ---------- Datos fiscales del negocio ----------

async function configDeTienda(slug) {
  const filas = await sb('/rest/v1/store_arca?store_slug=eq.' + encodeURIComponent(slug) + '&select=*');
  return (filas && filas[0]) || null;
}

function soloDigitos(v) {
  return String(v == null ? '' : v).replace(/\D/g, '');
}

// Dígito verificador de la CUIT (módulo 11). Una CUIT mal tipeada que
// llega a ARCA vuelve con un error que nadie entiende.
function cuitValida(cuit) {
  if (!/^\d{11}$/.test(cuit)) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((s, p, i) => s + p * Number(cuit[i]), 0);
  let dv = 11 - (suma % 11);
  if (dv === 11) dv = 0;
  if (dv === 10) dv = 9;
  return dv === Number(cuit[10]);
}

async function accionGuardar(slug, datos) {
  const cuit = soloDigitos(datos.cuit);
  if (!cuitValida(cuit)) throw new Error('La CUIT no es válida. Revisá los 11 números.');
  const puntoVenta = Number(datos.punto_venta);
  if (!Number.isInteger(puntoVenta) || puntoVenta < 1 || puntoVenta > 99998) {
    throw new Error('El punto de venta tiene que ser un número (el que creaste como "Web Services" en ARCA).');
  }
  const razon = String(datos.razon_social || '').trim();
  if (!razon) throw new Error('Falta la razón social (tu nombre como figura en ARCA).');

  await sb('/rest/v1/store_arca?on_conflict=store_slug', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: [{
      store_slug: slug,
      cuit: cuit,
      razon_social: razon.slice(0, 120),
      punto_venta: puntoVenta,
      condicion_iva: 'monotributo',
      domicilio: String(datos.domicilio || '').trim().slice(0, 200) || null,
      inicio_actividades: /^\d{4}-\d{2}-\d{2}$/.test(String(datos.inicio_actividades || '')) ? datos.inicio_actividades : null,
      ingresos_brutos: String(datos.ingresos_brutos || '').trim().slice(0, 40) || null,
      auto_facturar: !!datos.auto_facturar,
      actualizado_en: new Date().toISOString()
    }]
  });
  return accionEstado(slug);
}

async function accionEstado(slug) {
  const config = await configDeTienda(slug);
  const base = {
    entorno: PRODUCCION ? 'produccion' : 'homologacion',
    cuit_bruwal: process.env.ARCA_CUIT,
    config: config
  };
  if (!config) return Object.assign(base, { listo: false, motivo: 'Faltan tus datos fiscales.' });

  // La prueba de verdad: pedirle a ARCA el último número de ese punto de
  // venta CON la CUIT del negocio. Si la delegación o el punto de venta
  // están mal, falla acá y no en el medio de una venta.
  try {
    const ultimo = await ultimoNumero(config.cuit, config.punto_venta, FACTURA_C);
    return Object.assign(base, { listo: true, ultimo_numero: ultimo });
  } catch (err) {
    return Object.assign(base, { listo: false, motivo: String(err.message || err) });
  }
}

// ---------- Emitir ----------

function receptorDe(pedido, total) {
  const r = pedido || {};
  let docTipo = Number(r.doc_tipo) || DOC_SIN_IDENTIFICAR;
  let docNro = Number(soloDigitos(r.doc_nro)) || 0;
  if (docTipo === DOC_SIN_IDENTIFICAR || !docNro) { docTipo = DOC_SIN_IDENTIFICAR; docNro = 0; }

  if (docTipo === DOC_CUIT && !cuitValida(String(docNro))) throw new Error('La CUIT del cliente no es válida.');
  if (docTipo === DOC_DNI && (docNro < 1000000 || docNro > 99999999)) throw new Error('El DNI del cliente no es válido.');
  if (docTipo === DOC_SIN_IDENTIFICAR && Number(total) >= TOPE_SIN_IDENTIFICAR) {
    throw new Error('Desde $' + TOPE_SIN_IDENTIFICAR.toLocaleString('es-AR') +
                    ' ARCA exige identificar al cliente. Cargá su DNI o CUIT.');
  }

  // Con DNI o sin identificar, es consumidor final. Con CUIT se respeta
  // lo que eligió el vendedor (monotributista, responsable inscripto...).
  const condicion = docTipo === DOC_CUIT ? (Number(r.condicion) || CONSUMIDOR_FINAL) : CONSUMIDOR_FINAL;
  return {
    doc_tipo: docTipo,
    doc_nro: docNro,
    receptor_nombre: String(r.nombre || '').trim().slice(0, 120) || null,
    receptor_condicion: condicion
  };
}

async function comprobanteDeOrden(slug, orderId) {
  const filas = await sb('/rest/v1/store_comprobantes?store_slug=eq.' + encodeURIComponent(slug) +
                         '&order_id=eq.' + encodeURIComponent(orderId) + '&select=*');
  return (filas && filas[0]) || null;
}

// Emite la factura de una venta. La exporta este archivo para que más
// adelante los webhooks (tienda online, Mercado Libre) puedan facturar
// solos sin que haya nadie mirando el panel.
async function emitirParaOrden(slug, orderId, pedidoReceptor) {
  if (!/^[0-9a-f-]{36}$/i.test(String(orderId || ''))) throw new Error('Venta inválida');

  const config = await configDeTienda(slug);
  if (!config) throw new Error('Primero cargá tus datos fiscales en Configuración → Facturación ARCA.');

  // Que la venta sea de ESTA tienda: el id lo manda el navegador.
  const ordenes = await sb('/rest/v1/orders?id=eq.' + encodeURIComponent(orderId) +
                           '&store_slug=eq.' + encodeURIComponent(slug) + '&select=id,items,total,estado,customer_name');
  const orden = ordenes && ordenes[0];
  if (!orden) throw new Error('No se encontró esa venta.');
  if (orden.estado === 'cancelado') throw new Error('Esa venta está anulada, no se puede facturar.');
  if (orden.estado === 'pendiente') throw new Error('Confirmá el pedido antes de facturarlo.');
  if (!(Number(orden.total) > 0)) throw new Error('La venta no tiene importe para facturar.');

  const ya = await comprobanteDeOrden(slug, orderId);
  if (ya && ya.estado === 'autorizado') return { comprobante: ya, ya_existia: true };
  if (ya) {
    // Quedó una a medio hacer (se cortó la función en el medio). Si ARCA
    // llegó a darle número, NO se borra: ese número existe del lado de
    // ARCA y hay que revisarlo a mano antes de volver a emitir.
    if (ya.numero) throw new Error('Esta venta quedó con una factura a medio emitir (n° ' + ya.numero + '). Avisanos para revisarla.');
    await sb('/rest/v1/store_comprobantes?id=eq.' + ya.id, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  }

  const receptor = receptorDe(pedidoReceptor, orden.total);
  const items = (Array.isArray(orden.items) ? orden.items : []).map((it) => ({
    nombre: String(it.name || it.nombre || 'Producto').slice(0, 120),
    cantidad: Number(it.qty || 1),
    precio: Number(it.price || 0)
  }));

  // Primero se reserva la fila. El índice único por order_id hace que un
  // segundo "Facturar" de la misma venta choque acá, ANTES de pedir un CAE.
  let fila;
  try {
    const creadas = await sb('/rest/v1/store_comprobantes', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: [Object.assign({
        store_slug: slug,
        order_id: orderId,
        estado: 'pendiente',
        tipo: FACTURA_C,
        punto_venta: config.punto_venta,
        fecha: fechaArca(),
        total: Number(orden.total),
        items: items,
        emisor: {
          cuit: config.cuit,
          razon_social: config.razon_social,
          domicilio: config.domicilio,
          inicio_actividades: config.inicio_actividades,
          ingresos_brutos: config.ingresos_brutos,
          condicion_iva: config.condicion_iva
        }
      }, receptor)]
    });
    fila = creadas[0];
  } catch (err) {
    if (err.status === 409) throw new Error('Esta venta ya se está facturando. Esperá unos segundos y actualizá.');
    throw err;
  }

  let seMandoAArca = false;
  try {
    // El número lo decide ARCA (último + 1). Si otra venta del mismo punto
    // de venta se coló en el medio, ARCA rechaza con 10016 y se reintenta
    // una vez con el número siguiente.
    let numero = await ultimoNumero(config.cuit, config.punto_venta, FACTURA_C) + 1;
    let autorizado;
    for (let intento = 0; ; intento++) {
      await sb('/rest/v1/store_comprobantes?id=eq.' + fila.id, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: { numero: numero }
      });
      try {
        seMandoAArca = true;
        autorizado = await solicitarCae(config, Object.assign({}, fila, { numero: numero }));
        break;
      } catch (err) {
        if (intento === 0 && (err.codigos || []).includes(10016)) {
          numero = await ultimoNumero(config.cuit, config.punto_venta, FACTURA_C) + 1;
          continue;
        }
        throw err;
      }
    }

    const listas = await sb('/rest/v1/store_comprobantes?id=eq.' + fila.id, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: { estado: 'autorizado', numero: numero, cae: autorizado.cae, cae_vto: autorizado.cae_vto }
    });
    return { comprobante: listas[0], ya_existia: false };
  } catch (err) {
    // Si el pedido llegó a ARCA y no hubo respuesta clara (se cortó la
    // conexión), ARCA pudo haberlo autorizado igual. Esa fila queda con su
    // número para revisarla: borrarla y volver a emitir podría sacar dos
    // facturas por la misma venta.
    if (seMandoAArca && !err.codigos) throw err;
    // ARCA dijo que no: no hay comprobante, se libera la venta para poder
    // reintentar después de corregir lo que falte.
    await sb('/rest/v1/store_comprobantes?id=eq.' + fila.id, {
      method: 'DELETE', headers: { Prefer: 'return=minimal' }
    }).catch(() => {});
    throw err;
  }
}

// ---------- Entrada ----------

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const faltan = faltanVariables();
  if (faltan.length) {
    return res.status(500).json({
      error: 'La facturación con ARCA todavía no está activada en BRUWAL. Faltan: ' + faltan.join(', ')
    });
  }

  const cabecera = req.headers.authorization || '';
  const token = cabecera.startsWith('Bearer ') ? cabecera.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Falta la sesión' });

  const usuario = await usuarioDeToken(token);
  if (!usuario || !usuario.id) return res.status(401).json({ error: 'Sesión inválida' });

  const cuerpo = req.body || {};
  const accion = cuerpo.accion || '';

  const tienda = await tiendaDelUsuario(usuario.id, cuerpo.slug);
  if (!tienda) return res.status(403).json({ error: 'Este usuario no tiene tienda' });

  try {
    if (accion === 'estado') return res.status(200).json(await accionEstado(tienda.slug));
    if (accion === 'guardar') return res.status(200).json(await accionGuardar(tienda.slug, cuerpo.datos || {}));
    if (accion === 'emitir') {
      return res.status(200).json(await emitirParaOrden(tienda.slug, cuerpo.order_id, cuerpo.receptor));
    }
    if (accion === 'comprobante') {
      return res.status(200).json({ comprobante: await comprobanteDeOrden(tienda.slug, cuerpo.order_id) });
    }
    return res.status(400).json({ error: 'Acción desconocida' });
  } catch (err) {
    console.error('arca.js', accion, err);
    return res.status(400).json({ error: String(err.message || err) });
  }
};

module.exports.emitirParaOrden = emitirParaOrden;
module.exports._probar = { firmarTra, etiqueta, mensajesDe, cuitValida, receptorDe, fechaArca, desescapar };
