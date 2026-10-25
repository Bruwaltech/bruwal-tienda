// Estilo "moderno" de la tienda (ver tienda-moderna.css).
//
// tienda.html llama a BruwalModerno.activar(store) apenas tiene el perfil.
// Si la tienda no eligió este estilo no hace nada, y la página queda igual
// que siempre. Se puede probar en cualquier tienda con ?estilo=moderno (y
// apagar con ?estilo=clasico), sin guardar nada.
//
// Lo que agrega el script y la hoja sola no puede:
// - la aurora y la grilla de puntos detrás del encabezado,
// - la cinta con lo que ofrece la tienda, armada con datos reales del perfil,
// - la entrada escalonada de las tarjetas, UNA vez por producto: el listado
//   se vuelve a dibujar entero con cada + o −, y si cada vez entraran de
//   nuevo, la grilla parpadearía con cada toque,
// - el brillo que sigue al mouse sobre las tarjetas.
(function () {
  'use strict';

  function elegido(store) {
    let porLink = null;
    try { porLink = new URLSearchParams(window.location.search).get('estilo'); } catch (e) {}
    if (porLink === 'moderno') return true;
    if (porLink === 'clasico') return false;
    return !!(store && store.tema && store.tema.estilo === 'moderno');
  }

  function escapar(t) {
    return String(t == null ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function armarFondoDelEncabezado() {
    const header = document.querySelector('#storeView header');
    if (!header || header.querySelector('.bm-aurora')) return;
    const aurora = document.createElement('div');
    aurora.className = 'bm-aurora';
    aurora.setAttribute('aria-hidden', 'true');
    aurora.innerHTML = '<span></span><span></span><span></span>';
    const grilla = document.createElement('div');
    grilla.className = 'bm-grilla';
    grilla.setAttribute('aria-hidden', 'true');
    const haz = document.createElement('div');
    haz.className = 'bm-haz';
    haz.setAttribute('aria-hidden', 'true');
    header.prepend(grilla);
    header.prepend(aurora);
    header.appendChild(haz);
  }

  // Solo cosas que la tienda de verdad ofrece: todo sale de su perfil.
  function itemsDeLaCinta(store) {
    const items = [];
    if (store.phone) items.push(['fa-brands fa-whatsapp', 'Pedí por WhatsApp']);
    if (store.ofrece_envio !== false) items.push(['fa-solid fa-truck-fast', 'Envíos a domicilio']);
    else items.push(['fa-solid fa-store', 'Retiro en el local']);

    const medios = Array.isArray(store.medios_pago) ? store.medios_pago : [];
    if (medios.includes('Mercado Pago')) items.push(['fa-solid fa-wallet', 'Pagá con Mercado Pago']);
    if (medios.includes('Crédito') || medios.includes('Débito')) items.push(['fa-solid fa-credit-card', 'Tarjetas de crédito y débito']);
    if (medios.includes('Transferencia')) items.push(['fa-solid fa-building-columns', 'Transferencia']);
    if (medios.includes('Efectivo')) items.push(['fa-solid fa-money-bill-wave', 'Efectivo']);

    // Igual que en la ficha: menos de 20 ventas no es una reputación.
    const r = store.ml_reputacion;
    if (r && Number(r.ventas) >= 20 && r.positivas != null) {
      items.push(['fa-solid fa-circle-check',
        Number(r.ventas).toLocaleString('es-AR') + ' ventas en Mercado Libre · ' +
        Math.round(Number(r.positivas) * 100) + '% positivas']);
    }
    if (store.location) items.push(['fa-solid fa-location-dot', store.location]);
    if (store.instagram) items.push(['fa-brands fa-instagram', '@' + String(store.instagram).replace('@', '')]);
    return items;
  }

  function armarCinta(store) {
    const header = document.querySelector('#storeView header');
    if (!header || document.querySelector('.bm-cinta')) return;
    const items = itemsDeLaCinta(store);
    if (items.length < 2) return;
    // Se repite hasta llenar bien el ancho y después se duplica entero:
    // la animación corre la mitad exacta y vuelve sin salto.
    let lista = items.slice();
    while (lista.length < 8) lista = lista.concat(items);
    const grupo = '<div class="bm-cinta-grupo">' + lista.map(([icono, texto]) =>
      '<span class="bm-cinta-item"><i class="' + icono + '"></i>' + escapar(texto) + '</span>').join('') + '</div>';
    const cinta = document.createElement('div');
    cinta.className = 'bm-cinta';
    cinta.setAttribute('role', 'note');
    cinta.setAttribute('aria-label', items.map((i) => i[1]).join(', '));
    cinta.innerHTML = '<div class="bm-cinta-pista" aria-hidden="true">' + grupo + grupo + '</div>';
    header.insertAdjacentElement('afterend', cinta);
  }

  // Entrada escalonada: cada tarjeta entra una sola vez.
  function animarEntradas() {
    const lista = document.getElementById('productsList');
    if (!lista || !('MutationObserver' in window)) return;
    const vistas = new Set();
    const clave = (el) => el.dataset.id ||
      ('cat:' + ((el.querySelector('.cat-nombre') || el).textContent || '').trim());

    let pendiente = false;
    const revisar = () => {
      pendiente = false;
      let i = 0;
      lista.querySelectorAll('.product-card, .cat-card').forEach((el) => {
        const k = clave(el);
        if (vistas.has(k)) return;
        vistas.add(k);
        // Solo escalonan las que se ven ahora: las de más abajo entran
        // sin demora, porque cuando el cliente llegue ya habrán terminado.
        const arriba = el.getBoundingClientRect().top < window.innerHeight;
        el.style.setProperty('--bm-i', arriba ? Math.min(i++, 10) : 0);
        el.classList.add('bm-entrar');
        el.addEventListener('animationend', () => el.classList.remove('bm-entrar'), { once: true });
      });
    };
    revisar();
    new MutationObserver(() => {
      if (pendiente) return;
      pendiente = true;
      // Antes de pintar: la tarjeta nueva nunca llega a verse sin la clase.
      Promise.resolve().then(revisar);
    }).observe(lista, { childList: true, subtree: true });
  }

  // Spotlight: un solo listener para toda la grilla (las tarjetas se
  // recrean todo el tiempo y engancharlas una por una sería perderlas).
  function seguirAlMouse() {
    if (!window.matchMedia || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    const lista = document.getElementById('productsList');
    if (!lista) return;
    lista.addEventListener('pointermove', (ev) => {
      const card = ev.target.closest && ev.target.closest('.product-card');
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty('--bm-x', (ev.clientX - r.left) + 'px');
      card.style.setProperty('--bm-y', (ev.clientY - r.top) + 'px');
    }, { passive: true });
  }

  // El total da un saltito cuando cambia.
  function saltoDelTotal() {
    const total = document.getElementById('cartTotal');
    if (!total || !('MutationObserver' in window)) return;
    let anterior = total.textContent;
    new MutationObserver(() => {
      if (total.textContent === anterior) return;
      anterior = total.textContent;
      total.classList.remove('bm-salto');
      void total.offsetWidth; // reinicia la animación
      total.classList.add('bm-salto');
    }).observe(total, { childList: true, characterData: true, subtree: true });
    total.style.display = 'inline-block';
  }

  let activo = false;
  function activar(store) {
    if (activo || !elegido(store)) return false;
    activo = true;
    document.documentElement.classList.add('estilo-moderno');
    armarFondoDelEncabezado();
    armarCinta(store || {});
    animarEntradas();
    seguirAlMouse();
    saltoDelTotal();
    // El encabezado entra recién cuando la tienda se muestra (antes está
    // oculto y la animación se perdería).
    const vista = document.getElementById('storeView');
    const listo = () => document.documentElement.classList.add('bm-listo');
    if (vista && vista.classList.contains('hidden') && 'MutationObserver' in window) {
      const obs = new MutationObserver(() => {
        if (!vista.classList.contains('hidden')) { obs.disconnect(); listo(); }
      });
      obs.observe(vista, { attributes: true, attributeFilter: ['class'] });
    } else {
      listo();
    }
    return true;
  }

  window.BruwalModerno = { activar };
})();
