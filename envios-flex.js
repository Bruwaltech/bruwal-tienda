// Envíos Flex: el módulo para armar y evaluar una mensajería de Mercado
// Envíos Flex en el corredor Rosario – San Lorenzo.
//
// QUIÉN LO VE:
// solo las tiendas con store_profiles.features.envios_flex = true (por
// ahora, Novalis). Lo pone el administrador con schema/76-envios-flex.sql;
// el navegador no puede prenderlo. Las tablas flex_* tienen RLS que exige
// el mismo flag, así que esconder la pestaña no es la única barrera.
//
// CÓMO SE CARGA:
// el panel pide este archivo recién cuando se abre la pestaña, igual que
// demo.js. Para las demás tiendas no existe.
//
// SECCIONES:
//   Números     -> simulador con los supuestos editables y resultados en vivo
//   Corredor    -> las 4 zonas, de sur a norte, con oferta y demanda
//   Vendedores  -> CRM simple de los clientes de la mensajería
//   Repartidores-> la red de repartidores independientes
//   Liquidación -> semana por semana: qué pagar y qué cobrar
//   Referencias -> de dónde salen los números
// Y, si la tienda tiene Mercado Libre conectado, sus envíos Flex reales.
//
// Mismo criterio que planes.js y demo.js: un archivo propio, sin saber nada
// del panel más allá de lo que recibe en montar().

(function (global) {
  'use strict';

  // ---- Zonas, de sur a norte ----
  var ZONAS = [
    { id: 'rosario',     nombre: 'Rosario' },
    { id: 'baigorria',   nombre: 'Granadero Baigorria' },
    { id: 'bermudez',    nombre: 'Capitán Bermúdez' },
    { id: 'san_lorenzo', nombre: 'San Lorenzo' }
  ];
  var NOMBRE_ZONA = { otra: 'Otra' };
  ZONAS.forEach(function (z) { NOMBRE_ZONA[z.id] = z.nombre; });

  var ESTADOS_VENDEDOR = [
    { id: 'prospecto',  nombre: 'Prospecto' },
    { id: 'contactado', nombre: 'Contactado' },
    { id: 'activo',     nombre: 'Activo' },
    { id: 'descartado', nombre: 'Descartado' }
  ];
  var ESTADOS_REPARTIDOR = [
    { id: 'candidato', nombre: 'Candidato' },
    { id: 'activo',    nombre: 'Activo' },
    { id: 'pausado',   nombre: 'Pausado' }
  ];
  var VEHICULOS = [
    { id: 'moto', nombre: 'Moto' }, { id: 'auto', nombre: 'Auto' }, { id: 'utilitario', nombre: 'Utilitario' }
  ];
  var MONOTRIBUTO = [
    { id: 'si', nombre: 'Sí' }, { id: 'tramite', nombre: 'En trámite' }, { id: 'no', nombre: 'No' }
  ];

  // ---- Supuestos del simulador ----
  // Los porcentajes se guardan enteros (30 = 30%), como se tipean.
  var PARAMS = [
    { k: 'bonif_bajo',         def: 4990,  t: 'Bonificación ML, producto < $33.000', u: '$' },
    { k: 'bonif_alto',         def: 499,   t: 'Bonificación ML, producto ≥ $33.000', u: '$' },
    { k: 'pct_alto',           def: 30,    t: '% de paquetes de productos ≥ $33.000', u: '%' },
    { k: 'precio_vendedor',    def: 4500,  t: 'Precio que cobramos al vendedor por paquete', u: '$' },
    { k: 'pago_rep',           def: 3000,  t: 'Pago al repartidor por paquete', u: '$' },
    { k: 'pct_cruzado',        def: 20,    t: '% de envíos cruzados', u: '%' },
    { k: 'recargo_cruzado',    def: 2000,  t: 'Recargo al vendedor por cruzado', u: '$' },
    { k: 'extra_cruzado',      def: 1500,  t: 'Extra al repartidor por cruzado', u: '$' },
    { k: 'repartidores',       def: 4,     t: 'Repartidores activos', u: '' },
    { k: 'entregas_por_rep',   def: 25,    t: 'Entregas por repartidor por día', u: '' },
    { k: 'dias_semana',        def: 5,     t: 'Días hábiles por semana', u: '' },
    { k: 'gasto_vehiculo_pct', def: 50,    t: 'Gasto de vehículo del repartidor (% de lo que cobra)', u: '%' },
    { k: 'ref_camionero',      def: 44830, t: 'Referencia diaria camionero 1.ª cat.', u: '$' },
    { k: 'semanas_desfase',    def: 2,     t: 'Semanas de desfase de caja', u: '' },
    { k: 'gastos_fijos_mes',   def: 0,     t: 'Gastos fijos mensuales', u: '$' }
  ];
  var SEMANAS_POR_MES = 4.33;

  var SECCIONES = [
    { id: 'numeros',      nombre: '📊 Números' },
    { id: 'corredor',     nombre: '🛣️ Corredor' },
    { id: 'vendedores',   nombre: '🏪 Vendedores' },
    { id: 'repartidores', nombre: '🛵 Repartidores' },
    { id: 'liquidacion',  nombre: '💸 Liquidación' },
    { id: 'referencias',  nombre: '📚 Referencias' }
  ];

  // ---- Estado ----
  var ctx = null;          // lo que pasa el panel
  var raiz = null;
  var params = {};
  var vendedores = [];
  var repartidores = [];
  var liquidaciones = [];  // de la semana que se está mirando
  var semana = null;       // Date del lunes
  var seccion = 'numeros';
  var enviosMl = null;     // respuesta de flex_envios
  var guardarParamsTimer = null;

  // ---- Utilidades ----
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function plata(n) {
    var v = Math.round(num(n));
    return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('es-AR');
  }
  function entero(n) { return Math.round(num(n)).toLocaleString('es-AR'); }
  function nombreDe(lista, id) {
    var x = lista.find(function (e) { return e.id === id; });
    return x ? x.nombre : (id || '');
  }
  function opciones(lista, elegido) {
    return lista.map(function (o) {
      return '<option value="' + esc(o.id) + '"' + (o.id === elegido ? ' selected' : '') + '>' + esc(o.nombre) + '</option>';
    }).join('');
  }
  function aviso(t) { (ctx.aviso || global.alert)(t); }

  // La semana va de lunes a domingo, en la hora del negocio. Se arma con la
  // fecha local (no con toISOString) para que un lunes a las 22 h no caiga
  // en martes UTC.
  function lunesDe(d) {
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var dia = x.getDay() || 7;
    x.setDate(x.getDate() - (dia - 1));
    return x;
  }
  function isoLocal(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function textoSemana(lunes) {
    var dom = new Date(lunes); dom.setDate(dom.getDate() + 6);
    var f = function (d) { return d.getDate() + '/' + (d.getMonth() + 1); };
    return 'Semana del ' + f(lunes) + ' al ' + f(dom) + '/' + dom.getFullYear();
  }

  // ---- Cálculos (sección 4 del brief) ----
  function p(k) {
    return params[k] == null || params[k] === '' ? PARAMS.find(function (x) { return x.k === k; }).def : num(params[k]);
  }

  function calcular() {
    var pctCruz = p('pct_cruzado') / 100;
    var pctAlto = p('pct_alto') / 100;
    var dias = p('dias_semana');
    var r = {};
    r.paquetes_dia = p('repartidores') * p('entregas_por_rep');
    r.ingreso_x_paquete = p('precio_vendedor') + pctCruz * p('recargo_cruzado');
    r.costo_x_paquete = p('pago_rep') + pctCruz * p('extra_cruzado');
    r.margen_x_paquete = r.ingreso_x_paquete - r.costo_x_paquete;
    r.margen_dia = r.margen_x_paquete * r.paquetes_dia;
    r.margen_semana = r.margen_dia * dias;
    r.margen_mes = r.margen_semana * SEMANAS_POR_MES - p('gastos_fijos_mes');
    r.rep_bruto_dia = p('entregas_por_rep') * (p('pago_rep') + pctCruz * p('extra_cruzado'));
    r.rep_neto_dia = r.rep_bruto_dia * (1 - p('gasto_vehiculo_pct') / 100);
    r.caja_a_adelantar = r.costo_x_paquete * r.paquetes_dia * dias * p('semanas_desfase');
    r.equilibrio_paq_dia = p('gastos_fijos_mes') > 0 && r.margen_x_paquete > 0 && dias > 0
      ? p('gastos_fijos_mes') / (r.margen_x_paquete * dias * SEMANAS_POR_MES)
      : null;
    r.saldo_vendedor_bajo = p('bonif_bajo') - p('precio_vendedor');
    r.saldo_vendedor_alto = p('bonif_alto') - p('precio_vendedor');
    r.saldo_vendedor_prom = (1 - pctAlto) * r.saldo_vendedor_bajo + pctAlto * r.saldo_vendedor_alto;
    return r;
  }

  // ---- Estilos propios (prefijo fx-) ----
  function ponerEstilos() {
    if (document.getElementById('fxEstilos')) return;
    var s = document.createElement('style');
    s.id = 'fxEstilos';
    s.textContent = [
      '.fx-secciones{display:flex;gap:6px;overflow-x:auto;padding-bottom:6px;margin-bottom:16px;scrollbar-width:none}',
      '.fx-secciones::-webkit-scrollbar{display:none}',
      '.fx-chip{flex:0 0 auto;border:1px solid var(--line);background:var(--surface);color:var(--text-dark);border-radius:999px;padding:7px 13px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}',
      '.fx-chip.activo{background:var(--navy);border-color:var(--navy);color:#fff}',
      '.fx-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:18px}',
      '.fx-kpi{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px 14px}',
      '.fx-kpi .l{font-size:12px;color:var(--text-mute);margin-bottom:4px}',
      '.fx-kpi .v{font-size:20px;font-weight:700;color:var(--navy)}',
      '.fx-kpi .s{font-size:11.5px;color:var(--text-mute);margin-top:3px}',
      '.fx-pos{color:var(--stock)!important}.fx-neg{color:var(--danger)!important}',
      '.fx-panel{background:var(--surface);border:1px solid var(--line);border-radius:14px;margin-bottom:18px;overflow:hidden}',
      '.fx-head{padding:12px 14px;border-bottom:1px solid var(--line);font-weight:700;font-size:14px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}',
      '.fx-body{padding:12px 14px}',
      '.fx-nota{font-size:12.5px;line-height:1.5;color:var(--text-mute)}',
      '.fx-params{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px 16px}',
      '.fx-param{display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--text-mute)}',
      '.fx-param .in{display:flex;align-items:center;border:1px solid var(--line);border-radius:8px;background:#fff;overflow:hidden}',
      '.fx-param .in span{padding:0 9px;color:var(--text-mute);font-size:13px}',
      '.fx-param input{border:0;padding:8px 9px;font-size:15px;width:100%;font-family:inherit;color:var(--text-dark);background:transparent;min-width:0}',
      '.fx-bar{display:flex;height:26px;border-radius:7px;overflow:hidden;margin:6px 0 4px;background:var(--bg)}',
      '.fx-bar div{display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;white-space:nowrap;overflow:hidden;min-width:0}',
      '.fx-leyenda{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--text-mute);margin-top:8px}',
      '.fx-leyenda i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}',
      '.fx-c-rep{background:#2F8FE0}.fx-c-nos{background:#15294D}.fx-c-ven{background:#1FA088}.fx-c-bol{background:#D97706}',
      '.fx-corredor{position:relative;padding-left:22px}',
      '.fx-corredor:before{content:"";position:absolute;left:7px;top:10px;bottom:10px;width:3px;background:var(--line);border-radius:2px}',
      '.fx-zona{position:relative;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:10px}',
      '.fx-zona:before{content:"";position:absolute;left:-20px;top:16px;width:11px;height:11px;border-radius:50%;background:var(--celeste);border:2px solid #fff;box-shadow:0 0 0 1px var(--line)}',
      '.fx-zona.alerta{border-color:#F5B971;background:#FFF8EE}.fx-zona.alerta:before{background:var(--warn)}',
      '.fx-zona h4{font-size:15px;margin-bottom:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.fx-zona .datos{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:4px 12px;font-size:13px;color:var(--text-mute)}',
      '.fx-zona .datos b{color:var(--text-dark)}',
      '.fx-badge{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;background:var(--bg);color:var(--text-mute)}',
      '.fx-badge.warn{background:#FDE9CF;color:#9A4D00}.fx-badge.ok{background:#DDF3EE;color:#10614F}.fx-badge.mal{background:#FDE2E2;color:#9B1C1C}',
      '.fx-lista{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px}',
      '.fx-card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px 14px;cursor:pointer;font-size:13px;color:var(--text-mute);line-height:1.5}',
      '.fx-card:hover{border-color:var(--celeste)}',
      '.fx-card .t{font-size:15px;font-weight:700;color:var(--text-dark);display:flex;justify-content:space-between;gap:8px;margin-bottom:2px}',
      '.fx-btn{border:none;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;background:var(--navy);color:#fff;font-family:inherit}',
      '.fx-btn.sec{background:var(--bg);color:var(--navy);border:1px solid var(--line)}',
      '.fx-btn.peligro{background:#FDE2E2;color:var(--danger)}',
      '.fx-filtros{display:flex;gap:6px;flex-wrap:wrap}',
      '.fx-tabla{width:100%;border-collapse:collapse;font-size:13px}',
      '.fx-tabla th{text-align:left;font-size:11.5px;color:var(--text-mute);font-weight:600;padding:8px 8px;border-bottom:1px solid var(--line);white-space:nowrap}',
      '.fx-tabla td{padding:8px;border-bottom:1px solid var(--line);vertical-align:middle}',
      '.fx-tabla tr:last-child td{border-bottom:0}',
      '.fx-tabla input[type=number]{width:64px;padding:6px;border:1px solid var(--line);border-radius:7px;font-size:14px;font-family:inherit}',
      '.fx-tabla input[type=checkbox]{width:20px;height:20px;accent-color:var(--stock)}',
      '.fx-scroll{overflow-x:auto}',
      '.fx-der{text-align:right!important}',
      '.fx-semana{display:flex;align-items:center;gap:8px;justify-content:center;margin-bottom:14px;font-weight:700}',
      '.fx-alerta{background:#FFF8EE;border:1px solid #F5B971;color:#9A4D00;border-radius:10px;padding:10px 12px;font-size:13px;margin-bottom:14px}',
      '.fx-modal{position:fixed;inset:0;background:rgba(21,41,77,.45);display:flex;align-items:flex-end;justify-content:center;z-index:9000}',
      '@media(min-width:701px){.fx-modal{align-items:center}}',
      '.fx-modal-caja{background:#fff;width:100%;max-width:520px;max-height:92vh;overflow:auto;border-radius:16px 16px 0 0;padding:18px}',
      '@media(min-width:701px){.fx-modal-caja{border-radius:16px}}',
      '.fx-form{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}',
      '.fx-form label{display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--text-mute)}',
      '.fx-form label.ancho{grid-column:1/-1}',
      '.fx-form input,.fx-form select,.fx-form textarea{padding:9px;border:1px solid var(--line);border-radius:8px;font-size:15px;font-family:inherit;color:var(--text-dark);background:#fff;width:100%;min-width:0}',
      '.fx-form label.check{flex-direction:row;align-items:center;gap:8px}',
      '.fx-form label.check input{width:20px;height:20px;flex:0 0 auto}',
      '.fx-acciones{display:flex;gap:8px;justify-content:space-between;margin-top:16px;flex-wrap:wrap}',
      '.fx-ref li{margin:0 0 10px 18px;font-size:13px;line-height:1.5}',
      '.fx-ref a{color:var(--celeste)}'
    ].join('\n');
    document.head.appendChild(s);
  }

  // ---- Datos ----
  async function cargarTodo() {
    var slug = ctx.store.slug;
    var r = await Promise.all([
      ctx.sb.from('flex_params').select('params').eq('store_slug', slug).maybeSingle(),
      ctx.sb.from('flex_vendedores').select('*').eq('store_slug', slug).order('created_at', { ascending: true }),
      ctx.sb.from('flex_repartidores').select('*').eq('store_slug', slug).order('created_at', { ascending: true })
    ]);
    var err = r.find(function (x) { return x.error; });
    if (err) throw err.error;
    params = (r[0].data && r[0].data.params) || {};
    vendedores = r[1].data || [];
    repartidores = r[2].data || [];
    await cargarSemana();
  }

  async function cargarSemana() {
    var res = await ctx.sb.from('flex_liquidaciones').select('*')
      .eq('store_slug', ctx.store.slug).eq('semana_inicio', isoLocal(semana));
    if (res.error) throw res.error;
    liquidaciones = res.data || [];
  }

  function guardarParamsLuego() {
    clearTimeout(guardarParamsTimer);
    guardarParamsTimer = setTimeout(async function () {
      var res = await ctx.sb.from('flex_params').upsert({
        store_slug: ctx.store.slug, params: params, updated_at: new Date().toISOString()
      }, { onConflict: 'store_slug' });
      var estado = raiz.querySelector('#fxParamsEstado');
      if (estado) estado.textContent = res.error ? 'No se pudo guardar' : 'Guardado ✓';
    }, 700);
  }

  // ---- Render general ----
  function render() {
    var html = '<h2 style="font-size:20px;margin-bottom:12px;">🚚 Envíos Flex</h2>' +
      '<div class="fx-secciones">' + SECCIONES.map(function (s) {
        return '<button type="button" class="fx-chip' + (s.id === seccion ? ' activo' : '') + '" data-fx-sec="' + s.id + '">' + s.nombre + '</button>';
      }).join('') + '</div><div id="fxContenido"></div>';
    raiz.innerHTML = html;
    raiz.querySelectorAll('[data-fx-sec]').forEach(function (b) {
      b.addEventListener('click', function () { seccion = b.dataset.fxSec; render(); });
    });
    var c = raiz.querySelector('#fxContenido');
    ({ numeros: renderNumeros, corredor: renderCorredor, vendedores: renderVendedores,
       repartidores: renderRepartidores, liquidacion: renderLiquidacion, referencias: renderReferencias })[seccion](c);
  }

  // ---- 1. Números ----
  function kpi(label, valor, sub, clase) {
    return '<div class="fx-kpi"><div class="l">' + label + '</div><div class="v ' + (clase || '') + '">' + valor + '</div>' +
      (sub ? '<div class="s">' + sub + '</div>' : '') + '</div>';
  }

  function barraEnvio(titulo, bonif) {
    var precio = p('precio_vendedor'), rep = p('pago_rep');
    var nos = precio - rep;
    var saldo = bonif - precio;
    var total = Math.max(bonif, precio, 1);
    var seg = function (v, cls, txt) {
      return v > 0 ? '<div class="' + cls + '" style="width:' + (v / total * 100) + '%" title="' + esc(txt) + '">' + (v / total > 0.14 ? plata(v) : '') + '</div>' : '';
    };
    var pie = saldo >= 0
      ? 'ML le paga ' + plata(bonif) + ' al vendedor; a él le quedan <b class="fx-pos">' + plata(saldo) + '</b> a favor.'
      : 'ML le paga ' + plata(bonif) + '; el vendedor pone <b class="fx-neg">' + plata(-saldo) + '</b> de su bolsillo (lo compensa el "Llega hoy").';
    return '<div style="margin-bottom:12px;"><div style="font-size:13px;font-weight:600;">' + titulo + '</div>' +
      '<div class="fx-bar">' + seg(rep, 'fx-c-rep', 'Repartidor') + seg(nos, 'fx-c-nos', 'Nosotros') +
      (saldo >= 0 ? seg(saldo, 'fx-c-ven', 'Le queda al vendedor') : '') + '</div>' +
      (saldo < 0 ? '<div class="fx-bar" style="height:8px;margin-top:0;"><div class="fx-c-ven" style="width:' + (bonif / total * 100) + '%"></div><div class="fx-c-bol" style="width:' + (-saldo / total * 100) + '%"></div></div>' : '') +
      '<div class="fx-nota">' + pie + '</div></div>';
  }

  function htmlResultados() {
    var r = calcular();
    var difRep = r.rep_neto_dia - p('ref_camionero');
    var html = '';

    html += '<div class="fx-grid">' +
      kpi('Margen por paquete', plata(r.margen_x_paquete), 'cobro ' + plata(r.ingreso_x_paquete) + ' − pago ' + plata(r.costo_x_paquete), r.margen_x_paquete < 0 ? 'fx-neg' : '') +
      kpi('Paquetes por día', entero(r.paquetes_dia), p('repartidores') + ' rep. × ' + p('entregas_por_rep')) +
      kpi('Margen por día', plata(r.margen_dia)) +
      kpi('Margen por semana', plata(r.margen_semana), p('dias_semana') + ' días hábiles') +
      kpi('Margen por mes', plata(r.margen_mes), p('gastos_fijos_mes') ? 'ya restados ' + plata(p('gastos_fijos_mes')) + ' fijos' : '× 4,33 semanas', r.margen_mes < 0 ? 'fx-neg' : 'fx-pos') +
      kpi('Caja a adelantar', plata(r.caja_a_adelantar), p('semanas_desfase') + ' semana(s) pagando antes de cobrar', 'fx-neg') +
      kpi('Punto de equilibrio',
        r.equilibrio_paq_dia == null ? '—' : entero(Math.ceil(r.equilibrio_paq_dia)) + ' paq/día',
        p('gastos_fijos_mes') ? 'para cubrir los gastos fijos' : 'cargá los gastos fijos') +
      '</div>';

    html += '<div class="fx-panel"><div class="fx-head">🛵 El repartidor</div><div class="fx-body"><div class="fx-grid" style="margin-bottom:6px;">' +
      kpi('Cobra por día (bruto)', plata(r.rep_bruto_dia)) +
      kpi('Le queda (neto)', plata(r.rep_neto_dia), 'descontando ' + p('gasto_vehiculo_pct') + '% de vehículo', difRep >= 0 ? 'fx-pos' : 'fx-neg') +
      kpi('Camionero 1.ª cat.', plata(p('ref_camionero')), 'básico diario de referencia') +
      '</div><div class="fx-nota">' + (difRep >= 0
        ? 'Le queda <b class="fx-pos">' + plata(difRep) + '</b> por día más que el básico de un camionero.'
        : 'Le queda <b class="fx-neg">' + plata(-difRep) + '</b> por día menos que el básico de un camionero: difícil sostener repartidores así.') +
      '</div></div></div>';

    html += '<div class="fx-panel"><div class="fx-head">🏪 El vendedor</div><div class="fx-body"><div class="fx-grid" style="margin-bottom:6px;">' +
      kpi('Producto < $33.000', plata(r.saldo_vendedor_bajo), 'bonificación − nuestro precio', r.saldo_vendedor_bajo >= 0 ? 'fx-pos' : 'fx-neg') +
      kpi('Producto ≥ $33.000', plata(r.saldo_vendedor_alto), 'bonificación − nuestro precio', r.saldo_vendedor_alto >= 0 ? 'fx-pos' : 'fx-neg') +
      kpi('Promedio por paquete', plata(r.saldo_vendedor_prom), 'con ' + p('pct_alto') + '% de productos ≥ $33.000', r.saldo_vendedor_prom >= 0 ? 'fx-pos' : 'fx-neg') +
      '</div></div></div>';

    html += '<div class="fx-panel"><div class="fx-head">💰 En qué se va cada envío <span class="fx-nota" style="font-weight:400;">envío común, sin cruzado</span></div><div class="fx-body">' +
      barraEnvio('Producto de menos de $33.000 (paga el comprador)', p('bonif_bajo')) +
      barraEnvio('Producto de $33.000 o más (envío gratis)', p('bonif_alto')) +
      '<div class="fx-leyenda"><span><i class="fx-c-rep"></i>Repartidor</span><span><i class="fx-c-nos"></i>Nosotros</span>' +
      '<span><i class="fx-c-ven"></i>Vendedor / lo que pone ML</span><span><i class="fx-c-bol"></i>Lo pone el vendedor</span></div>' +
      '</div></div>';

    return html;
  }

  function renderNumeros(c) {
    var html = '<div id="fxResultados">' + htmlResultados() + '</div>';

    html += '<div class="fx-panel"><div class="fx-head">⚙️ Supuestos <span class="fx-nota" id="fxParamsEstado" style="font-weight:400;"></span></div><div class="fx-body">' +
      '<div class="fx-params">' + PARAMS.map(function (x) {
        var v = params[x.k] == null || params[x.k] === '' ? x.def : params[x.k];
        return '<label class="fx-param">' + esc(x.t) + '<div class="in">' + (x.u === '$' ? '<span>$</span>' : '') +
          '<input type="number" inputmode="decimal" step="any" min="0" data-fx-param="' + x.k + '" value="' + esc(v) + '">' +
          (x.u === '%' ? '<span>%</span>' : '') + '</div></label>';
      }).join('') + '</div>' +
      '<div style="margin-top:12px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">' +
      '<span class="fx-nota">Se guardan solos. Los valores de ML son de la página oficial al 21/10/2026: verificalos en tu cuenta.</span>' +
      '<button type="button" class="fx-btn sec" id="fxParamsReset">Volver a los valores por defecto</button></div>' +
      '</div></div>';

    html += '<div class="fx-panel"><div class="fx-head">📦 Envíos Flex reales de ' + esc(ctx.store.business_name || 'la tienda') +
      ' <button type="button" class="fx-btn sec" id="fxTraerMl">Traer de Mercado Libre</button></div>' +
      '<div class="fx-body" id="fxMl">' + htmlEnviosMl() + '</div></div>';

    c.innerHTML = html;

    c.querySelectorAll('[data-fx-param]').forEach(function (inp) {
      inp.addEventListener('input', function () {
        params[inp.dataset.fxParam] = inp.value === '' ? null : num(inp.value);
        var estado = raiz.querySelector('#fxParamsEstado');
        if (estado) estado.textContent = 'Guardando…';
        guardarParamsLuego();
        // Solo los resultados: re-pintar los inputs le cierra el teclado
        // al celular en cada número que tipea.
        c.querySelector('#fxResultados').innerHTML = htmlResultados();
      });
    });
    c.querySelector('#fxParamsReset').addEventListener('click', async function () {
      if (!(await (ctx.confirmar || global.confirm)('¿Volver todos los supuestos a los valores por defecto?'))) return;
      params = {};
      guardarParamsLuego();
      renderNumeros(c);
    });
    c.querySelector('#fxTraerMl').addEventListener('click', traerEnviosMl);
  }

  function htmlEnviosMl() {
    if (!enviosMl) {
      return '<div class="fx-nota">Trae los envíos Flex de los últimos 14 días desde la cuenta de Mercado Libre conectada ' +
        '(los reconoce porque ML los marca con el tipo de logística <code>self_service</code>).</div>';
    }
    if (enviosMl.cargando) return '<div class="fx-nota">Consultando Mercado Libre…</div>';
    if (enviosMl.error) return '<div class="fx-nota fx-neg">' + esc(enviosMl.error) + '</div>';
    if (enviosMl.conectado === false) return '<div class="fx-nota">Esta tienda no tiene Mercado Libre conectado. Conectalo desde la pestaña Mercado Libre.</div>';
    if (!enviosMl.ok) return '<div class="fx-nota fx-neg">' + esc(enviosMl.motivo || 'No se pudo leer.') + '</div>';

    var lista = enviosMl.envios || [];
    var hoy = isoLocal(new Date());
    var lunes = isoLocal(lunesDe(new Date()));
    var deHoy = 0, deSemana = 0, bonif = 0, conBonif = 0;
    lista.forEach(function (e) {
      var f = e.fecha_venta ? isoLocal(new Date(e.fecha_venta)) : '';
      if (f === hoy) deHoy++;
      if (f >= lunes) deSemana++;
      if (e.compensacion_vendedor) { bonif += e.compensacion_vendedor; conBonif++; }
    });

    var html = '<div class="fx-grid">' +
      kpi('Vendidos hoy', entero(deHoy)) +
      kpi('Esta semana', entero(deSemana), 'desde el lunes') +
      kpi('Últimos ' + enviosMl.dias + ' días', entero(lista.length), 'de ' + enviosMl.revisados + ' envíos revisados') +
      kpi('Bonificación según ML', conBonif ? plata(bonif) : '—', conBonif ? 'en ' + conBonif + ' envío(s)' : 'ML no la informa en el envío') +
      '</div>';
    if (enviosMl.recortado) html += '<div class="fx-nota" style="margin-bottom:8px;">Hay más envíos de los que se revisan de una vez: se muestran los más recientes.</div>';
    if (!lista.length) return html + '<div class="fx-nota">No hay envíos Flex en ese período.</div>';

    html += '<div class="fx-scroll"><table class="fx-tabla"><thead><tr><th>Venta</th><th>Destino</th><th>Estado</th>' +
      '<th class="fx-der">Paga comprador</th><th class="fx-der">Costo vendedor</th><th class="fx-der">Bonif.</th></tr></thead><tbody>' +
      lista.map(function (e) {
        var f = e.fecha_venta ? new Date(e.fecha_venta) : null;
        var cel = function (v) { return v == null ? '—' : plata(v); };
        return '<tr><td>' + (f ? f.getDate() + '/' + (f.getMonth() + 1) : '') +
          '<div class="fx-nota">' + esc((e.productos || []).join(', ').slice(0, 60)) + '</div></td>' +
          '<td>' + esc(e.ciudad || '—') + '</td>' +
          '<td>' + esc(e.estado || '') + (e.fecha_entrega ? '<div class="fx-nota">entregado ' + new Date(e.fecha_entrega).getDate() + '/' + (new Date(e.fecha_entrega).getMonth() + 1) + '</div>' : '') + '</td>' +
          '<td class="fx-der">' + cel(e.costo_comprador) + '</td>' +
          '<td class="fx-der">' + cel(e.costo_vendedor) + '</td>' +
          '<td class="fx-der">' + cel(e.compensacion_vendedor) + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<div class="fx-nota" style="margin-top:8px;">La bonificación de Flex se acredita en Mercado Pago a los 8 días de la entrega: contrastala con lo que figura ahí.</div>';
    return html;
  }

  async function traerEnviosMl() {
    var cont = raiz.querySelector('#fxMl');
    enviosMl = { cargando: true };
    if (cont) cont.innerHTML = htmlEnviosMl();
    try {
      enviosMl = await ctx.llamarApiMl('flex_envios');
    } catch (e) {
      enviosMl = { error: String(e.message || e) };
    }
    cont = raiz.querySelector('#fxMl');
    if (cont) cont.innerHTML = htmlEnviosMl();
  }

  // ---- 2. Corredor ----
  function renderCorredor(c) {
    var capPorRep = p('entregas_por_rep');
    var html = '<div class="fx-nota" style="margin-bottom:12px;">De sur a norte. Las colectas se cuentan por la localidad del vendedor; ' +
      'la capacidad, por los repartidores activos de cada zona (' + capPorRep + ' entregas por día cada uno).</div>' +
      '<div class="fx-corredor">';

    ZONAS.forEach(function (z) {
      var reps = repartidores.filter(function (r) { return r.zona === z.id; });
      var repAct = reps.filter(function (r) { return r.estado === 'activo'; }).length;
      var repCand = reps.filter(function (r) { return r.estado === 'candidato'; }).length;
      var vends = vendedores.filter(function (v) { return v.localidad === z.id; });
      var vAct = vends.filter(function (v) { return v.estado === 'activo'; });
      var vPros = vends.filter(function (v) { return v.estado === 'prospecto' || v.estado === 'contactado'; });
      var paq = vAct.reduce(function (s, v) { return s + num(v.paq_dia_est); }, 0);
      var paqPros = vPros.reduce(function (s, v) { return s + num(v.paq_dia_est); }, 0);
      var capacidad = repAct * capPorRep;
      var hayDemanda = vAct.length > 0 || vPros.length > 0;
      var sinRep = hayDemanda && repAct === 0;

      var badges = '';
      if (sinRep) badges += '<span class="fx-badge warn">Demanda sin repartidor</span>';
      else if (repAct && paq > capacidad) badges += '<span class="fx-badge mal">Sobre capacidad</span>';
      else if (repAct) badges += '<span class="fx-badge ok">Cubierta</span>';
      if (!hayDemanda) badges += '<span class="fx-badge">Sin vendedores</span>';

      html += '<div class="fx-zona' + (sinRep ? ' alerta' : '') + '"><h4>' + esc(z.nombre) + ' ' + badges + '</h4><div class="datos">' +
        '<span>Repartidores activos: <b>' + repAct + '</b>' + (repCand ? ' (+' + repCand + ' cand.)' : '') + '</span>' +
        '<span>Vendedores activos: <b>' + vAct.length + '</b></span>' +
        '<span>Prospectos: <b>' + vPros.length + '</b></span>' +
        '<span>Paquetes/día est.: <b>' + entero(paq) + '</b>' + (paqPros ? ' (+' + entero(paqPros) + ' prosp.)' : '') + '</span>' +
        '<span>Capacidad/día: <b>' + entero(capacidad) + '</b></span>' +
        '</div></div>';
    });
    html += '</div>';

    var otras = vendedores.filter(function (v) { return v.localidad === 'otra' && v.estado !== 'descartado'; }).length;
    if (otras) html += '<div class="fx-nota">Además hay ' + otras + ' vendedor(es) fuera del corredor.</div>';
    html += '<div class="fx-nota" style="margin-top:8px;">Recordatorio: no activar repartidores hasta que haya paquetes en su zona.</div>';
    c.innerHTML = html;
  }

  // ---- Formularios ----
  function abrirModal(titulo, cuerpo, onGuardar, onBorrar) {
    var m = document.createElement('div');
    m.className = 'fx-modal';
    m.innerHTML = '<div class="fx-modal-caja"><h3 style="font-size:17px;margin-bottom:12px;">' + esc(titulo) + '</h3>' +
      '<form class="fx-form">' + cuerpo + '</form><div class="fx-acciones">' +
      '<div>' + (onBorrar ? '<button type="button" class="fx-btn peligro" data-fx="borrar">Borrar</button>' : '') + '</div>' +
      '<div style="display:flex;gap:8px;"><button type="button" class="fx-btn sec" data-fx="cancelar">Cancelar</button>' +
      '<button type="button" class="fx-btn" data-fx="guardar">Guardar</button></div></div></div>';
    document.body.appendChild(m);
    var cerrar = function () { m.remove(); };
    m.addEventListener('click', function (e) { if (e.target === m) cerrar(); });
    m.querySelector('[data-fx="cancelar"]').addEventListener('click', cerrar);
    var form = m.querySelector('form');
    m.querySelector('[data-fx="guardar"]').addEventListener('click', async function (e) {
      e.target.disabled = true;
      var ok = await onGuardar(form);
      e.target.disabled = false;
      if (ok) cerrar();
    });
    if (onBorrar) {
      m.querySelector('[data-fx="borrar"]').addEventListener('click', async function () {
        if (await onBorrar()) cerrar();
      });
    }
    var primero = form.querySelector('input');
    if (primero && global.innerWidth > 700) primero.focus();
  }

  function valor(form, nombre) {
    var el = form.elements[nombre];
    if (!el) return null;
    if (el.type === 'checkbox') return el.checked;
    return el.value.trim();
  }
  function numONull(v) { return v === '' || v == null ? null : num(v); }

  // ---- 3. Vendedores ----
  var filtroVendedores = 'todos';

  function renderVendedores(c) {
    var lista = vendedores.filter(function (v) { return filtroVendedores === 'todos' || v.estado === filtroVendedores; });
    var html = '<div class="fx-head" style="padding:0 0 12px;border:0;"><div class="fx-filtros">' +
      [{ id: 'todos', nombre: 'Todos' }].concat(ESTADOS_VENDEDOR).map(function (e) {
        var n = e.id === 'todos' ? vendedores.length : vendedores.filter(function (v) { return v.estado === e.id; }).length;
        return '<button type="button" class="fx-chip' + (filtroVendedores === e.id ? ' activo' : '') + '" data-fx-filtro="' + e.id + '">' + e.nombre + ' (' + n + ')</button>';
      }).join('') + '</div><button type="button" class="fx-btn" id="fxNuevoVendedor">+ Nuevo vendedor</button></div>';

    if (!lista.length) html += '<div class="fx-nota">No hay vendedores en esta lista.</div>';
    html += '<div class="fx-lista">' + lista.map(function (v) {
      var badge = { activo: 'ok', descartado: 'mal', contactado: 'warn' }[v.estado] || '';
      return '<div class="fx-card" data-fx-vendedor="' + v.id + '"><div class="t"><span>' + esc(v.nombre) + '</span>' +
        '<span class="fx-badge ' + badge + '">' + esc(nombreDe(ESTADOS_VENDEDOR, v.estado)) + '</span></div>' +
        esc(NOMBRE_ZONA[v.localidad] || v.localidad) + (v.rubro ? ' · ' + esc(v.rubro) : '') + '<br>' +
        (v.usa_flex ? 'Ya usa Flex' : 'Sin Flex') + ' · ' + entero(v.paq_dia_est) + ' paq/día · ' +
        (v.precio_acordado != null ? plata(v.precio_acordado) : 'precio general') +
        (v.contacto ? '<br>📞 ' + esc(v.contacto) : '') +
        (v.notas ? '<br><i>' + esc(v.notas.slice(0, 120)) + '</i>' : '') + '</div>';
    }).join('') + '</div>';
    c.innerHTML = html;

    c.querySelectorAll('[data-fx-filtro]').forEach(function (b) {
      b.addEventListener('click', function () { filtroVendedores = b.dataset.fxFiltro; renderVendedores(c); });
    });
    c.querySelector('#fxNuevoVendedor').addEventListener('click', function () { editarVendedor(null); });
    c.querySelectorAll('[data-fx-vendedor]').forEach(function (el) {
      el.addEventListener('click', function () {
        editarVendedor(vendedores.find(function (v) { return v.id === el.dataset.fxVendedor; }));
      });
    });
  }

  function editarVendedor(v) {
    var x = v || { localidad: 'rosario', estado: 'prospecto', usa_flex: false, paq_dia_est: 0 };
    var cuerpo =
      '<label class="ancho">Nombre<input name="nombre" value="' + esc(x.nombre) + '" required></label>' +
      '<label>Localidad<select name="localidad">' + opciones(ZONAS.concat([{ id: 'otra', nombre: 'Otra' }]), x.localidad) + '</select></label>' +
      '<label>Rubro<input name="rubro" value="' + esc(x.rubro) + '"></label>' +
      '<label class="ancho">Contacto<input name="contacto" value="' + esc(x.contacto) + '" placeholder="Teléfono, Instagram, nombre de quien atiende"></label>' +
      '<label>Paquetes por día est.<input name="paq_dia_est" type="number" inputmode="decimal" min="0" step="0.5" value="' + esc(x.paq_dia_est) + '"></label>' +
      '<label>Precio acordado<input name="precio_acordado" type="number" inputmode="numeric" min="0" value="' + esc(x.precio_acordado) + '" placeholder="General: ' + p('precio_vendedor') + '"></label>' +
      '<label>Estado<select name="estado">' + opciones(ESTADOS_VENDEDOR, x.estado) + '</select></label>' +
      '<label class="check"><input type="checkbox" name="usa_flex"' + (x.usa_flex ? ' checked' : '') + '> Ya usa Flex</label>' +
      '<label class="ancho">Notas<textarea name="notas" rows="3">' + esc(x.notas) + '</textarea></label>';

    abrirModal(v ? 'Editar vendedor' : 'Nuevo vendedor', cuerpo, async function (form) {
      var fila = {
        store_slug: ctx.store.slug,
        nombre: valor(form, 'nombre'),
        localidad: valor(form, 'localidad'),
        rubro: valor(form, 'rubro') || null,
        contacto: valor(form, 'contacto') || null,
        usa_flex: valor(form, 'usa_flex'),
        paq_dia_est: num(valor(form, 'paq_dia_est')),
        precio_acordado: numONull(valor(form, 'precio_acordado')),
        estado: valor(form, 'estado'),
        notas: valor(form, 'notas') || null
      };
      if (!fila.nombre) { aviso('Falta el nombre.'); return false; }
      var res = v
        ? await ctx.sb.from('flex_vendedores').update(fila).eq('id', v.id).select().single()
        : await ctx.sb.from('flex_vendedores').insert(fila).select().single();
      if (res.error) { aviso('No se pudo guardar:\n\n' + res.error.message); return false; }
      if (v) vendedores = vendedores.map(function (e) { return e.id === v.id ? res.data : e; });
      else vendedores.push(res.data);
      render();
      return true;
    }, v ? async function () {
      if (!(await (ctx.confirmar || global.confirm)('¿Borrar a ' + v.nombre + '? Si solo no sigue, mejor marcalo como Descartado.'))) return false;
      var res = await ctx.sb.from('flex_vendedores').delete().eq('id', v.id);
      if (res.error) { aviso('No se pudo borrar:\n\n' + res.error.message); return false; }
      vendedores = vendedores.filter(function (e) { return e.id !== v.id; });
      render();
      return true;
    } : null);
  }

  // ---- 4. Repartidores ----
  function renderRepartidores(c) {
    var html = '<div class="fx-head" style="padding:0 0 12px;border:0;"><span class="fx-nota" style="font-weight:400;">' +
      'Independientes: monotributistas, pago por paquete, eligen sus días. Sin horarios ni exclusividad.</span>' +
      '<button type="button" class="fx-btn" id="fxNuevoRep">+ Nuevo repartidor</button></div>';
    if (!repartidores.length) html += '<div class="fx-nota">Todavía no hay repartidores cargados.</div>';

    // Agrupados por zona, de sur a norte, para leerlo igual que el corredor.
    ZONAS.forEach(function (z) {
      var deZona = repartidores.filter(function (r) { return r.zona === z.id; });
      if (!deZona.length) return;
      html += '<div style="font-weight:700;font-size:13px;margin:14px 0 8px;">' + esc(z.nombre) + '</div><div class="fx-lista">' +
        deZona.map(function (r) {
          var badge = { activo: 'ok', pausado: 'mal' }[r.estado] || 'warn';
          var mono = { si: 'ok', tramite: 'warn', no: 'mal' }[r.monotributo];
          return '<div class="fx-card" data-fx-rep="' + r.id + '"><div class="t"><span>' + esc(r.nombre) + '</span>' +
            '<span class="fx-badge ' + badge + '">' + esc(nombreDe(ESTADOS_REPARTIDOR, r.estado)) + '</span></div>' +
            esc(nombreDe(VEHICULOS, r.vehiculo)) + ' · ' + (r.pago_x_paquete != null ? plata(r.pago_x_paquete) : plata(p('pago_rep')) + ' (general)') + ' por paquete<br>' +
            'Monotributo: <span class="fx-badge ' + mono + '">' + esc(nombreDe(MONOTRIBUTO, r.monotributo)) + '</span>' +
            (r.telefono ? '<br>📞 ' + esc(r.telefono) : '') +
            (r.alias_mp ? '<br>💳 ' + esc(r.alias_mp) : '') + '</div>';
        }).join('') + '</div>';
    });
    c.innerHTML = html;

    c.querySelector('#fxNuevoRep').addEventListener('click', function () { editarRepartidor(null); });
    c.querySelectorAll('[data-fx-rep]').forEach(function (el) {
      el.addEventListener('click', function () {
        editarRepartidor(repartidores.find(function (r) { return r.id === el.dataset.fxRep; }));
      });
    });
  }

  function editarRepartidor(r) {
    var x = r || { zona: 'san_lorenzo', vehiculo: 'moto', monotributo: 'no', estado: 'candidato' };
    var cuerpo =
      '<label class="ancho">Nombre<input name="nombre" value="' + esc(x.nombre) + '" required></label>' +
      '<label>Zona<select name="zona">' + opciones(ZONAS, x.zona) + '</select></label>' +
      '<label>Vehículo<select name="vehiculo">' + opciones(VEHICULOS, x.vehiculo) + '</select></label>' +
      '<label>Teléfono<input name="telefono" type="tel" value="' + esc(x.telefono) + '"></label>' +
      '<label>CVU o alias de MP<input name="alias_mp" value="' + esc(x.alias_mp) + '"></label>' +
      '<label>Monotributo<select name="monotributo">' + opciones(MONOTRIBUTO, x.monotributo) + '</select></label>' +
      '<label>Estado<select name="estado">' + opciones(ESTADOS_REPARTIDOR, x.estado) + '</select></label>' +
      '<label class="ancho">Pago por paquete<input name="pago_x_paquete" type="number" inputmode="numeric" min="0" value="' + esc(x.pago_x_paquete) + '" placeholder="General: ' + p('pago_rep') + '"></label>';

    abrirModal(r ? 'Editar repartidor' : 'Nuevo repartidor', cuerpo, async function (form) {
      var fila = {
        store_slug: ctx.store.slug,
        nombre: valor(form, 'nombre'),
        zona: valor(form, 'zona'),
        vehiculo: valor(form, 'vehiculo'),
        telefono: valor(form, 'telefono') || null,
        alias_mp: valor(form, 'alias_mp') || null,
        monotributo: valor(form, 'monotributo'),
        estado: valor(form, 'estado'),
        pago_x_paquete: numONull(valor(form, 'pago_x_paquete'))
      };
      if (!fila.nombre) { aviso('Falta el nombre.'); return false; }
      var res = r
        ? await ctx.sb.from('flex_repartidores').update(fila).eq('id', r.id).select().single()
        : await ctx.sb.from('flex_repartidores').insert(fila).select().single();
      if (res.error) { aviso('No se pudo guardar:\n\n' + res.error.message); return false; }
      if (r) repartidores = repartidores.map(function (e) { return e.id === r.id ? res.data : e; });
      else repartidores.push(res.data);
      render();
      return true;
    }, r ? async function () {
      if (!(await (ctx.confirmar || global.confirm)('¿Borrar a ' + r.nombre + '? Si solo deja por un tiempo, mejor ponelo en Pausado.'))) return false;
      var res = await ctx.sb.from('flex_repartidores').delete().eq('id', r.id);
      if (res.error) { aviso('No se pudo borrar:\n\n' + res.error.message); return false; }
      repartidores = repartidores.filter(function (e) { return e.id !== r.id; });
      render();
      return true;
    } : null);
  }

  // ---- 5. Liquidación semanal ----
  function filaLiq(tipo, id) {
    return liquidaciones.find(function (l) { return l.tipo === tipo && l.ref_id === id; }) || null;
  }

  // Lo activo hoy más cualquiera que ya tenga algo cargado esa semana (un
  // repartidor que se pausó el jueves igual cobra lo que hizo).
  function sujetos(tipo) {
    var lista = tipo === 'repartidor' ? repartidores : vendedores;
    return lista.filter(function (x) { return x.estado === 'activo' || filaLiq(tipo, x.id); });
  }

  function montoDe(tipo, x, cantidad, cruzados) {
    if (tipo === 'repartidor') {
      var pago = x.pago_x_paquete != null ? num(x.pago_x_paquete) : p('pago_rep');
      return cantidad * pago + cruzados * p('extra_cruzado');
    }
    var precio = x.precio_acordado != null ? num(x.precio_acordado) : p('precio_vendedor');
    return cantidad * precio + cruzados * p('recargo_cruzado');
  }

  function renderLiquidacion(c) {
    var reps = sujetos('repartidor');
    var vends = sujetos('vendedor');
    var tot = { aPagar: 0, aCobrar: 0, entregas: 0, paquetes: 0, cruzR: 0, cruzV: 0 };

    var tabla = function (tipo, lista) {
      var esRep = tipo === 'repartidor';
      return '<div class="fx-scroll"><table class="fx-tabla"><thead><tr><th>' + (esRep ? 'Repartidor' : 'Vendedor') + '</th>' +
        '<th>' + (esRep ? 'Entregas' : 'Paquetes') + '</th><th>Cruzados</th><th class="fx-der">' + (esRep ? 'A pagar' : 'A cobrar') + '</th>' +
        (esRep ? '<th>Factura</th><th>Pagado</th>' : '<th>Cobrado</th>') + '</tr></thead><tbody>' +
        (lista.length ? lista.map(function (x) {
          var l = filaLiq(tipo, x.id) || {};
          var cant = num(l.cantidad), cruz = num(l.cruzados);
          var monto = l.id ? num(l.monto) : 0;
          if (esRep) { tot.aPagar += monto; tot.entregas += cant; tot.cruzR += cruz; }
          else { tot.aCobrar += monto; tot.paquetes += cant; tot.cruzV += cruz; }
          var attrs = ' data-fx-liq="' + tipo + '" data-fx-id="' + x.id + '"';
          return '<tr><td><b>' + esc(x.nombre) + '</b><div class="fx-nota">' + esc(NOMBRE_ZONA[esRep ? x.zona : x.localidad] || '') + '</div></td>' +
            '<td><input type="number" inputmode="numeric" min="0" step="1" value="' + (l.id ? cant : '') + '" placeholder="0" data-campo="cantidad"' + attrs + '></td>' +
            '<td><input type="number" inputmode="numeric" min="0" step="1" value="' + (l.id ? cruz : '') + '" placeholder="0" data-campo="cruzados"' + attrs + '></td>' +
            '<td class="fx-der"><b>' + plata(monto) + '</b></td>' +
            (esRep ? '<td><input type="checkbox" data-campo="factura_ok"' + attrs + (l.factura_ok ? ' checked' : '') + '></td>' : '') +
            '<td><input type="checkbox" data-campo="pagado_ok"' + attrs + (l.pagado_ok ? ' checked' : '') + '></td></tr>';
        }).join('') : '<tr><td colspan="6" class="fx-nota">No hay ' + (esRep ? 'repartidores' : 'vendedores') + ' activos.</td></tr>') +
        '</tbody></table></div>';
    };

    var tablaRep = tabla('repartidor', reps);
    var tablaVen = tabla('vendedor', vends);
    var margen = tot.aCobrar - tot.aPagar;
    var noCoinciden = tot.entregas !== tot.paquetes || tot.cruzR !== tot.cruzV;

    var html = '<div class="fx-semana"><button type="button" class="fx-btn sec" data-fx-semana="-1">‹</button>' +
      '<span>' + textoSemana(semana) + '</span><button type="button" class="fx-btn sec" data-fx-semana="1">›</button></div>';
    html += '<div class="fx-grid">' +
      kpi('A cobrar', plata(tot.aCobrar), entero(tot.paquetes) + ' paquetes') +
      kpi('A pagar', plata(tot.aPagar), entero(tot.entregas) + ' entregas') +
      kpi('Margen de la semana', plata(margen), '', margen >= 0 ? 'fx-pos' : 'fx-neg') + '</div>';
    if (noCoinciden && (tot.entregas || tot.paquetes)) {
      html += '<div class="fx-alerta">⚠️ No coinciden: los repartidores marcan ' + entero(tot.entregas) + ' entregas (' + entero(tot.cruzR) +
        ' cruzados) y los vendedores ' + entero(tot.paquetes) + ' paquetes (' + entero(tot.cruzV) + ' cruzados). Revisá antes de pagar o cobrar.</div>';
    }
    html += '<div class="fx-panel"><div class="fx-head">🛵 Repartidores <span class="fx-nota" style="font-weight:400;">transferencia a su CVU/alias contra su Factura C</span></div>' + tablaRep + '</div>';
    html += '<div class="fx-panel"><div class="fx-head">🏪 Vendedores <span class="fx-nota" style="font-weight:400;">contra nuestra factura</span></div>' + tablaVen + '</div>';
    html += '<div class="fx-nota">El monto se calcula con el precio de cada uno (o el general) al cargar la cantidad, y queda guardado: si después cambia el precio, lo de esta semana no se mueve.</div>';
    c.innerHTML = html;

    c.querySelectorAll('[data-fx-semana]').forEach(function (b) {
      b.addEventListener('click', async function () {
        semana = new Date(semana);
        semana.setDate(semana.getDate() + 7 * num(b.dataset.fxSemana));
        try { await cargarSemana(); } catch (e) { aviso('No se pudo cargar la semana:\n\n' + (e.message || e)); }
        renderLiquidacion(c);
      });
    });
    c.querySelectorAll('[data-fx-liq]').forEach(function (inp) {
      inp.addEventListener('change', function () { guardarLiq(inp, c); });
    });
  }

  async function guardarLiq(inp, c) {
    var tipo = inp.dataset.fxLiq, id = inp.dataset.fxId;
    var x = (tipo === 'repartidor' ? repartidores : vendedores).find(function (e) { return e.id === id; });
    var actual = filaLiq(tipo, id) || {};
    var fila = {
      store_slug: ctx.store.slug,
      semana_inicio: isoLocal(semana),
      tipo: tipo,
      ref_id: id,
      cantidad: num(actual.cantidad),
      cruzados: num(actual.cruzados),
      factura_ok: !!actual.factura_ok,
      pagado_ok: !!actual.pagado_ok,
      updated_at: new Date().toISOString()
    };
    var campo = inp.dataset.campo;
    if (inp.type === 'checkbox') fila[campo] = inp.checked;
    else fila[campo] = Math.max(0, Math.round(num(inp.value)));
    // El monto se recalcula solo si cambian las cantidades: tildar "pagado"
    // no tiene que reescribir un monto ya liquidado con el precio de hoy.
    fila.monto = (campo === 'cantidad' || campo === 'cruzados' || actual.monto == null)
      ? montoDe(tipo, x, fila.cantidad, fila.cruzados)
      : num(actual.monto);

    var res = await ctx.sb.from('flex_liquidaciones')
      .upsert(fila, { onConflict: 'store_slug,semana_inicio,tipo,ref_id' }).select().single();
    if (res.error) { aviso('No se pudo guardar:\n\n' + res.error.message); renderLiquidacion(c); return; }
    liquidaciones = liquidaciones.filter(function (l) { return !(l.tipo === tipo && l.ref_id === id); }).concat([res.data]);
    renderLiquidacion(c);
  }

  // ---- 6. Referencias ----
  function renderReferencias(c) {
    c.innerHTML =
      '<div class="fx-alerta">Verificá todo en tu cuenta de Mercado Libre: las tarifas cambian y dependen de la reputación.</div>' +
      '<div class="fx-panel"><div class="fx-head">Lo que paga Mercado Libre <span class="fx-nota" style="font-weight:400;">página oficial de tarifas Flex, consultada el 21/10/2026</span></div><div class="fx-body"><ul class="fx-ref">' +
      '<li>Producto de menos de <b>$33.000</b> (paga el comprador), "otras ciudades" (incluye Rosario y San Lorenzo): el vendedor recibe <b>$4.990</b> por envío, tarifa plana sin importar la distancia.</li>' +
      '<li>Producto de <b>$33.000 o más</b> (envío gratis): hasta 10% de la tarifa según reputación, <b>≈ $499</b>.</li>' +
      '<li>ML acredita venta + envío en Mercado Pago <b>8 días después de la entrega</b>.</li>' +
      '<li>Reprogramaciones y recargos por clima los paga el vendedor.</li>' +
      '<li>Tarifa plana: un cruzado San Lorenzo → Rosario paga lo mismo que una entrega a 10 cuadras. Por eso los cruzados se cobran con recargo.</li>' +
      '</ul></div></div>' +
      '<div class="fx-panel"><div class="fx-head">Mercado</div><div class="fx-body"><ul class="fx-ref">' +
      '<li>CABA: mensajerías Flex desde <b>~$3.700</b> por envío. Córdoba: un operador cobra <b>$5.000</b>.</li>' +
      '<li>Básico diario de un camionero de 1.ª categoría (agosto 2026): <b>~$44.830</b>.</li>' +
      '<li>Choferes de apps: casi el <b>50%</b> de lo facturado se va en gastos del vehículo.</li>' +
      '<li>Directorio oficial de ML "Mensajerías que ya operan con Envíos Flex" (21/10/2026): San Lorenzo tiene <b>0</b>. Rosario: Andreani, Chazki, Entregar, Epsa, Elog Group, QX Logística, Southpost; en moto, DOCRIDER.</li>' +
      '</ul></div></div>' +
      '<div class="fx-panel"><div class="fx-head">Documentación de la API</div><div class="fx-body"><ul class="fx-ref">' +
      '<li><a href="https://developers.mercadolibre.com.ar/es_ar/envios-flex" target="_blank" rel="noopener">Envíos Flex (incluye "Registrar envíos para mensajería")</a></li>' +
      '<li><a href="https://developers.mercadolivre.com.br/en_us/mercadoenvios-mode-2" target="_blank" rel="noopener">Mercado Envíos 2: tipos de logística</a> — Flex = <code>self_service</code>.</li>' +
      '<li><a href="https://developers.mercadolibre.com.ar/en_us/turbo-shipping" target="_blank" rel="noopener">Envíos Turbo</a> — también figura como <code>self_service</code>.</li>' +
      '</ul></div></div>';
  }

  // ---- Entrada ----
  async function montar(opciones) {
    ctx = opciones;
    raiz = opciones.contenedor;
    if (!semana) semana = lunesDe(new Date());
    ponerEstilos();
    raiz.innerHTML = '<div class="fx-nota">Cargando Envíos Flex…</div>';
    try {
      await cargarTodo();
    } catch (e) {
      raiz.innerHTML = '<div class="fx-alerta">No se pudo cargar Envíos Flex: ' + esc(e.message || e) + '</div>';
      return;
    }
    render();
  }

  global.bruwalFlex = { montar: montar, calcular: calcular, ZONAS: ZONAS };
})(window);
