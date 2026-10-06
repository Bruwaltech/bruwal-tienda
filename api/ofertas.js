// Las ofertas de Mercado Libre con link de referido (/ofertas).
//
// La página pública NO pasa por acá: lee la tabla directo con la clave
// pública (las políticas solo dejan ver las vigentes) y cuenta los clics
// con contar_click_oferta. Esta función es el lado de la cuenta de BRUWAL,
// el que carga y ordena los links desde /ofertas/panel.html.
//
// Todo es POST con la sesión de Supabase en Authorization, y el email de
// esa sesión tiene que estar en ADMIN_EMAILS. No hay otra forma de
// escribir en la tabla: no tiene políticas de escritura.
//
//   { accion: 'listar' }                -> todas, con los clics de 7 días
//   { accion: 'guardar', oferta: {...} } -> crea (sin id) o edita (con id)
//   { accion: 'borrar', id }
//   { accion: 'leer-link', link }        -> título, foto y precio desde ML

const SUPABASE_URL = 'https://qduguqazpxjjpxjfnkif.supabase.co';

// Sin la variable no hay admin: peor que no poder cargar ofertas es que
// cualquier cuenta pueda escribir en una página pública con nuestro nombre.
function esAdmin(email) {
  const lista = String(process.env.ADMIN_EMAILS || '')
    .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  return !!email && lista.includes(String(email).toLowerCase());
}

async function usuarioDeToken(token) {
  const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { Authorization: 'Bearer ' + token, apikey: process.env.SUPABASE_SERVICE_ROLE_KEY }
  });
  if (!r.ok) return null;
  return r.json();
}

async function sb(ruta, opciones) {
  const o = opciones || {};
  const clave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(SUPABASE_URL + ruta, {
    method: o.method || 'GET',
    headers: Object.assign({
      apikey: clave,
      Authorization: 'Bearer ' + clave,
      'Content-Type': 'application/json'
    }, o.headers || {}),
    body: o.body ? JSON.stringify(o.body) : undefined
  });
  if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + (await r.text()).slice(0, 300));
  if (r.status === 204) return null;
  const texto = await r.text();
  return texto ? JSON.parse(texto) : null;
}

// Fecha de hoy en Argentina, YYYY-MM-DD. La de Vercel es UTC y a las 21
// ya seria "mañana".
function hoyEnArgentina() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
}

function haceDias(n) {
  const d = new Date(hoyEnArgentina() + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// ---------- listar ----------

async function accionListar() {
  const ofertas = await sb('/rest/v1/ofertas?select=*&order=creada_en.desc&limit=1000');

  // Los clics de la última semana, sumados por oferta. Hoy cuenta como uno
  // de los siete.
  const filas = await sb('/rest/v1/ofertas_clicks_dia?dia=gte.' + haceDias(6) +
                         '&select=oferta_id,clicks&limit=10000');
  const semana = {};
  (filas || []).forEach((f) => { semana[f.oferta_id] = (semana[f.oferta_id] || 0) + f.clicks; });

  return {
    ok: true,
    hoy: hoyEnArgentina(),
    ofertas: (ofertas || []).map((o) => Object.assign(o, { clicks_7d: semana[o.id] || 0 }))
  };
}

// ---------- guardar ----------

function textoLimpio(valor, maximo) {
  const t = String(valor == null ? '' : valor).replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, maximo) : null;
}

function urlHttps(valor) {
  const t = String(valor || '').trim();
  if (!t) return null;
  try {
    const u = new URL(t);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch (err) {
    return null;
  }
}

function numeroOpcional(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : NaN;
}

// "celulares " y "Celulares" tienen que caer en el mismo rubro: si no, la
// página muestra dos botones para lo mismo.
function rubroLimpio(valor) {
  const t = textoLimpio(valor, 40);
  if (!t) return 'Varios';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

async function accionGuardar(datos) {
  const d = datos || {};

  const link = urlHttps(d.link);
  if (!link) return { ok: false, motivo: 'El link tiene que empezar con https://' };

  const titulo = textoLimpio(d.titulo, 200);
  if (!titulo) return { ok: false, motivo: 'Falta el título.' };

  const precio = numeroOpcional(d.precio);
  const precioAntes = numeroOpcional(d.precio_antes);
  if (Number.isNaN(precio) || Number.isNaN(precioAntes)) {
    return { ok: false, motivo: 'El precio tiene que ser un número.' };
  }

  const imagen = textoLimpio(d.imagen_url, 1000);
  if (imagen && !urlHttps(imagen)) {
    return { ok: false, motivo: 'La foto tiene que ser un link https://' };
  }

  const vence = d.vence ? String(d.vence).slice(0, 10) : null;
  if (vence && !/^\d{4}-\d{2}-\d{2}$/.test(vence)) {
    return { ok: false, motivo: 'La fecha de vencimiento no es válida.' };
  }

  const fila = {
    link,
    titulo,
    imagen_url: imagen ? urlHttps(imagen) : null,
    precio,
    precio_antes: precioAntes,
    rubro: rubroLimpio(d.rubro),
    nota: textoLimpio(d.nota, 280),
    ml_item_id: textoLimpio(d.ml_item_id, 30),
    destacada: !!d.destacada,
    activa: d.activa !== false,
    vence,
    actualizada_en: new Date().toISOString()
  };

  const id = d.id ? String(d.id) : '';
  if (id && !/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, motivo: 'Oferta inválida.' };

  const filas = id
    ? await sb('/rest/v1/ofertas?id=eq.' + id, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: fila
      })
    : await sb('/rest/v1/ofertas', {
        method: 'POST', headers: { Prefer: 'return=representation' }, body: fila
      });

  const guardada = filas && filas[0];
  if (!guardada) return { ok: false, motivo: 'Esa oferta ya no existe.' };
  return { ok: true, oferta: guardada };
}

// Prender, apagar o destacar desde la lista, sin pasar por el formulario.
async function accionCambiar(id, campos) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return { ok: false, motivo: 'Oferta inválida.' };
  const c = campos || {};
  const cambio = { actualizada_en: new Date().toISOString() };
  if (typeof c.activa === 'boolean') cambio.activa = c.activa;
  if (typeof c.destacada === 'boolean') cambio.destacada = c.destacada;

  const filas = await sb('/rest/v1/ofertas?id=eq.' + id, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: cambio
  });
  return filas && filas[0] ? { ok: true, oferta: filas[0] } : { ok: false, motivo: 'Esa oferta ya no existe.' };
}

async function accionBorrar(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return { ok: false, motivo: 'Oferta inválida.' };
  await sb('/rest/v1/ofertas?id=eq.' + id, { method: 'DELETE' });
  return { ok: true };
}

// ---------- leer un link de Mercado Libre ----------
//
// Para no tipear título, foto y precio: se abre el link como lo abriría
// alguien, y se leen las etiquetas que Mercado Libre pone para las vistas
// previas (og:) y para Google (itemprop, JSON-LD).
//
// Es una ayuda y nada más. Si ML contesta con un captcha o cambia la
// página, se completa a mano: la oferta se guarda igual.
//
// Solo se siguen hosts de Mercado Libre, en cada salto de la redirección.
// Es un endpoint de admin, pero un servidor que abre cualquier URL que le
// pasen es una puerta a la red interna de quien lo hospeda.

function esHostDeMl(host) {
  const h = String(host || '').toLowerCase();
  return h === 'meli.la' ||
    /(^|\.)mercadolibre\.com(\.[a-z]{2})?$/.test(h) ||
    /(^|\.)mercadolivre\.com\.br$/.test(h);
}

const NAVEGADOR = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
                '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'es-AR,es;q=0.9'
};

async function abrirSiguiendoRedirecciones(link) {
  let url = link;
  for (let salto = 0; salto < 6; salto++) {
    let u;
    try { u = new URL(url); } catch (err) { return { ok: false, motivo: 'El link no es válido.' }; }
    if (u.protocol !== 'https:' || !esHostDeMl(u.hostname)) {
      return { ok: false, motivo: 'Ese link no es de Mercado Libre.', url };
    }

    const r = await fetch(url, { headers: NAVEGADOR, redirect: 'manual', signal: AbortSignal.timeout(8000) });
    const destino = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && destino) {
      url = new URL(destino, url).toString();
      continue;
    }
    if (!r.ok) return { ok: false, motivo: 'Mercado Libre contestó ' + r.status + '.', url };
    return { ok: true, url, html: (await r.text()).slice(0, 1500000) };
  }
  return { ok: false, motivo: 'El link da demasiadas vueltas.', url };
}

function decodificar(texto) {
  return String(texto || '')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

// Las <meta> en un objeto { 'og:title': ..., price: ... }. Los atributos
// pueden venir en cualquier orden, así que se leen uno por uno.
function etiquetasMeta(html) {
  const meta = {};
  const etiquetas = html.match(/<meta\b[^>]*>/gi) || [];
  etiquetas.forEach((tag) => {
    const attrs = {};
    tag.replace(/([a-z:-]+)\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, nombre, v, dobles, simples) => {
      attrs[nombre.toLowerCase()] = dobles !== undefined ? dobles : simples;
    });
    const clave = attrs.property || attrs.name || attrs.itemprop;
    if (clave && attrs.content !== undefined && meta[clave.toLowerCase()] === undefined) {
      meta[clave.toLowerCase()] = decodificar(attrs.content);
    }
  });
  return meta;
}

// El precio que Mercado Libre le cuenta a Google. Viene en un bloque
// JSON-LD de tipo Product, a veces dentro de un @graph.
function precioDeJsonLd(html) {
  const bloques = html.match(/<script[^>]+application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const bloque of bloques) {
    try {
      const datos = JSON.parse(bloque.replace(/^<script[^>]*>|<\/script>$/gi, ''));
      const lista = [].concat(datos['@graph'] || datos);
      for (const d of lista) {
        if (!d || !/product/i.test(String(d['@type']))) continue;
        const oferta = [].concat(d.offers || [])[0] || {};
        const precio = Number(oferta.price || oferta.lowPrice);
        if (precio > 0) return precio;
      }
    } catch (err) { /* un bloque roto no tiene que tapar a los demás */ }
  }
  return null;
}

// El precio tachado no está en ninguna etiqueta: está en el HTML visible.
// Mercado Libre lo marca con aria-label "Antes: 1299999 pesos" o con la
// clase andes-money-amount--previous. "1.299.999" son pesos con puntos de
// miles, no decimales.
function precioAnterior(html) {
  const aria = html.match(/aria-label="Antes:\s*([\d.]+)\s*pesos/i);
  if (aria) return Number(aria[1].replace(/\./g, '')) || null;

  const corte = html.search(/andes-money-amount--previous/i);
  if (corte !== -1) {
    const tramo = html.slice(corte, corte + 1500);
    const fraccion = tramo.match(/andes-money-amount__fraction[^>]*>([\d.]+)</i);
    if (fraccion) return Number(fraccion[1].replace(/\./g, '')) || null;
  }
  return null;
}

// MLA123456789, venga como /MLA-123456789-... (publicación), /p/MLA123 (catálogo)
// o item_id:MLA123 en la query.
function idDePublicacion(url, html) {
  const fuentes = [String(url || ''), String(html || '').slice(0, 200000)];
  for (const t of fuentes) {
    const m = t.match(/item_id[:=](ML[A-Z])-?(\d{6,})/) || t.match(/\b(ML[A-Z])-?(\d{6,})\b/);
    if (m) return m[1] + m[2];
  }
  return null;
}

async function accionLeerLink(link) {
  const limpio = urlHttps(link);
  if (!limpio) return { ok: false, motivo: 'Pegá un link que empiece con https://' };

  let pagina;
  try {
    pagina = await abrirSiguiendoRedirecciones(limpio);
  } catch (err) {
    return { ok: false, motivo: 'Mercado Libre no contestó a tiempo. Completalo a mano.' };
  }
  if (!pagina.ok) return { ok: false, motivo: pagina.motivo + ' Completalo a mano.' };

  const meta = etiquetasMeta(pagina.html);

  // "Celular Samsung A15 | MercadoLibre" -> "Celular Samsung A15"
  let titulo = meta['og:title'] || (pagina.html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
  titulo = decodificar(titulo).replace(/\s*[|\-–]\s*Mercado\s*Libre.*$/i, '').trim();

  const precio = Number(meta['price'] || meta['product:price:amount'] || 0) || precioDeJsonLd(pagina.html);
  const antes = precioAnterior(pagina.html);
  const imagen = urlHttps(meta['og:image'] || meta['og:image:secure_url'] || '');

  // Sin título es casi seguro una página de verificación ("¿sos humano?"),
  // no la publicación: mejor decirlo que llenar el formulario con basura.
  if (!titulo || /verific|captcha|robot/i.test(titulo)) {
    return {
      ok: false,
      motivo: 'Mercado Libre no dejó leer la publicación. Completala a mano.',
      ml_item_id: idDePublicacion(pagina.url, '')
    };
  }

  return {
    ok: true,
    titulo: titulo.slice(0, 200),
    imagen_url: imagen,
    precio: precio || null,
    precio_antes: antes && precio && antes > precio ? antes : null,
    ml_item_id: idDePublicacion(pagina.url, pagina.html),
    url_final: pagina.url
  };
}

// ---------- entrada ----------

module.exports = async (req, res) => {
  const faltan = ['SUPABASE_SERVICE_ROLE_KEY'].filter((n) => !process.env[n]);
  if (faltan.length) return res.status(500).json({ error: 'Faltan variables de entorno: ' + faltan.join(', ') });

  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const cabecera = req.headers.authorization || '';
  const token = cabecera.startsWith('Bearer ') ? cabecera.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Falta la sesión' });

  const usuario = await usuarioDeToken(token);
  if (!usuario || !usuario.id) return res.status(401).json({ error: 'Sesión inválida' });
  if (!esAdmin(usuario.email)) {
    return res.status(403).json({ error: 'Esta sección es solo para la cuenta de BRUWAL.' });
  }

  const cuerpo = req.body || {};
  const accion = cuerpo.accion || '';

  try {
    if (accion === 'listar') return res.status(200).json(await accionListar());
    if (accion === 'guardar') return res.status(200).json(await accionGuardar(cuerpo.oferta));
    if (accion === 'cambiar') return res.status(200).json(await accionCambiar(cuerpo.id, cuerpo.campos));
    if (accion === 'borrar') return res.status(200).json(await accionBorrar(cuerpo.id));
    if (accion === 'leer-link') return res.status(200).json(await accionLeerLink(cuerpo.link));
    return res.status(400).json({ error: 'Acción desconocida' });
  } catch (err) {
    console.error('ofertas.js', accion, err);
    // Un error de Postgres no es una respuesta para mostrar tal cual.
    const texto = String((err && err.message) || err);
    if (texto.includes('42P01') || texto.includes('PGRST205')) {
      return res.status(200).json({
        ok: false,
        motivo: 'Falta crear la tabla de ofertas: corré schema/55-ofertas-referidos.sql en Supabase.'
      });
    }
    return res.status(500).json({ error: 'No se pudo completar. Probá de nuevo en un rato.' });
  }
};

// Para probarlas sin levantar la función.
module.exports._interno = { etiquetasMeta, precioDeJsonLd, precioAnterior, idDePublicacion, esHostDeMl, rubroLimpio };
