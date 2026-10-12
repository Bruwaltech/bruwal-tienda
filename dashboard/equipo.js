// =============================================================================
// USUARIOS DEL EQUIPO — cada empleado entra al panel con SU usuario y contraseña
// =============================================================================
//
// Vive en un archivo aparte a proposito: dashboard/index.html tiene 25.000
// lineas y una funcion la usan cinco pantallas. Aca esta todo lo nuevo, y en
// index.html solo hay tres ganchos chicos (buscar "equipo.js" y "equipoMiembro").
//
// Se carga en el <head>, ANTES del script principal, asi sus funciones ya
// existen cuando onLoggedIn() las necesita. Usa las globales del panel (sb,
// byId, show, hide, escapeHtml, currentStore...) solo adentro de funciones
// que corren despues de la carga.
//
// Como funciona:
//  - Base: schema/60-equipo-usuarios.sql (tabla store_miembros + politicas).
//    La seguridad de verdad esta ahi, no aca: esconder una solapa es comodidad;
//    lo que el cajero no puede hacer, la base no se lo deja hacer aunque abra
//    la consola del navegador.
//  - Las cuentas las crea la Edge Function `equipo` (supabase/functions/equipo).
//  - El empleado entra con local + usuario + contraseña. Por debajo es un mail
//    armado con emailDeEquipo(), que nunca recibe correo.
// =============================================================================

// La fila de store_miembros de quien entro, o null si entro el dueño.
// `var` y no `let`: index.html la lee como window.equipoMiembro, y asi sigue
// andando (como dueño) aunque este archivo no haya llegado a cargar.
var equipoMiembro = null;

const EQUIPO_DOMINIO = 'equipo.bruwaltech.com.ar';   // igual que en la Edge Function
const EQUIPO_LS_LOCAL = 'bruwal_equipo_local';
const EQUIPO_LS_RECIENTES = 'bruwal_equipo_recientes';

// Que puede hacer cada uno. `solapas` = que pestañas del panel le abre.
const EQUIPO_PERMISOS = [
  { clave: 'vender',       icono: '🧾', titulo: 'Vender en el mostrador',
    ayuda: 'Carga ventas y cobra. Descuenta stock, pero no puede cambiar precios.' },
  { clave: 'pedidos',      icono: '🛵', titulo: 'Ver y atender pedidos',
    ayuda: 'Ve los pedidos de la tienda online y del mostrador, y los marca como listos o entregados.' },
  { clave: 'cocina',       icono: '👨‍🍳', titulo: 'Cocina',
    ayuda: 'Ve los pedidos para prepararlos y los marca como listos. No ve plata.' },
  { clave: 'fiado',        icono: '📒', titulo: 'Cuentas corrientes (fiado)',
    ayuda: 'Anota fiados, cobra deudas y manda el estado de cuenta por WhatsApp.' },
  { clave: 'caja',         icono: '💰', titulo: 'Caja y gastos',
    ayuda: 'Ve cuánto entró en el día, hace el cierre de caja y carga gastos.' },
  { clave: 'productos',    icono: '🏷️', titulo: 'Productos y precios',
    ayuda: 'Carga productos nuevos y cambia precios, fotos y stock.' },
  { clave: 'anular',       icono: '↩️', titulo: 'Anular ventas',
    ayuda: 'Puede borrar una venta ya hecha (el stock vuelve).' },
  { clave: 'reparaciones', icono: '🔧', titulo: 'Reparaciones',
    ayuda: 'Toma equipos para reparar y les cambia el estado.',
    disponible: () => typeof rubroEsElectronica === 'function' && rubroEsElectronica() },
  { clave: 'turnos',       icono: '📅', titulo: 'Agenda de turnos',
    ayuda: 'Ve la agenda, confirma y cancela turnos.',
    disponible: () => !!(currentStore && currentStore.turnos && currentStore.turnos.activo) }
];

const EQUIPO_ROLES = {
  encargado: {
    icono: '🧑‍💼', titulo: 'Encargado', bajada: 'Maneja el local cuando no estás',
    permisos: ['vender', 'pedidos', 'cocina', 'fiado', 'caja', 'productos', 'anular', 'reparaciones', 'turnos'],
    noVe: 'Configuración, plan, estadísticas, Mercado Libre ni los usuarios del equipo.'
  },
  cajero: {
    icono: '🧾', titulo: 'Cajero', bajada: 'Atiende el mostrador y cobra',
    permisos: ['vender', 'pedidos', 'fiado'],
    noVe: 'La caja del día, los gastos, los costos, ni puede cambiar precios.'
  },
  cocina: {
    icono: '👨‍🍳', titulo: 'Cocina', bajada: 'Prepara los pedidos',
    permisos: ['cocina'],
    noVe: 'Nada de plata: ni ventas, ni caja, ni precios.'
  }
};

// Que permiso abre cada solapa. Las que no estan (o tienen []) son solo del dueño.
const EQUIPO_SOLAPAS = {
  tabDashboard:    ['caja'],
  tabProductos:    ['productos'],
  tabPedidos:      ['pedidos', 'cocina', 'vender'],
  tabAgenda:       ['turnos'],
  tabClientes:     ['fiado'],
  tabVentas:       ['vender'],
  tabCaja:         ['caja'],
  tabEmpleados:    [],
  tabMercadoLibre: [],
  tabEstadisticas: [],
  tabFiado:        ['fiado'],
  tabReparaciones: ['reparaciones'],
  tabGastos:       ['caja']
};

// ---------------------------------------------------------------- utilidades

// "Juan Pérez" -> "juanperez". El mismo criterio que la Edge Function.
function normalizarUsuarioEquipo(u) {
  return String(u || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 30);
}

function emailDeEquipo(usuario, storeId) {
  return normalizarUsuarioEquipo(usuario) + '.' + String(storeId).replace(/-/g, '') + '@' + EQUIPO_DOMINIO;
}

// Acepta el link entero pegado ("bruwaltech.com.ar/dashboard/?local=burger")
// o la tienda ("bruwaltech.com.ar/burger"), ademas del nombre del local solo.
function limpiarLocalEquipo(texto) {
  let t = String(texto || '').trim();
  const porParametro = t.match(/[?&]local=([^&#\s]+)/i);
  if (porParametro) t = decodeURIComponent(porParametro[1]);
  else if (t.includes('/')) t = t.split('/').filter(Boolean).pop() || '';
  return t.toLowerCase().replace(/[^a-z0-9-]/g, '');
}

function equipoPuede(permiso) {
  return !!(equipoMiembro && equipoMiembro.permisos && equipoMiembro.permisos[permiso] === true);
}

function permisosDisponiblesEquipo() {
  return EQUIPO_PERMISOS.filter(p => !p.disponible || p.disponible());
}

function permisosDeRol(rol) {
  const r = EQUIPO_ROLES[rol];
  if (!r) return {};
  const disponibles = permisosDisponiblesEquipo().map(p => p.clave);
  const out = {};
  r.permisos.filter(k => disponibles.includes(k)).forEach(k => { out[k] = true; });
  return out;
}

// Si los permisos coinciden justo con un rol, es ese rol; si no, "personalizado".
function rolDePermisos(permisos) {
  const marcados = Object.keys(permisos).filter(k => permisos[k]).sort().join(',');
  for (const rol of Object.keys(EQUIPO_ROLES)) {
    if (Object.keys(permisosDeRol(rol)).sort().join(',') === marcados) return rol;
  }
  return 'personalizado';
}

function tituloDeRol(rol) {
  const r = EQUIPO_ROLES[rol];
  return r ? r.icono + ' ' + r.titulo : '⚙️ A medida';
}

function lsLeer(clave, porDefecto) {
  try { const v = localStorage.getItem(clave); return v === null ? porDefecto : v; } catch (e) { return porDefecto; }
}
function lsGuardar(clave, valor) {
  try { localStorage.setItem(clave, valor); } catch (e) { /* almacenamiento bloqueado: no pasa nada */ }
}

function recientesEquipo() {
  try { return JSON.parse(lsLeer(EQUIPO_LS_RECIENTES, '[]')) || []; } catch (e) { return []; }
}

function recordarRecienteEquipo(local, usuario, nombre) {
  const lista = recientesEquipo().filter(r => !(r.local === local && r.usuario === usuario));
  lista.unshift({ local, usuario, nombre });
  lsGuardar(EQUIPO_LS_RECIENTES, JSON.stringify(lista.slice(0, 8)));
}

function haceCuantoEquipo(iso) {
  if (!iso) return 'Todavía no entró';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 2) return 'Entró recién';
  if (min < 60) return 'Entró hace ' + min + ' min';
  const h = Math.round(min / 60);
  if (h < 24) return 'Entró hace ' + h + ' h';
  const d = Math.round(h / 24);
  return 'Entró hace ' + d + (d === 1 ? ' día' : ' días');
}

// Contraseña facil de dictar en voz alta: palabra + 4 numeros ("queso4821").
function inventarClaveEquipo() {
  const palabras = ['queso', 'papas', 'burger', 'salsa', 'pepino', 'tomate', 'limon', 'menta',
                    'pancho', 'fritas', 'cebolla', 'pizza', 'mostaza', 'pickle', 'barbacoa', 'cheddar'];
  const n = new Uint32Array(2);
  (window.crypto || window.msCrypto).getRandomValues(n);
  return palabras[n[0] % palabras.length] + String(1000 + (n[1] % 9000));
}

function avisoEquipo(texto, tipo) {
  let caja = byId('eqAviso');
  if (!caja) {
    caja = document.createElement('div');
    caja.id = 'eqAviso';
    document.body.appendChild(caja);
  }
  caja.className = 'eq-aviso ' + (tipo || '');
  caja.innerHTML = texto;
  caja.style.opacity = '1';
  clearTimeout(avisoEquipo.t);
  avisoEquipo.t = setTimeout(() => { caja.style.opacity = '0'; }, tipo === 'largo' ? 9000 : 4500);
}

async function llamarEquipo(accion, datos) {
  const { data, error } = await sb.functions.invoke('equipo', {
    body: Object.assign({ accion, store_slug: currentStore.slug }, datos || {})
  });
  if (error) {
    let msg = 'No se pudo conectar. Revisá internet y probá de nuevo.';
    try {
      const j = await error.context.json();
      if (j && j.error) msg = j.error;
    } catch (e) { /* no vino JSON */ }
    throw new Error(msg);
  }
  return data;
}

// ---------------------------------------------------------------- estilos

function estilosEquipo() {
  if (byId('eqEstilos')) return;
  const s = document.createElement('style');
  s.id = 'eqEstilos';
  s.textContent = `
    /* Lo que es solo del dueño, escondido cuando entra alguien del equipo.
       Es comodidad, no seguridad: la base ya le niega estas cosas. */
    body.modo-equipo #adherirmeBtn, body.modo-equipo #trialBar,
    body.modo-equipo #openConfigBtn, body.modo-equipo #negocioPanel,
    body.modo-equipo #negocioFlecha { display: none !important; }
    body.modo-equipo .negocio-btn { cursor: default; }

    .eq-chip-usuario { display:inline-flex; align-items:center; gap:8px; padding:5px 6px 5px 12px;
      border-radius:999px; background:#EAF4FD; border:1px solid #CFE3F7; font-size:13px; color:var(--navy); }
    .eq-chip-usuario b { font-weight:800; }
    .eq-chip-usuario button { border:none; background:var(--navy); color:#fff; border-radius:999px;
      padding:5px 10px; font-size:12px; font-weight:700; cursor:pointer; font-family:inherit; }
    .eq-chip-usuario { white-space:nowrap; max-width:100%; min-width:0; }
    .eq-chip-usuario .quien { overflow:hidden; text-overflow:ellipsis; min-width:0; flex:1 1 auto; }
    .eq-chip-usuario button { flex-shrink:0; }
    .eq-chip-usuario .corto { display:none; }
    @media (max-width: 600px) {
      .eq-chip-usuario { max-width:190px; }
      .eq-chip-usuario .largo, .eq-chip-usuario .rol { display:none; }
      .eq-chip-usuario .corto { display:inline; }
    }

    .eq-aviso { position:fixed; left:50%; bottom:22px; transform:translateX(-50%); z-index:400;
      max-width:min(520px, calc(100vw - 32px)); background:var(--navy); color:#fff; padding:13px 18px;
      border-radius:12px; font-size:14px; line-height:1.5; box-shadow:0 10px 30px rgba(21,41,77,.3);
      transition:opacity .4s; }
    .eq-aviso.error { background:var(--danger); }
    .eq-aviso.ok { background:var(--stock); }

    .eq-login-intro { background:#EAF4FD; border-radius:10px; padding:11px 13px; font-size:13px;
      color:var(--navy); line-height:1.5; margin-bottom:16px; }
    .eq-local-ok { margin:-6px 0 12px; font-size:12.5px; font-weight:700; color:var(--stock); }
    .eq-local-mal { margin:-6px 0 12px; font-size:12.5px; font-weight:700; color:var(--warn); }
    .eq-recientes { display:flex; flex-wrap:wrap; gap:7px; margin:0 0 14px; }
    .eq-recientes .eq-titulito { width:100%; font-size:12px; color:var(--text-mute); font-weight:600; }
    .eq-reciente { display:inline-flex; align-items:center; gap:7px; border:1.5px solid var(--line); background:#fff;
      border-radius:999px; padding:5px 12px 5px 5px; cursor:pointer; font-family:inherit; font-size:13px;
      font-weight:700; color:var(--navy); }
    .eq-reciente.activo { border-color:var(--celeste); background:#EAF4FD; }
    .eq-avatar { width:28px; height:28px; border-radius:50%; display:inline-flex; align-items:center;
      justify-content:center; font-weight:800; color:#fff; font-size:13px; flex-shrink:0; }
    .eq-avatar.grande { width:42px; height:42px; font-size:17px; }
    .eq-login-ayuda { margin-top:12px; font-size:12px; color:var(--text-mute); text-align:center; line-height:1.5; }

    .eq-pasos-vacio { display:grid; grid-template-columns:repeat(auto-fit, minmax(190px, 1fr)); gap:12px; padding:4px 14px 16px; }
    .eq-paso-vacio { background:var(--bg); border-radius:12px; padding:14px; font-size:13px; line-height:1.5; color:var(--text-mute); }
    .eq-paso-vacio .num { width:26px; height:26px; border-radius:50%; background:var(--celeste); color:#fff;
      display:inline-flex; align-items:center; justify-content:center; font-weight:800; font-size:13px; margin-bottom:8px; }
    .eq-paso-vacio b { color:var(--navy); display:block; margin-bottom:3px; font-size:13.5px; }

    .eq-lista { padding:4px 14px 14px; display:grid; gap:10px; }
    .eq-miembro { display:flex; gap:12px; align-items:center; border:1px solid var(--line); border-radius:12px;
      padding:12px; flex-wrap:wrap; background:#fff; }
    .eq-miembro.pausado { opacity:.6; background:var(--bg); }
    .eq-miembro .datos { flex:1; min-width:160px; }
    .eq-miembro .nombre { font-weight:800; color:var(--navy); font-size:14.5px; }
    .eq-miembro .sub { font-size:12.5px; color:var(--text-mute); margin-top:2px; }
    .eq-pill { display:inline-block; font-size:11.5px; font-weight:800; padding:3px 9px; border-radius:999px;
      background:#EAF4FD; color:var(--navy); margin-left:6px; vertical-align:1px; }
    .eq-pill.pausado { background:#FEF3C7; color:#92400E; }
    .eq-acciones { display:flex; gap:6px; flex-wrap:wrap; }
    .eq-btn { border:1px solid var(--line); background:#fff; color:var(--navy); border-radius:8px; padding:7px 10px;
      font-size:12.5px; font-weight:700; cursor:pointer; font-family:inherit; white-space:nowrap; flex-shrink:0; }
    .eq-btn:hover { border-color:var(--celeste); }
    .eq-btn.peligro { color:var(--danger); }
    .eq-btn.principal { background:var(--navy); color:#fff; border-color:var(--navy); }

    .eq-progreso { display:flex; gap:6px; margin-bottom:16px; }
    .eq-progreso span { flex:1; height:5px; border-radius:3px; background:var(--line); }
    .eq-progreso span.hecho { background:var(--celeste); }
    .eq-paso-titulo { font-size:12px; font-weight:800; color:var(--celeste); text-transform:uppercase;
      letter-spacing:.04em; margin-bottom:4px; }
    .eq-roles { display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:10px; margin:6px 0 12px; }
    .eq-rol { text-align:left; border:2px solid var(--line); border-radius:12px; padding:13px; background:#fff;
      cursor:pointer; font-family:inherit; color:var(--text-dark);
      display:flex; flex-direction:column; align-items:flex-start; justify-content:flex-start; }
    .eq-rol.activo { border-color:var(--celeste); background:#F3F9FF; box-shadow:0 0 0 3px rgba(47,143,224,.15); }
    .eq-rol .ico { font-size:26px; }
    .eq-rol .tit { font-weight:800; color:var(--navy); font-size:15px; margin-top:4px; }
    .eq-rol .baj { font-size:12.5px; color:var(--text-mute); margin-bottom:8px; }
    .eq-rol ul { list-style:none; padding:0; margin:0; font-size:12.2px; line-height:1.55; }
    .eq-rol li.no { color:var(--text-mute); }
    .eq-permisos { border:1px solid var(--line); border-radius:12px; padding:4px 12px; }
    .eq-permiso { display:flex; gap:10px; align-items:flex-start; padding:9px 0; border-bottom:1px solid var(--line); cursor:pointer; }
    .eq-permiso:last-child { border-bottom:none; }
    .eq-permiso input { width:auto; margin-top:3px; }
    .eq-permiso .t { font-weight:700; color:var(--navy); font-size:13.5px; }
    .eq-permiso .a { font-size:12.2px; color:var(--text-mute); line-height:1.45; }
    .eq-pie { display:flex; justify-content:space-between; gap:10px; margin-top:18px; }
    .eq-pie .btn { width:auto; padding:10px 18px; }
    .eq-preview-usuario { font-size:12.5px; color:var(--text-mute); margin-top:6px; }
    .eq-preview-usuario b { color:var(--navy); }
    .eq-error { color:var(--danger); font-size:13px; font-weight:600; margin-top:10px; min-height:1px; }

    .eq-tarjeta { border:2px dashed var(--celeste); border-radius:16px; padding:18px; background:#F7FBFF;
      display:flex; gap:18px; align-items:center; flex-wrap:wrap; }
    .eq-tarjeta .izq { flex:1; min-width:220px; }
    .eq-tarjeta .local { font-size:12px; font-weight:800; color:var(--celeste); text-transform:uppercase; letter-spacing:.05em; }
    .eq-tarjeta .hola { font-size:20px; font-weight:800; color:var(--navy); margin:4px 0 12px; }
    .eq-tarjeta .linea { display:flex; gap:10px; align-items:baseline; font-size:13.5px; margin-bottom:8px; color:var(--text-mute); }
    .eq-tarjeta .linea .n { width:20px; height:20px; border-radius:50%; background:var(--navy); color:#fff; font-size:11px;
      font-weight:800; display:inline-flex; align-items:center; justify-content:center; flex-shrink:0; }
    .eq-tarjeta code { font-family:ui-monospace, Menlo, Consolas, monospace; font-size:15px; font-weight:800; color:var(--navy);
      background:#fff; border:1px solid var(--line); border-radius:6px; padding:2px 8px; word-break:break-all; }
    .eq-tarjeta .qr { background:#fff; padding:8px; border-radius:10px; border:1px solid var(--line); min-width:132px; min-height:132px;
      display:flex; align-items:center; justify-content:center; }
    .eq-tarjeta .rolito { font-size:12.5px; color:var(--text-mute); margin-top:10px; line-height:1.5; }

    /* Seccion "Va a usar el sistema" adentro del formulario de empleado */
    .eq-acceso { border:1.5px solid var(--line); border-radius:12px; padding:12px 13px; margin-bottom:16px; background:#fff; }
    .eq-acceso.prendido { border-color:var(--celeste); background:#F7FBFF; }
    .eq-acceso-tilde { display:flex; gap:10px; align-items:flex-start; cursor:pointer; margin:0; }
    .eq-acceso-tilde input { width:auto; margin-top:3px; }
    .eq-acceso-tilde b { display:block; color:var(--navy); font-size:14px; }
    .eq-acceso-tilde span { display:block; font-size:12px; color:var(--text-mute); line-height:1.45; margin-top:2px; font-weight:400; }
    .eq-acceso-campos { margin-top:12px; }
    .eq-acceso-campos .field { margin-bottom:11px; }
    .eq-roles-chicos { display:flex; gap:6px; flex-wrap:wrap; }
    .eq-rol-chico { border:1.5px solid var(--line); background:#fff; border-radius:999px; padding:7px 12px;
      font-size:13px; font-weight:700; color:var(--navy); cursor:pointer; font-family:inherit; }
    .eq-rol-chico.activo { border-color:var(--celeste); background:#EAF4FD; box-shadow:0 0 0 2px rgba(47,143,224,.15); }
    .eq-rol-explica { font-size:12px; color:var(--text-mute); line-height:1.5; margin-top:7px; }
    .eq-acceso-ya { display:flex; gap:10px; align-items:center; flex-wrap:wrap; font-size:13px; color:var(--navy); }
    .eq-acceso-error { color:var(--danger); font-size:12.5px; font-weight:600; margin-top:6px; }

    /* "🔑 juan" / "🔑 Darle acceso" en la lista de empleados */
    .eq-chip-acceso { border:1px solid #CFE3F7; background:#EAF4FD; color:var(--navy); border-radius:999px;
      padding:4px 9px; font-size:11.5px; font-weight:700; cursor:pointer; font-family:inherit; margin-right:4px; vertical-align:middle; }
    .eq-chip-acceso.nuevo { background:#fff; border-style:dashed; border-color:var(--celeste); color:var(--celeste); }
    .eq-chip-acceso.pausado { background:#FEF3C7; border-color:#FCD34D; color:#92400E; }
  `;
  document.head.appendChild(s);
}

// =============================================================================
// 1) LOGIN DEL EQUIPO (pantalla de ingreso)
// =============================================================================

function montarLoginEquipo() {
  const tabs = document.querySelector('#authView .auth-tabs');
  const loginForm = byId('loginForm');
  if (!tabs || !loginForm || byId('tabEquipo')) return;

  const tab = document.createElement('button');
  tab.className = 'auth-tab';
  tab.id = 'tabEquipo';
  tab.type = 'button';
  tab.textContent = '👥 Equipo';
  tab.title = 'Para empleados: entrá con tu usuario y contraseña';
  tabs.appendChild(tab);

  const form = document.createElement('form');
  form.id = 'eqLoginForm';
  form.className = 'hidden';
  form.setAttribute('novalidate', '');
  form.innerHTML = `
    <div class="eq-login-intro">👋 <b>¿Trabajás en un local?</b> Entrá con el usuario y la contraseña que te dio el dueño o el encargado.</div>
    <div class="field"><label>Local</label>
      <input type="text" id="eqLocal" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="Está en tu tarjeta de acceso">
    </div>
    <div id="eqLocalEstado" class="hidden"></div>
    <div id="eqRecientes" class="eq-recientes hidden"></div>
    <div class="field"><label>Tu usuario</label>
      <input type="text" id="eqUsuario" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="ej: juan">
    </div>
    <div class="field"><label>Contraseña</label>
      <div style="position:relative;">
        <input type="password" id="eqClave" autocomplete="current-password" style="padding-right:44px;">
        <button type="button" id="eqVerClave" tabindex="-1" aria-label="Ver contraseña"
                style="position:absolute;right:4px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:var(--text-mute);padding:8px;font-size:15px;">
          <i class="fa-solid fa-eye"></i>
        </button>
      </div>
    </div>
    <button type="submit" class="btn btn-primary" id="eqEntrarBtn">Entrar a trabajar</button>
    <div class="eq-login-ayuda">¿Te olvidaste la contraseña? Pedile al dueño o al encargado que te la cambie desde <b>Empleados</b>.</div>
  `;
  loginForm.insertAdjacentElement('afterend', form);

  tab.addEventListener('click', abrirLoginEquipo);
  // Los botones de siempre no saben que existe esta solapa: se le suma un
  // listener a cada uno para esconderla, sin tocar el que ya tienen.
  ['tabLogin', 'tabRegister'].forEach(id => {
    const b = byId(id);
    if (b) b.addEventListener('click', () => { hide(form); tab.classList.remove('active'); });
  });

  byId('eqVerClave').addEventListener('click', () => {
    const inp = byId('eqClave');
    const ver = inp.type === 'password';
    inp.type = ver ? 'text' : 'password';
    byId('eqVerClave').querySelector('i').className = ver ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
  });

  let espera = null;
  byId('eqLocal').addEventListener('input', () => {
    clearTimeout(espera);
    espera = setTimeout(() => verificarLocalEquipo(), 450);
  });
  byId('eqLocal').addEventListener('blur', () => verificarLocalEquipo());
  form.addEventListener('submit', entrarComoEquipoSubmit);

  // El link de la tarjeta (?local=...) abre directo en esta solapa.
  const params = new URLSearchParams(location.search);
  const delLink = limpiarLocalEquipo(params.get('local') || '');
  if (delLink) {
    lsGuardar(EQUIPO_LS_LOCAL, delLink);
    abrirLoginEquipo();
  }
}

function abrirLoginEquipo() {
  ['tabLogin', 'tabRegister'].forEach(id => byId(id) && byId(id).classList.remove('active'));
  byId('tabEquipo').classList.add('active');
  ['loginForm', 'registerForm', 'recuperarForm', 'nuevaClaveForm', 'authError']
    .forEach(id => byId(id) && hide(byId(id)));
  show(byId('eqLoginForm'));

  const guardado = lsLeer(EQUIPO_LS_LOCAL, '');
  if (guardado && !byId('eqLocal').value) byId('eqLocal').value = guardado;
  verificarLocalEquipo();
  setTimeout(() => {
    const foco = !byId('eqLocal').value ? 'eqLocal' : (!byId('eqUsuario').value ? 'eqUsuario' : 'eqClave');
    byId(foco) && byId(foco).focus();
  }, 50);
}

// Confirma el nombre del local mientras se escribe ("✓ Burger Centro"): asi
// el empleado sabe que escribio bien el local antes de pelearse con la clave.
async function verificarLocalEquipo() {
  const estado = byId('eqLocalEstado');
  const local = limpiarLocalEquipo(byId('eqLocal').value);
  pintarRecientesEquipo(local);
  if (!local) { hide(estado); return null; }
  if (verificarLocalEquipo.cache && verificarLocalEquipo.cache.local === local) {
    pintarEstadoLocal(verificarLocalEquipo.cache.tienda);
    return verificarLocalEquipo.cache.tienda;
  }
  const { data: tienda, error } = await sb.from('store_profiles')
    .select('id, slug, business_name').eq('slug', local).maybeSingle();
  if (error) { hide(estado); return null; }
  verificarLocalEquipo.cache = { local, tienda: tienda || null };
  if (limpiarLocalEquipo(byId('eqLocal').value) === local) pintarEstadoLocal(tienda);
  return tienda || null;
}

function pintarEstadoLocal(tienda) {
  const estado = byId('eqLocalEstado');
  if (tienda) {
    estado.className = 'eq-local-ok';
    estado.textContent = '✓ ' + tienda.business_name;
  } else {
    estado.className = 'eq-local-mal';
    estado.textContent = 'No encontramos ese local. Fijate cómo está escrito en tu tarjeta de acceso.';
  }
}

// "¿Sos vos?": los que ya entraron en este aparato, para tocar el nombre y
// solo poner la clave. Es lo que hace rapido el cambio de turno en la tablet.
function pintarRecientesEquipo(local) {
  const cont = byId('eqRecientes');
  const lista = recientesEquipo().filter(r => r.local === local);
  if (!local || !lista.length) { hide(cont); return; }
  cont.innerHTML = '<div class="eq-titulito">¿Sos vos? Tocá tu nombre:</div>' + lista.map(r =>
    `<button type="button" class="eq-reciente" data-usuario="${escapeHtml(r.usuario)}">` +
      `<span class="eq-avatar" style="background:${colorAvatarEquipo(r.usuario)}">${escapeHtml((r.nombre || r.usuario).charAt(0).toUpperCase())}</span>` +
      `${escapeHtml(r.nombre || r.usuario)}</button>`).join('');
  show(cont);
  cont.querySelectorAll('[data-usuario]').forEach(b => b.addEventListener('click', () => {
    byId('eqUsuario').value = b.dataset.usuario;
    cont.querySelectorAll('.eq-reciente').forEach(x => x.classList.toggle('activo', x === b));
    byId('eqClave').focus();
  }));
}

function colorAvatarEquipo(texto) {
  const colores = ['#2F8FE0', '#1FA088', '#D97706', '#7C3AED', '#DB2777', '#0891B2', '#65A30D', '#DC2626'];
  let h = 0;
  for (const c of String(texto || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return colores[h % colores.length];
}

function errorLoginEquipo(html) {
  const cartel = byId('authError');
  cartel.classList.remove('exito');
  cartel.innerHTML = html;
  show(cartel);
}

async function entrarComoEquipoSubmit(e) {
  e.preventDefault();
  hide(byId('authError'));

  const local = limpiarLocalEquipo(byId('eqLocal').value);
  const usuario = normalizarUsuarioEquipo(byId('eqUsuario').value);
  const clave = byId('eqClave').value;

  if (!local) { errorLoginEquipo('Escribí el <b>local</b>: está en tu tarjeta de acceso.'); byId('eqLocal').focus(); return; }
  if (!usuario) { errorLoginEquipo('Escribí tu <b>usuario</b>.'); byId('eqUsuario').focus(); return; }
  if (!clave) { errorLoginEquipo('Escribí tu <b>contraseña</b>.'); byId('eqClave').focus(); return; }

  const boton = byId('eqEntrarBtn');
  boton.disabled = true;
  boton.textContent = 'Entrando…';
  try {
    const tienda = await verificarLocalEquipo();
    if (!tienda) {
      errorLoginEquipo('No encontramos el local <b>' + escapeHtml(local) + '</b>. Fijate cómo está escrito en tu tarjeta de acceso.');
      return;
    }

    // En la tablet del local la sesion queda abierta: el cambio de turno se
    // hace con "Cambiar de usuario", no cerrando el navegador.
    lsGuardar('bruwal_remember_me', 'true');

    const { error } = await sb.auth.signInWithPassword({ email: emailDeEquipo(usuario, tienda.id), password: clave });
    if (error) {
      const m = (error.message || '').toLowerCase();
      if (m.includes('banned')) {
        errorLoginEquipo('<b>Tu usuario está pausado.</b><br><span style="font-size:12.5px;">Hablá con el dueño o el encargado del local.</span>');
      } else if (m.includes('invalid login credentials')) {
        errorLoginEquipo('El usuario o la contraseña no coinciden. Revisá que esté igual que en tu tarjeta de acceso.');
      } else if (m.match(/after (\d+) seconds?/) || m.includes('rate limit')) {
        errorLoginEquipo('Demasiados intentos seguidos. Esperá un minuto y volvé a probar.');
      } else if (m.includes('fetch') || m.includes('network') || m.includes('load failed')) {
        errorLoginEquipo('No hay conexión. Revisá el wifi o los datos y probá de nuevo.');
      } else {
        errorLoginEquipo(escapeHtml(error.message));
      }
      return;
    }

    lsGuardar(EQUIPO_LS_LOCAL, local);
    byId('eqClave').value = '';
    await onLoggedIn();
  } finally {
    boton.disabled = false;
    boton.textContent = 'Entrar a trabajar';
  }
}

// =============================================================================
// 2) ENTRAR AL PANEL COMO EQUIPO (lo llama onLoggedIn)
// =============================================================================

// Devuelve la tienda a la que entra, o null si no tiene acceso (en ese caso
// ya cerro la sesion y dejo el cartel explicando por que). NUNCA crea una
// tienda: ese es justamente el error que evita el gancho de onLoggedIn.
async function entrarComoEquipo(user) {
  const salir = async (html) => {
    equipoMiembro = null;
    try { await sb.auth.signOut(); } catch (e) { /* igual se muestra el cartel */ }
    hide(byId('appView'));
    show(byId('authView'));
    if (byId('tabEquipo')) abrirLoginEquipo();
    errorLoginEquipo(html);
    return null;
  };

  const { data: fila, error } = await sb.from('store_miembros').select('*')
    .eq('user_id', user.id).maybeSingle();
  if (error) throw error;   // onLoggedIn lo muestra como "no pudimos cargar tu tienda"
  if (!fila || !fila.activo) {
    return salir('<b>Tu usuario está pausado o fue dado de baja.</b><br><span style="font-size:12.5px;">Hablá con el dueño o el encargado del local.</span>');
  }

  const { data: tienda, error: eTienda } = await sb.from('store_profiles').select('*')
    .eq('slug', fila.store_slug).maybeSingle();
  if (eTienda) throw eTienda;
  if (!tienda) return salir('Ese local ya no existe en BRUWAL.');
  if (!['pro', 'cortesia'].includes(tienda.plan)) {
    return salir('<b>El local no tiene el plan Pro activo.</b><br><span style="font-size:12.5px;">Los usuarios del equipo vuelven a andar apenas el dueño lo renueve.</span>');
  }

  equipoMiembro = fila;
  // Lo que pudo haber dejado abierto el dueño en este mismo navegador.
  if (typeof costosDesbloqueados !== 'undefined') costosDesbloqueados = false;
  lsGuardar('bruwal_guia_vista', '1');   // la guia es para el dueño (cargar productos, planes)
  recordarRecienteEquipo(fila.store_slug, fila.usuario, fila.nombre);
  return tienda;
}

// Esconde lo que no le toca y le deja puesto su nombre. Corre antes de
// refreshData para que no se vean solapas que despues desaparecen.
function aplicarModoEquipo() {
  if (!equipoMiembro) return;
  estilosEquipo();
  document.body.classList.add('modo-equipo');

  const ocultas = Object.keys(EQUIPO_SOLAPAS).filter(id => !EQUIPO_SOLAPAS[id].some(equipoPuede));
  let estilo = byId('eqEstiloSolapas');
  if (!estilo) {
    estilo = document.createElement('style');
    estilo.id = 'eqEstiloSolapas';
    document.head.appendChild(estilo);
  }
  estilo.textContent = ocultas.map(id => 'body.modo-equipo #' + id).join(',') +
    (ocultas.length ? ' { display: none !important; }' : '') +
    ' body.equipo-sin-caja .eq-solo-caja { display: none !important; }';

  // Adentro de Ventas estan los totales del local y el grafico por hora: es
  // plata, y el que no tiene permiso de caja no la ve. Se marcan por su id en
  // vez de tocar el HTML de la vista.
  ['statTotalSales', 'hourlyChart'].forEach(id => {
    const el = byId(id);
    const bloque = el && (el.closest('.stats-row') || el.closest('.panel'));
    if (bloque) bloque.classList.add('eq-solo-caja');
  });
  document.body.classList.toggle('equipo-sin-caja', !equipoPuede('caja'));

  // Quien atiende queda escrito en la venta y en el ticket, sin poder cambiarlo.
  const vendedor = byId('barcodeVendedor');
  if (vendedor) {
    vendedor.value = equipoMiembro.nombre;
    vendedor.readOnly = true;
    vendedor.title = 'Las ventas quedan a tu nombre';
  }

  // Chip "👤 Juan · Cajero [Cambiar de usuario]" en el encabezado.
  const appUser = document.querySelector('#appView .app-user');
  if (appUser && !byId('eqChipUsuario')) {
    const chip = document.createElement('div');
    chip.id = 'eqChipUsuario';
    chip.className = 'eq-chip-usuario';
    appUser.insertBefore(chip, appUser.firstChild);
  }
  const chip = byId('eqChipUsuario');
  if (chip) {
    chip.innerHTML = '<span class="quien">👤 <b>' + escapeHtml(equipoMiembro.nombre) + '</b>' +
      '<span class="rol"> · ' + escapeHtml(tituloDeRol(equipoMiembro.rol)) + '</span></span>' +
      ' <button type="button" id="eqCambiarUsuarioBtn" title="Cambiar de usuario">⇄ <span class="largo">Cambiar de usuario</span><span class="corto">Cambiar</span></button>';
    byId('eqCambiarUsuarioBtn').addEventListener('click', () => byId('logoutBtn').click());
  }
}

// La pantalla con la que arranca: la cocina va a Pedidos, el que vende a Ventas.
function irAPrimeraSolapaEquipo() {
  if (!equipoMiembro) return;
  let destino = null;
  if (equipoPuede('vender')) destino = 'tabVentas';
  else if (equipoPuede('cocina') || equipoPuede('pedidos')) destino = 'tabPedidos';
  else destino = Object.keys(EQUIPO_SOLAPAS).find(id => EQUIPO_SOLAPAS[id].some(equipoPuede));
  if (destino && byId(destino)) byId(destino).click();
  saludarEquipo();
}

// La primera vez en cada aparato, le cuenta en una linea que puede hacer.
function saludarEquipo() {
  const clave = 'bruwal_equipo_saludo_' + equipoMiembro.user_id;
  if (lsLeer(clave, '')) return;
  lsGuardar(clave, '1');
  const puede = EQUIPO_PERMISOS.filter(p => equipoPuede(p.clave)).map(p => p.titulo.toLowerCase());
  avisoEquipo('👋 <b>¡Hola ' + escapeHtml(equipoMiembro.nombre) + '!</b> Entraste como ' + escapeHtml(tituloDeRol(equipoMiembro.rol)) +
    '. Podés: ' + escapeHtml(puede.join(', ')) + '.' +
    (equipoPuede('vender') ? ' Todo lo que vendas queda a tu nombre.' : ''), 'largo');
}

// Al salir alguien del equipo se recarga la pagina entera: es la unica forma
// de que no quede nada en memoria (productos, PIN destrabado) para el que
// entra despues. Vuelve con ?local= para que el siguiente solo ponga su clave.
function montarSalidaEquipo() {
  const btn = byId('logoutBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!equipoMiembro) return;
    const slug = equipoMiembro.store_slug;
    equipoMiembro = null;
    try { await sb.auth.signOut(); } catch (e) { /* recargamos igual */ }
    location.href = location.pathname + '?local=' + encodeURIComponent(slug);
  });
}

// =============================================================================
// 3) PARA EL DUEÑO: crear y manejar los usuarios (arriba de todo en Empleados)
// =============================================================================

let eqMiembros = [];
let eqBorrador = null;

function montarPanelEquipo() {
  const vista = byId('empleadosView');
  if (!vista || byId('eqPanel')) return;
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.id = 'eqPanel';
  vista.insertBefore(panel, vista.firstChild);

  const tab = byId('tabEmpleados');
  if (tab) tab.addEventListener('click', () => { if (!equipoMiembro) renderPanelEquipo(true); });

  // Un solo modal que se rellena segun el paso.
  const modal = document.createElement('div');
  modal.className = 'modal-overlay hidden';
  modal.id = 'eqModal';
  modal.innerHTML = '<div class="modal" style="max-width:640px;"><button class="modal-close" type="button" id="eqModalCerrar">✕</button><div id="eqModalCuerpo"></div></div>';
  document.body.appendChild(modal);
  byId('eqModalCerrar').addEventListener('click', cerrarModalEquipo);
  modal.addEventListener('click', (ev) => { if (ev.target === modal) cerrarModalEquipo(); });
}

function cerrarModalEquipo() {
  hide(byId('eqModal'));
  eqBorrador = null;
}

async function renderPanelEquipo(traer) {
  const panel = byId('eqPanel');
  if (!panel || !currentStore || equipoMiembro) return;
  estilosEquipo();

  const cabecera = `
    <div class="panel-head" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
      <span>🔑 Usuarios del equipo <span style="font-weight:500;color:var(--text-mute);font-size:12.5px;">— cada uno entra con lo suyo</span></span>
      <button type="button" class="btn" id="eqNuevoBtn" style="width:auto;padding:8px 14px;font-size:13px;">+ Crear usuario</button>
    </div>`;

  if (traer) {
    panel.innerHTML = cabecera + '<div style="padding:14px;color:var(--text-mute);font-size:13px;">Cargando el equipo…</div>';
    byId('eqNuevoBtn').addEventListener('click', abrirCrearUsuario);
    try {
      eqMiembros = (await llamarEquipo('listar')).miembros || [];
    } catch (err) {
      // Si la funcion no responde, igual se muestra la lista (sin "ultimo ingreso").
      const { data } = await sb.from('store_miembros').select('*')
        .eq('store_slug', currentStore.slug).order('created_at');
      eqMiembros = data || [];
    }
    // La lista de "Empleados y horas" muestra quien ya tiene usuario: se
    // repinta ahora que se sabe.
    if (typeof renderEmpleados === 'function') renderEmpleados();
  }

  let cuerpo;
  if (!eqMiembros.length) {
    cuerpo = `
      <div style="padding:12px 14px 6px;font-size:13.5px;color:var(--text-mute);line-height:1.6;">
        Hoy todos entran con tu cuenta. Con un usuario para cada uno, <b>cada venta queda con el nombre de quien la hizo</b>
        y cada persona ve solo lo que necesita: el cajero no ve la caja ni toca precios, la cocina no ve plata.
      </div>
      <div class="eq-pasos-vacio">
        <div class="eq-paso-vacio"><span class="num">1</span><b>Creás el usuario</b>Elegís si es encargado, cajero o cocina. Le inventamos una contraseña fácil.</div>
        <div class="eq-paso-vacio"><span class="num">2</span><b>Le pasás su tarjeta</b>Por WhatsApp o impresa, con un QR que abre el sistema listo para entrar.</div>
        <div class="eq-paso-vacio"><span class="num">3</span><b>Entra y trabaja</b>Desde la tablet del local o su celular. Al cambiar de turno, “Cambiar de usuario”.</div>
      </div>`;
  } else {
    cuerpo = '<div class="eq-lista">' + eqMiembros.map(m => `
      <div class="eq-miembro ${m.activo ? '' : 'pausado'}">
        <span class="eq-avatar grande" style="background:${colorAvatarEquipo(m.usuario)}">${escapeHtml(m.nombre.charAt(0).toUpperCase())}</span>
        <div class="datos">
          <div class="nombre">${escapeHtml(m.nombre)}
            <span class="eq-pill">${escapeHtml(tituloDeRol(m.rol))}</span>
            ${m.activo ? '' : '<span class="eq-pill pausado">⏸ Pausado</span>'}
          </div>
          <div class="sub">Usuario: <b>${escapeHtml(m.usuario)}</b>${'ultimo_ingreso' in m ? ' · ' + haceCuantoEquipo(m.ultimo_ingreso) : ''}</div>
        </div>
        <div class="eq-acciones">
          <button type="button" class="eq-btn" data-eq="tarjeta" data-id="${m.id}">📲 Tarjeta</button>
          <button type="button" class="eq-btn" data-eq="permisos" data-id="${m.id}">✏️ Qué puede hacer</button>
          <button type="button" class="eq-btn" data-eq="clave" data-id="${m.id}">🔒 Contraseña</button>
          <button type="button" class="eq-btn" data-eq="activo" data-id="${m.id}">${m.activo ? '⏸ Pausar' : '▶ Reactivar'}</button>
          <button type="button" class="eq-btn peligro" data-eq="borrar" data-id="${m.id}">🗑</button>
        </div>
      </div>`).join('') + '</div>' +
      `<div style="padding:0 14px 14px;font-size:12.5px;color:var(--text-mute);line-height:1.6;">
        Link para entrar: <b>${escapeHtml(linkLoginEquipo())}</b> · Si pusiste PIN de costos, Caja y Gastos también lo piden.
      </div>`;
  }

  panel.innerHTML = cabecera + cuerpo;
  byId('eqNuevoBtn').addEventListener('click', abrirCrearUsuario);
  panel.querySelectorAll('[data-eq]').forEach(b => b.addEventListener('click', () => {
    const m = eqMiembros.find(x => x.id === b.dataset.id);
    if (!m) return;
    const accion = b.dataset.eq;
    if (accion === 'tarjeta') mostrarTarjetaEquipo(m, null);
    if (accion === 'permisos') abrirPermisosMiembro(m);
    if (accion === 'clave') abrirCambioDeClave(m);
    if (accion === 'activo') cambiarActivoMiembro(m, b);
    if (accion === 'borrar') borrarMiembro(m, b);
  }));
}

function linkLoginEquipo() {
  return location.origin + '/dashboard/?local=' + encodeURIComponent(currentStore.slug);
}

// ---- Crear usuario: 3 pasos (quién es, qué hace, contraseña)

// `previo` (opcional) llega desde "🔑 Darle acceso" de la lista de empleados o
// cuando fallo el alta desde el formulario: abre el asistente ya completado.
// Cuando lo llama el boton directo, lo que llega es el evento del click.
function abrirCrearUsuario(previo) {
  if (typeof tienePlanPro === 'function' && !tienePlanPro()) {
    if (typeof ofrecerUpgradePro === 'function') ofrecerUpgradePro('Usuarios del equipo');
    return;
  }
  const p = (previo && !(previo instanceof Event)) ? previo : {};
  const rol = EQUIPO_ROLES[p.rol] ? p.rol : 'cajero';
  const sugerido = normalizarUsuarioEquipo(String(p.nombre || '').trim().split(/\s+/)[0] || '');
  eqBorrador = { paso: 1, nombre: p.nombre || '', usuario: p.usuario || sugerido, usuarioTocado: !!p.usuario,
                 empleado_id: p.empleado_id || null, rol, permisos: permisosDeRol(rol),
                 password: p.password || inventarClaveEquipo() };
  pintarPasoCrear();
  show(byId('eqModal'));
}

function progresoCrear(paso) {
  return '<div class="eq-progreso">' + [1, 2, 3].map(n => `<span class="${n <= paso ? 'hecho' : ''}"></span>`).join('') + '</div>';
}

function pintarPasoCrear() {
  const b = eqBorrador;
  const cuerpo = byId('eqModalCuerpo');

  if (b.paso === 1) {
    const sinUsuario = (typeof empleados !== 'undefined' ? empleados : [])
      .filter(emp => emp.activo !== false && !eqMiembros.some(m => m.empleado_id === emp.id));
    cuerpo.innerHTML = progresoCrear(1) + `
      <div class="eq-paso-titulo">Paso 1 de 3</div>
      <h3 style="margin-bottom:12px;">¿Quién es?</h3>
      ${sinUsuario.length ? `<div style="font-size:12.5px;color:var(--text-mute);margin-bottom:8px;">Tocá uno de tus empleados o escribí un nombre nuevo:</div>
        <div class="eq-recientes" style="margin-bottom:12px;">${sinUsuario.map(emp =>
          `<button type="button" class="eq-reciente ${b.empleado_id === emp.id ? 'activo' : ''}" data-emp="${emp.id}">
             <span class="eq-avatar" style="background:${colorAvatarEquipo(emp.nombre)}">${escapeHtml(String(emp.nombre).charAt(0).toUpperCase())}</span>${escapeHtml(emp.nombre)}</button>`).join('')}
        </div>` : ''}
      <div class="field"><label>Nombre</label><input type="text" id="eqNombre" maxlength="60" placeholder="ej: Juan Pérez" value="${escapeHtml(b.nombre)}"></div>
      <div class="field"><label>Usuario para entrar</label>
        <input type="text" id="eqUsuarioNuevo" maxlength="30" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="ej: juan" value="${escapeHtml(b.usuario)}">
        <div class="eq-preview-usuario" id="eqPreviewUsuario"></div>
      </div>
      <div class="eq-error" id="eqError"></div>
      <div class="eq-pie"><span></span><button type="button" class="btn btn-primary" id="eqSiguiente">Siguiente →</button></div>`;

    const pintarPreview = () => {
      const u = normalizarUsuarioEquipo(byId('eqUsuarioNuevo').value);
      byId('eqPreviewUsuario').innerHTML = u
        ? 'Va a entrar como <b>' + escapeHtml(u) + '</b>' + (u !== byId('eqUsuarioNuevo').value ? ' (sin espacios, tildes ni mayúsculas)' : '')
        : 'Corto y fácil de recordar: el nombre de pila alcanza.';
    };
    const sugerirUsuario = () => {
      if (b.usuarioTocado) return;
      const primero = byId('eqNombre').value.trim().split(/\s+/)[0] || '';
      byId('eqUsuarioNuevo').value = normalizarUsuarioEquipo(primero);
      pintarPreview();
    };
    byId('eqNombre').addEventListener('input', () => { b.empleado_id = null; sugerirUsuario(); });
    byId('eqUsuarioNuevo').addEventListener('input', () => { b.usuarioTocado = true; pintarPreview(); });
    cuerpo.querySelectorAll('[data-emp]').forEach(btn => btn.addEventListener('click', () => {
      const emp = empleados.find(x => x.id === btn.dataset.emp);
      if (!emp) return;
      byId('eqNombre').value = emp.nombre;
      b.usuarioTocado = false;
      sugerirUsuario();
      b.empleado_id = emp.id;
      const rolSugerido = /encarg/i.test(emp.rol || '') ? 'encargado' : /cocin|cociner|chef|parrill/i.test(emp.rol || '') ? 'cocina' : null;
      if (rolSugerido) { b.rol = rolSugerido; b.permisos = permisosDeRol(rolSugerido); }
      cuerpo.querySelectorAll('[data-emp]').forEach(x => x.classList.toggle('activo', x === btn));
    }));
    pintarPreview();
    byId('eqSiguiente').addEventListener('click', () => {
      const nombre = byId('eqNombre').value.trim();
      const usuario = normalizarUsuarioEquipo(byId('eqUsuarioNuevo').value);
      if (!nombre) { byId('eqError').textContent = 'Poné el nombre de la persona.'; byId('eqNombre').focus(); return; }
      if (!/^[a-z0-9][a-z0-9._-]{1,29}$/.test(usuario)) {
        byId('eqError').textContent = 'El usuario tiene que tener al menos 2 letras o números.'; byId('eqUsuarioNuevo').focus(); return;
      }
      if (eqMiembros.some(m => m.usuario === usuario)) {
        byId('eqError').textContent = 'Ya hay alguien con el usuario "' + usuario + '". Probá con el apellido o un número.'; return;
      }
      b.nombre = nombre; b.usuario = usuario; b.paso = 2;
      pintarPasoCrear();
    });
    setTimeout(() => byId('eqNombre').focus(), 50);
    return;
  }

  if (b.paso === 2) {
    cuerpo.innerHTML = progresoCrear(2) + `
      <div class="eq-paso-titulo">Paso 2 de 3</div>
      <h3 style="margin-bottom:4px;">¿Qué hace ${escapeHtml(b.nombre.split(' ')[0])}?</h3>
      <div style="font-size:12.5px;color:var(--text-mute);margin-bottom:6px;">Elegí uno. Lo podés cambiar cuando quieras.</div>
      ${htmlEditorPermisos(b)}
      <div class="eq-error" id="eqError"></div>
      <div class="eq-pie"><button type="button" class="btn" id="eqAtras" style="background:var(--bg);color:var(--navy);border:1px solid var(--line);">← Atrás</button>
        <button type="button" class="btn btn-primary" id="eqSiguiente">Siguiente →</button></div>`;
    atarEditorPermisos(b, pintarPasoCrear);
    byId('eqAtras').addEventListener('click', () => { b.paso = 1; pintarPasoCrear(); });
    byId('eqSiguiente').addEventListener('click', () => {
      if (!Object.keys(b.permisos).some(k => b.permisos[k])) { byId('eqError').textContent = 'Marcá al menos una cosa que pueda hacer.'; return; }
      b.paso = 3; pintarPasoCrear();
    });
    return;
  }

  // Paso 3: contraseña
  cuerpo.innerHTML = progresoCrear(3) + `
    <div class="eq-paso-titulo">Paso 3 de 3</div>
    <h3 style="margin-bottom:4px;">Su contraseña</h3>
    <div style="font-size:12.5px;color:var(--text-mute);margin-bottom:12px;line-height:1.5;">
      Te inventamos una fácil de dictar. ${escapeHtml(b.nombre.split(' ')[0])} no la puede cambiar por su cuenta: si se la olvida, se la cambiás vos desde acá.
    </div>
    <div class="field"><label>Contraseña</label>
      <div style="display:flex;gap:8px;">
        <input type="text" id="eqClaveNueva" minlength="6" maxlength="60" autocomplete="off" value="${escapeHtml(b.password)}" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:16px;font-weight:700;">
        <button type="button" class="eq-btn" id="eqOtraClave" title="Inventar otra">🎲 Otra</button>
      </div>
    </div>
    <div style="background:var(--bg);border-radius:10px;padding:11px 13px;font-size:13px;line-height:1.6;color:var(--text-mute);">
      <b style="color:var(--navy);">${escapeHtml(b.nombre)}</b> va a entrar con el usuario <b style="color:var(--navy);">${escapeHtml(b.usuario)}</b>
      como <b style="color:var(--navy);">${escapeHtml(tituloDeRol(b.rol))}</b>.
    </div>
    <div class="eq-error" id="eqError"></div>
    <div class="eq-pie"><button type="button" class="btn" id="eqAtras" style="background:var(--bg);color:var(--navy);border:1px solid var(--line);">← Atrás</button>
      <button type="button" class="btn btn-primary" id="eqCrear">✓ Crear usuario</button></div>`;
  byId('eqOtraClave').addEventListener('click', () => { b.password = inventarClaveEquipo(); byId('eqClaveNueva').value = b.password; });
  byId('eqClaveNueva').addEventListener('input', () => { b.password = byId('eqClaveNueva').value; });
  byId('eqAtras').addEventListener('click', () => { b.paso = 2; pintarPasoCrear(); });
  byId('eqCrear').addEventListener('click', crearUsuarioEquipo);
}

async function crearUsuarioEquipo() {
  const b = eqBorrador;
  const boton = byId('eqCrear');
  if (!b || !boton) return;
  b.password = byId('eqClaveNueva').value.trim();
  if (b.password.length < 6) { byId('eqError').textContent = 'La contraseña tiene que tener al menos 6 caracteres.'; return; }

  boton.disabled = true;
  boton.textContent = 'Creando…';
  byId('eqError').textContent = '';
  try {
    const r = await llamarEquipo('crear', {
      nombre: b.nombre, usuario: b.usuario, password: b.password,
      rol: b.rol, permisos: b.permisos, empleado_id: b.empleado_id
    });
    const clave = b.password;
    eqBorrador = null;
    renderPanelEquipo(true);
    // La lista de Empleados y horas tambien: la funcion pudo haber creado el empleado.
    if (typeof refreshData === 'function') refreshData().then(() => { if (typeof renderEmpleados === 'function') renderEmpleados(); });
    mostrarTarjetaEquipo(r.miembro, clave);
  } catch (err) {
    byId('eqError').textContent = err.message;
    boton.disabled = false;
    boton.textContent = '✓ Crear usuario';
  }
}

// ---- Editor de "qué puede hacer" (se usa al crear y al editar)

function htmlEditorPermisos(b) {
  const tarjetas = Object.keys(EQUIPO_ROLES).map(clave => {
    const r = EQUIPO_ROLES[clave];
    const permisos = permisosDisponiblesEquipo().filter(p => r.permisos.includes(p.clave));
    return `<button type="button" class="eq-rol ${b.rol === clave ? 'activo' : ''}" data-rol="${clave}">
      <div class="ico">${r.icono}</div><div class="tit">${r.titulo}</div><div class="baj">${r.bajada}</div>
      <ul>${permisos.slice(0, 4).map(p => '<li>✓ ' + escapeHtml(p.titulo) + '</li>').join('')}
        ${permisos.length > 4 ? '<li>✓ y ' + (permisos.length - 4) + ' más</li>' : ''}
        <li class="no">✗ No ve: ${escapeHtml(r.noVe)}</li></ul></button>`;
  }).join('');

  const casillas = permisosDisponiblesEquipo().map(p => `
    <label class="eq-permiso"><input type="checkbox" data-permiso="${p.clave}" ${b.permisos[p.clave] ? 'checked' : ''}>
      <div><div class="t">${p.icono} ${escapeHtml(p.titulo)}</div><div class="a">${escapeHtml(p.ayuda)}</div></div></label>`).join('');

  return `<div class="eq-roles">${tarjetas}</div>
    <details ${b.rol === 'personalizado' ? 'open' : ''} style="margin-top:4px;">
      <summary style="cursor:pointer;font-size:13px;font-weight:700;color:var(--celeste);margin-bottom:8px;">
        ⚙️ Ajustar a mano ${b.rol === 'personalizado' ? '(a medida)' : ''}</summary>
      <div class="eq-permisos">${casillas}</div>
      <div style="font-size:12px;color:var(--text-mute);margin-top:8px;line-height:1.5;">
        Nunca ven: Configuración, el plan, Estadísticas, Mercado Libre ni estos usuarios. Eso es solo tuyo.</div>
    </details>`;
}

function atarEditorPermisos(b, repintar) {
  const cuerpo = byId('eqModalCuerpo');
  cuerpo.querySelectorAll('[data-rol]').forEach(btn => btn.addEventListener('click', () => {
    b.rol = btn.dataset.rol;
    b.permisos = permisosDeRol(b.rol);
    repintar();
  }));
  cuerpo.querySelectorAll('[data-permiso]').forEach(chk => chk.addEventListener('change', () => {
    if (chk.checked) b.permisos[chk.dataset.permiso] = true;
    else delete b.permisos[chk.dataset.permiso];
    b.rol = rolDePermisos(b.permisos);
    cuerpo.querySelectorAll('[data-rol]').forEach(x => x.classList.toggle('activo', x.dataset.rol === b.rol));
    const resumen = cuerpo.querySelector('details summary');
    if (resumen) resumen.textContent = '⚙️ Ajustar a mano' + (b.rol === 'personalizado' ? ' (a medida)' : '');
  }));
}

function abrirPermisosMiembro(m) {
  eqBorrador = { editando: m.id, nombre: m.nombre, rol: m.rol, permisos: Object.assign({}, m.permisos || {}) };
  const pintar = () => {
    byId('eqModalCuerpo').innerHTML = `
      <h3 style="margin-bottom:4px;">¿Qué puede hacer ${escapeHtml(m.nombre.split(' ')[0])}?</h3>
      <div style="font-size:12.5px;color:var(--text-mute);margin-bottom:6px;">El cambio vale desde su próximo clic: no hace falta que vuelva a entrar.</div>
      ${htmlEditorPermisos(eqBorrador)}
      <div class="field" style="margin-top:14px;"><label>Nombre</label><input type="text" id="eqNombreEdit" maxlength="60" value="${escapeHtml(eqBorrador.nombre)}"></div>
      <div class="eq-error" id="eqError"></div>
      <div class="eq-pie"><span></span><button type="button" class="btn btn-primary" id="eqGuardarPermisos">Guardar</button></div>`;
    atarEditorPermisos(eqBorrador, pintar);
    byId('eqNombreEdit').addEventListener('input', () => { eqBorrador.nombre = byId('eqNombreEdit').value; });
    byId('eqGuardarPermisos').addEventListener('click', guardarPermisosMiembro);
  };
  pintar();
  show(byId('eqModal'));
}

async function guardarPermisosMiembro() {
  const b = eqBorrador;
  const nombre = (b.nombre || '').trim();
  if (!nombre) { byId('eqError').textContent = 'Poné el nombre.'; return; }
  if (!Object.keys(b.permisos).some(k => b.permisos[k])) { byId('eqError').textContent = 'Marcá al menos una cosa que pueda hacer.'; return; }
  const boton = byId('eqGuardarPermisos');
  boton.disabled = true; boton.textContent = 'Guardando…';
  // Se pide la fila de vuelta: un update que la politica no deja pasar NO da
  // error, solo no toca nada. Sin el select diriamos "guardado" en falso.
  const { data, error } = await sb.from('store_miembros')
    .update({ nombre, rol: b.rol, permisos: b.permisos })
    .eq('id', b.editando).eq('store_slug', currentStore.slug)
    .select('id');
  if (error || !data || !data.length) {
    byId('eqError').textContent = 'No se pudo guardar' + (error ? ': ' + error.message : '. Volvé a intentar.');
    boton.disabled = false; boton.textContent = 'Guardar';
    return;
  }
  cerrarModalEquipo();
  avisoEquipo('✓ Listo: los permisos de <b>' + escapeHtml(nombre) + '</b> ya están cambiados.', 'ok');
  renderPanelEquipo(true);
}

function abrirCambioDeClave(m) {
  eqBorrador = { password: inventarClaveEquipo() };
  byId('eqModalCuerpo').innerHTML = `
    <h3 style="margin-bottom:4px;">Contraseña nueva para ${escapeHtml(m.nombre.split(' ')[0])}</h3>
    <div style="font-size:12.5px;color:var(--text-mute);margin-bottom:12px;">La vieja deja de andar en cuanto guardes.</div>
    <div class="field"><label>Contraseña</label>
      <div style="display:flex;gap:8px;">
        <input type="text" id="eqClaveNueva" minlength="6" maxlength="60" autocomplete="off" value="${escapeHtml(eqBorrador.password)}" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:16px;font-weight:700;">
        <button type="button" class="eq-btn" id="eqOtraClave">🎲 Otra</button>
      </div>
    </div>
    <div class="eq-error" id="eqError"></div>
    <div class="eq-pie"><span></span><button type="button" class="btn btn-primary" id="eqGuardarClave">Cambiar contraseña</button></div>`;
  byId('eqOtraClave').addEventListener('click', () => { byId('eqClaveNueva').value = inventarClaveEquipo(); });
  byId('eqGuardarClave').addEventListener('click', async () => {
    const clave = byId('eqClaveNueva').value.trim();
    if (clave.length < 6) { byId('eqError').textContent = 'Tiene que tener al menos 6 caracteres.'; return; }
    const boton = byId('eqGuardarClave');
    boton.disabled = true; boton.textContent = 'Cambiando…';
    try {
      await llamarEquipo('clave', { miembro_id: m.id, password: clave });
      mostrarTarjetaEquipo(m, clave);
    } catch (err) {
      byId('eqError').textContent = err.message;
      boton.disabled = false; boton.textContent = 'Cambiar contraseña';
    }
  });
  show(byId('eqModal'));
}

async function cambiarActivoMiembro(m, boton) {
  const pausar = m.activo;
  if (pausar && !confirm('¿Pausar a ' + m.nombre + '?\n\nNo va a poder entrar ni ver nada del local hasta que lo reactives. Sus ventas quedan como están.')) return;
  boton.disabled = true;
  try {
    await llamarEquipo('activo', { miembro_id: m.id, activo: !pausar });
    avisoEquipo(pausar ? '⏸ <b>' + escapeHtml(m.nombre) + '</b> quedó pausado.' : '▶ <b>' + escapeHtml(m.nombre) + '</b> ya puede volver a entrar.', 'ok');
    renderPanelEquipo(true);
  } catch (err) {
    avisoEquipo(escapeHtml(err.message), 'error');
    boton.disabled = false;
  }
}

async function borrarMiembro(m, boton) {
  if (!confirm('¿Quitarle el acceso a ' + m.nombre + ' para siempre?\n\nSus ventas siguen a su nombre y sigue en la lista de Empleados con sus horas. ' +
               'Solo se borra su usuario. Si es por un tiempo, mejor usá "Pausar".')) return;
  boton.disabled = true;
  try {
    await llamarEquipo('borrar', { miembro_id: m.id });
    avisoEquipo('🗑 Se quitó el acceso de <b>' + escapeHtml(m.nombre) + '</b>.', 'ok');
    renderPanelEquipo(true);
  } catch (err) {
    avisoEquipo(escapeHtml(err.message), 'error');
    boton.disabled = false;
  }
}

// ---- Tarjeta de acceso: lo que se le pasa al empleado

function textoTarjetaEquipo(m, clave) {
  return 'Hola ' + m.nombre.split(' ')[0] + '! 👋 Ya tenés tu usuario para el sistema de *' + currentStore.business_name + '*.\n\n' +
    '1️⃣ Entrá acá: ' + linkLoginEquipo() + '\n' +
    '2️⃣ Usuario: *' + m.usuario + '*\n' +
    '3️⃣ Contraseña: *' + (clave || '(la que te di)') + '*\n\n' +
    (m.permisos && m.permisos.vender ? 'Todo lo que vendas queda a tu nombre. ' : '') +
    'Si te olvidás la contraseña, pedime que te la cambie.';
}

function mostrarTarjetaEquipo(m, clave) {
  const link = linkLoginEquipo();
  const puede = EQUIPO_PERMISOS.filter(p => m.permisos && m.permisos[p.clave]).map(p => p.titulo.toLowerCase());
  byId('eqModalCuerpo').innerHTML = `
    ${clave ? '<div style="font-size:13px;font-weight:800;color:var(--stock);margin-bottom:10px;">✓ Listo. Ahora pasale esto a ' + escapeHtml(m.nombre.split(' ')[0]) + ':</div>' : ''}
    <h3 style="margin-bottom:12px;">📲 Tarjeta de acceso</h3>
    <div class="eq-tarjeta" id="eqTarjeta">
      <div class="izq">
        <div class="local">${escapeHtml(currentStore.business_name)}</div>
        <div class="hola">Hola ${escapeHtml(m.nombre.split(' ')[0])} 👋</div>
        <div class="linea"><span class="n">1</span><span>Escaneá el QR o entrá a<br><b style="color:var(--navy);word-break:break-all;">${escapeHtml(link)}</b></span></div>
        <div class="linea"><span class="n">2</span><span>Usuario: <code>${escapeHtml(m.usuario)}</code></span></div>
        <div class="linea"><span class="n">3</span><span>Contraseña: ${clave ? '<code>' + escapeHtml(clave) + '</code>' : '<i>la que le diste</i>'}</span></div>
        <div class="rolito">Entra como <b>${escapeHtml(tituloDeRol(m.rol))}</b>: ${escapeHtml(puede.join(', '))}.</div>
      </div>
      <div class="qr" id="eqQr"><span style="font-size:11px;color:var(--text-mute);">Cargando QR…</span></div>
    </div>
    ${clave ? '' : '<div style="font-size:12.5px;color:var(--text-mute);margin-top:10px;">La contraseña no se guarda a la vista. Si no se la acuerda, tocá “🔒 Contraseña” y le ponés una nueva.</div>'}
    <div class="eq-pie" style="flex-wrap:wrap;justify-content:flex-start;">
      <button type="button" class="btn btn-primary" id="eqWhatsapp" style="background:#25D366;border-color:#25D366;">📲 Mandar por WhatsApp</button>
      <button type="button" class="eq-btn" id="eqImprimir">🖨 Imprimir</button>
      <button type="button" class="eq-btn" id="eqCopiar">📋 Copiar</button>
      <button type="button" class="eq-btn" id="eqListo" style="margin-left:auto;">Listo</button>
    </div>`;

  byId('eqWhatsapp').addEventListener('click', () => {
    window.open('https://wa.me/?text=' + encodeURIComponent(textoTarjetaEquipo(m, clave)), '_blank');
  });
  byId('eqCopiar').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(textoTarjetaEquipo(m, clave).replace(/\*/g, ''));
      byId('eqCopiar').textContent = '✓ Copiado';
    } catch (e) { byId('eqCopiar').textContent = 'No se pudo copiar'; }
  });
  byId('eqImprimir').addEventListener('click', () => imprimirTarjetaEquipo());
  byId('eqListo').addEventListener('click', cerrarModalEquipo);
  show(byId('eqModal'));
  dibujarQrEquipo(link);
}

// El QR sale de una libreria chica que se baja solo cuando hace falta. Si no
// carga (sin internet, bloqueada), la tarjeta igual sirve con el link escrito.
function dibujarQrEquipo(texto) {
  const pintar = () => {
    const caja = byId('eqQr');
    if (!caja) return;
    caja.innerHTML = '';
    try {
      new QRCode(caja, { text: texto, width: 120, height: 120, correctLevel: QRCode.CorrectLevel.M });
    } catch (e) { caja.innerHTML = '<span style="font-size:11px;color:var(--text-mute);">Sin QR</span>'; }
  };
  if (window.QRCode) { pintar(); return; }
  const s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
  s.onload = pintar;
  s.onerror = () => { const c = byId('eqQr'); if (c) c.innerHTML = '<span style="font-size:11px;color:var(--text-mute);">Sin QR</span>'; };
  document.head.appendChild(s);
}

function imprimirTarjetaEquipo() {
  const tarjeta = byId('eqTarjeta');
  if (!tarjeta) return;
  const v = window.open('', '_blank', 'width=520,height=640');
  if (!v) { avisoEquipo('El navegador bloqueó la ventana de impresión. Permitila y probá de nuevo.', 'error'); return; }
  const estilos = byId('eqEstilos') ? byId('eqEstilos').textContent : '';
  v.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Tarjeta de acceso</title><style>' +
    ':root{--navy:#15294D;--celeste:#2F8FE0;--line:#DCE6F0;--text-mute:#5C6B82;--bg:#F4F8FC;}' +
    'body{font-family:Inter,Arial,sans-serif;padding:24px;}' + estilos + '</style></head><body>' +
    tarjeta.outerHTML + '<script>setTimeout(function(){window.print();},300);<\/script></body></html>');
  v.document.close();
}

// =============================================================================
// 4) "VA A USAR EL SISTEMA" adentro del formulario de empleado
// =============================================================================
//
// El formulario "Nuevo empleado" es el del reloj y las horas. Antes, para que
// esa misma persona entrara al sistema habia que ir a otro lado: confundia
// ("¿y la contraseña donde va?"). Ahora se tilda ahi mismo y listo.
//
// Ganchos en index.html: abrirModalEmpleado -> prepararAccesoEnEmpleado,
// guardarEmpleado -> accesoEmpleadoValido (antes) y accesoTrasGuardarEmpleado
// (despues), renderEmpleados -> botonAccesoEmpleado.

let eqAccesoForm = null;       // estado de la seccion mientras el formulario esta abierto
let eqAccesoPendiente = null;  // lo que hay que crear cuando termine de guardar el empleado

// "Cajero", "Cocinero", "Encargada"... -> el rol que mas se parece.
function rolDesdePuesto(puesto) {
  const t = String(puesto || '').toLowerCase();
  if (/encarg|gerent|supervis|admin/.test(t)) return 'encargado';
  if (/cocin|chef|parrill|plancha|pizzer|bacher|ayudante de cocina/.test(t)) return 'cocina';
  return 'cajero';
}

function montarAccesoEnEmpleado() {
  const activo = byId('empleadoActivo');
  const campoActivo = activo && activo.closest('.field');
  if (!campoActivo || byId('eqAccesoEmpleado')) return;

  const caja = document.createElement('div');
  caja.id = 'eqAccesoEmpleado';
  caja.className = 'eq-acceso';
  caja.innerHTML = `
    <div id="eqAccesoNuevo">
      <label class="eq-acceso-tilde">
        <input type="checkbox" id="eqDarAcceso">
        <div><b>🔑 Va a usar el sistema</b>
          <span>Le damos usuario y contraseña para que entre a vender, atender pedidos o la cocina. No hace falta tarjeta ni lector.</span></div>
      </label>
      <div id="eqAccesoCampos" class="eq-acceso-campos hidden">
        <div class="field"><label>Usuario para entrar</label>
          <input type="text" id="eqAccUsuario" maxlength="30" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="ej: juan">
          <div class="eq-preview-usuario" id="eqAccUsuarioAyuda"></div>
        </div>
        <div class="field"><label>¿Qué hace?</label>
          <div class="eq-roles-chicos" id="eqAccRoles"></div>
          <div class="eq-rol-explica" id="eqAccRolExplica"></div>
        </div>
        <div class="field"><label>Contraseña</label>
          <div style="display:flex;gap:8px;">
            <input type="text" id="eqAccClave" maxlength="60" autocomplete="off" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:700;">
            <button type="button" class="eq-btn" id="eqAccOtraClave" title="Inventar otra">🎲 Otra</button>
          </div>
          <div class="eq-rol-explica">Te la inventamos fácil de dictar. Al guardar te mostramos la tarjeta para mandársela por WhatsApp.</div>
        </div>
        <div class="eq-acceso-error" id="eqAccError"></div>
      </div>
    </div>
    <div id="eqAccesoYa" class="eq-acceso-ya hidden"></div>`;
  campoActivo.insertAdjacentElement('afterend', caja);

  byId('eqDarAcceso').addEventListener('change', () => {
    const si = byId('eqDarAcceso').checked;
    byId('eqAccesoCampos').classList.toggle('hidden', !si);
    caja.classList.toggle('prendido', si);
    if (si) {
      sugerirAccesoDesdeFormulario();
      setTimeout(() => byId('eqAccUsuario').focus(), 50);
    }
  });
  byId('empleadoNombre').addEventListener('input', sugerirAccesoDesdeFormulario);
  byId('empleadoRol').addEventListener('input', sugerirAccesoDesdeFormulario);
  byId('eqAccUsuario').addEventListener('input', () => {
    if (eqAccesoForm) eqAccesoForm.usuarioTocado = true;
    pintarAyudaUsuarioAcceso();
  });
  byId('eqAccOtraClave').addEventListener('click', () => { byId('eqAccClave').value = inventarClaveEquipo(); });
}

// Lo llama abrirModalEmpleado cada vez que se abre el formulario.
function prepararAccesoEnEmpleado(empleado) {
  const caja = byId('eqAccesoEmpleado');
  if (!caja) return;
  // Es del dueño y del plan Pro. Al equipo nunca le aparece (no ve Empleados).
  if (equipoMiembro || (typeof tienePlanPro === 'function' && !tienePlanPro())) { hide(caja); return; }
  show(caja);

  eqAccesoForm = { rol: rolDesdePuesto(empleado && empleado.rol), rolTocado: false, usuarioTocado: false };
  eqAccesoPendiente = null;
  byId('eqDarAcceso').checked = false;
  hide(byId('eqAccesoCampos'));
  caja.classList.remove('prendido');
  byId('eqAccUsuario').value = '';
  byId('eqAccClave').value = inventarClaveEquipo();
  byId('eqAccError').textContent = '';

  const yaTiene = empleado && eqMiembros.find(m => m.empleado_id === empleado.id);
  if (yaTiene) {
    hide(byId('eqAccesoNuevo'));
    show(byId('eqAccesoYa'));
    byId('eqAccesoYa').innerHTML =
      '<span>🔑 Ya entra al sistema como <b>' + escapeHtml(yaTiene.usuario) + '</b> · ' + escapeHtml(tituloDeRol(yaTiene.rol)) +
      (yaTiene.activo ? '' : ' <span class="eq-pill pausado">⏸ Pausado</span>') + '</span>' +
      '<button type="button" class="eq-btn" id="eqAccVerTarjeta">📲 Tarjeta</button>' +
      '<button type="button" class="eq-btn" id="eqAccPermisos">✏️ Qué puede hacer</button>';
    byId('eqAccVerTarjeta').addEventListener('click', () => { hide(byId('empleadoModal')); mostrarTarjetaEquipo(yaTiene, null); });
    byId('eqAccPermisos').addEventListener('click', () => { hide(byId('empleadoModal')); abrirPermisosMiembro(yaTiene); });
  } else {
    show(byId('eqAccesoNuevo'));
    hide(byId('eqAccesoYa'));
  }
  pintarRolesAcceso();
}

function sugerirAccesoDesdeFormulario() {
  if (!eqAccesoForm || !byId('eqDarAcceso') || !byId('eqDarAcceso').checked) return;
  if (!eqAccesoForm.usuarioTocado) {
    const primero = byId('empleadoNombre').value.trim().split(/\s+/)[0] || '';
    byId('eqAccUsuario').value = normalizarUsuarioEquipo(primero);
  }
  if (!eqAccesoForm.rolTocado) eqAccesoForm.rol = rolDesdePuesto(byId('empleadoRol').value);
  pintarAyudaUsuarioAcceso();
  pintarRolesAcceso();
}

function pintarAyudaUsuarioAcceso() {
  const crudo = byId('eqAccUsuario').value;
  const u = normalizarUsuarioEquipo(crudo);
  const ayuda = byId('eqAccUsuarioAyuda');
  if (!u) { ayuda.textContent = 'Corto y fácil de recordar: el nombre de pila alcanza.'; return; }
  const repetido = eqMiembros.some(m => m.usuario === u);
  ayuda.innerHTML = repetido
    ? '<span style="color:var(--danger);font-weight:700;">Ya hay alguien con el usuario "' + escapeHtml(u) + '". Probá con el apellido o un número.</span>'
    : 'Va a entrar como <b>' + escapeHtml(u) + '</b>' + (u !== crudo ? ' (sin espacios, tildes ni mayúsculas)' : '');
}

function pintarRolesAcceso() {
  const cont = byId('eqAccRoles');
  if (!cont || !eqAccesoForm) return;
  cont.innerHTML = ['cajero', 'encargado', 'cocina'].map(clave =>
    `<button type="button" class="eq-rol-chico ${eqAccesoForm.rol === clave ? 'activo' : ''}" data-acc-rol="${clave}">` +
    `${EQUIPO_ROLES[clave].icono} ${EQUIPO_ROLES[clave].titulo}</button>`).join('');
  cont.querySelectorAll('[data-acc-rol]').forEach(b => b.addEventListener('click', () => {
    eqAccesoForm.rol = b.dataset.accRol;
    eqAccesoForm.rolTocado = true;
    pintarRolesAcceso();
  }));
  const r = EQUIPO_ROLES[eqAccesoForm.rol];
  const puede = permisosDisponiblesEquipo().filter(p => r.permisos.includes(p.clave)).map(p => p.titulo.toLowerCase());
  byId('eqAccRolExplica').innerHTML = '<b style="color:var(--navy);">Puede:</b> ' + escapeHtml(puede.join(', ')) +
    '.<br><b style="color:var(--navy);">No ve:</b> ' + escapeHtml(r.noVe);
}

// Antes de guardar el empleado. Si algo del usuario esta mal no se guarda
// nada: mejor que quedar con el empleado guardado y el usuario a medias.
function accesoEmpleadoValido() {
  eqAccesoPendiente = null;
  const tilde = byId('eqDarAcceso');
  if (!tilde || !tilde.checked || byId('eqAccesoEmpleado').classList.contains('hidden')) return true;

  const error = (msg, foco) => {
    byId('eqAccError').textContent = msg;
    if (foco && byId(foco)) byId(foco).focus();
    byId('eqAccesoEmpleado').scrollIntoView({ block: 'center', behavior: 'smooth' });
    return false;
  };
  const usuario = normalizarUsuarioEquipo(byId('eqAccUsuario').value);
  const password = byId('eqAccClave').value.trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,29}$/.test(usuario)) return error('El usuario tiene que tener al menos 2 letras o números.', 'eqAccUsuario');
  if (eqMiembros.some(m => m.usuario === usuario)) return error('Ya hay alguien con el usuario "' + usuario + '". Probá con el apellido o un número.', 'eqAccUsuario');
  if (password.length < 6) return error('La contraseña tiene que tener al menos 6 caracteres.', 'eqAccClave');

  byId('eqAccError').textContent = '';
  eqAccesoPendiente = { usuario, password, rol: eqAccesoForm ? eqAccesoForm.rol : 'cajero' };
  return true;
}

// Despues de guardar el empleado (ya tiene id).
async function accesoTrasGuardarEmpleado(empleadoId, nombre) {
  if (equipoMiembro) return;
  const miembro = eqMiembros.find(m => m.empleado_id === empleadoId);
  const empleado = (typeof empleados !== 'undefined' ? empleados : []).find(e => e.id === empleadoId);

  if (miembro) {
    // Ya tenia usuario: el nombre va parejo en los dos lados...
    if (nombre && miembro.nombre !== nombre) {
      await sb.from('store_miembros').update({ nombre }).eq('id', miembro.id).eq('store_slug', currentStore.slug);
      miembro.nombre = nombre;
    }
    // ...y si dejo de trabajar, se ofrece cortarle el acceso en el momento.
    if (empleado && empleado.activo === false && miembro.activo &&
        confirm(nombre + ' ya no trabaja más.\n\n¿Le pausamos también el usuario para que no pueda entrar al sistema?')) {
      try {
        await llamarEquipo('activo', { miembro_id: miembro.id, activo: false });
        avisoEquipo('⏸ Listo: <b>' + escapeHtml(nombre) + '</b> ya no puede entrar al sistema.', 'ok');
      } catch (err) { avisoEquipo(escapeHtml(err.message), 'error'); }
    }
    renderPanelEquipo(true);
    return;
  }

  const pendiente = eqAccesoPendiente;
  eqAccesoPendiente = null;
  if (!pendiente) return;

  avisoEquipo('🔑 Creando el usuario de <b>' + escapeHtml(nombre) + '</b>…');
  try {
    const r = await llamarEquipo('crear', {
      nombre, usuario: pendiente.usuario, password: pendiente.password,
      rol: pendiente.rol, permisos: permisosDeRol(pendiente.rol), empleado_id: empleadoId
    });
    renderPanelEquipo(true);
    mostrarTarjetaEquipo(r.miembro, pendiente.password);
  } catch (err) {
    // El empleado ya quedo guardado: se abre el asistente con todo cargado
    // para corregir lo que fallo y reintentar, sin volver a escribir nada.
    avisoEquipo('El empleado se guardó, pero el usuario no: ' + escapeHtml(err.message), 'error');
    abrirCrearUsuario({ empleado_id: empleadoId, nombre, usuario: pendiente.usuario, rol: pendiente.rol, password: pendiente.password });
    if (byId('eqError')) byId('eqError').textContent = err.message;
  }
}

// En la tabla de Empleados y horas, al lado del lapiz.
function botonAccesoEmpleado(e) {
  if (equipoMiembro || !e) return '';
  const m = eqMiembros.find(x => x.empleado_id === e.id);
  if (m) {
    return '<button type="button" class="eq-chip-acceso ' + (m.activo ? '' : 'pausado') + '" data-acceso-empleado="' + e.id + '" ' +
      'title="Entra al sistema como ' + escapeHtml(m.usuario) + '. Tocá para ver su tarjeta">' +
      (m.activo ? '🔑 ' : '⏸ ') + escapeHtml(m.usuario) + '</button>';
  }
  if (e.activo === false) return '';
  return '<button type="button" class="eq-chip-acceso nuevo" data-acceso-empleado="' + e.id + '" ' +
    'title="Darle usuario y contraseña para entrar al sistema">🔑 Darle acceso</button>';
}

function montarBotonesAccesoEmpleados() {
  // Un solo listener para toda la tabla: se repinta seguido y asi no hay que
  // volver a atar cada boton.
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest && ev.target.closest('[data-acceso-empleado]');
    if (!b || equipoMiembro) return;
    const empleado = (typeof empleados !== 'undefined' ? empleados : []).find(e => e.id === b.dataset.accesoEmpleado);
    if (!empleado) return;
    const m = eqMiembros.find(x => x.empleado_id === empleado.id);
    if (m) mostrarTarjetaEquipo(m, null);
    else abrirCrearUsuario({ empleado_id: empleado.id, nombre: empleado.nombre, rol: rolDesdePuesto(empleado.rol) });
  });
}

// ---------------------------------------------------------------- arranque

document.addEventListener('DOMContentLoaded', () => {
  try {
    estilosEquipo();
    montarLoginEquipo();
    montarSalidaEquipo();
    montarPanelEquipo();
    montarAccesoEnEmpleado();
    montarBotonesAccesoEmpleados();
  } catch (e) {
    // Si algo de esto falla, el panel del dueño tiene que seguir andando igual.
    console.error('equipo.js: no se pudo montar', e);
  }
});
