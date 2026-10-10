// Avisos propios de BRUWAL, en lugar de los alert/confirm/prompt del
// navegador. Esos cuadros grises dicen "bruwal.com dice..." arriba, no se
// pueden estilar y en el celular tapan todo. Estos usan los colores del
// panel y funcionan igual en la tienda, la home y el admin.
//
// Todos devuelven una promesa, así que donde antes habia
//   if (!confirm('¿Borrar?')) return;
// ahora va
//   if (!await dialogoConfirmar('¿Borrar?')) return;
//
//   dialogoAviso(msg)               -> se cierra con "Entendido"
//   dialogoConfirmar(msg)           -> true / false
//   dialogoPedir(msg, valorInicial) -> el texto escrito, o null si cancela
//   dialogoCopiar(msg, texto)       -> muestra un texto con boton "Copiar"
//
// Si el mensaje tiene un parrafo en blanco ("\n\n"), lo primero se muestra
// como titulo y lo demas como detalle. Si llegan varios avisos juntos se
// muestran de a uno, en orden, como hacia el navegador.
(function () {
  if (window.dialogoAviso) return;

  const CSS = `
.bdlg-fondo{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;
  padding:16px;background:rgba(15,25,45,.55);opacity:0;transition:opacity .15s ease;
  font-family:inherit;-webkit-tap-highlight-color:transparent}
.bdlg-fondo.bdlg-ve{opacity:1}
.bdlg-caja{background:var(--surface,#fff);color:var(--text-dark,#15294D);border-radius:16px;width:100%;max-width:420px;
  max-height:88dvh;overflow:auto;padding:22px 20px 18px;box-shadow:0 20px 50px rgba(15,25,45,.28);
  transform:translateY(8px) scale(.98);transition:transform .15s ease}
.bdlg-ve .bdlg-caja{transform:none}
.bdlg-icono{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  font-size:20px;font-weight:700;margin-bottom:12px;background:rgba(47,143,224,.12);color:var(--celeste,#2F8FE0)}
.bdlg-peligro .bdlg-icono{background:rgba(220,38,38,.1);color:var(--danger,#DC2626)}
.bdlg-titulo{font-size:17px;font-weight:700;line-height:1.35;margin:0 0 6px;white-space:pre-line;overflow-wrap:anywhere}
.bdlg-texto{font-size:14.5px;line-height:1.5;color:var(--text-mute,#5C6B82);margin:0;white-space:pre-line;overflow-wrap:anywhere}
.bdlg-campo{width:100%;box-sizing:border-box;margin-top:14px;padding:11px 12px;font:inherit;font-size:16px;
  color:inherit;background:var(--bg,#F4F8FC);border:1.5px solid var(--line,#DCE6F0);border-radius:10px;outline:none}
.bdlg-campo:focus{border-color:var(--celeste,#2F8FE0)}
.bdlg-botones{display:flex;gap:10px;justify-content:flex-end;margin-top:20px}
.bdlg-btn{flex:0 1 auto;min-width:96px;min-height:44px;padding:10px 18px;border-radius:10px;border:none;cursor:pointer;
  font:inherit;font-size:15px;font-weight:600}
.bdlg-si{background:var(--navy,#15294D);color:#fff}
.bdlg-peligro .bdlg-si{background:var(--danger,#DC2626)}
.bdlg-no{background:transparent;color:var(--text-dark,#15294D);border:1.5px solid var(--line,#DCE6F0)}
.bdlg-btn:focus-visible{outline:3px solid rgba(47,143,224,.45);outline-offset:2px}
@media (max-width:480px){.bdlg-fondo{align-items:flex-end;padding:0}
  .bdlg-caja{max-width:none;border-radius:18px 18px 0 0;padding-bottom:calc(18px + env(safe-area-inset-bottom))}
  .bdlg-btn{flex:1}}
@media (prefers-reduced-motion:reduce){.bdlg-fondo,.bdlg-caja{transition:none}}`;

  // Palabras que hacen que el boton principal sea rojo: lo que se pierde.
  const PELIGRO = /\b(borrar|eliminar|anular|vaciar|desconectar|rechazar|sacar|liberar)\b|no se puede deshacer/i;

  let cola = Promise.resolve();

  function ponerEstilos() {
    if (document.getElementById('bdlg-estilos')) return;
    const s = document.createElement('style');
    s.id = 'bdlg-estilos';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function partir(msg) {
    const t = String(msg == null ? '' : msg).trim();
    const corte = t.indexOf('\n\n');
    if (corte === -1) return { titulo: t, detalle: '' };
    return { titulo: t.slice(0, corte).trim(), detalle: t.slice(corte + 2).trim() };
  }

  // tipo: 'aviso' | 'confirmar' | 'pedir' | 'copiar'
  function abrir(tipo, msg, valor) {
    ponerEstilos();
    const { titulo, detalle } = partir(msg);
    const peligro = tipo === 'confirmar' && PELIGRO.test(String(msg));
    const antes = document.activeElement;

    const fondo = document.createElement('div');
    fondo.className = 'bdlg-fondo' + (peligro ? ' bdlg-peligro' : '');
    const caja = document.createElement('div');
    caja.className = 'bdlg-caja';
    caja.setAttribute('role', tipo === 'aviso' ? 'alertdialog' : 'dialog');
    caja.setAttribute('aria-modal', 'true');

    const icono = document.createElement('div');
    icono.className = 'bdlg-icono';
    icono.setAttribute('aria-hidden', 'true');
    icono.textContent = peligro ? '!' : (tipo === 'confirmar' ? '?' : 'i');
    caja.appendChild(icono);

    const h = document.createElement('p');
    h.className = 'bdlg-titulo';
    h.id = 'bdlg-t' + Date.now();
    h.textContent = titulo;
    caja.setAttribute('aria-labelledby', h.id);
    caja.appendChild(h);
    if (detalle) {
      const p = document.createElement('p');
      p.className = 'bdlg-texto';
      p.textContent = detalle;
      caja.appendChild(p);
    }

    let campo = null;
    if (tipo === 'pedir' || tipo === 'copiar') {
      campo = document.createElement('input');
      campo.className = 'bdlg-campo';
      campo.type = 'text';
      campo.value = valor == null ? '' : String(valor);
      if (tipo === 'copiar') campo.readOnly = true;
      caja.appendChild(campo);
    }

    const botones = document.createElement('div');
    botones.className = 'bdlg-botones';
    const si = document.createElement('button');
    si.type = 'button';
    si.className = 'bdlg-btn bdlg-si';
    si.textContent = { aviso: 'Entendido', confirmar: 'Aceptar', pedir: 'Aceptar', copiar: 'Copiar' }[tipo];
    let no = null;
    if (tipo !== 'aviso') {
      no = document.createElement('button');
      no.type = 'button';
      no.className = 'bdlg-btn bdlg-no';
      no.textContent = tipo === 'copiar' ? 'Cerrar' : 'Cancelar';
      botones.appendChild(no);
    }
    botones.appendChild(si);
    caja.appendChild(botones);
    fondo.appendChild(caja);
    document.body.appendChild(fondo);
    requestAnimationFrame(() => fondo.classList.add('bdlg-ve'));

    return new Promise((resolver) => {
      let listo = false;
      function cerrar(resultado) {
        if (listo) return;
        listo = true;
        document.removeEventListener('keydown', teclas, true);
        fondo.remove();
        if (antes && typeof antes.focus === 'function' && document.contains(antes)) {
          try { antes.focus({ preventScroll: true }); } catch (e) {}
        }
        resolver(resultado);
      }
      const aceptar = () => {
        if (tipo === 'aviso') return cerrar(undefined);
        if (tipo === 'confirmar') return cerrar(true);
        if (tipo === 'pedir') return cerrar(campo.value);
        // copiar: se copia y se avisa en el mismo boton, sin cerrar de golpe.
        const texto = campo.value;
        const hecho = () => { si.textContent = '¡Copiado!'; setTimeout(() => cerrar(undefined), 700); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(texto).then(hecho, () => { campo.select(); });
        } else {
          campo.select();
          try { document.execCommand('copy'); hecho(); } catch (e) {}
        }
      };
      const cancelar = () => cerrar(tipo === 'confirmar' ? false : (tipo === 'pedir' ? null : undefined));

      si.addEventListener('click', aceptar);
      if (no) no.addEventListener('click', cancelar);
      // Tocar afuera cierra solo los que no preguntan nada.
      fondo.addEventListener('click', (e) => { if (e.target === fondo && tipo === 'aviso') cerrar(undefined); });

      function teclas(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelar(); }
        else if (e.key === 'Enter' && (e.target === campo || !caja.contains(e.target) || e.target === caja)) {
          e.preventDefault(); e.stopPropagation(); aceptar();
        } else if (e.key === 'Tab') {
          // El foco no se escapa del aviso mientras esta abierto.
          const f = [campo, no, si].filter(Boolean);
          const i = f.indexOf(document.activeElement);
          e.preventDefault();
          f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
        }
      }
      document.addEventListener('keydown', teclas, true);

      // En lo que borra, el foco arranca en "Cancelar": un Enter de mas no borra nada.
      if (campo) { campo.focus(); campo.select(); } else { (peligro && no ? no : si).focus(); }
    });
  }

  // De a uno: el siguiente espera a que se cierre el anterior.
  function enCola(tipo, msg, valor) {
    const turno = cola.then(() => abrir(tipo, msg, valor));
    cola = turno.catch(() => {});
    return turno;
  }

  window.dialogoAviso = (msg) => enCola('aviso', msg);
  window.dialogoConfirmar = (msg) => enCola('confirmar', msg);
  window.dialogoPedir = (msg, valor) => enCola('pedir', msg, valor);
  window.dialogoCopiar = (msg, texto) => enCola('copiar', msg, texto);
})();
