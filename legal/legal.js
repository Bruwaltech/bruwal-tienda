// Páginas legales compartidas por BRUWAL y por cada tienda.
// Sin ?tienda= hablan en nombre de BRUWAL (la plataforma y sus planes).
// Con ?tienda=<slug> hablan en nombre de esa tienda (sus ventas a clientes)
// y BRUWAL queda como proveedor de la plataforma.

// Datos de BRUWAL como proveedor. Si alguno queda vacío, la línea no se muestra.
const BRUWAL = {
  nombre: 'BRUWAL Technologies',
  titular: 'Bruno Sebastián Ruiz',
  cuit: '20-35464068-7',
  email: 'administracion@bruwaltech.com',
  domicilio: '',
  telefono: ''
};

const SUPABASE_URL = 'https://qduguqazpxjjpxjfnkif.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_xYt7UXHADSkLyWt4uIRl1w_Ka6WdSbN';

const slug = (new URLSearchParams(location.search).get('tienda') || '').trim().toLowerCase();
let responsable = null;

function soloDigitos(t) { return String(t || '').replace(/\D/g, ''); }

function numeroWhatsApp(tel) {
  let n = soloDigitos(tel);
  if (!n) return '';
  if (n.startsWith('54')) return n;
  n = n.replace(/^0/, '');
  return '549' + n.replace(/^(\d{2,4})15/, '$1');
}

async function cargarTienda() {
  const url = SUPABASE_URL + '/rest/v1/store_profiles?select=slug,business_name,email,phone,location' +
    '&slug=eq.' + encodeURIComponent(slug) + '&limit=1';
  const r = await fetch(url, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY } });
  if (!r.ok) return null;
  const filas = await r.json();
  return filas[0] || null;
}

function llenar(datos) {
  document.querySelectorAll('[data-c]').forEach(el => {
    const v = datos[el.dataset.c];
    if (v) el.textContent = v;
    else if (el.closest('[data-opcional]')) el.closest('[data-opcional]').classList.add('oculto');
  });
  document.querySelectorAll('[data-href]').forEach(el => {
    const v = datos[el.dataset.href];
    if (v) el.href = (el.dataset.href === 'email' ? 'mailto:' : '') + v;
  });
}

async function iniciar() {
  const anio = document.getElementById('anio');
  if (anio) anio.textContent = new Date().getFullYear();

  let tienda = null;
  if (slug) { try { tienda = await cargarTienda(); } catch (e) {} }

  document.querySelectorAll(tienda ? '[data-si="bruwal"]' : '[data-si="tienda"]').forEach(el => el.remove());

  responsable = tienda ? {
    responsable: tienda.business_name,
    email: tienda.email,
    telefono: tienda.phone,
    domicilio: tienda.location,
    whatsapp: numeroWhatsApp(tienda.phone)
  } : {
    responsable: BRUWAL.nombre,
    email: BRUWAL.email,
    telefono: BRUWAL.telefono,
    domicilio: BRUWAL.domicilio,
    whatsapp: numeroWhatsApp(BRUWAL.telefono)
  };
  responsable.titular = BRUWAL.titular;
  responsable.cuit = BRUWAL.cuit;
  responsable.bruwal = BRUWAL.nombre;
  responsable.bruwal_email = BRUWAL.email;
  llenar(responsable);

  // Los links entre páginas legales y el de volver conservan la tienda.
  if (tienda) {
    document.querySelectorAll('a[data-legal]').forEach(a => {
      a.href = a.getAttribute('href') + '?tienda=' + encodeURIComponent(tienda.slug);
    });
    const volver = document.getElementById('volver');
    if (volver) { volver.href = '/' + tienda.slug; volver.textContent = '← Volver a ' + tienda.business_name; }
    document.title = document.title.replace('BRUWAL', tienda.business_name);
  }

  iniciarArrepentimiento();
}

// Botón de arrepentimiento (Res. 424/2020): sin registrarse, y con un código
// de revocación que se le da a la persona en el momento.
function iniciarArrepentimiento() {
  const form = document.getElementById('formArrepentimiento');
  if (!form) return;
  form.addEventListener('submit', ev => {
    ev.preventDefault();
    const val = id => document.getElementById(id).value.trim();
    const hoy = new Date();
    const fecha = hoy.toISOString().slice(0, 10).replace(/-/g, '');
    const azar = Math.random().toString(36).slice(2, 7).toUpperCase();
    const codigo = 'ARR-' + fecha + '-' + azar;

    const texto =
      'Solicitud de revocación (botón de arrepentimiento)\n' +
      'Código: ' + codigo + '\n' +
      'Fecha: ' + hoy.toLocaleString('es-AR') + '\n' +
      'Nombre: ' + val('arrNombre') + '\n' +
      'Contacto: ' + val('arrContacto') + '\n' +
      'Compra o plan: ' + val('arrDetalle') + '\n' +
      'Fecha de compra o entrega: ' + val('arrFecha') + '\n' +
      (val('arrMotivo') ? 'Comentario: ' + val('arrMotivo') + '\n' : '') +
      '\nEjerzo mi derecho a revocar la aceptación según el art. 34 de la Ley 24.240 y el art. 1110 del Código Civil y Comercial.';

    document.getElementById('arrCodigo').textContent = codigo;
    const wa = document.getElementById('arrWhatsapp');
    const mail = document.getElementById('arrMail');
    if (responsable.whatsapp) {
      wa.href = 'https://wa.me/' + responsable.whatsapp + '?text=' + encodeURIComponent(texto);
      wa.classList.remove('oculto');
    }
    if (responsable.email) {
      mail.href = 'mailto:' + responsable.email + '?subject=' + encodeURIComponent('Botón de arrepentimiento ' + codigo) +
        '&body=' + encodeURIComponent(texto);
      mail.classList.remove('oculto');
    }
    form.classList.add('oculto');
    document.getElementById('arrListo').classList.remove('oculto');
    if (responsable.whatsapp) window.open(wa.href, '_blank');
  });
}

iniciar();
