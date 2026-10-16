// Aviso de cookies y Google Analytics.
//
// Google Analytics guarda cookies que identifican el navegador, así que no
// se carga hasta que la persona toca "Aceptar". Si toca "Solo necesarias",
// no se carga nunca (Vercel Analytics sigue andando: no usa cookies).
//
// La elección queda guardada en este navegador. Desde la política de cookies
// se puede cambiar (botón "Cambiar mi elección", que llama a
// bruwalCookies.preguntar()).
//
// Para anotar algo que pasó (un registro, un pedido):
//   bruwalEvento('sign_up')
// Si la persona no aceptó, no hace nada.

(function () {
  if (window.bruwalCookies) return;

  var ID_ANALYTICS = 'G-G86WZ7WGFD';
  var CLAVE = 'bruwal_cookies'; // 'si' | 'no'
  var cargado = false;

  function leer() {
    try { return localStorage.getItem(CLAVE); } catch (e) { return null; }
  }
  function guardar(valor) {
    try { localStorage.setItem(CLAVE, valor); } catch (e) {}
  }

  // En local no mandamos nada: serían visitas nuestras.
  var host = location.hostname;
  var esLocal = location.protocol === 'file:' || host === 'localhost' || host === '127.0.0.1';

  function cargarAnalytics() {
    if (cargado || esLocal) return;
    cargado = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    // De la URL va solo el camino: el portal de clientes y algunos links
    // llevan un token en el ?query que no tiene que llegar a Google.
    window.gtag('config', ID_ANALYTICS, {
      page_location: location.origin + location.pathname
    });
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + ID_ANALYTICS;
    document.head.appendChild(s);
  }

  window.bruwalEvento = function (nombre, datos) {
    try {
      if (cargado && window.gtag) window.gtag('event', nombre, datos || {});
    } catch (e) {}
  };

  // ---- El aviso -------------------------------------------------------------
  var CSS =
    '#bruwal-cookies{position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483000;' +
    'max-width:560px;margin:0 auto;background:#15294D;color:#fff;border-radius:14px;' +
    'box-shadow:0 10px 30px rgba(0,0,0,.25);padding:16px 16px 14px;' +
    'font:14px/1.45 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}' +
    '#bruwal-cookies p{margin:0 0 12px;color:#fff;}' +
    '#bruwal-cookies a{color:#8FC8F7;text-decoration:underline;}' +
    '#bruwal-cookies .bc-botones{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;}' +
    '#bruwal-cookies button{font:600 14px Inter,-apple-system,sans-serif;border-radius:10px;' +
    'padding:10px 16px;cursor:pointer;border:1px solid transparent;min-height:42px;}' +
    '#bruwal-cookies .bc-si{background:#2F8FE0;color:#fff;}' +
    '#bruwal-cookies .bc-no{background:transparent;color:#fff;border-color:rgba(255,255,255,.45);}' +
    '@media (max-width:420px){#bruwal-cookies .bc-botones button{flex:1;}}';

  function cerrar() {
    var caja = document.getElementById('bruwal-cookies');
    if (caja) caja.remove();
  }

  function mostrar() {
    if (document.getElementById('bruwal-cookies')) return;
    if (!document.getElementById('bruwal-cookies-css')) {
      var estilo = document.createElement('style');
      estilo.id = 'bruwal-cookies-css';
      estilo.textContent = CSS;
      document.head.appendChild(estilo);
    }
    var caja = document.createElement('div');
    caja.id = 'bruwal-cookies';
    caja.setAttribute('role', 'dialog');
    caja.setAttribute('aria-label', 'Aviso de cookies');
    caja.innerHTML =
      '<p>Usamos cookies para saber cómo se usa el sitio y mejorarlo. ' +
      '<a href="/legal/cookies.html">Más información</a></p>' +
      '<div class="bc-botones">' +
      '<button type="button" class="bc-no">Solo necesarias</button>' +
      '<button type="button" class="bc-si">Aceptar</button>' +
      '</div>';
    caja.querySelector('.bc-si').addEventListener('click', function () {
      guardar('si');
      cerrar();
      cargarAnalytics();
    });
    caja.querySelector('.bc-no').addEventListener('click', function () {
      guardar('no');
      cerrar();
    });
    document.body.appendChild(caja);
  }

  function cuandoHayaBody(fn) {
    if (document.body) fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  window.bruwalCookies = {
    // Vuelve a mostrar el aviso (desde la política de cookies).
    preguntar: function () { cuandoHayaBody(mostrar); }
  };

  var eleccion = leer();
  if (eleccion === 'si') cargarAnalytics();
  else if (eleccion !== 'no') cuandoHayaBody(mostrar);

  // ---- Clics que importan ---------------------------------------------------
  // "Crear mi tienda" aparece en varios lugares de la portada: con mirar el
  // texto alcanza para contarlos todos, y si se agrega otro botón igual, se
  // cuenta solo.
  document.addEventListener('click', function (e) {
    try {
      var el = e.target && e.target.closest && e.target.closest('a,button');
      if (!el) return;
      var texto = (el.textContent || '').trim();
      var href = el.getAttribute('href') || '';
      if (/crear mi tienda|registrarse/i.test(texto)) {
        window.bruwalEvento('crear_tienda_click', { texto: texto.slice(0, 40) });
      } else if (/wa\.me|api\.whatsapp\.com/.test(href)) {
        window.bruwalEvento('whatsapp_click');
      }
    } catch (err) {}
  }, true);
})();
