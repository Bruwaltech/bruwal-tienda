// Los correos que manda BRUWAL, por Resend.
//
// El guión bajo del nombre no es decorativo: Vercel no publica como función
// los archivos que empiezan con "_". Esto es una biblioteca que usan otras
// funciones, no una dirección a la que se pueda entrar desde afuera.
//
// POR QUÉ LA PLANTILLA SE BAJA EN VEZ DE ESTAR ESCRITA ACÁ:
// vive en emails/bienvenida.html, que se publica con el sitio. Así se puede
// abrir en el navegador para ver cómo quedó, y corregir una palabra sin
// tocar el código de cobranza — que es lo último que uno quiere tocar para
// arreglar una coma.

const RESEND_API = 'https://api.resend.com/emails';

// De dónde sale el correo. Va por variable de entorno porque depende del
// dominio verificado en Resend, no del código.
function remitente() {
  return process.env.MAIL_DESDE || 'BRUWAL <hola@bruwaltech.com.ar>';
}

function hayComoMandar() {
  return !!process.env.RESEND_API_KEY;
}

// Trae la plantilla del sitio y reemplaza lo que va entre llaves.
//
// Los valores se escapan: el nombre del negocio lo escribió el cliente y
// puede tener un "&" o un "<". Sin escaparlo, un nombre como
// "Pérez & Cía <la esquina>" rompe el mail o mete etiquetas en el correo.
async function armarPlantilla(base, archivo, valores) {
  const r = await fetch(base + '/emails/' + archivo);
  if (!r.ok) throw new Error('No se pudo leer la plantilla ' + archivo + ' (HTTP ' + r.status + ')');

  let html = await r.text();
  Object.entries(valores || {}).forEach(([clave, valor]) => {
    const seguro = String(valor == null ? '' : valor)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    html = html.split('{{' + clave + '}}').join(seguro);
  });
  return html;
}

// Manda un correo. Devuelve true si salió.
//
// NUNCA tira una excepción hacia afuera: esto se llama justo después de
// activarle el plan a alguien que pagó, y un problema del servidor de
// correo no puede hacer que ese pago se pierda. Si el mail falla, queda en
// el log y el plan igual queda activo.
async function mandar({ para, asunto, html }) {
  if (!hayComoMandar()) {
    console.warn('Falta RESEND_API_KEY: no se mando el correo a', para);
    return false;
  }
  if (!para || !String(para).includes('@')) {
    console.warn('Direccion de correo invalida:', para);
    return false;
  }

  try {
    const r = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from: remitente(), to: [para], subject: asunto, html })
    });

    if (!r.ok) {
      const detalle = await r.text().catch(() => '');
      console.error('Resend contesto', r.status, detalle.slice(0, 300));
      return false;
    }

    console.log('Correo enviado a', para, '-', asunto);
    return true;
  } catch (err) {
    console.error('No se pudo enviar el correo a', para, String((err && err.message) || err));
    return false;
  }
}

// El de bienvenida, que sale cuando el pago entra y el plan queda activo.
async function bienvenida({ base, para, nombre, whatsapp }) {
  const html = await armarPlantilla(base, 'bienvenida.html', {
    NOMBRE: nombre || 'y bienvenido',
    LINK_PANEL: base + '/dashboard',
    WHATSAPP: whatsapp || '5493413005232'
  }).catch((err) => {
    console.error('Plantilla de bienvenida:', String((err && err.message) || err));
    return null;
  });

  if (!html) return false;

  return await mandar({
    para,
    // El asunto se lee antes de abrir, y muchas veces es lo único que se
    // lee. Dice quién es y qué pasó, sin signos de admiración ni mayúsculas
    // sueltas, que es lo que manda el correo a spam.
    asunto: 'Bienvenido a BRUWAL: tu plan ya esta activo',
    html
  });
}

module.exports = { mandar, bienvenida, hayComoMandar };
