// Bruwal Chat · panel del bot de Walter (clientes de tipo "monedas").
//
// Walter compra monedas por kilo, cobre y bronce. Su bot (supabase/functions/
// walter-bot) cotiza y toma los pedidos por WhatsApp y Messenger; desde acá
// Walter les pone día y turno, revisa y aprueba la hoja de ruta, cambia los
// precios y atiende las charlas: contesta por el número del bot, pausa el bot,
// borra charlas y carga contactos nuevos.
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
  // Perfil de WhatsApp del bot: se pide al entrar a Precios y ajustes; fotoNueva es la elegida sin guardar
  let perfilCargado = false;
  let fotoNueva = null;
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
  // Las contadas llevan los kilos estimados, con cuántas de ese tipo hacen un kilo (pestaña Precios)
  const cantidadDe = (p) => {
    if (p.modo !== 'u') return kilos(p.cantidad);
    const t = (cfg.monedas || []).find((x) => x.n === p.tipo);
    return Number(p.cantidad).toLocaleString('es-AR') + (p.tipo && !esLlave(p) ? ' de ' + p.tipo : ' unidades') +
      (t && t.kg > 0 ? ' (≈ ' + kilos(p.cantidad / t.kg) + ')' : '');
  };
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

  function traerDatos() {
    const { hoy } = ahoraAR();

    // Los pedidos abiertos todos; los cerrados, los de los últimos dos meses.
    return Promise.all([
      sb.from('walter_config').select('data, actualizado').eq('id', 1).maybeSingle(),
      sb.from('walter_pedidos').select('*')
        .or('estado.in.(nuevo,agendado),creado.gte.' + sumarDias(hoy, -60))
        .order('creado', { ascending: false })
        .limit(1000),
      sb.from('walter_conversaciones')
        .select('canal, usuario, nombre_perfil, localidad, estado, pide_humano, bot_pausado, actualizado')
        .order('pide_humano', { ascending: false })
        .order('actualizado', { ascending: false })
        .limit(300),
      sb.from('walter_rutas').select('dia, turno, paradas, aprobada').gte('dia', sumarDias(hoy, -30))
    ]);
  }

  async function cargar() {
    if (cargando) return false;
    cargando = true;
    let respuestas = await traerDatos();
    // Al volver de una compu dormida la pestaña consulta antes de que se
    // renueve la sesión, y todo vuelve 401 "JWT expired". Se renueva y se
    // reintenta una vez, en vez de mostrar el error hasta la próxima vuelta.
    if (respuestas.some((x) => x.status === 401)) {
      const { error: errSesion } = await sb.auth.refreshSession();
      if (!errSesion) respuestas = await traerDatos();
    }
    cargando = false;
    const [rc, rp, rch, rr] = respuestas;

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
    if (nombre === 'precios' && !perfilCargado) cargarPerfil();
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
      return {
        clase: 'chip-atendido', chip: 'Confirmó',
        texto: p.aviso_enviado ? 'Le avisamos el ' + fechaHora(p.aviso_enviado) + '.' : 'Le dijimos el día y le quedó bien.'
      };
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
    // El aviso del día sale apenas se pone el día, si el cliente escribió en las últimas 24 horas
    const yaSabe = p.aviso_dia === 'enviado' ? 'Ya le dijimos el día. ' : '';
    const deManana = p.turno === 'Mañana';
    const diaAviso = deManana ? sumarDias(p.dia, -1) : p.dia;
    const hora = (deManana ? cfg.horaNoche : cfg.horaManana) || (deManana ? '21:00' : '09:00');

    if (diaAviso > hoy) {
      const cuando = diaAviso === sumarDias(hoy, 1) ? 'mañana' : 'el ' + nombreDia(diaAviso);
      return { clase: 'chip-nuevo', chip: 'Programado', texto: yaSabe + 'El recordatorio sale ' + cuando + ' a las ' + hora + '.' };
    }
    if (diaAviso === hoy) {
      return {
        clase: 'chip-nuevo', chip: 'Programado',
        texto: yaSabe + (hhmm < hora ? 'El recordatorio sale hoy a las ' + hora + '.' : 'El recordatorio sale en los próximos minutos.')
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

  // Modo para todas las charlas: automático (contesta el bot) o manual (contesta Walter)
  function pintarModo() {
    const manual = cfg.modo === 'manual';
    $('mModo').classList.toggle('manual', manual);
    $('mModoTitulo').textContent = manual ? 'Modo manual: contestás vos' : 'Modo automático: contesta el bot';
    $('mModoTexto').textContent = manual
      ? 'El bot no contesta ninguna charla. Los mensajes te llegan acá.'
      : 'El bot atiende todas las charlas, salvo las que tomás vos.';
    $('mBtnModo').textContent = manual ? 'Volver a automático' : 'Pasar a manual';
    pintarAvisos();
  }

  async function cambiarModo() {
    const manual = cfg.modo !== 'manual';
    if (manual && !confirm('¿Pasar a modo manual?\n\nEl bot deja de contestar en todas las charlas hasta que vuelvas a automático.')) return;
    $('mBtnModo').disabled = true;
    const { data, error } = await sb
      .from('walter_config')
      .update({ data: Object.assign({}, cfg, { modo: manual ? 'manual' : 'auto' }), actualizado: new Date().toISOString() })
      .eq('id', 1)
      .select('data, actualizado')
      .maybeSingle();
    $('mBtnModo').disabled = false;
    if (error || !data) return toast('No se pudo cambiar el modo' + (error ? ': ' + error.message : '.'));
    cfg = data.data;
    cfgActualizado = data.actualizado;
    pintarModo();
    toast(manual ? 'Modo manual: el bot no contesta' : 'Modo automático: contesta el bot');
  }

  function pintarCharlas() {
    pintarModo();
    const visibles = charlas.filter((c) => filtroCharlas === 'todas' ||
      (filtroCharlas === 'vos' ? c.bot_pausado : c.pide_humano));

    $('mCuerpoCharlas').innerHTML = visibles.map((c) =>
      '<tr data-canal="' + escapar(c.canal) + '" data-usuario="' + escapar(c.usuario) + '">' +
        '<td>' +
          '<div class="nombre-lead">' + escapar(nombreCharla(c)) + '</div>' +
          '<div class="dato-secundario">' +
            escapar(PASOS[c.estado && c.estado.step] || (c.estado ? '' : c.localidad || 'Contacto cargado a mano')) + '</div>' +
        '</td>' +
        '<td class="opcional">' + escapar(canalDe(c.canal)) + '</td>' +
        '<td class="opcional dato-secundario">' + escapar(fecha(c.actualizado)) + '</td>' +
        '<td>' +
          (c.pide_humano
            ? '<span class="chip chip-pendiente">' + (c.bot_pausado ? 'Te escribió' : 'Quiere hablar con vos') + '</span>'
            : c.bot_pausado
            ? '<span class="chip chip-nuevo">La atendés vos</span>'
            : '<span class="chip chip-atendido">La atiende el bot</span>') +
        '</td>' +
      '</tr>').join('');

    if (visibles.length) return ocultar($('mSinCharlas'));
    $('mSinCharlas').innerHTML = filtroCharlas === 'humano'
      ? '<strong>Nadie está esperando que le escribas</strong>' +
          'Cuando alguien le pida al bot hablar con Walter, aparece acá.'
      : filtroCharlas === 'vos'
      ? '<strong>No estás atendiendo ninguna charla</strong>' +
          'Cuando le escribas a alguien desde acá, el bot se calla en esa charla y aparece en esta lista.'
      : '<strong>Todavía no hay charlas</strong>Van a aparecer apenas alguien escriba.';
    ver($('mSinCharlas'));
  }

  // Meta deja escribir libre hasta 24 horas después del último mensaje del cliente.
  const VENTANA = 24 * 60 * 60 * 1000;
  let ultimoDelCliente = null;

  function pintarFichaEstado() {
    const c = charlaAbierta;
    if (!c) return;
    $('mBtnAtendida').classList.toggle('hidden', !c.pide_humano);
    $('mBtnPausa').textContent = c.bot_pausado ? 'Devolverle la charla al bot' : 'Atenderla yo (pausar el bot)';
    $('mChipBot').className = 'chip ' + (c.bot_pausado ? 'chip-nuevo' : 'chip-atendido');
    $('mChipBot').textContent = c.bot_pausado ? 'La atendés vos' : 'La atiende el bot';

    const abierta = ultimoDelCliente && Date.now() - new Date(ultimoDelCliente).getTime() < VENTANA;
    $('mRespuesta').disabled = !abierta;
    $('mEnviar').disabled = !abierta;
    // Las fotos y los audios salen solo por WhatsApp
    $('mFotoBtn').classList.toggle('hidden', !abierta || c.canal !== 'whatsapp');
    $('mAudioBtn').classList.toggle('hidden', !abierta || c.canal !== 'whatsapp' || !puedeGrabar());
    $('mVentana').textContent = abierta
      ? 'Sale por el número del bot. Mientras atendés vos, el bot no contesta.'
      : ultimoDelCliente
      ? 'Pasaron más de 24 horas desde su último mensaje: WhatsApp no deja escribirle hasta que vuelva a escribir.'
      : 'Todavía no te escribió: WhatsApp solo deja escribirle primero con el saludo aprobado.';
  }

  // Lo que queda como texto de una foto o un audio sin epígrafe: en la burbuja se ve el archivo
  const SOLO_ETIQUETA = /^\[(Foto|Audio|Video|Archivo|Sticker)\]$/;
  const NOMBRE_MEDIO = { imagen: 'la foto', audio: 'el audio', video: 'el video', documento: 'el archivo', sticker: 'el sticker' };

  // El archivo va sin link: ponerMedios le pone uno firmado después de pintar la charla
  // Los archivos se borran solos a los 30 días (limpiarMedios en walter-bot)
  const DIAS_MEDIOS = 30;
  function htmlMedio(m) {
    if (!m.media_tipo) return '';
    if (!m.media_path) {
      const vencido = Date.now() - new Date(m.creado).getTime() > DIAS_MEDIOS * 24 * 60 * 60 * 1000;
      return '<span class="medio-falta">' + (vencido
        ? 'Se borró ' + NOMBRE_MEDIO[m.media_tipo] + ' a los ' + DIAS_MEDIOS + ' días para no ocupar lugar.'
        : 'No se pudo bajar ' + NOMBRE_MEDIO[m.media_tipo] + '.') + '</span>';
    }
    const p = escapar(m.media_path).replace(/"/g, '&quot;');
    // Bajar: el mismo link firmado, pero el navegador lo guarda en vez de abrirlo
    const bajar = '<a class="medio-link" data-bajar="' + p + '">Bajar</a>';
    if (m.media_tipo === 'imagen' || m.media_tipo === 'sticker') {
      return '<a class="medio" data-medio="' + p + '" target="_blank" rel="noopener"><img alt="Foto" data-medio="' + p + '"></a>' + bajar;
    }
    if (m.media_tipo === 'audio') {
      return '<audio controls preload="metadata" data-medio="' + p + '"></audio>' +
        '<a class="medio-link" data-medio="' + p + '" target="_blank" rel="noopener">Abrir el audio</a>' + bajar;
    }
    if (m.media_tipo === 'video') return '<video controls playsinline preload="metadata" data-medio="' + p + '"></video>' + bajar;
    return '<a class="medio-link" data-medio="' + p + '" target="_blank" rel="noopener">Abrir el archivo</a>' + bajar;
  }

  function htmlBurbuja(m) {
    const clase = m.direccion === 'entra' ? 'de-cliente' : m.autor === 'walter' ? 'de-walter' : 'de-bot';
    const quien = m.direccion === 'entra' ? '' : m.autor === 'walter' ? 'Vos · ' : 'Bot · ';
    const texto = m.media_tipo && SOLO_ETIQUETA.test(m.texto || '') ? '' : escapar(m.texto);
    return '<div class="burbuja ' + clase + '">' + htmlMedio(m) + texto +
      '<span class="hora">' + escapar(quien + fechaHora(m.creado)) + '</span></div>';
  }

  // Links firmados de las fotos y audios: valen una hora, se piden de nuevo antes de que venzan
  const linksMedios = {};
  async function ponerMedios(caja, alFinal) {
    const nodos = Array.from(caja.querySelectorAll('[data-medio], [data-bajar]'));
    const faltan = Array.from(new Set(nodos.map((n) => n.dataset.medio || n.dataset.bajar)))
      .filter((p) => !linksMedios[p] || linksMedios[p].hasta < Date.now());
    if (faltan.length) {
      const r = await llamarBot({ accion: 'medios', paths: faltan });
      const hasta = Date.now() + 50 * 60 * 1000;
      Object.keys(r.urls || {}).forEach((p) => { linksMedios[p] = { url: r.urls[p], hasta }; });
    }
    nodos.forEach((n) => {
      const l = linksMedios[n.dataset.medio || n.dataset.bajar];
      if (!l) return;
      // download= hace que Supabase lo mande como descarga, con ese nombre
      if (n.dataset.bajar) n.href = l.url + '&download=' + encodeURIComponent(n.dataset.bajar.split('/').pop());
      else if (n.tagName === 'A') n.href = l.url;
      else {
        // La foto llega después de pintar: si estaba al final, que siga al final
        if (alFinal) n.addEventListener('load', () => { caja.scrollTop = caja.scrollHeight; }, { once: true });
        n.src = l.url;
      }
    });
  }

  // Las últimas 200 líneas alcanzan para entender qué pasó.
  async function cargarMensajes(c) {
    const { data, error } = await sb
      .from('walter_mensajes')
      .select('direccion, texto, creado, autor, media_tipo, media_path')
      .eq('canal', c.canal)
      .eq('usuario', c.usuario)
      .order('id', { ascending: false })
      .limit(200);

    if (charlaAbierta !== c) return;
    const caja = $('mFichaCharla');
    // Si estaba leyendo más arriba, un mensaje nuevo no lo lleva al final
    const alFinal = caja.scrollHeight - caja.scrollTop - caja.clientHeight < 40;
    const lista = (data || []).reverse();
    const ult = lista.filter((m) => m.direccion === 'entra').pop();
    ultimoDelCliente = ult ? ult.creado : null;

    caja.innerHTML = error
      ? '<div class="dato-secundario">No se pudo cargar la conversación.</div>'
      : lista.map(htmlBurbuja).join('') || '<div class="dato-secundario">Sin mensajes.</div>';
    const pegado = alFinal || !caja.dataset.cargada;
    if (pegado) caja.scrollTop = caja.scrollHeight;
    caja.dataset.cargada = '1';
    pintarFichaEstado();
    if (!error) ponerMedios(caja, pegado);
  }

  async function abrirCharla(canal, usuario) {
    const c = charlas.find((x) => x.canal === canal && x.usuario === usuario);
    if (!c) return;
    charlaAbierta = c;
    ultimoDelCliente = null;

    ocultar($('mFichaError'));
    $('mFichaNombre').textContent = nombreCharla(c);
    $('mFichaCanal').textContent = canalDe(canal) + (canal === 'whatsapp' ? ' · +' + usuario : '') +
      (c.localidad ? ' · ' + c.localidad : '');
    // Messenger no tiene el número del bot: ahí sigue la bandeja de Facebook
    $('mBtnAbrir').classList.toggle('hidden', canal !== 'messenger');
    $('mRespuesta').value = '';

    const suyos = pedidos.filter((p) => p.canal === canal && p.usuario === usuario);
    $('mFichaPedidos').innerHTML = suyos.length
      ? suyos.map((p) =>
          '<div class="dato"><span class="k">' + escapar(fechaHora(p.creado)) + '</span>' +
          '<span class="v">' + escapar(materialDe(p) + ' · ' + cantidadDe(p) + ' · ' + plata(p.monto) +
            ' · ' + ESTADOS[p.estado]) + '</span></div>').join('')
      : '<div class="dato"><span class="v dato-secundario">Todavía no hizo ningún pedido.</span></div>';

    $('mFichaCharla').innerHTML = '<div class="dato-secundario">Cargando…</div>';
    delete $('mFichaCharla').dataset.cargada;
    pintarFichaEstado();
    ver($('mTelon'));
    await cargarMensajes(c);
  }

  function cerrarCharla() {
    terminarAudio(false); // si estaba grabando, no se manda
    ocultar($('mTelon'));
    charlaAbierta = null;
  }

  function errorFicha(texto) {
    $('mFichaError').textContent = texto;
    ver($('mFichaError'));
  }

  // Lo que necesita el número del bot (mandar, borrar, contacto nuevo) lo hace
  // walter-bot, que revisa que el usuario esté habilitado.
  async function llamarBot(datos) {
    const { data: s } = await sb.auth.getSession();
    const token = s && s.session && s.session.access_token;
    if (!token) return { error: 'Tu sesión venció. Volvé a entrar.' };
    try {
      const r = await fetch(SUPABASE_URL + '/functions/v1/walter-bot?tarea=panel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, apikey: SUPABASE_ANON_KEY },
        body: JSON.stringify(datos)
      });
      const j = await r.json().catch(() => ({}));
      return r.ok ? j : { error: j.error || 'No se pudo completar (' + r.status + ').' };
    } catch (e) {
      return { error: 'No hay conexión. Probá de nuevo.' };
    }
  }

  async function enviarRespuesta(e) {
    e.preventDefault();
    const c = charlaAbierta;
    const texto = $('mRespuesta').value.trim();
    if (!c || !texto) return;
    ocultar($('mFichaError'));
    $('mEnviar').disabled = true;
    $('mEnviar').textContent = 'Enviando…';

    const r = await llamarBot({ accion: 'enviar', canal: c.canal, usuario: c.usuario, texto });

    $('mEnviar').textContent = 'Enviar';
    if (charlaAbierta !== c) return;
    if (r.error) {
      errorFicha(r.error);
      return pintarFichaEstado();
    }
    $('mRespuesta').value = '';
    c.bot_pausado = true;
    c.pide_humano = false;
    await cargarMensajes(c);
    pintarTarjetas();
    pintarCharlas();
  }

  // La foto se achica a 1280 px y va en JPG: pesa poco (unos 150 KB) y WhatsApp la acepta. Lo que haya
  // escrito en la respuesta va como texto de la foto.
  function elegirFotoCharla() {
    const archivo = $('mFoto').files[0];
    $('mFoto').value = '';
    const c = charlaAbierta;
    if (!archivo || !c) return;
    ocultar($('mFichaError'));
    const url = URL.createObjectURL(archivo);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const escala = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
      const lienzo = document.createElement('canvas');
      lienzo.width = Math.round(img.naturalWidth * escala);
      lienzo.height = Math.round(img.naturalHeight * escala);
      lienzo.getContext('2d').drawImage(img, 0, 0, lienzo.width, lienzo.height);
      enviarFoto(c, lienzo.toDataURL('image/jpeg', 0.75));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      errorFicha('No se pudo abrir esa foto. Probá con otra.');
    };
    img.src = url;
  }

  async function enviarFoto(c, foto) {
    const texto = $('mRespuesta').value.trim();
    $('mEnviar').disabled = true;
    $('mFotoBtn').textContent = 'Enviando foto…';

    const r = await llamarBot({ accion: 'enviar_foto', canal: c.canal, usuario: c.usuario, foto, texto });

    $('mFotoBtn').textContent = 'Foto';
    if (charlaAbierta !== c) return;
    if (r.error) {
      errorFicha(r.error);
      return pintarFichaEstado();
    }
    $('mRespuesta').value = '';
    c.bot_pausado = true;
    c.pide_humano = false;
    await cargarMensajes(c);
    pintarTarjetas();
    pintarCharlas();
  }

  // ---------- Audios desde el panel ----------
  // Se graba con el micrófono y se pasa a MP3 (mono, 64 kbps): WhatsApp no acepta el formato en el que graba
  // Chrome, y el MP3 lo aceptan todos. El conversor (lamejs) se baja la primera vez que se graba.
  const MAX_AUDIO = 5 * 60; // segundos
  const LAMEJS = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';
  let grabacion = null;

  function puedeGrabar() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  }

  function cargarLame() {
    if (window.lamejs) return Promise.resolve();
    return new Promise((ok, mal) => {
      const s = document.createElement('script');
      s.src = LAMEJS;
      s.onload = ok;
      s.onerror = mal;
      document.head.appendChild(s);
    });
  }

  async function tocarAudio() {
    if (grabacion) return terminarAudio(true);
    const c = charlaAbierta;
    if (!c) return;
    ocultar($('mFichaError'));
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      return errorFicha('No se pudo usar el micrófono. Fijate que el navegador tenga permiso.');
    }
    cargarLame().catch(() => {}); // mientras habla
    const rec = new MediaRecorder(stream);
    const partes = [];
    rec.ondataavailable = (e) => { if (e.data.size) partes.push(e.data); };
    const inicio = Date.now();
    const g = { c, rec, stream, partes, enviar: false };
    grabacion = g;
    g.reloj = setInterval(() => {
      const s = Math.floor((Date.now() - inicio) / 1000);
      $('mAudioBtn').textContent = 'Enviar audio (' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') + ')';
      if (s >= MAX_AUDIO) terminarAudio(true);
    }, 250);
    rec.onstop = () => audioGrabado(g);
    rec.start();
    $('mAudioBtn').classList.add('grabando');
    $('mAudioBtn').textContent = 'Enviar audio (0:00)';
    mostrar($('mAudioCancelar'));
  }

  function terminarAudio(enviar) {
    const g = grabacion;
    if (!g) return;
    grabacion = null;
    g.enviar = enviar;
    clearInterval(g.reloj);
    if (g.rec.state !== 'inactive') g.rec.stop();
    g.stream.getTracks().forEach((t) => t.stop());
    $('mAudioBtn').classList.remove('grabando');
    $('mAudioBtn').textContent = 'Grabar audio';
    ocultar($('mAudioCancelar'));
  }

  async function audioGrabado(g) {
    if (!g.enviar || !g.partes.length) return;
    $('mAudioBtn').disabled = true;
    $('mAudioBtn').textContent = 'Enviando audio…';
    try {
      await cargarLame();
      const mp3 = await aMp3(new Blob(g.partes, { type: g.rec.mimeType }));
      const audio = await new Promise((ok) => {
        const fr = new FileReader();
        fr.onload = () => ok(fr.result);
        fr.readAsDataURL(mp3);
      });
      const r = await llamarBot({ accion: 'enviar_audio', canal: g.c.canal, usuario: g.c.usuario, audio });
      if (charlaAbierta !== g.c) return;
      if (r.error) return errorFicha(r.error);
      g.c.bot_pausado = true;
      g.c.pide_humano = false;
      await cargarMensajes(g.c);
      pintarTarjetas();
      pintarCharlas();
    } catch (e) {
      errorFicha('No se pudo preparar el audio. Probá de nuevo.');
    } finally {
      $('mAudioBtn').disabled = false;
      $('mAudioBtn').textContent = 'Grabar audio';
      if (charlaAbierta === g.c) pintarFichaEstado();
    }
  }

  // Lo grabado (webm, ogg o mp4 según el navegador) pasa a MP3 mono de 16 kHz: alcanza para la voz y pesa poco
  async function aMp3(blob) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const datos = await blob.arrayBuffer();
    // Safari viejo no devuelve promesa: con los callbacks anda en todos
    const buf = await new Promise((ok, mal) => ctx.decodeAudioData(datos, ok, mal));
    ctx.close();
    // Mezcla a mono y baja a 16 kHz promediando
    const HZ = 16000;
    const paso = buf.sampleRate / HZ;
    const largo = Math.floor(buf.length / paso);
    const canales = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
    const pcm = new Int16Array(largo);
    for (let i = 0; i < largo; i++) {
      const desde = Math.floor(i * paso), hasta = Math.max(desde + 1, Math.floor((i + 1) * paso));
      let suma = 0, n = 0;
      for (const ch of canales) for (let j = desde; j < hasta && j < ch.length; j++) { suma += ch[j]; n++; }
      const v = Math.max(-1, Math.min(1, n ? suma / n : 0));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    const enc = new window.lamejs.Mp3Encoder(1, HZ, 64);
    const partes = [];
    for (let i = 0; i < pcm.length; i += 1152) {
      const b = enc.encodeBuffer(pcm.subarray(i, i + 1152));
      if (b.length) partes.push(new Uint8Array(b));
    }
    const fin = enc.flush();
    if (fin.length) partes.push(new Uint8Array(fin));
    return new Blob(partes, { type: 'audio/mpeg' });
  }

  async function cambiarPausa() {
    const c = charlaAbierta;
    if (!c) return;
    const pausar = !c.bot_pausado;
    $('mBtnPausa').disabled = true;
    ocultar($('mFichaError'));

    const { data, error } = await sb
      .from('walter_conversaciones')
      .update(pausar ? { bot_pausado: true } : { bot_pausado: false, pide_humano: false })
      .eq('canal', c.canal)
      .eq('usuario', c.usuario)
      .select('bot_pausado, pide_humano')
      .maybeSingle();

    $('mBtnPausa').disabled = false;
    if (error || !data) return errorFicha('No se pudo guardar' + (error ? ': ' + error.message : '.'));
    c.bot_pausado = data.bot_pausado;
    c.pide_humano = data.pide_humano;
    pintarFichaEstado();
    pintarTarjetas();
    pintarCharlas();
    toast(pausar ? 'El bot no va a contestar en esta charla' : 'La charla vuelve a atenderla el bot');
  }

  async function borrarCharla() {
    const c = charlaAbierta;
    if (!c) return;
    if (!confirm('¿Eliminar la charla con ' + nombreCharla(c) + '?\n\nSe borran todos los mensajes. Los pedidos quedan.')) return;
    $('mBtnBorrar').disabled = true;
    ocultar($('mFichaError'));
    const r = await llamarBot({ accion: 'borrar', canal: c.canal, usuario: c.usuario });
    $('mBtnBorrar').disabled = false;
    if (r.error) return errorFicha(r.error);
    charlas = charlas.filter((x) => x !== c);
    cerrarCharla();
    pintarTarjetas();
    pintarCharlas();
    toast('Charla eliminada');
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
    if (error || !data) return errorFicha('No se pudo guardar' + (error ? ': ' + error.message : '.'));

    c.pide_humano = false;
    cerrarCharla();
    pintarTarjetas();
    pintarCharlas();
    toast('Listo');
  }

  function abrirAfuera() {
    window.open('https://business.facebook.com/latest/inbox/all', '_blank', 'noopener');
  }

  // ---------------------------------------------------------- contacto nuevo

  function abrirContacto() {
    $('mFormContacto').reset();
    $('mContactoSaludar').checked = true;
    $('mLocalidades').innerHTML = Object.keys(LOCALIDADES).map((l) => '<option value="' + escapar(l) + '">').join('');
    ocultar($('mContactoError'));
    ver($('mTelonContacto'));
    $('mContactoNombre').focus();
  }

  function cerrarContacto() {
    ocultar($('mTelonContacto'));
  }

  async function guardarContacto(e) {
    e.preventDefault();
    const nombre = $('mContactoNombre').value.trim();
    const numero = $('mContactoNumero').value.trim();
    const falta = !nombre ? 'Poné el nombre.' : !numero ? 'Poné el número de WhatsApp.' : '';
    if (falta) {
      $('mContactoError').textContent = falta;
      return ver($('mContactoError'));
    }
    ocultar($('mContactoError'));
    const boton = $('mGuardarContacto');
    boton.disabled = true;
    boton.textContent = 'Guardando…';

    const r = await llamarBot({
      accion: 'contacto', nombre, numero,
      localidad: $('mContactoLocalidad').value.trim(), saludar: $('mContactoSaludar').checked
    });

    boton.disabled = false;
    boton.textContent = 'Guardar contacto';
    if (r.error) {
      $('mContactoError').textContent = r.error;
      return ver($('mContactoError'));
    }

    cerrarContacto();
    await cargar();
    filtroCharlas = 'todas';
    marcarFiltro('mFiltrosCharlas', 'todas');
    mostrarPestana('charlas');
    toast(r.saludo === false
      ? 'Contacto guardado. El saludo no salió: Meta todavía no aprobó ese mensaje.'
      : r.saludo ? 'Contacto guardado y saludo enviado' : 'Contacto guardado');
    abrirCharla('whatsapp', r.usuario);
  }

  // ---------------------------------------------------------- perfil de WhatsApp

  function pintarFotoPerfil(src) {
    $('mPerfilImg').classList.toggle('hidden', !src);
    $('mPerfilSinFoto').classList.toggle('hidden', !!src);
    if (src) $('mPerfilImg').src = src;
  }

  async function cargarPerfil() {
    perfilCargado = true;
    ver($('mPerfilCargando'));
    ocultar($('mPerfilError'));
    const r = await llamarBot({ accion: 'perfil' });
    ocultar($('mPerfilCargando'));
    if (r.error) {
      perfilCargado = false;
      $('mPerfilError').textContent = r.error;
      return ver($('mPerfilError'));
    }
    fotoNueva = null;
    pintarFotoPerfil(r.foto);
    $('mPerfilAbout').value = r.about || '';
    $('mPerfilDescripcion').value = r.description || '';
    $('mPerfilDireccion').value = r.address || '';
    $('mPerfilEmail').value = r.email || '';
    $('mPerfilWeb').value = r.website || '';
    $('mPerfilEstado').textContent = '';
  }

  // La foto se recorta cuadrada y se achica a 640 px antes de mandarla: así pesa poco
  // y WhatsApp la acepta (pide al menos 192 px).
  function elegirFoto() {
    const archivo = $('mPerfilArchivo').files[0];
    $('mPerfilArchivo').value = '';
    if (!archivo) return;
    ocultar($('mPerfilError'));
    if (!/^image\/(jpeg|png)$/.test(archivo.type)) {
      $('mPerfilError').textContent = 'La foto tiene que ser JPG o PNG.';
      return ver($('mPerfilError'));
    }
    const url = URL.createObjectURL(archivo);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const lado = Math.min(img.naturalWidth, img.naturalHeight);
      if (lado < 192) {
        $('mPerfilError').textContent = 'La foto es muy chica: tiene que tener al menos 192 píxeles de lado.';
        return ver($('mPerfilError'));
      }
      const final = Math.min(640, lado);
      const lienzo = document.createElement('canvas');
      lienzo.width = lienzo.height = final;
      lienzo.getContext('2d').drawImage(img, (img.naturalWidth - lado) / 2, (img.naturalHeight - lado) / 2, lado, lado, 0, 0, final, final);
      fotoNueva = lienzo.toDataURL('image/jpeg', 0.88);
      pintarFotoPerfil(fotoNueva);
      $('mPerfilEstado').textContent = 'Foto nueva sin guardar';
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      $('mPerfilError').textContent = 'No se pudo abrir esa foto. Probá con otra.';
      ver($('mPerfilError'));
    };
    img.src = url;
  }

  async function guardarPerfil() {
    ocultar($('mPerfilError'));
    const boton = $('mGuardarPerfil');
    boton.disabled = true;
    boton.textContent = 'Guardando…';
    const r = await llamarBot({
      accion: 'perfil_guardar', foto: fotoNueva,
      about: $('mPerfilAbout').value, description: $('mPerfilDescripcion').value,
      address: $('mPerfilDireccion').value, email: $('mPerfilEmail').value, website: $('mPerfilWeb').value
    });
    boton.disabled = false;
    boton.textContent = 'Guardar perfil';
    if (r.error) {
      $('mPerfilError').textContent = r.error;
      return ver($('mPerfilError'));
    }
    toast('Perfil de WhatsApp guardado');
    await cargarPerfil();
    $('mPerfilEstado').textContent = 'Guardado. WhatsApp puede tardar unos minutos en mostrarlo.';
  }

  // ---------------------------------------------------------- en vivo

  // Realtime avisa cuando entra un mensaje, un pedido o cambia una charla. Se
  // junta lo que llega seguido y se trae todo de nuevo una sola vez.
  let relojVivo = null;
  function cambioEnVivo(cambio) {
    const fila = cambio.new && Object.keys(cambio.new).length ? cambio.new : cambio.old || {};
    if (cambio.table === 'walter_mensajes' && cambio.eventType === 'INSERT' && fila.direccion === 'entra') avisar(fila);
    const c = charlaAbierta;
    if (c && cambio.table === 'walter_mensajes' && fila.canal === c.canal && fila.usuario === c.usuario) {
      cargarMensajes(c);
    }
    clearTimeout(relojVivo);
    relojVivo = setTimeout(async () => {
      // Si está escribiendo un precio o eligiendo un día, no le redibuja nada encima
      const activo = document.activeElement;
      if (activo && activo.closest && activo.closest('#vistaMonedas input, #vistaMonedas select, #vistaMonedas textarea')) return;
      if (!(await cargar())) return;
      if (charlaAbierta) {
        const nueva = charlas.find((x) => x.canal === charlaAbierta.canal && x.usuario === charlaAbierta.usuario);
        if (nueva) { Object.assign(charlaAbierta, nueva); pintarFichaEstado(); }
      }
      pintar();
    }, 800);
  }

  function escucharEnVivo() {
    const canal = sb.channel('walter-panel');
    ['walter_mensajes', 'walter_pedidos', 'walter_conversaciones'].forEach((tabla) => {
      canal.on('postgres_changes', { event: '*', schema: 'public', table: tabla }, (cambio) => {
        cambioEnVivo(Object.assign({ table: tabla }, cambio));
      });
    });
    canal.subscribe();
  }

  // ---------------------------------------------------------- avisos

  // Avisa cuando escribe un cliente, aunque el panel esté en otra pestaña o minimizado.
  // Necesita el panel abierto: con el navegador cerrado no llega nada.
  const AVISOS_KEY = 'walter-avisos';
  function avisosActivos() {
    try { return 'Notification' in window && Notification.permission === 'granted' && localStorage.getItem(AVISOS_KEY) !== 'no'; }
    catch (e) { return false; }
  }

  function pintarAvisos() {
    const b = $('mBtnAvisos');
    if (!('Notification' in window)) return ocultar(b);
    b.textContent = avisosActivos() ? '🔔 Avisos activados' : '🔕 Activar avisos';
  }

  async function activarAvisos() {
    if (avisosActivos()) {
      try { localStorage.setItem(AVISOS_KEY, 'no'); } catch (e) { /* sin guardado, igual se apaga hasta recargar */ }
      pintarAvisos();
      return toast('Avisos apagados');
    }
    const permiso = await Notification.requestPermission();
    try { localStorage.removeItem(AVISOS_KEY); } catch (e) { /* nada */ }
    pintarAvisos();
    if (permiso !== 'granted') return toast('El navegador no dio permiso. Activalo en la configuración del sitio.');
    sonar();
    toast('Listo: te avisa cuando escriba un cliente');
  }

  function sonar() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.15, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.4);
    } catch (e) { /* sin sonido */ }
  }

  async function avisar(m) {
    if (!avisosActivos()) return;
    const abierta = charlaAbierta && charlaAbierta.canal === m.canal && charlaAbierta.usuario === m.usuario;
    if (abierta && !document.hidden) return;
    const c = charlas.find((x) => x.canal === m.canal && x.usuario === m.usuario);
    const titulo = c ? nombreCharla(c) : m.canal === 'whatsapp' ? '+' + m.usuario : 'Cliente nuevo';
    const cuerpo = SOLO_ETIQUETA.test(m.texto || '') ? 'Mandó ' + NOMBRE_MEDIO[m.media_tipo] : m.texto;
    sonar();
    const opciones = { body: cuerpo, tag: m.canal + ':' + m.usuario, icon: '/icon-192.png' };
    try {
      const n = new Notification(titulo, opciones);
      n.onclick = () => { window.focus(); mostrarPestana('charlas'); abrirCharla(m.canal, m.usuario); n.close(); };
    } catch (e) {
      // En el celu (Android) solo se puede avisar a través del service worker
      try {
        const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
        if (reg) reg.showNotification(titulo, opciones);
      } catch (e2) { /* sin aviso */ }
    }
  }

  // ---------------------------------------------------------- copia de seguridad

  // Un CSV que abre bien en Excel: separado por punto y coma y con BOM para los acentos
  function bajarCsv(nombre, filas) {
    const celda = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const texto = '\ufeff' + filas.map((f) => f.map(celda).join(';')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([texto], { type: 'text/csv;charset=utf-8' }));
    a.download = nombre + '-' + ahoraAR().hoy + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // Todas las filas de una tabla, de a mil
  async function todo(tabla, columnas) {
    const filas = [];
    for (let desde = 0; desde < 50000; desde += 1000) {
      const { data, error } = await sb.from(tabla).select(columnas).order('id').range(desde, desde + 999);
      if (error) throw error;
      filas.push(...data);
      if (data.length < 1000) break;
    }
    return filas;
  }

  async function copiaCharlas() {
    const b = $('mCopiaCharlas');
    b.disabled = true;
    try {
      const mensajes = await todo('walter_mensajes', 'id, creado, canal, usuario, direccion, autor, texto, media_tipo');
      const nombres = {};
      charlas.forEach((c) => { nombres[c.canal + ':' + c.usuario] = nombreCharla(c); });
      bajarCsv('charlas', [['Fecha', 'Cliente', 'Número', 'Canal', 'Quién', 'Mensaje', 'Archivo']].concat(mensajes.map((m) => [
        fechaHora(m.creado), nombres[m.canal + ':' + m.usuario] || '', m.canal === 'whatsapp' ? '+' + m.usuario : m.usuario,
        canalDe(m.canal), m.direccion === 'entra' ? 'Cliente' : m.autor === 'walter' ? 'Walter' : 'Bot', m.texto, m.media_tipo || ''
      ])));
    } catch (e) {
      toast('No se pudo armar la copia: ' + (e.message || e));
    }
    b.disabled = false;
  }

  async function copiaPedidos() {
    const b = $('mCopiaPedidos');
    b.disabled = true;
    try {
      const lista = await todo('walter_pedidos', '*');
      bajarCsv('pedidos', [['Fecha', 'Nombre', 'Número', 'Localidad', 'Material', 'Cantidad', 'Monto', 'Entrega', 'Dirección', 'Día', 'Turno', 'Estado']]
        .concat(lista.map((p) => [
          fechaHora(p.creado), p.nombre, p.canal === 'whatsapp' ? '+' + p.usuario : p.usuario, p.localidad, materialDe(p), cantidadDe(p),
          Math.round(p.monto || 0), p.retiro, p.direccion || '', p.dia || '', p.turno || '', ESTADOS[p.estado] || p.estado
        ])));
    } catch (e) {
      toast('No se pudo armar la copia: ' + (e.message || e));
    }
    b.disabled = false;
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
      if (e.key !== 'Escape') return;
      if (!$('mTelonContacto').classList.contains('hidden')) cerrarContacto();
      else if (!$('mTelon').classList.contains('hidden')) cerrarCharla();
    });
    $('mBtnAtendida').addEventListener('click', marcarAtendida);
    $('mBtnAbrir').addEventListener('click', abrirAfuera);
    $('mBtnPausa').addEventListener('click', cambiarPausa);
    $('mBtnBorrar').addEventListener('click', borrarCharla);
    $('mFormResponder').addEventListener('submit', enviarRespuesta);
    $('mFoto').addEventListener('change', elegirFotoCharla);
    $('mAudioBtn').addEventListener('click', tocarAudio);
    $('mAudioCancelar').addEventListener('click', () => terminarAudio(false));
    // Enter manda, como en WhatsApp; Shift+Enter hace otro renglón
    $('mRespuesta').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) enviarRespuesta(e);
    });
    $('mBtnModo').addEventListener('click', cambiarModo);
    $('mBtnAvisos').addEventListener('click', activarAvisos);
    $('mCopiaCharlas').addEventListener('click', copiaCharlas);
    $('mCopiaPedidos').addEventListener('click', copiaPedidos);

    $('mNuevoContacto').addEventListener('click', abrirContacto);
    $('mCerrarContacto').addEventListener('click', cerrarContacto);
    $('mTelonContacto').addEventListener('click', (e) => { if (e.target === $('mTelonContacto')) cerrarContacto(); });
    $('mFormContacto').addEventListener('submit', guardarContacto);

    $('mFormPrecios').addEventListener('input', marcarPreciosEditados);
    $('mAgregarTipo').addEventListener('click', agregarTipo);
    $('mTiposMoneda').addEventListener('click', quitarTipo);
    $('mFormPrecios').addEventListener('submit', guardarPrecios);

    $('mPerfilArchivo').addEventListener('change', elegirFoto);
    $('mGuardarPerfil').addEventListener('click', guardarPerfil);

    // Los pedidos entran solos: al volver a la pestaña del navegador, y cada
    // dos minutos si no hay nada a medio editar, se traen de nuevo.
    const enUso = () => $('vistaMonedas').classList.contains('hidden') ||
      !$('mTelon').classList.contains('hidden') || !$('mTelonContacto').classList.contains('hidden') ||
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
      escucharEnVivo();
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
