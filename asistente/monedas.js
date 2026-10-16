// Bruwal Chat · panel del bot de Walter (clientes de tipo "monedas").
//
// Walter compra monedas por kilo, cobre y bronce. Su bot (supabase/functions/
// walter-bot) cotiza y toma los pedidos por WhatsApp y Messenger; desde acá
// Walter les pone día y turno, revisa y aprueba la hoja de ruta, cambia los
// precios y ve quién pidió hablar con él.
//
// Usa sb, $, ver, ocultar, escapar, fecha y fechaHora de index.html, y el
// marcado de #vistaMonedas. Qué se puede ver y qué se puede cambiar lo deciden
// las políticas de la base (schema/63-bruwal-chat.sql), no esta página.

const panelMonedas = (() => {
  // Centro aproximado de cada localidad de la zona. La hoja de ruta ordena por
  // cercanía entre localidades: alcanza para decidir el orden del recorrido sin
  // pagar un servicio de mapas. Los nombres son los que guarda walter-bot.
  const LOCALIDADES = {
    'Rosario': [-32.947, -60.639],
    'Baigorria': [-32.857, -60.717],
    'Bermúdez': [-32.823, -60.713],
    'Beltrán': [-32.791, -60.729],
    'San Lorenzo': [-32.746, -60.737],
    'Puerto General San Martín': [-32.716, -60.734],
    'Aldao': [-32.705, -60.817],
    'Pueblo Andino': [-32.672, -60.877],
    'Serodino': [-32.605, -60.947],
    'La Ribera': [-32.605, -60.86],
    'Oliveros': [-32.574, -60.857],
    'Maciel': [-32.459, -60.893],
    'Totoras': [-32.584, -61.168],
    'Funes': [-32.917, -60.81],
    'Ibarlucea': [-32.852, -60.787],
    'Roldán': [-32.898, -60.906]
  };
  const BASE = LOCALIDADES['Pueblo Andino'];

  const ESTADOS = { nuevo: 'Nuevo', agendado: 'Agendado', retirado: 'Retirado', cancelado: 'Cancelado' };

  // En qué paso de la charla quedó cada cliente (estado.step de walter-bot).
  const PASOS = {
    loc: 'Diciendo de qué localidad es', cat: 'Eligiendo qué vende',
    unit: 'Eligiendo unidades o kilos', tipo: 'Eligiendo el tipo de moneda', qty: 'Diciendo la cantidad',
    mod: 'Eligiendo cómo lo entrega', name: 'Dando su nombre',
    addr: 'Dando la dirección', done: 'Pedido tomado', out: 'Fuera de la zona'
  };

  let cfg = {};
  let cfgActualizado = null;
  let pedidos = [];
  let charlas = [];
  let rutas = [];

  let pestana = 'pedidos';
  let filtroPedidos = 'pendientes';
  let busqueda = '';
  let filtroCharlas = 'humano';
  let diaRuta = null;
  let turnoRuta = 'Mañana';
  let turnoElegido = false;
  let charlaAbierta = null;
  let preciosEditados = false;
  let eventosAtados = false;
  let cargando = false;

  // ---------------------------------------------------------- formatos

  const plata = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-AR');
  const kilos = (n) => (Math.round(Number(n) * 10) / 10).toLocaleString('es-AR') + ' kg';
  // Las llaves se compran como las monedas contadas: walter-bot las guarda como
  // Monedas con tipo "Llaves".
  const esLlave = (p) => /llave/i.test(p.tipo || '');
  const materialDe = (p) => (esLlave(p) ? 'Llaves' : p.material);
  const cantidadDe = (p) => p.modo === 'u'
    ? Number(p.cantidad).toLocaleString('es-AR') + (p.tipo && !esLlave(p) ? ' de ' + p.tipo : ' unidades')
    : kilos(p.cantidad);
  const canalDe = (c) => (c === 'messenger' ? 'Messenger' : 'WhatsApp');

  // Fecha y hora de Argentina, esté donde esté la compu: walter-bot decide los
  // avisos con la hora de acá y el panel tiene que contar lo mismo.
  function ahoraAR() {
    const partes = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date());
    const v = {};
    partes.forEach((x) => { v[x.type] = x.value; });
    return { hoy: v.year + '-' + v.month + '-' + v.day, hhmm: v.hour + ':' + v.minute };
  }

  function sumarDias(iso, n) {
    const d = new Date(iso + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  // "jueves 16/10". Armado a mano: según el navegador, es-AR sale "16-10".
  const nombreDia = (iso) => {
    const d = new Date(iso + 'T12:00:00Z');
    return d.toLocaleDateString('es-AR', { timeZone: 'UTC', weekday: 'long' }) + ' ' +
      d.getUTCDate() + '/' + (d.getUTCMonth() + 1);
  };

  // Mismo criterio que walter-bot, con el umbral de hoy: si Walter lo cambia,
  // la hoja de ruta lo toma en el momento. Las contadas se pasan a kilos con
  // cuántas de ese tipo hacen un kilo.
  const esPrioridad = (p) => {
    if (p.material !== 'Monedas' || esLlave(p)) return false;
    if (p.modo === 'kg') return Number(p.cantidad) >= Number(cfg.umbralPrio);
    const tipo = (cfg.monedas || []).find((t) => t.n === p.tipo);
    if (!tipo || !tipo.kg) return !!p.prioridad;
    return Number(p.cantidad) / tipo.kg >= Number(cfg.umbralPrio);
  };

  const cerrado = (p) => p.estado === 'retirado' || p.estado === 'cancelado';

  function toast(texto) {
    const t = $('mToast');
    t.textContent = texto;
    ver(t);
    clearTimeout(toast.reloj);
    toast.reloj = setTimeout(() => ocultar(t), 2200);
  }

  function mostrarError(texto) {
    $('mError').textContent = texto;
    ver($('mError'));
  }

  // ---------------------------------------------------------- datos

  async function cargar() {
    if (cargando) return false;
    cargando = true;
    const { hoy } = ahoraAR();

    // Los pedidos abiertos todos; los cerrados, los de los últimos dos meses.
    const [rc, rp, rch, rr] = await Promise.all([
      sb.from('walter_config').select('data, actualizado').eq('id', 1).maybeSingle(),
      sb.from('walter_pedidos').select('*')
        .or('estado.in.(nuevo,agendado),creado.gte.' + sumarDias(hoy, -60))
        .order('creado', { ascending: false })
        .limit(1000),
      sb.from('walter_conversaciones')
        .select('canal, usuario, nombre_perfil, estado, pide_humano, actualizado')
        .order('pide_humano', { ascending: false })
        .order('actualizado', { ascending: false })
        .limit(300),
      sb.from('walter_rutas').select('dia, turno, paradas, aprobada').gte('dia', sumarDias(hoy, -30))
    ]);
    cargando = false;

    const error = rc.error || rp.error || rch.error || rr.error;
    if (error || !rc.data) {
      // Sin error y sin config: la política no lo dejó ver, o sea que el
      // usuario no está vinculado al cliente de Walter.
      mostrarError(error
        ? 'No se pudieron cargar los datos: ' + error.message
        : 'Tu usuario no tiene acceso a este panel. Escribinos y lo revisamos.');
      return false;
    }

    ocultar($('mError'));
    cfg = rc.data.data || {};
    cfgActualizado = rc.data.actualizado;
    pedidos = rp.data || [];
    charlas = rch.data || [];
    rutas = rr.data || [];
    return true;
  }

  async function actualizar() {
    if (await cargar()) pintar();
  }

  // ---------------------------------------------------------- pintar

  function pintar() {
    pintarTarjetas();
    if (pestana === 'pedidos') pintarPedidos();
    if (pestana === 'ruta') pintarRuta();
    if (pestana === 'charlas') pintarCharlas();
    if (pestana === 'precios') pintarPrecios();
  }

  function mostrarPestana(nombre) {
    pestana = nombre;
    document.querySelectorAll('#vistaMonedas .pestana').forEach((b) => {
      b.classList.toggle('activa', b.dataset.pestana === nombre);
      b.setAttribute('aria-selected', b.dataset.pestana === nombre);
    });
    document.querySelectorAll('#vistaMonedas [data-seccion]').forEach((s) => {
      s.classList.toggle('hidden', s.dataset.seccion !== nombre);
    });
    pintar();
  }

  function marcarFiltro(contenedor, valor) {
    document.querySelectorAll('#' + contenedor + ' .filtro').forEach((b) => {
      b.classList.toggle('activo', b.dataset.filtro === valor);
    });
  }

  function pintarTarjetas() {
    const { hoy } = ahoraAR();
    const manana = sumarDias(hoy, 1);
    const abiertos = pedidos.filter((p) => !cerrado(p));
    const semana = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const humano = charlas.filter((c) => c.pide_humano).length;
    const sinDia = abiertos.filter((p) => p.retiro !== 'Depósito' && (!p.dia || !p.turno)).length;

    $('mNumHumano').textContent = humano;
    $('mNumSinDia').textContent = sinDia;
    $('mNumManana').textContent =
      abiertos.filter((p) => p.dia === manana && p.turno && p.retiro !== 'Depósito').length;
    $('mNumSemana').textContent = pedidos.filter((p) => new Date(p.creado) >= semana).length;

    $('mNumHumano').closest('.tarjeta').classList.toggle('alerta', humano > 0);
    $('mNumSinDia').closest('.tarjeta').classList.toggle('alerta', sinDia > 0);
  }

  // ---------------------------------------------------------- pedidos

  // Qué pasa con el aviso al cliente. Sigue las reglas de walter-bot, que
  // revisa cada 15 minutos: el turno mañana se avisa la noche anterior desde
  // horaNoche y el turno tarde ese mismo día desde horaManana.
  function avisoDe(p) {
    if (p.retiro === 'Depósito') return { texto: 'Lo trae al depósito: no lleva aviso.' };
    if (cerrado(p)) return null;
    if (p.respuesta_aviso === 'confirmó') {
      return { clase: 'chip-atendido', chip: 'Confirmó', texto: 'Le avisamos el ' + fechaHora(p.aviso_enviado) + '.' };
    }
    if (p.respuesta_aviso === 'no puede') {
      return { clase: 'chip-alerta', chip: 'No puede', texto: 'Cambiale el día y el bot le vuelve a avisar.' };
    }
    if (p.aviso_enviado) {
      return { clase: 'chip-nuevo', chip: 'Avisado', texto: fechaHora(p.aviso_enviado) + ', falta que conteste.' };
    }
    if (!p.dia || !p.turno) {
      return { clase: 'chip-pendiente', chip: 'Sin día', texto: 'Poné día y turno para que salga el aviso.' };
    }

    const { hoy, hhmm } = ahoraAR();
    const deManana = p.turno === 'Mañana';
    const diaAviso = deManana ? sumarDias(p.dia, -1) : p.dia;
    const hora = (deManana ? cfg.horaNoche : cfg.horaManana) || (deManana ? '21:00' : '09:00');

    if (diaAviso > hoy) {
      const cuando = diaAviso === sumarDias(hoy, 1) ? 'mañana' : 'el ' + nombreDia(diaAviso);
      return { clase: 'chip-nuevo', chip: 'Programado', texto: 'El aviso sale ' + cuando + ' a las ' + hora + '.' };
    }
    if (diaAviso === hoy) {
      return {
        clase: 'chip-nuevo', chip: 'Programado',
        texto: hhmm < hora ? 'El aviso sale hoy a las ' + hora + '.' : 'El aviso sale en los próximos minutos.'
      };
    }
    return { clase: 'chip-pendiente', chip: 'Sin aviso', texto: 'Ya pasó la hora de avisar para ese turno.' };
  }

  // Arriba lo que pide una acción: el que avisó que no puede y el que no tiene
  // día. Después por día de retiro, y el mismo día primero la mañana.
  function urgencia(p) {
    if (cerrado(p)) return 3;
    if (p.respuesta_aviso === 'no puede') return 0;
    if (p.retiro !== 'Depósito' && (!p.dia || !p.turno)) return 1;
    return 2;
  }

  function ordenPedidos(a, b) {
    const diferencia = urgencia(a) - urgencia(b);
    if (diferencia) return diferencia;
    if (urgencia(a) === 2) {
      const ka = (a.dia || '9999') + (a.turno === 'Tarde' ? '2' : '1');
      const kb = (b.dia || '9999') + (b.turno === 'Tarde' ? '2' : '1');
      if (ka !== kb) return ka < kb ? -1 : 1;
    }
    return a.creado < b.creado ? 1 : -1;
  }

  function htmlPedido(p) {
    const fijo = cerrado(p);
    const aviso = avisoDe(p);
    const { hoy } = ahoraAR();

    const agenda = p.retiro === 'Depósito' ? '' :
      '<input type="date" data-campo="dia" aria-label="Día de retiro" min="' + hoy + '"' +
        ' value="' + escapar(p.dia || '') + '"' + (fijo ? ' disabled' : '') + '>' +
      '<select data-campo="turno" aria-label="Turno"' + (fijo ? ' disabled' : '') + '>' +
        '<option value="">Turno…</option>' +
        ['Mañana', 'Tarde'].map((t) =>
          '<option' + (p.turno === t ? ' selected' : '') + '>' + t + '</option>').join('') +
      '</select>';

    return '<div class="pedido' + (fijo ? ' pedido-cerrado' : '') + '" data-id="' + escapar(p.id) + '">' +
      '<div>' +
        '<div class="nombre-lead">' + escapar(p.nombre) +
          (esPrioridad(p) ? ' <span class="chip chip-prioridad">Prioridad</span>' : '') + '</div>' +
        '<div class="dato-secundario">' +
          escapar([p.localidad, p.direccion].filter(Boolean).join(' · ')) + '</div>' +
        '<div class="dato-secundario">' +
          escapar(canalDe(p.canal) + ' · pidió el ' + fechaHora(p.creado)) + '</div>' +
      '</div>' +
      '<div>' +
        '<div><b>' + escapar(materialDe(p)) + '</b> · ' + escapar(cantidadDe(p)) + '</div>' +
        '<div class="dato-secundario">' + escapar(plata(p.monto) + ' · ' + p.tarifa) + '</div>' +
        '<div class="dato-secundario">' + escapar(p.retiro) + '</div>' +
      '</div>' +
      '<div>' +
        '<div class="fila-agenda">' + agenda +
          '<select data-campo="estado" aria-label="Estado">' +
            Object.keys(ESTADOS).map((v) =>
              '<option value="' + v + '"' + (p.estado === v ? ' selected' : '') + '>' +
              ESTADOS[v] + '</option>').join('') +
          '</select>' +
        '</div>' +
        (aviso
          ? '<div class="aviso-pedido">' +
              (aviso.chip ? '<span class="chip ' + aviso.clase + '">' + escapar(aviso.chip) + '</span> ' : '') +
              escapar(aviso.texto) +
            '</div>'
          : '') +
      '</div>' +
    '</div>';
  }

  function pintarPedidos() {
    const texto = busqueda.trim().toLowerCase();
    const visibles = pedidos.filter((p) => {
      if (filtroPedidos === 'pendientes' && cerrado(p)) return false;
      if (filtroPedidos === 'retirados' && p.estado !== 'retirado') return false;
      if (filtroPedidos === 'cancelados' && p.estado !== 'cancelado') return false;
      if (!texto) return true;
      return [p.nombre, p.localidad, p.direccion, p.usuario]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(texto));
    }).sort(ordenPedidos);

    $('mListaPedidos').innerHTML = visibles.map(htmlPedido).join('');

    if (visibles.length) return ocultar($('mSinPedidos'));
    $('mSinPedidos').innerHTML = texto
      ? '<strong>Sin resultados para “' + escapar(busqueda) + '”</strong>Probá con otro dato.'
      : filtroPedidos === 'pendientes'
      ? '<strong>No hay pedidos pendientes</strong>Los que tome el bot van a aparecer acá.'
      : '<strong>No hay pedidos para mostrar</strong>';
    ver($('mSinPedidos'));
  }

  // Cada cambio se guarda en el momento. La tarjeta se redibuja en su lugar y
  // no se reordena la lista: si saltara apenas se elige el día, el turno se
  // terminaría poniendo en otro pedido.
  async function guardarPedido(e) {
    const campo = e.target.dataset.campo;
    const tarjeta = e.target.closest('.pedido');
    if (!campo || !tarjeta) return;

    const id = Number(tarjeta.dataset.id);
    e.target.disabled = true;

    // El resto lo resuelve la base: al cambiar día o turno borra el aviso que
    // ya había salido (para que walter-bot mande el nuevo) y ajusta el estado.
    const { data, error } = await sb
      .from('walter_pedidos')
      .update({ [campo]: e.target.value || null })
      .eq('id', id)
      .select()
      .maybeSingle();

    const i = pedidos.findIndex((p) => p.id === id);
    if (error || !data) {
      mostrarError('No se pudo guardar el cambio' + (error ? ': ' + error.message : '.'));
      if (i >= 0) tarjeta.outerHTML = htmlPedido(pedidos[i]);
      return;
    }

    ocultar($('mError'));
    if (i >= 0) pedidos[i] = data;
    tarjeta.outerHTML = htmlPedido(data);
    pintarTarjetas();
    toast('Guardado');
  }

  // ---------------------------------------------------------- hoja de ruta

  function km(a, b) {
    const R = 6371;
    const r = Math.PI / 180;
    const dLat = (b[0] - a[0]) * r;
    const dLon = (b[1] - a[1]) * r;
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  const lugarDe = (p) => LOCALIDADES[p.localidad] || BASE;

  // Vecino más cercano: desde donde está, siempre a la parada más próxima.
  function porCercania(lista, desde) {
    const resto = lista.slice();
    const orden = [];
    let aca = desde;
    while (resto.length) {
      let mejor = 0;
      let distancia = Infinity;
      resto.forEach((p, i) => {
        const d = km(aca, lugarDe(p));
        if (d < distancia) { distancia = d; mejor = i; }
      });
      const p = resto.splice(mejor, 1)[0];
      orden.push({ p, tramo: distancia });
      aca = lugarDe(p);
    }
    return orden;
  }

  // Sale de Pueblo Andino. Primero los pedidos con prioridad (monedas desde
  // umbralPrio kilos) y después el resto, siguiendo desde la última parada.
  function armarRuta(dia, turno) {
    const lista = pedidos
      .filter((p) => p.dia === dia && p.turno === turno &&
                     p.retiro !== 'Depósito' && p.estado !== 'cancelado')
      .sort((a, b) => a.id - b.id);
    const primero = porCercania(lista.filter(esPrioridad), BASE);
    const desde = primero.length ? lugarDe(primero[primero.length - 1].p) : BASE;
    return primero.concat(porCercania(lista.filter((p) => !esPrioridad(p)), desde));
  }

  // Google Maps arma el recorrido con las paradas en este orden. Acepta hasta
  // nueve paradas intermedias: con más, abre las diez primeras.
  function linkMapa(ruta) {
    const lugar = (p) => [p.direccion, p.localidad, 'Santa Fe', 'Argentina'].filter(Boolean).join(', ');
    const origen = cfg.depPA && !/confirmar/i.test(cfg.depPA)
      ? cfg.depPA + ', Pueblo Andino, Santa Fe, Argentina'
      : 'Pueblo Andino, Santa Fe, Argentina';
    const paradas = ruta.slice(0, 10).map(({ p }) => lugar(p));
    const destino = paradas.pop();
    return 'https://www.google.com/maps/dir/?api=1&travelmode=driving' +
      '&origin=' + encodeURIComponent(origen) +
      '&destination=' + encodeURIComponent(destino) +
      (paradas.length ? '&waypoints=' + encodeURIComponent(paradas.join('|')) : '');
  }

  function pintarRuta() {
    const { hoy } = ahoraAR();
    const dias = [...new Set(pedidos
      .filter((p) => p.dia && p.turno && p.retiro !== 'Depósito' && p.estado !== 'cancelado')
      .map((p) => p.dia))].sort();

    if (!dias.includes(diaRuta)) {
      diaRuta = dias.find((d) => d >= hoy) || dias[dias.length - 1] || null;
      turnoElegido = false;
    }
    // Sin elección del usuario, el turno que tenga retiros.
    if (diaRuta && !turnoElegido && !armarRuta(diaRuta, turnoRuta).length) {
      turnoRuta = turnoRuta === 'Mañana' ? 'Tarde' : 'Mañana';
    }

    $('mDiaRuta').innerHTML = dias.length
      ? dias.map((d) => '<option value="' + d + '"' + (d === diaRuta ? ' selected' : '') + '>' +
          escapar(nombreDia(d) + (d === hoy ? ' (hoy)' : '')) + '</option>').join('')
      : '<option value="">Sin retiros agendados</option>';
    $('mTurnoRuta').value = turnoRuta;
    $('mTituloRuta').textContent = diaRuta
      ? 'Hoja de ruta · ' + nombreDia(diaRuta) + ' · turno ' + turnoRuta.toLowerCase()
      : 'Hoja de ruta';

    const ruta = diaRuta ? armarRuta(diaRuta, turnoRuta) : [];

    $('mParadas').innerHTML = !ruta.length
      ? '<li class="vacio"><strong>No hay retiros para este día y turno</strong>' +
          'Poné día y turno a los pedidos en la pestaña Pedidos.</li>'
      : '<li class="parada parada-base"><span class="numero-parada">⌂</span><div>' +
          '<b>Salida: base de Pueblo Andino</b>' +
          '<div class="dato-secundario">' + escapar(cfg.depPA || '') + '</div></div><span></span></li>' +
        ruta.map(({ p, tramo }, i) =>
          '<li class="parada' + (p.estado === 'retirado' ? ' pedido-cerrado' : '') + '">' +
            '<span class="numero-parada">' + (i + 1) + '</span>' +
            '<div>' +
              '<b>' + escapar(p.nombre) + '</b>' +
              (esPrioridad(p) ? ' <span class="chip chip-prioridad">Prioridad</span>' : '') +
              (p.respuesta_aviso === 'confirmó' ? ' <span class="chip chip-atendido">Confirmó</span>' : '') +
              (p.respuesta_aviso === 'no puede' ? ' <span class="chip chip-alerta">Avisó que no puede</span>' : '') +
              (p.estado === 'retirado' ? ' <span class="chip chip-atendido">Retirado</span>' : '') +
              '<div class="dato-secundario">' +
                escapar([p.direccion, p.localidad].filter(Boolean).join(', ') + ' · ' + p.retiro) + '</div>' +
              '<div class="dato-secundario">' +
                escapar(materialDe(p) + ' · ' + cantidadDe(p) + ' · ' + plata(p.monto) +
                  (p.canal === 'whatsapp' ? ' · Tel. +' + p.usuario : '')) + '</div>' +
            '</div>' +
            '<span class="tramo">' + (tramo < 1 ? 'misma zona' : '+' + Math.round(tramo) + ' km') + '</span>' +
          '</li>').join('');

    const totalKg = ruta.reduce((a, { p }) => a + (p.modo === 'kg' ? Number(p.cantidad) : 0), 0);
    const unidades = ruta.reduce((a, { p }) => a + (p.modo === 'u' ? Number(p.cantidad) : 0), 0);
    const efectivo = ruta.reduce((a, { p }) => a + Number(p.monto), 0);
    const recorrido = ruta.reduce((a, s) => a + s.tramo, 0);

    $('mResumenRuta').innerHTML = !ruta.length ? '' : [
      ['Paradas', ruta.length],
      ['Kilos', kilos(totalKg)],
      unidades ? ['Contadas', unidades.toLocaleString('es-AR') + ' u.'] : null,
      ['Efectivo a llevar', plata(efectivo)],
      ['Recorrido aprox.', Math.round(recorrido) + ' km']
    ].filter(Boolean).map(([k, v]) =>
      '<div><span class="rotulo">' + escapar(k) + '</span><b>' + escapar(v) + '</b></div>').join('');

    // Aprobada vale para este orden exacto. Si después entró o se cayó un
    // pedido, se avisa para que la vuelva a mirar antes de salir.
    const ids = ruta.map(({ p }) => p.id);
    const aprobada = rutas.find((r) => r.dia === diaRuta && r.turno === turnoRuta);
    const igual = aprobada && aprobada.paradas.length === ids.length &&
      aprobada.paradas.every((id, i) => Number(id) === ids[i]);

    $('mAprobar').disabled = !ruta.length;
    $('mAprobar').textContent = aprobada ? 'Volver a aprobar' : 'Aprobar hoja de ruta';
    $('mImprimir').disabled = !ruta.length;
    $('mMapa').classList.toggle('hidden', !ruta.length);
    if (ruta.length) $('mMapa').href = linkMapa(ruta);

    $('mEstadoRuta').innerHTML = !ruta.length ? '' :
      (igual
        ? '<span class="chip chip-atendido">Aprobada</span> el ' + escapar(fechaHora(aprobada.aprobada))
        : aprobada
        ? '<span class="chip chip-alerta">Cambió</span> desde que la aprobaste el ' +
            escapar(fechaHora(aprobada.aprobada)) + '. Revisala y aprobala de nuevo.'
        : '<span class="chip chip-pendiente">Sin aprobar</span>') +
      (ruta.length > 10 ? ' Google Maps abre las primeras 10 paradas.' : '');
  }

  async function aprobarRuta() {
    const ruta = diaRuta ? armarRuta(diaRuta, turnoRuta) : [];
    if (!ruta.length) return;

    const fila = {
      dia: diaRuta,
      turno: turnoRuta,
      paradas: ruta.map(({ p }) => p.id),
      aprobada: new Date().toISOString()
    };

    $('mAprobar').disabled = true;
    const { error } = await sb.from('walter_rutas').upsert(fila, { onConflict: 'dia,turno' });
    $('mAprobar').disabled = false;

    if (error) return mostrarError('No se pudo aprobar la hoja de ruta: ' + error.message);

    ocultar($('mError'));
    rutas = rutas.filter((r) => !(r.dia === fila.dia && r.turno === fila.turno)).concat(fila);
    pintarRuta();
    toast('Hoja de ruta aprobada');
  }

  // ---------------------------------------------------------- charlas

  function nombreCharla(c) {
    if (c.nombre_perfil) return c.nombre_perfil;
    const p = pedidos.find((x) => x.canal === c.canal && x.usuario === c.usuario);
    if (p) return p.nombre;
    return c.canal === 'whatsapp' ? '+' + c.usuario : 'Cliente de Messenger';
  }

  function pintarCharlas() {
    const visibles = charlas.filter((c) => filtroCharlas === 'todas' || c.pide_humano);

    $('mCuerpoCharlas').innerHTML = visibles.map((c) =>
      '<tr data-canal="' + escapar(c.canal) + '" data-usuario="' + escapar(c.usuario) + '">' +
        '<td>' +
          '<div class="nombre-lead">' + escapar(nombreCharla(c)) + '</div>' +
          '<div class="dato-secundario">' + escapar(PASOS[c.estado && c.estado.step] || '') + '</div>' +
        '</td>' +
        '<td class="opcional">' + escapar(canalDe(c.canal)) + '</td>' +
        '<td class="opcional dato-secundario">' + escapar(fecha(c.actualizado)) + '</td>' +
        '<td>' +
          (c.pide_humano
            ? '<span class="chip chip-pendiente">Quiere hablar con vos</span>'
            : '<span class="chip chip-atendido">La atiende el bot</span>') +
        '</td>' +
      '</tr>').join('');

    if (visibles.length) return ocultar($('mSinCharlas'));
    $('mSinCharlas').innerHTML = filtroCharlas === 'humano'
      ? '<strong>Nadie está esperando que le escribas</strong>' +
          'Cuando alguien le pida al bot hablar con Walter, aparece acá.'
      : '<strong>Todavía no hay charlas</strong>Van a aparecer apenas alguien escriba.';
    ver($('mSinCharlas'));
  }

  async function abrirCharla(canal, usuario) {
    const c = charlas.find((x) => x.canal === canal && x.usuario === usuario);
    if (!c) return;
    charlaAbierta = c;

    ocultar($('mFichaError'));
    $('mFichaNombre').textContent = nombreCharla(c);
    $('mFichaCanal').textContent = canalDe(canal) + (canal === 'whatsapp' ? ' · +' + usuario : '');
    $('mBtnAtendida').classList.toggle('hidden', !c.pide_humano);
    $('mBtnAbrir').textContent = canal === 'whatsapp' ? 'Escribirle por WhatsApp' : 'Abrir la bandeja de Facebook';

    const suyos = pedidos.filter((p) => p.canal === canal && p.usuario === usuario);
    $('mFichaPedidos').innerHTML = suyos.length
      ? suyos.map((p) =>
          '<div class="dato"><span class="k">' + escapar(fechaHora(p.creado)) + '</span>' +
          '<span class="v">' + escapar(materialDe(p) + ' · ' + cantidadDe(p) + ' · ' + plata(p.monto) +
            ' · ' + ESTADOS[p.estado]) + '</span></div>').join('')
      : '<div class="dato"><span class="v dato-secundario">Todavía no hizo ningún pedido.</span></div>';

    $('mFichaCharla').innerHTML = '<div class="dato-secundario">Cargando…</div>';
    ver($('mTelon'));

    // Las últimas 200 líneas alcanzan para entender qué pasó.
    const { data, error } = await sb
      .from('walter_mensajes')
      .select('direccion, texto, creado')
      .eq('canal', canal)
      .eq('usuario', usuario)
      .order('id', { ascending: false })
      .limit(200);

    if (charlaAbierta !== c) return;

    $('mFichaCharla').innerHTML = error
      ? '<div class="dato-secundario">No se pudo cargar la conversación.</div>'
      : (data || []).reverse().map((m) =>
          '<div class="burbuja ' + (m.direccion === 'entra' ? 'de-cliente' : 'de-bot') + '">' +
            escapar(m.texto) +
            '<span class="hora">' + escapar(fechaHora(m.creado)) + '</span>' +
          '</div>').join('') || '<div class="dato-secundario">Sin mensajes.</div>';
    $('mFichaCharla').scrollTop = $('mFichaCharla').scrollHeight;
  }

  function cerrarCharla() {
    ocultar($('mTelon'));
    charlaAbierta = null;
  }

  async function marcarAtendida() {
    const c = charlaAbierta;
    if (!c) return;
    $('mBtnAtendida').disabled = true;
    ocultar($('mFichaError'));

    const { data, error } = await sb
      .from('walter_conversaciones')
      .update({ pide_humano: false })
      .eq('canal', c.canal)
      .eq('usuario', c.usuario)
      .select('pide_humano')
      .maybeSingle();

    $('mBtnAtendida').disabled = false;
    if (error || !data) {
      $('mFichaError').textContent = 'No se pudo guardar' + (error ? ': ' + error.message : '.');
      return ver($('mFichaError'));
    }

    c.pide_humano = false;
    cerrarCharla();
    pintarTarjetas();
    pintarCharlas();
    toast('Listo');
  }

  function abrirAfuera() {
    const c = charlaAbierta;
    if (!c) return;
    // El número del bot vive en la API de WhatsApp y no se puede usar desde el
    // celular: Walter le escribe desde su WhatsApp de siempre.
    const url = c.canal === 'whatsapp'
      ? 'https://wa.me/' + String(c.usuario).replace(/\D/g, '')
      : 'https://business.facebook.com/latest/inbox/all';
    window.open(url, '_blank', 'noopener');
  }

  // ---------------------------------------------------------- precios

  // Cada tipo de moneda contada (y las llaves): nombre, precio por unidad y
  // cuántas hacen un kilo. walter-bot los ofrece en este orden.
  function htmlTipo(t) {
    // escapar no toca las comillas, y estos valores van dentro de atributos
    const v = (x) => (x == null ? '' : escapar(x).replace(/"/g, '&quot;'));
    return '<div class="tipo-moneda">' +
      '<input data-t="n" type="text" aria-label="Tipo" placeholder="ej. $5" value="' + v(t.n) + '">' +
      '<input data-t="u" type="number" min="0" step="any" inputmode="decimal" aria-label="Precio por unidad ($)" value="' + v(t.u) + '">' +
      '<input data-t="kg" type="number" min="0" step="any" inputmode="decimal" aria-label="Cuántas hacen un kilo" value="' + v(t.kg) + '">' +
      '<button type="button" class="btn btn-suave quitar-tipo" aria-label="Quitar ' + v(t.n || 'este tipo') + '" title="Quitar">×</button>' +
    '</div>';
  }

  function pintarTipos(lista) {
    $('mTiposMoneda').innerHTML =
      '<div class="tipos-cabecera" aria-hidden="true"><span>Tipo</span><span>Precio c/u ($)</span><span>Hacen 1 kg</span><span></span></div>' +
      lista.map(htmlTipo).join('');
  }

  function marcarPreciosEditados() {
    preciosEditados = true;
    ocultar($('mPreciosError'));
    $('mPreciosEstado').textContent = 'Hay cambios sin guardar';
  }

  function agregarTipo() {
    $('mTiposMoneda').insertAdjacentHTML('beforeend', htmlTipo({}));
    $('mTiposMoneda').lastElementChild.querySelector('input').focus();
    marcarPreciosEditados();
  }

  function quitarTipo(e) {
    const boton = e.target.closest('.quitar-tipo');
    if (!boton) return;
    boton.closest('.tipo-moneda').remove();
    marcarPreciosEditados();
  }

  // Los tipos de la pantalla, o un mensaje con lo que hay que corregir
  function leerTipos() {
    const lista = [];
    for (const fila of document.querySelectorAll('#mTiposMoneda .tipo-moneda')) {
      const n = fila.querySelector('[data-t="n"]');
      const u = fila.querySelector('[data-t="u"]');
      const kg = fila.querySelector('[data-t="kg"]');
      if (!n.value.trim() && !u.value && !kg.value) continue;
      const nombre = n.value.trim();
      if (!nombre) return { error: 'Poné el nombre de cada tipo de moneda.', campo: n };
      if (lista.some((t) => t.n.toLowerCase() === nombre.toLowerCase())) {
        return { error: 'El tipo "' + nombre + '" está dos veces.', campo: n };
      }
      if (!(Number(u.value) > 0)) {
        return { error: 'Revisá el precio de "' + nombre + '": tiene que ser un número mayor que cero.', campo: u };
      }
      if (kg.value !== '' && !(Number(kg.value) > 0)) {
        return { error: 'Revisá cuántas "' + nombre + '" hacen un kilo: tiene que ser un número mayor que cero.', campo: kg };
      }
      const tipo = { n: nombre, u: Number(u.value) };
      if (kg.value !== '') tipo.kg = Number(kg.value);
      lista.push(tipo);
    }
    if (!lista.length) {
      return { error: 'Dejá al menos un tipo de moneda: el bot los usa para cotizar las contadas.' };
    }
    return { lista };
  }

  function pintarPrecios() {
    // Si Walter está escribiendo, un "Actualizar" no le pisa lo que tipeó.
    if (preciosEditados) return;
    document.querySelectorAll('#mFormPrecios [data-cfg]').forEach((el) => {
      const v = cfg[el.dataset.cfg];
      el.value = v == null ? ('cero' in el.dataset ? 0 : '') : v;
    });
    pintarTipos(cfg.monedas || []);
    ocultar($('mPreciosError'));
    $('mPreciosEstado').textContent = cfgActualizado
      ? 'Último cambio: ' + fechaHora(cfgActualizado)
      : '';
  }

  async function guardarPrecios(e) {
    e.preventDefault();
    ocultar($('mPreciosError'));

    const nuevo = Object.assign({}, cfg);
    for (const el of document.querySelectorAll('#mFormPrecios [data-cfg]')) {
      const nombre = el.closest('.campo').querySelector('label').textContent;
      if (el.type === 'number') {
        const n = Number(el.value);
        // data-cero: el campo acepta 0 (por ejemplo, sin mínimo para pasar a buscar)
        const cero = 'cero' in el.dataset;
        if (el.value === '' || !Number.isFinite(n) || n < 0 || (n === 0 && !cero)) {
          $('mPreciosError').textContent = 'Revisá "' + nombre + '": tiene que ser un número ' +
            (cero ? 'desde cero.' : 'mayor que cero.');
          el.focus();
          return ver($('mPreciosError'));
        }
        nuevo[el.dataset.cfg] = n;
      } else {
        const v = el.value.trim();
        if (!v) {
          $('mPreciosError').textContent = 'Completá "' + nombre + '".';
          el.focus();
          return ver($('mPreciosError'));
        }
        nuevo[el.dataset.cfg] = v;
      }
    }

    const tipos = leerTipos();
    if (tipos.error) {
      $('mPreciosError').textContent = tipos.error;
      if (tipos.campo) tipos.campo.focus();
      return ver($('mPreciosError'));
    }
    nuevo.monedas = tipos.lista;

    const boton = $('mGuardarPrecios');
    boton.disabled = true;
    boton.textContent = 'Guardando…';

    const { data, error } = await sb
      .from('walter_config')
      .update({ data: nuevo, actualizado: new Date().toISOString() })
      .eq('id', 1)
      .select('data, actualizado')
      .maybeSingle();

    boton.disabled = false;
    boton.textContent = 'Guardar cambios';

    if (error || !data) {
      $('mPreciosError').textContent = 'No se pudo guardar' + (error ? ': ' + error.message : '.');
      return ver($('mPreciosError'));
    }

    cfg = data.data;
    cfgActualizado = data.actualizado;
    preciosEditados = false;
    pintarPrecios();
    toast('Guardado: el bot ya usa estos valores');
  }

  // ---------------------------------------------------------- eventos

  function atarEventos() {
    document.querySelectorAll('#vistaMonedas .pestana').forEach((b) => {
      b.addEventListener('click', () => mostrarPestana(b.dataset.pestana));
    });

    // Las tarjetas de arriba llevan a donde está lo que cuentan.
    document.querySelectorAll('#vistaMonedas [data-ir]').forEach((t) => {
      t.addEventListener('click', () => {
        if (t.dataset.ir === 'charlas') { filtroCharlas = 'humano'; marcarFiltro('mFiltrosCharlas', 'humano'); }
        if (t.dataset.ir === 'pedidos') { filtroPedidos = 'pendientes'; marcarFiltro('mFiltrosPedidos', 'pendientes'); }
        if (t.dataset.ir === 'ruta') { diaRuta = sumarDias(ahoraAR().hoy, 1); turnoElegido = false; }
        mostrarPestana(t.dataset.ir);
      });
    });

    $('mActualizar').addEventListener('click', actualizar);

    document.querySelectorAll('#mFiltrosPedidos .filtro').forEach((b) => {
      b.addEventListener('click', () => {
        filtroPedidos = b.dataset.filtro;
        marcarFiltro('mFiltrosPedidos', filtroPedidos);
        pintarPedidos();
      });
    });
    $('mBuscador').addEventListener('input', (e) => {
      busqueda = e.target.value;
      pintarPedidos();
    });
    $('mListaPedidos').addEventListener('change', guardarPedido);

    $('mDiaRuta').addEventListener('change', (e) => {
      diaRuta = e.target.value || null;
      turnoElegido = false;
      pintarRuta();
    });
    $('mTurnoRuta').addEventListener('change', (e) => {
      turnoRuta = e.target.value;
      turnoElegido = true;
      pintarRuta();
    });
    $('mAprobar').addEventListener('click', aprobarRuta);
    $('mImprimir').addEventListener('click', () => window.print());

    document.querySelectorAll('#mFiltrosCharlas .filtro').forEach((b) => {
      b.addEventListener('click', () => {
        filtroCharlas = b.dataset.filtro;
        marcarFiltro('mFiltrosCharlas', filtroCharlas);
        pintarCharlas();
      });
    });
    $('mCuerpoCharlas').addEventListener('click', (e) => {
      const fila = e.target.closest('tr');
      if (fila) abrirCharla(fila.dataset.canal, fila.dataset.usuario);
    });
    $('mCerrarFicha').addEventListener('click', cerrarCharla);
    $('mTelon').addEventListener('click', (e) => { if (e.target === $('mTelon')) cerrarCharla(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('mTelon').classList.contains('hidden')) cerrarCharla();
    });
    $('mBtnAtendida').addEventListener('click', marcarAtendida);
    $('mBtnAbrir').addEventListener('click', abrirAfuera);

    $('mFormPrecios').addEventListener('input', marcarPreciosEditados);
    $('mAgregarTipo').addEventListener('click', agregarTipo);
    $('mTiposMoneda').addEventListener('click', quitarTipo);
    $('mFormPrecios').addEventListener('submit', guardarPrecios);

    // Los pedidos entran solos: al volver a la pestaña del navegador, y cada
    // dos minutos si no hay nada a medio editar, se traen de nuevo.
    const enUso = () => $('vistaMonedas').classList.contains('hidden') ||
      !$('mTelon').classList.contains('hidden') ||
      (document.activeElement && document.activeElement.closest &&
       document.activeElement.closest('#vistaMonedas input, #vistaMonedas select, #vistaMonedas textarea'));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !enUso()) actualizar();
    });
    setInterval(() => {
      if (document.visibilityState === 'visible' && !enUso()) actualizar();
    }, 2 * 60 * 1000);
  }

  // ---------------------------------------------------------- entrada

  async function abrir() {
    if (!eventosAtados) {
      atarEventos();
      eventosAtados = true;
    }
    if (!(await cargar())) return;

    // Si alguien está esperando, la pestaña de charlas arranca mostrándolo.
    filtroCharlas = charlas.some((c) => c.pide_humano) ? 'humano' : 'todas';
    marcarFiltro('mFiltrosCharlas', filtroCharlas);
    mostrarPestana(pestana);
  }

  return { abrir };
})();
