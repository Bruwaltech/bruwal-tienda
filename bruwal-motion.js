/* ==========================================================================
   BRUWAL — capa de movimiento (comportamiento)
   --------------------------------------------------------------------------
   Va en un archivo aparte y con defer a propósito: así, si algo de acá
   fallara, NO puede cortar la ejecución del script grande de index.html
   (que es lo que deja la página colgada cuando revienta una línea).
   Además todo está dentro de un try/catch por bloque: si una parte falla,
   las otras siguen.

   No toca el DOM que ya existe salvo para AGREGAR clases con prefijo bw- y
   tres elementos nuevos propios (barra de progreso, aurora, volver arriba).
   ========================================================================== */
(function () {
  'use strict';

  var raiz = document.documentElement;
  var menosMovimiento = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var hayObserver = 'IntersectionObserver' in window;
  var punteroFino = window.matchMedia &&
    window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  // Envuelve cada bloque: un error en uno no se lleva puestos los demás.
  function seguro(nombre, fn) {
    try { fn(); } catch (e) { console.warn('[bw-motion] ' + nombre + ':', e); }
  }

  function cada(selector, fn, raizBusqueda) {
    var nodos = (raizBusqueda || document).querySelectorAll(selector);
    Array.prototype.forEach.call(nodos, fn);
  }

  /* ---------------------------------------------------------------- 1
     Entradas al hacer scroll.
     Se activan SOLO si el navegador tiene IntersectionObserver y el usuario
     no pidió menos movimiento. Si no, no se agrega .bw-motion y entonces la
     regla que esconde (que vive bajo .bw-motion) nunca aplica: la página se
     ve completa, como siempre. */
  seguro('revelados', function () {
    if (menosMovimiento || !hayObserver) return;

    // Lo que NO se toca: el mapa (un transform le desacomoda los tiles) y la
    // lista de tiendas, que se dibuja sola con datos de Supabase.
    var prohibido = '#map, #map *, #storesList, #storesList *, .leaflet-container, .leaflet-container *';

    // Grupos: [selector, clase de variante, escalonar entre hermanos]
    var grupos = [
      ['.hero .paso',            '',            true],
      ['.hero .paso-extra',      '',            false],
      ['.hero-acciones',         '',            false],
      ['.telefono',              'bw-rev-zoom', false],
      ['.search-box',            '',            false],
      ['.results-title',         '',            false],
      ['.video-inner > .revelar','',            false],
      ['.celu-lista > div',      'bw-rev-izq',  true],
      ['.equipo-ficha',          'bw-rev-der',  false],
      ['.ia-top > div',          '',            true],
      ['.planes-seccion .cabecera', '',         false],
      ['.site-footer .footer-inner > *', '',    true]
    ];

    var observador = new IntersectionObserver(function (entradas) {
      entradas.forEach(function (entrada) {
        if (!entrada.isIntersecting) return;
        entrada.target.classList.add('bw-in');
        observador.unobserve(entrada.target);   // una sola vez, no al volver a subir
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -60px 0px' });

    function preparar(el, variante, indice) {
      if (!el || el.classList.contains('bw-rev')) return;
      if (el.matches(prohibido) || el.closest('#map, #storesList')) return;
      // Si ya tenía la animación propia del sitio, la respeto y no la duplico.
      if (el.classList.contains('revelar')) return;

      el.classList.add('bw-rev');
      if (variante) el.classList.add(variante);
      if (indice) el.style.transitionDelay = Math.min(indice * 90, 450) + 'ms';
      observador.observe(el);
    }

    raiz.classList.add('bw-motion');

    grupos.forEach(function (grupo) {
      var selector = grupo[0], variante = grupo[1], escalonar = grupo[2];
      cada(selector, function (el, i) { preparar(el, variante, escalonar ? i : 0); });
    });

    // Las tarjetas de planes las dibuja pintarPlanes() después, leyendo
    // planes.js. Espero a que aparezcan en vez de adivinar cuándo.
    var contenedorPlanes = document.getElementById('planesHome');
    if (contenedorPlanes && 'MutationObserver' in window) {
      new MutationObserver(function () {
        cada('#planesHome > *', function (el, i) { preparar(el, 'bw-rev-zoom', i); });
      }).observe(contenedorPlanes, { childList: true });
    }

    /* Red de seguridad: si por lo que sea algo quedó marcado para revelarse y
       nunca se reveló (un observer que no disparó, una pestaña en segundo
       plano), a los 4 segundos se muestra igual. Contenido invisible es el
       único error que esta capa no se puede permitir. */
    setTimeout(function () {
      cada('.bw-rev:not(.bw-in)', function (el) { el.classList.add('bw-in'); });
    }, 4000);
  });

  /* ---------------------------------------------------------------- 2
     Barra de progreso + header al despegarse del tope + volver arriba.
     Los tres dependen del scroll, así que comparten un solo listener
     pasivo con requestAnimationFrame: no se recalcula nada de más. */
  seguro('scroll', function () {
    var barra = null;
    if (!menosMovimiento) {
      barra = document.createElement('div');
      barra.className = 'bw-progreso';
      document.body.appendChild(barra);
    }

    var header = document.querySelector('header');

    var arriba = document.createElement('button');
    arriba.className = 'bw-top';
    arriba.type = 'button';
    arriba.setAttribute('aria-label', 'Volver arriba');
    arriba.innerHTML = '&uarr;';
    arriba.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: menosMovimiento ? 'auto' : 'smooth' });
    });
    document.body.appendChild(arriba);

    var pendiente = false;
    function actualizar() {
      pendiente = false;
      var y = window.pageYOffset || raiz.scrollTop;
      var alto = raiz.scrollHeight - window.innerHeight;

      if (barra) {
        barra.style.transform = 'scaleX(' + (alto > 0 ? Math.min(y / alto, 1) : 0) + ')';
      }
      if (header) header.classList.toggle('bw-fijo', y > 24);

      // El cartel de instalación de iPhone ocupa esta misma esquina.
      var ayuda = document.querySelector('.ayuda-ios');
      var chocan = ayuda && ayuda.offsetParent !== null;
      arriba.classList.toggle('bw-visible', y > 700 && !chocan);
    }

    window.addEventListener('scroll', function () {
      if (pendiente) return;
      pendiente = true;
      window.requestAnimationFrame(actualizar);
    }, { passive: true });

    actualizar();
  });

  /* ---------------------------------------------------------------- 3
     Botones: brillo, levante y onda al tocar. */
  seguro('botones', function () {
    // .video-play queda afuera a propósito: está centrado con position:absolute
    // + translate(-50%,-50%) y ya tiene su propio hover. Tocarlo lo descoloca.
    var botones = [
      '.hero-btn', '.video-cta', '.ia-btn', '.btn-auth',
      '.search-btn', '.plan-home .accion'
    ].join(', ');

    cada(botones, function (el) {
      // Leer la posición ANTES de agregar la clase, si no me leo a mí mismo.
      var estatico = getComputedStyle(el).position === 'static';
      el.classList.add('bw-btn');
      if (estatico) el.classList.add('bw-btn-rel');
    });

    // El halo late solo en el botón que queremos que se toque.
    cada('.hero-btn.principal', function (el) { el.classList.add('bw-cta-halo'); });

    if (menosMovimiento) return;

    document.addEventListener('pointerdown', function (ev) {
      var btn = ev.target.closest && ev.target.closest('.bw-btn');
      if (!btn) return;

      var caja = btn.getBoundingClientRect();
      var lado = Math.max(caja.width, caja.height);
      var onda = document.createElement('span');
      onda.className = 'bw-onda';
      onda.style.width = onda.style.height = lado + 'px';
      onda.style.left = (ev.clientX - caja.left - lado / 2) + 'px';
      onda.style.top  = (ev.clientY - caja.top  - lado / 2) + 'px';
      btn.appendChild(onda);
      setTimeout(function () { onda.remove(); }, 620);
    }, { passive: true });
  });

  /* ---------------------------------------------------------------- 4
     Tarjetas: levante al pasar por arriba. Las de fondo oscuro llevan otra
     clase porque ahí una sombra negra no se ve; lo que se enciende es el borde. */
  seguro('tarjetas', function () {
    cada('.ml-card, .video-marco, .plan-home', function (el) { el.classList.add('bw-card'); });
    cada('.ia-item, .equipo-ficha', function (el) { el.classList.add('bw-card-oscura'); });
  });

  /* ---------------------------------------------------------------- 5
     Aurora del hero: dos manchas de luz muy lentas por detrás del texto. */
  seguro('aurora', function () {
    if (menosMovimiento) return;
    var hero = document.querySelector('.hero');
    if (!hero || hero.querySelector('.bw-aurora')) return;

    var aurora = document.createElement('div');
    aurora.className = 'bw-aurora';
    aurora.setAttribute('aria-hidden', 'true');
    aurora.innerHTML = '<i></i><i></i>';
    hero.insertBefore(aurora, hero.firstChild);
  });

  /* ---------------------------------------------------------------- 6
     El celular del hero: flota y se inclina siguiendo al mouse.
     Solo si no tenía ya un transform propio — si lo tenía, se lo pisaría. */
  seguro('telefono', function () {
    var tel = document.querySelector('.telefono');
    if (!tel || menosMovimiento) return;
    if (getComputedStyle(tel).transform !== 'none') return;

    tel.classList.add('bw-flota');
    if (!punteroFino) return;   // en el celular no hay mouse que seguir

    var contenedor = tel.parentElement || tel;
    contenedor.addEventListener('mousemove', function (ev) {
      var caja = tel.getBoundingClientRect();
      var x = (ev.clientX - caja.left) / caja.width  - 0.5;
      var y = (ev.clientY - caja.top)  / caja.height - 0.5;
      tel.classList.remove('bw-flota');   // el tilt manda mientras hay mouse
      tel.classList.add('bw-tilt');
      tel.style.transform =
        'perspective(900px) rotateY(' + (x * 9).toFixed(2) + 'deg) rotateX(' +
        (-y * 9).toFixed(2) + 'deg)';
    });
    contenedor.addEventListener('mouseleave', function () {
      tel.style.transform = '';
      tel.classList.remove('bw-tilt');
      tel.classList.add('bw-flota');
    });
  });

  /* ---------------------------------------------------------------- 7
     Imán en el botón principal: se corre unos pocos píxeles hacia el mouse
     cuando pasás cerca. Es el detalle que más "caro" hace ver un sitio, y
     como es solo transform no mueve nada alrededor. */
  seguro('iman', function () {
    if (menosMovimiento || !punteroFino) return;

    cada('.hero-btn.principal, .video-cta', function (btn) {
      btn.addEventListener('mousemove', function (ev) {
        var caja = btn.getBoundingClientRect();
        var x = (ev.clientX - caja.left - caja.width / 2) * 0.16;
        var y = (ev.clientY - caja.top - caja.height / 2) * 0.28;
        btn.style.transform = 'translate(' + x.toFixed(1) + 'px, ' + (y - 3).toFixed(1) + 'px)';
      });
      btn.addEventListener('mouseleave', function () { btn.style.transform = ''; });
    });
  });
})();

/* ==========================================================================
   v2 — comportamiento de los agregados que se ven
   ========================================================================== */
(function () {
  'use strict';

  var menosMovimiento = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function seguro(nombre, fn) {
    try { fn(); } catch (e) { console.warn('[bw-motion v2] ' + nombre + ':', e); }
  }
  function cada(sel, fn) {
    Array.prototype.forEach.call(document.querySelectorAll(sel), fn);
  }

  /* ---- Luz que sigue al cursor dentro de cada tarjeta ----
     Escribo las coordenadas en variables CSS: el degradé se reubica solo y
     no hay ni un estilo recalculado de layout, solo repintado. */
  seguro('luz', function () {
    if (menosMovimiento) return;

    cada('.ml-card, .plan-home', function (el) { el.classList.add('bw-luz'); });
    cada('.ia-item, .bw-ml-banner', function (el) {
      el.classList.add('bw-luz', 'bw-luz-fria');
    });

    cada('.bw-luz', function (el) {
      el.addEventListener('pointermove', function (ev) {
        var caja = el.getBoundingClientRect();
        el.style.setProperty('--bw-x', (ev.clientX - caja.left) + 'px');
        el.style.setProperty('--bw-y', (ev.clientY - caja.top) + 'px');
      }, { passive: true });
    });
  });

  /* ---- La prueba social: chapita con pulso y número que sube ----
     El texto lo escribe mostrarPruebaSocial() cuando vuelve la consulta a
     Supabase, así que no puedo leerlo al arrancar: espero a que aparezca. */
  seguro('prueba-social', function () {
    var caja = document.getElementById('heroPrueba');
    if (!caja || !('MutationObserver' in window)) return;

    function animarNumero(b) {
      var final = parseInt((b.textContent || '').replace(/\D/g, ''), 10);
      var resto = (b.textContent || '').replace(/^\s*\d+\s*/, '');
      if (!final || final < 2) return;

      // Si no se puede animar (pestaña oculta o menos movimiento), va el
      // número final directo: nunca se muestra un dato en cero.
      if (menosMovimiento || document.hidden) return;

      b.classList.add('bw-contador');
      var desde = Math.max(0, final - 14);
      var arranque = performance.now();
      var duracion = 1100;

      (function paso(ahora) {
        var t = Math.min((ahora - arranque) / duracion, 1);
        var suave = 1 - Math.pow(1 - t, 3);           // frena al final
        b.textContent = Math.round(desde + (final - desde) * suave) + ' ' + resto;
        if (t < 1) requestAnimationFrame(paso);
        else b.textContent = final + ' ' + resto;
      })(arranque);

      // Red de seguridad: si el rAF nunca corre, a los 2s queda el número real.
      setTimeout(function () { b.textContent = final + ' ' + resto; }, 2000);
    }

    var obs = new MutationObserver(function () {
      var b = caja.querySelector('b');
      if (!b) return;
      obs.disconnect();
      caja.classList.add('bw-pill');
      animarNumero(b);
    });
    obs.observe(caja, { childList: true, subtree: true });
  });
})();
