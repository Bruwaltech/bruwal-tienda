// Métricas de uso y registro de errores, para todas las páginas.
//
// Hace dos cosas:
//
// 1. Carga Vercel Web Analytics y Speed Insights: visitas, de dónde viene
//    la gente, qué páginas mira y qué tan rápido le carga. Se ve en el panel
//    de Vercel (pestañas Analytics y Speed Insights). Si esas pestañas no
//    están activadas, el script da 404 y no pasa nada.
//
// 2. Anota en Supabase (tabla errores_sitio, vía /api/error) los errores que
//    le pasan a la gente de verdad:
//      - errores de JavaScript que nadie atrapó,
//      - promesas que fallaron sin catch,
//      - respuestas rotas de nuestra API o de Supabase (400, 403, 5xx),
//      - avisos de "No se pudo..." que el panel le muestra al usuario.
//    Sin esto, un error en el celular de un cliente no lo ve nadie.
//
// Cuidados:
//   - De la URL se manda solo el camino (/dashboard/), nunca el ?query:
//     el portal de clientes lleva el token ahí.
//   - Máximo 10 errores por carga de página y sin repetir el mismo, para que
//     un error en un bucle no llene la tabla.
//   - Si algo de esto falla, se calla: el registro de errores nunca puede
//     ser la causa de un error.

(function () {
  if (window.__seguimiento) return;
  window.__seguimiento = true;

  // ---- 1. Vercel Analytics + Speed Insights --------------------------------
  window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
  window.si = window.si || function () { (window.siq = window.siq || []).push(arguments); };
  ['/_vercel/insights/script.js', '/_vercel/speed-insights/script.js'].forEach(function (src) {
    try {
      var s = document.createElement('script');
      s.src = src;
      s.defer = true;
      document.head.appendChild(s);
    } catch (e) {}
  });

  // ---- 2. Errores ----------------------------------------------------------
  // En local (file:// o localhost) no anotamos nada: son errores nuestros.
  var host = location.hostname;
  if (location.protocol === 'file:' || host === 'localhost' || host === '127.0.0.1') return;

  var MAXIMO = 10;
  var enviados = 0;
  var vistos = {};
  var fetchOriginal = window.fetch;

  function cortar(texto, largo) {
    return String(texto == null ? '' : texto).slice(0, largo);
  }

  // Saca los ?parametros de cualquier URL que aparezca en el texto (la
  // fuente y el stack traen la URL completa de la página, con el token).
  function sinQuery(texto) {
    return String(texto == null ? '' : texto).replace(/\?[^\s:)'"]*/g, '');
  }

  function anotar(tipo, mensaje, extra) {
    try {
      extra = extra || {};
      mensaje = cortar(mensaje, 500);
      if (!mensaje) return;
      var clave = tipo + '|' + mensaje + '|' + (extra.fuente || '');
      if (vistos[clave] || enviados >= MAXIMO) return;
      vistos[clave] = true;
      enviados++;

      var cuerpo = JSON.stringify({
        tipo: tipo,
        mensaje: mensaje,
        pagina: location.pathname,
        fuente: cortar(sinQuery(extra.fuente), 300),
        linea: extra.linea || null,
        columna: extra.columna || null,
        stack: cortar(sinQuery(extra.stack), 2000),
        estado: extra.estado || null,
        ancho: window.innerWidth || null
      });

      // sendBeacon sobrevive aunque la persona cierre la pestaña justo ahí.
      if (navigator.sendBeacon && navigator.sendBeacon('/api/error', new Blob([cuerpo], { type: 'application/json' }))) return;
      if (fetchOriginal) {
        fetchOriginal.call(window, '/api/error', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: cuerpo,
          keepalive: true
        }).catch(function () {});
      }
    } catch (e) {}
  }

  window.addEventListener('error', function (e) {
    // Una imagen o un script que no cargó también dispara 'error', pero sin
    // mensaje. Esos los dejamos: ya hay onerror que los maneja en cada lugar.
    if (!e || !e.message) return;
    // "Script error." es un error de un script de otro dominio que el
    // navegador no nos deja ver. No sirve para arreglar nada.
    if (e.message === 'Script error.' || e.message === 'Script error') return;
    anotar('js', e.message, {
      fuente: e.filename,
      linea: e.lineno,
      columna: e.colno,
      stack: e.error && e.error.stack
    });
  });

  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    var mensaje = r && r.message ? r.message : (typeof r === 'string' ? r : JSON.stringify(r));
    anotar('promesa', mensaje, { stack: r && r.stack });
  });

  // Respuestas rotas. Miramos solo lo nuestro y Supabase. Dejamos afuera 401
  // (sesión vencida), 404 y 406 (supabase .single() sin filas) y 409
  // (duplicado): son parte del uso normal, no errores del sitio.
  function esNuestro(url) {
    return url.indexOf('/api/') !== -1 && (url.charAt(0) === '/' || url.indexOf(location.origin) === 0)
      || url.indexOf('.supabase.co/') !== -1;
  }
  function estadoAnotable(n) {
    return n === 400 || n === 403 || n >= 500;
  }

  if (fetchOriginal) {
    window.fetch = function (entrada, opciones) {
      var url = '';
      try { url = typeof entrada === 'string' ? entrada : (entrada && entrada.url) || String(entrada); } catch (e) {}
      var promesa = fetchOriginal.apply(this, arguments);
      if (url.indexOf('/api/error') !== -1 || !esNuestro(url)) return promesa;
      return promesa.then(function (res) {
        try {
          if (res && estadoAnotable(res.status)) {
            var metodo = (opciones && opciones.method) || (entrada && entrada.method) || 'GET';
            // Solo el camino, sin parámetros: los filtros de Supabase pueden
            // llevar nombres o teléfonos de clientes.
            var camino = url.split('?')[0].replace(/^https?:\/\/[^/]+/, '');
            res.clone().text().then(function (t) {
              anotar('red', metodo + ' ' + camino + ' -> ' + res.status + ': ' + cortar(t, 300), {
                fuente: camino,
                estado: res.status
              });
            }).catch(function () {});
          }
        } catch (e) {}
        return res;
      });
    };
  }

  // Los avisos de "No se pudo..." son el error tal cual lo ve el usuario.
  // avisos.js puede cargar después que este archivo, así que esperamos.
  function engancharAvisos() {
    var original = window.dialogoAviso;
    if (typeof original !== 'function' || original.__seguimiento) return;
    var envuelto = function (msg) {
      try {
        var t = String(msg || '');
        if (/^no se pud|error/i.test(t)) anotar('aviso', t);
      } catch (e) {}
      return original.apply(this, arguments);
    };
    envuelto.__seguimiento = true;
    window.dialogoAviso = envuelto;
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', engancharAvisos);
  } else {
    engancharAvisos();
  }
})();
