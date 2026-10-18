// Lógica de la charla del bot de Walter. Sin dependencias: recibe el estado guardado,
// el texto del cliente y la configuración, y devuelve el estado nuevo y las respuestas.

// Un tipo de moneda (o las llaves): precio por unidad y cuántas entran en un kilo
export type TipoMoneda = { n: string; u: number; kg?: number };

export type Config = {
  // monedaU es el precio por unidad de antes de los tipos: se usa solo si no hay tipos
  monedaKg: number; monedaU?: number; monedas?: TipoMoneda[];
  cobreMin: number; cobreMay: number; bronceMin: number; bronceMay: number;
  umbralMay: number; umbralPrio: number;
  // Desde cuántos kilos pasamos a buscar (a domicilio o a un punto de encuentro); con menos, al depósito
  minRetiro?: number;
  depPA: string; depPAh: string; depSL: string; depSLh: string;
  horaNoche?: string; horaManana?: string;
  saludo: string;
};

export type Datos = {
  loc?: string; mat?: "Monedas" | "Cobre" | "Bronce"; modo?: "kg" | "u"; tipo?: string; cant?: number;
  ret?: "Retiro a domicilio" | "Punto de encuentro" | "Depósito"; nombre?: string; dir?: string;
};
// Pistas: lo que la IA entendió de un mensaje escrito libremente y todavía no se usó
export type Pistas = Partial<Pick<Datos, "loc" | "mat" | "modo" | "tipo" | "cant" | "ret">>;
export type Estado = { step: string; d: Datos; p?: Pistas };
export type Respuesta = { text: string; options?: string[] };
export type Pedido = Required<Pick<Datos, "loc" | "mat" | "modo" | "cant" | "ret" | "nombre">> & {
  tipo: string | null; dir: string | null; monto: number; tarifa: string; prioridad: boolean;
};
export type Resultado = { estado: Estado; respuestas: Respuesta[]; pedido?: Pedido; derivar?: boolean };

export const LOCALIDADES: { n: string; a: string[] }[] = [
  { n: "Rosario", a: ["rosario"] },
  { n: "Baigorria", a: ["baigorria", "granadero baigorria"] },
  { n: "Bermúdez", a: ["bermudez", "capitan bermudez"] },
  { n: "Beltrán", a: ["beltran", "fray luis beltran"] },
  { n: "San Lorenzo", a: ["san lorenzo"] },
  { n: "Puerto General San Martín", a: ["puerto general san martin", "puerto san martin", "pto gral san martin", "pto san martin", "puerto gral san martin"] },
  { n: "Aldao", a: ["aldao"] },
  { n: "Pueblo Andino", a: ["pueblo andino", "andino"] },
  { n: "Serodino", a: ["serodino"] },
  { n: "La Ribera", a: ["la ribera", "ribera"] },
  { n: "Oliveros", a: ["oliveros"] },
  { n: "Maciel", a: ["maciel"] },
  { n: "Totoras", a: ["totoras"] },
  { n: "Funes", a: ["funes"] },
  { n: "Ibarlucea", a: ["ibarlucea"] },
  { n: "Roldán", a: ["roldan"] },
];

const fmt = (n: number) => "$" + Math.round(n).toLocaleString("es-AR");
const kgf = (n: number) => (Math.round(n * 10) / 10).toLocaleString("es-AR") + " kg";
export const norm = (s: string) =>
  (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 .,]/g, " ").replace(/\s+/g, " ").trim();

export function parseNum(s: string): number | null {
  const m = String(s).match(/\d[\d.,]*/);
  if (!m) return null;
  let x = m[0].replace(/[.,]$/, "");
  if (x.includes(",")) x = x.replace(/\./g, "").replace(",", ".");
  else if (/\.\d{3}(\.|$)/.test(x)) x = x.replace(/\./g, "");
  const v = parseFloat(x);
  return isNaN(v) ? null : v;
}

export function findLoc(s: string): string | null {
  const n = " " + norm(s) + " ";
  let best: { n: string; len: number } | null = null;
  for (const l of LOCALIDADES) for (const a of l.a) {
    if (n.includes(" " + a + " ") && (!best || a.length > best.len)) best = { n: l.n, len: a.length };
  }
  return best ? best.n : null;
}

export const MEZCLADAS = "Mezcladas";
// La opción de la lista de tipos para las que van por kilo, sean de una clase o mezcladas
const OPCION_KILO = "Por kilo o mezcladas";
export const tiposDe = (c: Config) => (c.monedas ?? []).filter((t) => t && t.n && t.u > 0);
const esLlave = (n?: string) => /llave/i.test(n ?? "");
const tipoPorNombre = (c: Config, n?: string) => tiposDe(c).find((t) => t.n === n);
// "monedas de $10", "llaves"
const nombreTipo = (n: string) => (esLlave(n) ? "llaves" : "monedas de " + n);

/** El tipo que nombra el cliente: un tipo de la configuración, MEZCLADAS, o null si no se entiende. */
export function findTipo(c: Config, s: string): string | null {
  const n = norm(s);
  if (/mezcl|varias|surtid|de todo|kilo|kg|pesad/.test(n)) return MEZCLADAS;
  const tipos = tiposDe(c);
  const exacto = tipos.find((t) => norm(t.n) === n);
  if (exacto) return exacto.n;
  // Por el número ("10", "50") o, en las llaves, por la palabra. Si quedan dos
  // (25 dorada y 25 plateada), decide la otra palabra del nombre.
  const palabras = new Set(n.split(/[ .,]+/));
  let cand = tipos.filter((t) => {
    const num = norm(t.n).match(/\d+/)?.[0];
    return num ? palabras.has(num) : esLlave(t.n) && /llave/.test(n);
  });
  if (cand.length > 1) {
    cand = cand.filter((t) => norm(t.n).split(" ").filter((w) => !/^\d+$/.test(w) && w !== "centavos")
      .every((w) => palabras.has(w) || palabras.has(w + "s")));
  }
  return cand.length === 1 ? cand[0].n : null;
}

export function cotizar(c: Config, mat: string, modo: string, cant: number, tipo?: string) {
  if (mat === "Monedas") {
    const precio = modo === "u" ? (tipoPorNombre(c, tipo)?.u ?? c.monedaU ?? 0) : c.monedaKg;
    return { precio, total: cant * precio, tarifa: modo === "u" ? "por unidad" : "por kilo" };
  }
  const may = cant >= c.umbralMay;
  const precio = mat === "Cobre" ? (may ? c.cobreMay : c.cobreMin) : (may ? c.bronceMay : c.bronceMin);
  return { precio, total: cant * precio, tarifa: may ? "mayorista" : "minorista" };
}

const cantTxt = (d: Datos) => {
  if (d.modo !== "u") return kgf(d.cant ?? 0);
  const n = (d.cant ?? 0).toLocaleString("es-AR");
  return d.tipo ? n + " " + nombreTipo(d.tipo) : n + " unidades";
};
// "300 monedas de $10", "12,5 kg de cobre"
const queTxt = (d: Datos) => (d.tipo ? cantTxt(d) : cantTxt(d) + " de " + d.mat?.toLowerCase());

// Kilos estimados: las contadas se pasan a kilos con cuántas hacen un kilo; null si el tipo no lo dice
function kilosDe(d: Datos, c: Config): number | null {
  if (d.modo !== "u") return d.cant ?? 0;
  const kg = tipoPorNombre(c, d.tipo)?.kg;
  return kg ? (d.cant ?? 0) / kg : null;
}
const soloDeposito = (d: Datos, c: Config) => {
  const k = kilosDe(d, c);
  return !!c.minRetiro && k !== null && k < c.minRetiro;
};
// "Pasamos a buscar desde 2 kg (unas 222 monedas de $10)."
function minTxt(d: Datos, c: Config) {
  const kg = d.modo === "u" ? tipoPorNombre(c, d.tipo)?.kg : undefined;
  const eq = kg && d.tipo ? ` (unas ${Math.ceil(c.minRetiro! * kg).toLocaleString("es-AR")} ${nombreTipo(d.tipo)})` : "";
  return `Pasamos a buscar desde ${kgf(c.minRetiro!)}${eq}. Con menos, lo podés traer a uno de nuestros depósitos.`;
}

function depositos(c: Config) {
  return `📍 Depósito San Lorenzo: ${c.depSL}\n${c.depSLh}\n\n📍 Depósito Pueblo Andino: ${c.depPA}\n${c.depPAh}`;
}
function precios(c: Config) {
  const tipos = tiposDe(c);
  const monedas = tipos.length
    ? `• Monedas: ${fmt(c.monedaKg)} el kilo. Contadas, cada una:\n` +
      tipos.map((t) => `   – ${esLlave(t.n) ? "Llaves" : "De " + t.n}: ${fmt(t.u)}`).join("\n") + "\n"
    : `• Monedas: ${fmt(c.monedaKg)} el kilo o ${fmt(c.monedaU ?? 0)} por unidad\n`;
  return `Precios de hoy:\n${monedas}` +
    `• Cobre: ${fmt(c.cobreMin)}/kg (desde ${c.umbralMay} kg: ${fmt(c.cobreMay)}/kg)\n` +
    `• Bronce: ${fmt(c.bronceMin)}/kg (desde ${c.umbralMay} kg: ${fmt(c.bronceMay)}/kg)`;
}

function pregunta(e: Estado, c: Config): Respuesta {
  const d = e.d;
  switch (e.step) {
    case "loc": return { text: "¿De qué localidad nos escribís?" };
    case "cat": return { text: "¿Qué querés vender?", options: ["Monedas", "Cobre", "Bronce"] };
    case "unit": return { text: "¿Las tenés contadas o pesadas?", options: ["Por kilo", "Por unidad"] };
    case "tipo": return {
      text: `¿De qué monedas son? Si las tenés pesadas o son de varias clases, elegí "${OPCION_KILO}".`,
      options: [...tiposDe(c).map((t) => t.n), OPCION_KILO],
    };
    case "qty":
      if (d.mat === "Monedas") {
        if (d.modo !== "u") return { text: "¿Cuántos kilos tenés, aproximadamente?" };
        return { text: `¿Cuántas ${d.tipo ? nombreTipo(d.tipo) : "monedas"} son, más o menos?` };
      }
      return { text: `¿Cuántos kilos de ${d.mat?.toLowerCase()} tenés en total?` };
    case "mod":
      if (soloDeposito(d, c)) return { text: "¿Lo traés al depósito?", options: ["Llevo al depósito", "Hablar con Walter"] };
      // La dirección escrita ya elige el retiro a domicilio: un mensaje menos que tocar el botón y después escribirla
      return {
        text: `¿Cómo lo hacemos? Si querés que lo pasemos a buscar, escribime la dirección en ${d.loc} (calle y número). Si no, elegí una opción.`,
        options: ["Punto de encuentro", "Llevo al depósito"],
      };
    case "name": return { text: "¿A nombre de quién lo anotamos?" };
    case "addr": return {
      text: d.ret === "Punto de encuentro"
        ? `¿Qué lugar de ${d.loc} te queda cómodo para encontrarnos? (plaza, estación de servicio, esquina)`
        : `¿Cuál es la dirección en ${d.loc}?`,
    };
    case "out": return { text: "¿Querés probar con otra localidad?", options: ["Otra localidad", "Hablar con Walter"] };
    default: return { text: "¿Querés cotizar algo más?", options: ["Empezar de nuevo"] };
  }
}

export function nuevoEstado(): Estado { return { step: "loc", d: {} }; }

/**
 * Junta las respuestas seguidas en un solo mensaje, porque Meta cobra cada mensaje.
 * Solo el último de cada grupo puede llevar opciones; el texto no pasa de lo que acepta
 * un mensaje con botones (1024) o uno de Messenger (2000).
 */
export function juntar(rs: Respuesta[]): Respuesta[] {
  const out: Respuesta[] = [];
  for (const r of rs) {
    const prev = out[out.length - 1];
    const text = prev ? prev.text + "\n\n" + r.text : r.text;
    if (prev && !prev.options?.length && text.length <= (r.options?.length ? 1024 : 2000)) out[out.length - 1] = { ...r, text };
    else out.push(r);
  }
  return out;
}

/** Procesa un mensaje del cliente. `estado` es null en el primer mensaje. */
export function procesar(estado: Estado | null, texto: string, c: Config): Resultado {
  if (!estado) {
    // Primer mensaje: saludo. Si ya dijo la localidad, la tomamos de una.
    const e = nuevoEstado();
    if (findLoc(texto)) return procesar(e, texto, c);
    // Lo que sigue necesita la localidad: si el saludo no la pide, la pide el bot.
    const respuestas: Respuesta[] = [{ text: c.saludo }];
    if (!/localidad/.test(norm(c.saludo))) respuestas.push(pregunta(e, c));
    return { estado: e, respuestas };
  }
  const e: Estado = { step: estado.step, d: { ...estado.d } };
  const d = e.d;
  const t = texto.trim();
  const n = norm(t);
  const out = (...r: Respuesta[]): Resultado => ({ estado: e, respuestas: r });

  // Un saludo suelto a mitad de la charla (volvió, o se perdió) arranca de nuevo
  const saludo = /^(hola|buenas|buen dia|buenos dias|buenas tardes|buenas noches)$/.test(n) && e.step !== "name" && e.step !== "addr";
  if (saludo || /(empezar de nuevo|reiniciar)/.test(n)) return procesar(null, "", c);
  if (n === "otra localidad") { e.step = "loc"; return out(pregunta(e, c)); }
  if (/(hablar|humano|persona|walter)/.test(n) && e.step !== "name" && e.step !== "addr") {
    return { ...out({ text: "Listo, le aviso a Walter y te escribe por acá apenas pueda. 🙌" }, pregunta(e, c)), derivar: true };
  }
  if (/(horario|deposito|donde estan)/.test(n) && e.step !== "addr" && e.step !== "mod") return out({ text: depositos(c) }, pregunta(e, c));
  if (/(precio|cuanto pagan|cotizacion|a cuanto)/.test(n)) {
    // Si pregunta por un tipo ("¿cuánto pagan las de 10?"), le contestamos ese y no la lista entera
    const tp = /cobre|bronce/.test(n) ? undefined : tipoPorNombre(c, findTipo(c, t) ?? undefined);
    if (tp) {
      return out({ text: `${esLlave(tp.n) ? "Las llaves" : "Las de " + tp.n} las pagamos ${fmt(tp.u)} cada una. ` +
        `Si las tenés pesadas o mezcladas, el kilo está ${fmt(c.monedaKg)}.` }, pregunta(e, c));
    }
    if (parseNum(t) === null) return out({ text: precios(c) }, pregunta(e, c));
  }

  switch (e.step) {
    case "out":
      if (!findLoc(t)) return out(pregunta(e, c));
      e.step = "loc";
    // falls through
    case "loc": {
      const l = findLoc(t);
      if (!l) {
        e.step = "out";
        return out({
          text: `Por ahora retiramos en Rosario y alrededores: ${LOCALIDADES.map((x) => x.n).join(", ")}.\n` +
            `Si te queda cerca, también podés acercarte a nuestro depósito:\n\n${depositos(c)}`,
          options: ["Otra localidad", "Hablar con Walter"],
        });
      }
      d.loc = l; e.step = "cat";
      return out({ text: `¡Genial, en ${l} trabajamos! ¿Qué querés vender?`, options: ["Monedas", "Cobre", "Bronce"] });
    }
    case "cat": {
      const llave = /llave/.test(n) ? tiposDe(c).find((x) => esLlave(x.n)) : undefined;
      if (llave) {
        d.mat = "Monedas"; d.modo = "u"; d.tipo = llave.n; e.step = "qty";
        return out(pregunta(e, c));
      }
      const mat = /moneda/.test(n) ? "Monedas" : /cobre/.test(n) ? "Cobre" : /bronce/.test(n) ? "Bronce" : null;
      if (!mat) {
        const llaves = tiposDe(c).some((x) => esLlave(x.n)) ? "llaves, " : "";
        return out({ text: `Compramos monedas, ${llaves}cobre y bronce. ¿Cuál de esos tenés?`, options: ["Monedas", "Cobre", "Bronce"] });
      }
      d.mat = mat;
      if (mat === "Monedas") {
        // Sin preguntar si están contadas o pesadas: la lista de tipos trae la opción por kilo
        if (/kilo|kg|pesad/.test(n)) {
          d.modo = "kg"; e.step = "qty";
          const q = parseNum(t);
          return q ? cantidad(e, q, c) : out(pregunta(e, c));
        }
        if (!tiposDe(c).length) { e.step = "unit"; return out(pregunta(e, c)); }
        e.step = "tipo"; return out(pregunta(e, c));
      }
      d.modo = "kg"; e.step = "qty"; return out(pregunta(e, c));
    }
    case "unit": {
      if (/unidad|contad|cantidad/.test(n)) d.modo = "u";
      else if (/kilo|kg|pesad/.test(n)) d.modo = "kg";
      else return out(pregunta(e, c));
      delete d.tipo;
      if (d.modo === "u" && tiposDe(c).length) { e.step = "tipo"; return out(pregunta(e, c)); }
      e.step = "qty";
      const q = parseNum(t);
      return q ? cantidad(e, q, c) : out(pregunta(e, c));
    }
    case "tipo": {
      const tipo = findTipo(c, t);
      if (!tipo) return out(pregunta(e, c));
      e.step = "qty";
      if (tipo === MEZCLADAS) {
        d.modo = "kg"; delete d.tipo;
        return out({ text: `Por kilo pagamos ${fmt(c.monedaKg)}.` }, pregunta(e, c));
      }
      d.modo = "u"; d.tipo = tipo;
      return out(pregunta(e, c));
    }
    case "qty": {
      const q = parseNum(t);
      if (!q || q <= 0) {
        // Con las opciones para salir, si no sabe cuánto tiene o quiere preguntar otra cosa
        return out({ text: d.modo === "u"
          ? `Pasame un número aproximado de ${esLlave(d.tipo) ? "llaves" : "monedas"}, por ejemplo 2500.`
          : "Pasame los kilos con un número, por ejemplo 12 o 7,5.", options: ["Hablar con Walter", "Empezar de nuevo"] });
      }
      return cantidad(e, q, c);
    }
    case "mod": {
      if (/encuentro|punto|nos vemos/.test(n)) d.ret = "Punto de encuentro";
      else if (/deposito|llevo|voy/.test(n)) d.ret = "Depósito";
      else if (esDireccion(n)) { d.ret = "Retiro a domicilio"; d.dir = t.slice(0, 120); }
      else if (/domicilio|casa|busquen|retir/.test(n)) d.ret = "Retiro a domicilio";
      else return out(pregunta(e, c));
      if (d.ret !== "Depósito" && soloDeposito(d, c)) { delete d.ret; delete d.dir; return out({ text: minTxt(d, c) }, pregunta(e, c)); }
      e.step = "name"; return out(pregunta(e, c));
    }
    case "name": {
      d.nombre = t.slice(0, 40);
      if (d.ret === "Depósito") {
        e.step = "done";
        return {
          ...out({ text: `Perfecto, ${d.nombre}. Te esperamos en el depósito:\n\n${depositos(c)}\n\n` +
            (d.mat !== "Monedas" ? "Traelo y lo pesamos" : d.modo === "u" ? "Traelas y las contamos" : "Traelas y las pesamos") +
            " ahí mismo.", options: ["Empezar de nuevo"] }),
          pedido: armarPedido(d, c, null),
        };
      }
      if (d.dir) return anotar(e, c);
      e.step = "addr"; return out(pregunta(e, c));
    }
    case "addr": {
      d.dir = t.slice(0, 120);
      return anotar(e, c);
    }
    default: return out(pregunta(e, c));
  }
}

// Una dirección escrita en vez de elegir cómo entregarlo: calle y número, sin horarios ni cantidades
const esDireccion = (n: string) =>
  /\d/.test(n) && /[a-z]{3,}/.test(n) && !/\b(hs|hora|horas|manana|tarde|noche|kilo|kilos|kg|monedas?)\b/.test(n);

// Cierra un pedido con retiro a domicilio o punto de encuentro
function anotar(e: Estado, c: Config): Resultado {
  const d = e.d;
  e.step = "done";
  const p = armarPedido(d, c, d.dir!);
  return {
    estado: e,
    respuestas: [{
      // Con la dirección a la vista, para que el cliente la corrija si la escribió mal
      text: `¡Listo, ${d.nombre}! Quedó anotado:\n• ${queTxt(d)}\n• ${d.ret}: ${d.dir}, ${d.loc}\n• Estimado: ${fmt(p.monto)}\n\n` +
        `Walter arma los recorridos y te avisamos por acá el día y si pasamos a la mañana o a la tarde.` +
        (p.prioridad ? "\n\nComo es una buena cantidad, te ponemos entre los primeros del recorrido." : ""),
      options: ["Empezar de nuevo"],
    }],
    pedido: p,
  };
}

/** El nombre del perfil de WhatsApp sin emojis, o null si no parece un nombre. */
export function nombreDePerfil(s?: string): string | null {
  const x = (s ?? "").replace(/[^\p{L}\p{M} .'-]/gu, " ").replace(/\s+/g, " ").trim();
  return /\p{L}.*\p{L}/u.test(x) ? x.slice(0, 40) : null;
}

/** Si el bot iba a preguntar a nombre de quién anotarlo y ya lo sabemos por el perfil, contesta solo. */
export function conPerfil(r: Resultado, nombre: string | null, c: Config): Resultado {
  if (!nombre || r.estado.step !== "name" || r.derivar) return r;
  const r2 = procesar(r.estado, nombre, c);
  return {
    ...r2,
    estado: r.estado.p ? { ...r2.estado, p: r.estado.p } : r2.estado,
    respuestas: [...r.respuestas.slice(0, -1), ...r2.respuestas],
  };
}

// Lo que la IA entendió de un mensaje. otraLoc: nombró una localidad que no está en la lista.
export type Lectura = Pistas & { otraLoc?: boolean; intencion?: "precios" | "depositos" | "humano" };

// El texto con el que el cliente habría contestado la pregunta actual, si las pistas ya la responden
function respuestaDesde(e: Estado, p: Pistas, c: Config): { texto: string; campo: keyof Pistas } | null {
  const d = e.d;
  switch (e.step) {
    case "loc": case "out": return p.loc ? { texto: p.loc, campo: "loc" } : null;
    case "cat":
      if (esLlave(p.tipo)) return { texto: "llaves", campo: "tipo" };
      // Pesadas: directo a los kilos, sin pasar por la lista de tipos
      if (p.mat === "Monedas" && (p.modo === "kg" || p.tipo === MEZCLADAS)) return { texto: "monedas por kilo", campo: "mat" };
      return p.mat ? { texto: p.mat, campo: "mat" } : null;
    case "unit":
      if (p.modo) return { texto: p.modo === "u" ? "Por unidad" : "Por kilo", campo: "modo" };
      if (p.tipo) return { texto: p.tipo === MEZCLADAS ? "Por kilo" : "Por unidad", campo: "modo" };
      return null;
    case "tipo":
      if (p.tipo) return { texto: p.tipo, campo: "tipo" };
      return p.modo === "kg" ? { texto: OPCION_KILO, campo: "modo" } : null;
    // Una cantidad en kilos no sirve si estamos contando unidades, y al revés
    case "qty": return p.cant && (!p.modo || p.modo === d.modo) ? { texto: String(p.cant), campo: "cant" } : null;
    case "mod":
      // Con pocos kilos solo queda el depósito: eso ya se lo dijimos con la cotización
      if (!p.ret || (p.ret !== "Depósito" && soloDeposito(d, c))) return null;
      return { texto: p.ret === "Depósito" ? "Llevo al depósito" : p.ret, campo: "ret" };
    default: return null;
  }
}

const PALABRA_INTENCION = { precios: "precios", depositos: "deposito", humano: "hablar con Walter" } as const;

/**
 * Como procesar, con lo que la IA entendió del mensaje: contesta de una las preguntas que el
 * cliente ya respondió ("tengo 3 kilos de cobre en Funes") y guarda el resto para más adelante.
 * Los precios, las cuentas y los textos siguen saliendo de procesar.
 * Con l null (tocó un botón, o la IA no respondió) solo se usan las pistas que ya estaban guardadas.
 */
export function procesarConLectura(estado: Estado | null, texto: string, c: Config, l: Lectura | null): Resultado {
  // Después de un pedido, si cuenta que tiene otra cosa, cotizamos de nuevo en la misma localidad
  if (estado?.step === "done" && estado.d.loc && (l?.mat || l?.tipo)) estado = { step: "cat", d: { loc: estado.d.loc } };
  let r = procesar(estado, texto, c);
  const sinAvance = !!estado && JSON.stringify(r.estado.d) === JSON.stringify(estado.d);
  // Lo que procesar no reconoce por palabras clave ("¿dónde quedan?")
  // Con el tipo que nombró, el precio de ese tipo
  const palabra = l?.intencion === "precios" && tipoPorNombre(c, l.tipo) ? "precio " + l.tipo : l?.intencion && PALABRA_INTENCION[l.intencion];
  if (sinAvance && palabra && !r.derivar) r = procesar(estado, palabra, c);
  // Si arranca preguntando ("¿cuánto pagan las de 10?"), después del saludo le contestamos eso
  if (!estado && palabra && r.estado.step === "loc") {
    const r2 = procesar(r.estado, palabra, c);
    r = { ...r2, respuestas: [r.respuestas[0], ...r2.respuestas] };
  }

  // Empezar de nuevo descarta las pistas viejas
  const reinicio = !!estado && r.estado.step === "loc" && !Object.keys(r.estado.d).length;
  const p: Pistas = { ...(reinicio ? {} : estado?.p), ...(l ? pistasDe(l, c) : {}) };

  // Si no nombró ningún lugar, en vez de "por ahora no retiramos ahí" le volvemos a preguntar
  if (l && estado?.step === "loc" && r.estado.step === "out" && !l.otraLoc && !p.loc && !l.intencion) {
    r = { estado: { step: "loc", d: r.estado.d }, respuestas: [{ text: "¿De qué localidad nos escribís? Así te digo si pasamos por ahí." }] };
  }

  const respuestas: Respuesta[] = [];
  let prefijo = "";
  for (let i = 0; i < 8 && !r.derivar && !r.pedido; i++) {
    const a = respuestaDesde(r.estado, p, c);
    if (!a) break;
    delete p[a.campo];
    // La última respuesta de cada paso es la pregunta que ahora contestamos solos.
    // De la confirmación de la localidad queda el "trabajamos ahí", sumado al mensaje que sigue.
    if (r.estado.step === "cat" && !prefijo && r.estado.d.loc && r.estado.d.loc !== estado?.d.loc) prefijo = `¡Genial, en ${r.estado.d.loc} trabajamos! `;
    respuestas.push(...r.respuestas.slice(0, -1));
    r = procesar(r.estado, a.texto, c);
  }
  respuestas.push(...r.respuestas);
  if (prefijo && respuestas.length && !respuestas.some((x) => x.text.startsWith("¡Genial, en "))) {
    respuestas[0] = { ...respuestas[0], text: prefijo + respuestas[0].text };
  }

  // Lo que ya quedó anotado no hace falta guardarlo como pista
  for (const k of Object.keys(p) as (keyof Pistas)[]) if (r.estado.d[k] !== undefined) delete p[k];
  const estadoFinal: Estado = { step: r.estado.step, d: r.estado.d };
  if (Object.keys(p).length) estadoFinal.p = p;
  return { ...r, estado: estadoFinal, respuestas };
}

function pistasDe(l: Lectura, c: Config): Pistas {
  const p: Pistas = {};
  if (l.loc && LOCALIDADES.some((x) => x.n === l.loc)) p.loc = l.loc;
  if (l.mat === "Monedas" || l.mat === "Cobre" || l.mat === "Bronce") p.mat = l.mat;
  if (l.modo === "kg" || l.modo === "u") p.modo = l.modo;
  if (l.tipo && (l.tipo === MEZCLADAS || tipoPorNombre(c, l.tipo))) p.tipo = l.tipo;
  if (typeof l.cant === "number" && l.cant > 0) p.cant = l.cant;
  if (l.ret === "Retiro a domicilio" || l.ret === "Punto de encuentro" || l.ret === "Depósito") p.ret = l.ret;
  return p;
}

function cantidad(e: Estado, q: number, c: Config): Resultado {
  const d = e.d; d.cant = q;
  const r = cotizar(c, d.mat!, d.modo!, q, d.tipo);
  let text: string;
  if (d.mat === "Monedas") {
    text = `Por ${queTxt(d)} te pagamos ${fmt(r.total)} (` +
      (d.modo === "u" ? `${fmt(r.precio)} cada una` : `hoy ${fmt(r.precio)} el kilo`) + ").";
  }
  else text = `Por ${kgf(q)} de ${d.mat!.toLowerCase()} te pagamos ${fmt(r.total)} (${fmt(r.precio)} el kilo, precio ${r.tarifa}).` +
    (r.tarifa === "mayorista" ? "" : `\nDesde ${c.umbralMay} kg pagamos precio mayorista.`);
  e.step = "mod";
  const fin = soloDeposito(d, c) ? minTxt(d, c) : "El monto final se confirma al pesar en el momento del retiro.";
  return { estado: e, respuestas: [{ text: text + "\n" + fin }, pregunta(e, c)] };
}

function armarPedido(d: Datos, c: Config, dir: string | null): Pedido {
  const r = cotizar(c, d.mat!, d.modo!, d.cant!, d.tipo);
  // Las contadas también cuentan para la prioridad, pasadas a kilos; las llaves no son monedas.
  const kilos = kilosDe(d, c) ?? 0;
  return {
    loc: d.loc!, mat: d.mat!, modo: d.modo!, tipo: d.tipo ?? null, cant: d.cant!, ret: d.ret!, nombre: d.nombre!, dir,
    monto: Math.round(r.total), tarifa: r.tarifa,
    prioridad: d.mat === "Monedas" && !esLlave(d.tipo) && kilos >= c.umbralPrio,
  };
}
