/* ==========================================================================
   BRUWAL — capa de movimiento del PANEL (comportamiento)
   --------------------------------------------------------------------------
   Archivo aparte y con defer: si algo de acá fallara no puede cortar la
   ejecución del script de index.html, que son 17.000 líneas y es la app.
   Cada bloque va en su propio try/catch.

   No llama a ninguna función del panel ni le cambia datos a nada. Lo único
   que hace es agregar clases con prefijo bwd-, escribir dos variables CSS y,
   para cerrar con Escape, apretar el mismo botón de cerrar que ya existe
   (así corre la lógica de cierre que escribió el panel, no una mía).
   ========================================================================== */
(function () {
  'use strict';

  var menosMovimiento = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function seguro(nombre, fn) {
    try { fn(); } catch (e) { console.warn('[bwd-motion] ' + nombre + ':', e); }
  }
  function cada(sel, fn, raiz) {
    Array.prototype.forEach.call((raiz || document).querySelectorAll(sel), fn);
  }

  /* ---------------------------------------------------------------- 1
     Onda al hacer clic en cualquier botón.
     Va delegada en el documento: los botones del panel se dibujan y se
     borran todo el tiempo (cada fila de cada tabla trae los suyos), así que
     engancharse uno por uno se perdería todo lo que aparece después. */
  seguro('onda', function () {
    if (menosMovimiento) return;

    document.addEventListener('pointerdown', function (ev) {
      var btn = ev.target.closest &&
                ev.target.closest('.btn, .btn-action, .icon-btn, .btn-ghost, .chip-sug');
      if (!btn || btn.disabled) return;

      var caja = btn.getBoundingClientRect();
      var lado = Math.max(caja.width, caja.height);
      var onda = document.createElement('span');
      onda.className = 'bwd-onda';
      onda.style.width = onda.style.height = lado + 'px';
      onda.style.left = (ev.clientX - caja.left - lado / 2) + 'px';
      onda.style.top  = (ev.clientY - caja.top  - lado / 2) + 'px';
      btn.appendChild(onda);
      setTimeout(function () { onda.remove(); }, 580);
    }, { passive: true });
  });

  /* ---------------------------------------------------------------- 2
     Sombra de las solapas cuando quedan pegadas arriba. */
  seguro('solapas', function () {
    var tabs = document.querySelector('.app-tabs');
    if (!tabs) return;

    var pendiente = false;
    function revisar() {
      pendiente = false;
      tabs.classList.toggle('bwd-pegada', tabs.getBoundingClientRect().top <= 0);
    }
    window.addEventListener('scroll', function () {
      if (pendiente) return;
      pendiente = true;
      requestAnimationFrame(revisar);
    }, { passive: true });
    revisar();
  });

  /* ---------------------------------------------------------------- 3
     Luz que sigue al cursor en las tarjetas de números.
     Delegada también: las stat-cards se redibujan al cambiar de solapa. */
  seguro('luz', function () {
    if (menosMovimiento) return;

    document.addEventListener('pointermove', function (ev) {
      var tarjeta = ev.target.closest && ev.target.closest('.stat-card');
      if (!tarjeta) return;
      var caja = tarjeta.getBoundingClientRect();
      tarjeta.style.setProperty('--bwd-x', (ev.clientX - caja.left) + 'px');
      tarjeta.style.setProperty('--bwd-y', (ev.clientY - caja.top) + 'px');
    }, { passive: true });
  });

  /* ---------------------------------------------------------------- 4
     Los números de las tarjetas.
     Dos cosas distintas:
     - la primera vez que se llenan, suben contando (entrada)
     - cuando cambian después, la tarjeta pega un destello (aviso)

     Regla de oro: el texto que se muestra tiene que poder reconstruirse
     EXACTO. Antes de animar reformateo el número y lo comparo con el
     original; si no da igual (una moneda rara, un texto tipo "3 de 8"),
     no toco nada y solo destello. Nunca se muestra un número mal escrito. */
  seguro('numeros', function () {
    if (!('MutationObserver' in window)) return;

    var FORMA = /^(\D*?)(\d[\d.]*(?:,\d+)?)(\D*)$/;

    function analizar(txt) {
      var m = FORMA.exec((txt || '').trim());
      if (!m) return null;

      var crudo = m[2];
      var decimales = crudo.indexOf(',') >= 0 ? crudo.split(',')[1].length : 0;
      var valor = parseFloat(crudo.replace(/\./g, '').replace(',', '.'));
      if (!isFinite(valor)) return null;

      var fmt = new Intl.NumberFormat('es-AR', {
        minimumFractionDigits: decimales,
        maximumFractionDigits: decimales
      });
      // Si no puedo reproducir el texto tal cual, me abstengo.
      if (fmt.format(valor) !== crudo) return null;

      return { antes: m[1], valor: valor, despues: m[3], fmt: fmt };
    }

    function contar(el, info) {
      if (menosMovimiento || document.hidden || info.valor === 0) return;

      var desde = 0;
      var arranque = performance.now();
      var duracion = Math.min(280 + info.valor / 60, 900);
      var textoFinal = el.textContent;

      el.dataset.bwdAnimando = '1';
      el.classList.add('bwd-contador');

      (function paso(ahora) {
        var t = Math.min((ahora - arranque) / duracion, 1);
        var suave = 1 - Math.pow(1 - t, 3);
        el.textContent = info.antes + info.fmt.format(
          Math.round((desde + (info.valor - desde) * suave) * 100) / 100) + info.despues;
        if (t < 1) { requestAnimationFrame(paso); }
        else { el.textContent = textoFinal; delete el.dataset.bwdAnimando; }
      })(arranque);

      // Si el rAF no corre (pestaña de fondo), el número real vuelve igual.
      setTimeout(function () {
        if (el.dataset.bwdAnimando) {
          el.textContent = textoFinal;
          delete el.dataset.bwdAnimando;
        }
      }, 1500);
    }

    function destellar(el) {
      var tarjeta = el.closest('.stat-card');
      if (!tarjeta || menosMovimiento) return;
      tarjeta.classList.remove('bwd-cambio');
      void tarjeta.offsetWidth;              // reinicia la animación
      tarjeta.classList.add('bwd-cambio');
      setTimeout(function () { tarjeta.classList.remove('bwd-cambio'); }, 950);
    }

    var vistos = new WeakMap();

    var observador = new MutationObserver(function (cambios) {
      cambios.forEach(function (c) {
        var el = c.target.closest ? c.target.closest('.stat-card .value')
                                  : c.target.parentElement;
        if (!el || el.dataset.bwdAnimando) return;

        var texto = el.textContent.trim();
        var previo = vistos.get(el);
        if (texto === previo) return;
        vistos.set(el, texto);

        var info = analizar(texto);
        // Primera vez con un número de verdad: sube contando. Después: destella.
        if (info && (previo === undefined || previo === '' || previo === '—' || previo === '-')) {
          contar(el, info);
        } else if (previo !== undefined) {
          destellar(el);
        }
      });
    });

    observador.observe(document.body, {
      subtree: true, childList: true, characterData: true
    });

    // Estado inicial de lo que ya estaba dibujado, para no contarlo dos veces.
    cada('.stat-card .value', function (el) { vistos.set(el, el.textContent.trim()); });
  });

  /* ---------------------------------------------------------------- 5
     Escape cierra el modal de arriba.
     No cierro yo: aprieto el botón de cerrar que ya tiene el modal, así
     corre la limpieza que hace el panel (vaciar el formulario, soltar el
     producto en edición) y no queda nada a medias. */
  seguro('escape', function () {
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;

      var abiertos = document.querySelectorAll('.modal-overlay:not(.hidden)');
      if (!abiertos.length) return;

      var ultimo = abiertos[abiertos.length - 1];
      var cerrar = ultimo.querySelector('.modal-close');
      if (cerrar) cerrar.click();
    });
  });
})();
