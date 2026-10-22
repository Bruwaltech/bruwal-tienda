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
  // manual: Walter atiende todas las charlas desde el panel y el bot no contesta ninguna
  modo?: "auto" | "manual";
};

// Una línea de monedas del pedido: un tipo contado, o mezcladas por kilo (sin tipo)
export type Linea = { modo: "kg" | "u"; tipo?: string; cant: number };
export type Datos = {
  loc?: string; mat?: "Monedas" | "Cobre" | "Bronce"; modo?: "kg" | "u"; tipo?: string; cant?: number;
  // Las monedas de otros tipos que ya sumó al pedido; la que está cotizando ahora va en modo, tipo y cant
  items?: Linea[];
  // Los tipos que eligió de la lista uno atrás de otro, todavía sin cantidad ("25 plateada", "$1", "$10")
  pend?: string[];
  ret?: "Retiro a domicilio" | "Punto de encuentro" | "Depósito"; nombre?: string; dir?: string;
};
// Pistas: lo que la IA entendió de un mensaje escrito libremente y todavía no se usó
// items: varias clases de monedas con su cantidad en un mismo mensaje ("145 de 1, 58 de 50, 348 de 10")
// varias: nombró llaves y monedas juntas, sin cantidades ("tengo monedas y llaves"): se pregunta por todo de una
export type Pistas = Partial<Pick<Datos, "loc" | "mat" | "modo" | "tipo" | "cant" | "ret" | "dir" | "items">> & { varias?: boolean };
export type Estado = { step: string; d: Datos; p?: Pistas };
export type Respuesta = { text: string; options?: string[] };
export type Pedido = Required<Pick<Datos, "loc" | "mat" | "modo" | "cant" | "ret" | "nombre">> & {
  tipo: string | null; dir: string | null; monto: number; tarifa: string; prioridad: boolean;
  // Con varios tipos de moneda: cada línea con su precio y su total (walter_pedidos.items, schema/70)
  items: (Linea & { precio: number; total: number })[] | null;
};
// consulta: el cliente hizo una pregunta que hay que contestar antes de seguir (la contesta la IA con hechos())
export type Resultado = { estado: Estado; respuestas: Respuesta[]; pedido?: Pedido; derivar?: boolean; consulta?: boolean };

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
  // Sin puntos ni comas, para que "Funes," o "Rosario." también cuenten
  const n = " " + norm(s).replace(/[.,]/g, " ") + " ";
  let best: { n: string; len: number } | null = null;
  for (const l of LOCALIDADES) for (const a of l.a) {
    if (n.includes(" " + a + " ") && (!best || a.length > best.len)) best = { n: l.n, len: a.length };
  }
  return best ? best.n : null;
}

// Lo que Walter no compra nunca, porque suele venir de robos: no se cotiza ni se anota
const PROHIBIDO = /medidor|cementerio|lapida|nicho|placas? (recordatoria|conmemorativa|funeraria|mortuoria)|cables? (telefonic|de telefono|de telecom)|par telefonico|(block|bloque|taco)s? .*numer|numerad|numeracion|robad|afanad|choread/;
export const esProhibido = (s: string) => PROHIBIDO.test(norm(s));

/** No compramos eso: lo dice y vuelve a preguntar qué tiene, sin lo que ya había anotado de material. */
export function rechazar(estado: Estado | null, c: Config, prohibido: boolean, texto = ""): Resultado {
  const e: Estado = estado ? { step: estado.step, d: { ...estado.d } } : nuevoEstado();
  const d = e.d;
  // "Soy de Roldán, tengo medidores": la localidad sirve para lo que sí tenga
  d.loc ??= findLoc(texto) ?? undefined;
  delete d.mat; delete d.modo; delete d.tipo; delete d.cant; delete d.ret; delete d.dir;
  e.step = d.loc ? "cat" : "loc";
  const llaves = tiposDe(c).some((x) => esLlave(x.n)) ? "llaves, " : "";
  return { estado: e, respuestas: [
    { text: prohibido
      ? "Eso no lo compramos: medidores, placas de cementerio, cables telefónicos ni piezas con numeración."
      : "Eso no lo compramos." },
    d.loc ? { text: `Compramos monedas, ${llaves}cobre y bronce. ¿Tenés algo de eso?`, options: ["Monedas", "Cobre", "Bronce"] }
      : { text: `Compramos monedas, ${llaves}cobre y bronce. Si tenés algo de eso, ¿de qué localidad nos escribís?` },
  ] };
}

export const MEZCLADAS = "Mezcladas";
const OTRO_TIPO = "Sí, de otro tipo";
const NADA_MAS = "No, eso es todo";
// Lo que se usa por dentro cuando las pistas dicen que van por kilo (findTipo lo lee como MEZCLADAS).
// Ya no es una opción de la lista: Walter ofrece primero pagar por unidad.
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

const cantTxt = (d: Pick<Datos, "modo" | "tipo" | "cant">) => {
  if (d.modo !== "u") return kgf(d.cant ?? 0);
  const n = (d.cant ?? 0).toLocaleString("es-AR");
  return d.tipo ? n + " " + nombreTipo(d.tipo) : n + " unidades";
};
// "300 monedas de $10", "12,5 kg de cobre"
const lineaTxt = (d: Pick<Datos, "mat" | "modo" | "tipo" | "cant">) => (d.tipo ? cantTxt(d) : cantTxt(d) + " de " + (d.mat ?? "Monedas").toLowerCase());

/** Las líneas de monedas del pedido: las que ya sumó y la que está cotizando. Vacío si no son monedas. */
export function lineas(d: Datos): Linea[] {
  if (d.mat !== "Monedas") return [];
  const ahora: Linea[] = d.cant != null && d.modo ? [{ modo: d.modo, ...(d.tipo ? { tipo: d.tipo } : {}), cant: d.cant }] : [];
  // El mismo tipo dos veces ("200 de 10" y después "100 de 10 más") va sumado
  const todas: Linea[] = [];
  for (const l of [...(d.items ?? []), ...ahora]) {
    const igual = todas.find((x) => x.modo === l.modo && x.tipo === l.tipo);
    if (igual) igual.cant += l.cant;
    else todas.push({ ...l });
  }
  return todas;
}
const varias = (d: Datos) => lineas(d).length > 1;
// Los tipos que eligió y todavía no tienen cantidad
const pendientes = (d: Datos) => (d.pend ?? []).filter((t) => !lineas(d).some((l) => l.tipo === t));
// "300 monedas de $10 y 2 kg de monedas"; con una sola línea, como siempre
const queTxt = (d: Datos) => (varias(d) ? enLista(lineas(d).map((l) => lineaTxt({ mat: "Monedas", ...l }))) : lineaTxt(d));
// "a, b y c"
const enLista = (xs: string[]) => (xs.length > 1 ? xs.slice(0, -1).join(", ") + " y " + xs[xs.length - 1] : xs[0] ?? "");

// Kilos estimados: las contadas se pasan a kilos con cuántas hacen un kilo; null si ningún tipo lo dice
function kilosLinea(l: Linea, c: Config): number | null {
  if (l.modo !== "u") return l.cant;
  const kg = tipoPorNombre(c, l.tipo)?.kg;
  return kg ? l.cant / kg : null;
}
function kilosDe(d: Datos, c: Config): number | null {
  if (d.mat !== "Monedas") return d.cant ?? 0;
  const k = lineas(d).map((l) => kilosLinea(l, c)).filter((x): x is number => x !== null);
  return k.length ? k.reduce((a, b) => a + b, 0) : null;
}
// Cuánto se paga por todas las monedas del pedido (o por el cobre o el bronce)
function totalDe(d: Datos, c: Config): number {
  if (d.mat !== "Monedas") return cotizar(c, d.mat!, d.modo!, d.cant!, d.tipo).total;
  return lineas(d).reduce((a, l) => a + cotizar(c, "Monedas", l.modo, l.cant, l.tipo).total, 0);
}
const soloDeposito = (d: Datos, c: Config) => {
  const k = kilosDe(d, c);
  return !!c.minRetiro && k !== null && k < c.minRetiro;
};
// "Pasamos a buscar desde 2 kg (unas 222 monedas de $10)."
function minTxt(d: Datos, c: Config) {
  const kg = d.modo === "u" && !varias(d) ? tipoPorNombre(c, d.tipo)?.kg : undefined;
  const eq = kg && d.tipo ? ` (unas ${Math.ceil(c.minRetiro! * kg).toLocaleString("es-AR")} ${nombreTipo(d.tipo)})` : "";
  return `Para esa cantidad no llegamos a pasar a buscarlo: retiramos desde ${kgf(c.minRetiro!)}${eq}.`;
}

/** Lo que el bot sabe del negocio, para que la IA conteste preguntas sin inventar. */
export function hechos(c: Config): string {
  return [
    precios(c),
    // Walter compra las monedas por unidad; el kilo es solo para las mezcladas o las que no quieren contar
    tiposDe(c).length ? `Las monedas las compramos por unidad. Solo si están mezcladas o no las quieren contar, por kilo a ${fmt(c.monedaKg)}.` : "",
    tiposDe(c).length ? `Solo compramos estas monedas: ${tiposDe(c).map((t) => t.n).join(", ")}. Si tiene de otras, que las separe: esas no las compramos.` : "",
    "En un mismo pedido se pueden juntar monedas de varios tipos y llaves: se pasa la lista (por ejemplo 50 de $1 y 20 de 50 centavos) y se suma todo.",
    `Pasamos a buscar (a domicilio o en un punto de encuentro) en: ${LOCALIDADES.map((x) => x.n).join(", ")}.`,
    c.minRetiro ? `Pasamos a buscar desde ${kgf(c.minRetiro)}; con menos, lo traen al depósito.` : "",
    `Desde ${c.umbralMay} kg de cobre o bronce pagamos precio mayorista.`,
    "El monto final se confirma al pesar o contar en el momento del retiro.",
    "No compramos medidores, placas de cementerio, cables telefónicos ni piezas con numeración.",
    depositos(c),
  ].filter(Boolean).join("\n");
}

function depositos(c: Config) {
  return `📍 Depósito San Lorenzo: ${c.depSL}\n${c.depSLh}\n\n📍 Depósito Pueblo Andino: ${c.depPA}\n${c.depPAh}`;
}
// Las monedas, por unidad: el precio por kilo se dice solo si el cliente las tiene pesadas o mezcladas
function precios(c: Config, soloMonedas = false) {
  const tipos = tiposDe(c);
  const monedas = tipos.length
    ? `• Monedas, cada una:\n` +
      tipos.map((t) => `   – ${esLlave(t.n) ? "Llaves" : "De " + t.n}: ${fmt(t.u)}`).join("\n") + "\n"
    : `• Monedas: ${fmt(c.monedaKg)} el kilo o ${fmt(c.monedaU ?? 0)} por unidad\n`;
  if (soloMonedas && tipos.length) return `Precios de hoy:\n${monedas.trimEnd()}`;
  return `Precios de hoy:\n${monedas}` +
    `• Cobre: ${fmt(c.cobreMin)}/kg (desde ${c.umbralMay} kg: ${fmt(c.cobreMay)}/kg)\n` +
    `• Bronce: ${fmt(c.bronceMin)}/kg (desde ${c.umbralMay} kg: ${fmt(c.bronceMay)}/kg)`;
}

function pregunta(e: Estado, c: Config): Respuesta {
  const d = e.d;
  switch (e.step) {
    case "loc": return { text: "¿De qué localidad nos escribís? Así me fijo si pasamos por ahí." };
    case "cat": return { text: "¿Qué tenés para vender?", options: ["Monedas", "Cobre", "Bronce"] };
    case "unit": return { text: "¿Las tenés contadas o pesadas?", options: ["Por kilo", "Por unidad"] };
    case "tipo":
      if (pendientes(d).length) {
        const ps = pendientes(d);
        const mon = ps.filter((x) => !esLlave(x));
        const que = (mon.length ? "monedas de " + enLista(mon) : "") + (mon.length < ps.length ? (mon.length ? " y llaves" : "llaves") : "");
        return { text: `Anotado: tenés ${que}. Pasame cuántas tenés de cada una, más o menos. Por ejemplo: ${enLista(ps.slice(0, 2).map((x, i) => (i ? "20" : "50") + " de " + x))}. Si las tenés que contar, tranqui, me las pasás cuando puedas.` };
      }
      if (d.items?.length) return { text: "¿Cuáles son las otras y cuántas tenés?", options: tiposDe(c).map((t) => t.n) };
      // Una pregunta abierta: con la lista de una ("50 de $1 y 20 de 50 centavos") se cotiza todo junto
      return {
        text: `Contame qué monedas tenés y cuántas de cada una, más o menos. Por ejemplo: ${ejemploLista(c)}. Las pagamos por unidad, cada tipo a su precio.`,
        options: tiposDe(c).map((t) => t.n),
      };
    case "mas":
      if (pendientes(d).length) return { text: `¿Y cuántas tenés de ${enLista(pendientes(d).map((x) => (esLlave(x) ? "llaves" : "las de " + x)))}?`, options: [NADA_MAS] };
      return { text: "¿Tenés de algún otro tipo? Lo sumo al mismo pedido.", options: [OTRO_TIPO, NADA_MAS] };
    case "qty":
      if (d.mat === "Monedas") {
        if (d.modo !== "u") return { text: "¿Cuántos kilos tenés, aproximadamente?" };
        return { text: `¿Y cuántas ${d.tipo ? nombreTipo(d.tipo) : "monedas"} tenés, más o menos? Con un número aproximado alcanza.` };
      }
      return { text: `¿Cuántos kilos de ${d.mat?.toLowerCase()} tenés en total?` };
    case "mod":
      if (soloDeposito(d, c)) return { text: "¿Te queda cómodo acercarlo a uno de los depósitos, en San Lorenzo o en Pueblo Andino?", options: ["Llevo al depósito", "Hablar con Walter"] };
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

const SALUDO = "(hola|holis|buenas|buen dia|buenos dias|buenas tardes|buenas noches|que tal|como estas|como va)";
/** "Hola", "Hola buen día", "Buenas, qué tal": nada más que un saludo. */
export const esSaludo = (s: string) => new RegExp(`^${SALUDO}( ${SALUDO})*$`).test(norm(s).replace(/[.,]/g, " ").replace(/\s+/g, " ").trim());

// "50 de $1, 20 de 50 centavos y 10 llaves", con los tipos que haya cargados
function ejemploLista(c: Config) {
  const ts = tiposDe(c);
  const ej = [["$1", "50 de $1"], ["50 centavos", "20 de 50 centavos"]].filter(([n]) => ts.some((t) => t.n === n)).map(([, x]) => x);
  if (ts.some((t) => esLlave(t.n))) ej.push("10 llaves");
  return enLista(ej.length ? ej : ["200 de " + (ts[0]?.n ?? "$10")]);
}

/** Tocó un tipo de la lista (o lo escribió solo): "25 centavos plateada", "$10". */
export const tipoSuelto = (c: Config, s: string) => tiposDe(c).find((t) => norm(t.n) === norm(s).replace(/[.,]/g, " ").replace(/\s+/g, " ").trim())?.n ?? null;

/** "Las tengo que contar, después te paso": todavía no tiene las cantidades. */
const DESPUES = /(las?|los) tengo que (contar|pesar)|tengo que contar|(las|los) cuento y|cuando (las |los )?(tenga|cuente|pese)|despues te (las |los )?(paso|aviso|digo|mando)|te (las |los )?paso (despues|mas tarde|luego)|mas tarde te|ahora no (se|las tengo)|no las conte|todavia no las conte/;
export const esParaDespues = (s: string) => DESPUES.test(norm(s));

/** "¿Estás?", "hola??", "?": quiere saber si hay alguien del otro lado. */
export const esPing = (s: string) => /\?/.test(s) &&
  /^(|estas|estan|esta|hola+|holis|hay alguien|alguien|me lees|me leen|me leiste|seguis ahi|sigues ahi|seguis|che|ey|eh|alo|y|y entonces|entonces)$/
    .test(norm(s).replace(/[.,]/g, " ").replace(/\s+/g, " ").trim());

/** "Hola tengo", "son de": el cliente cortó la frase y seguro manda otro mensaje enseguida. */
export const pareceCortado = (s: string) =>
  /\b(tengo|de|y|con|unas?|unos?|son|hay|las|los|el|la|tambien|ademas|mas|como|mira|te cuento)$/.test(norm(s).replace(/[.,]+$/, ""));

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
  if (esProhibido(texto) && estado?.step !== "name" && estado?.step !== "addr") return rechazar(estado, c, true, texto);
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

  // "¿Estás?": sí, y le recordamos en qué estábamos
  if (esPing(t) && e.step !== "name" && e.step !== "addr") return out({ text: "¡Sí, acá estoy!" }, pregunta(e, c));
  // Un saludo suelto a mitad de la charla (volvió, o se perdió) arranca de nuevo
  const saludo = esSaludo(t) && e.step !== "name" && e.step !== "addr";
  if (saludo || /(empezar de nuevo|reiniciar)/.test(n)) return procesar(null, "", c);
  if (n === "otra localidad") { e.step = "loc"; return out(pregunta(e, c)); }
  // "Hola Walter" es un saludo: deriva solo si pide hablar con él
  const pideWalter = /(hablar|humano|persona)/.test(n) || /\b(con|a|pasame|llamame|llame) walter\b/.test(n);
  if (pideWalter && e.step !== "name" && e.step !== "addr") {
    return { ...out({ text: "Listo, le aviso a Walter y te escribe por acá apenas pueda. 🙌" }, pregunta(e, c)), derivar: true };
  }
  if (/(horario|deposito|donde estan)/.test(n) && e.step !== "addr" && e.step !== "mod") return out({ text: depositos(c) }, pregunta(e, c));
  if (/(precio|cuanto pagan|cotizacion|a cuanto)/.test(n)) {
    // Si pregunta por un tipo ("¿cuánto pagan las de 10?"), le contestamos ese y no la lista entera
    const tp = /cobre|bronce/.test(n) ? undefined : tipoPorNombre(c, findTipo(c, t) ?? undefined);
    if (tp) {
      return out({ text: `${esLlave(tp.n) ? "Las llaves" : "Las de " + tp.n} las pagamos ${fmt(tp.u)} cada una.` }, pregunta(e, c));
    }
    if (parseNum(t) === null) return out({ text: precios(c, d.mat === "Monedas" && !/cobre|bronce/.test(n)) }, pregunta(e, c));
  }

  // Va tocando los tipos de la lista uno atrás de otro: los anotamos todos y le pedimos las cantidades juntas
  const suelto = d.mat === "Monedas" ? tipoSuelto(c, t) : null;
  if (suelto && (e.step === "qty" && d.modo === "u" && d.tipo && d.tipo !== suelto || e.step === "tipo" && pendientes(d).length)) {
    d.pend = [...new Set([...pendientes(d), ...(e.step === "qty" && d.tipo ? [d.tipo] : []), suelto])];
    if (e.step === "qty") { delete d.tipo; delete d.modo; delete d.cant; }
    e.step = "tipo";
    return out(pregunta(e, c));
  }
  // "Las tengo que contar": sin volver a preguntar lo mismo
  if (["tipo", "qty", "mas"].includes(e.step) && esParaDespues(t) && parseNum(t) === null) {
    return out({ text: "¡Dale, sin apuro! Cuando las tengas, pasame cuántas tenés de cada una y te hago la cuenta." });
  }

  // Ya cotizado, corrige la cantidad o la localidad ("soy de Totoras, tengo unas 300 llaves"): se rehace la cuenta
  if (e.step === "mod" && d.mat === "Monedas") {
    const tipo = findTipo(c, t);
    const q = tipo && tipo !== MEZCLADAS ? cantidadConTipo(t, tipo) : null;
    if (q) return corregir(e, tipo!, q, findLoc(t), c);
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
      return out({ text: `¡Genial, en ${l} trabajamos! ¿Qué tenés para vender?`, options: ["Monedas", "Cobre", "Bronce"] });
    }
    case "cat": {
      // Solo llaves; con llaves y monedas va a la pregunta abierta de los tipos
      const llave = /llave/.test(n) && !/moneda/.test(n) ? tiposDe(c).find((x) => esLlave(x.n)) : undefined;
      if (llave) {
        d.mat = "Monedas"; d.modo = "u"; d.tipo = llave.n; e.step = "qty";
        return out(pregunta(e, c));
      }
      const mat = /moneda|llave/.test(n) ? "Monedas" : /cobre/.test(n) ? "Cobre" : /bronce/.test(n) ? "Bronce" : null;
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
      // "300 de 10": ya trae la cantidad
      const q = cantidadConTipo(t, tipo);
      return q ? cantidad(e, q, c) : out(pregunta(e, c));
    }
    case "qty": {
      // Contaba monedas de un tipo pero dice kilos ("tengo como 3 kilos"): van por kilo
      if (d.mat === "Monedas" && d.modo === "u" && !esLlave(d.tipo) && /\b(kilo|kilos|kg)\b/.test(n)) { d.modo = "kg"; delete d.tipo; }
      const q = parseNum(t);
      if (!q || q <= 0) {
        // Con las opciones para salir, si no sabe cuánto tiene o quiere preguntar otra cosa
        return out({ text: d.modo === "u"
          ? `Pasame un número aproximado de ${esLlave(d.tipo) ? "llaves" : "monedas"}, por ejemplo 2500.`
          : "Pasame los kilos con un número, por ejemplo 12 o 7,5.", options: ["Hablar con Walter", "Empezar de nuevo"] });
      }
      return cantidad(e, q, c);
    }
    case "mas": {
      // Antes que el "sí": "no tengo de otro tipo" también dice "tengo"
      if (/^(no|nop|nada|ninguna|ningun|eso es todo|eso nomas|solo eso|nomas eso|listo|es todo)\b/.test(n) || n === norm(NADA_MAS)) {
        return cerrarMonedas(e, c);
      }
      const tipo = findTipo(c, t);
      const otro = /^(si|dale|otro|otra|otras|tengo|tambien|ademas|mas|y )/.test(n) || n === norm(OTRO_TIPO);
      if (!tipo && !otro) return out(pregunta(e, c));
      // La que estaba cotizando pasa a la lista y arranca la próxima
      d.items = lineas(d);
      delete d.tipo; delete d.cant; delete d.modo;
      if (!tipo) { e.step = "tipo"; return out(pregunta(e, c)); }
      e.step = "qty";
      if (tipo === MEZCLADAS) { d.modo = "kg"; return out({ text: `Por kilo pagamos ${fmt(c.monedaKg)}.` }, pregunta(e, c)); }
      d.modo = "u"; d.tipo = tipo;
      // "200 de 50": el número que no es el del tipo es la cantidad
      const q = cantidadConTipo(t, tipo);
      return q ? cantidad(e, q, c) : out(pregunta(e, c));
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

// En "200 de 50" o "de 50 tengo 200", la cantidad es el número que no forma parte del nombre del tipo
function cantidadConTipo(t: string, tipo: string): number | null {
  const delTipo = norm(tipo).match(/\d+/)?.[0];
  const nums = (t.match(/\d[\d.,]*/g) ?? []).map((x) => x.replace(/[.,]$/, ""));
  const otro = nums.find((x) => x.replace(/\D/g, "") !== delTipo);
  const q = otro ? parseNum(otro) : null;
  return q && q > 0 ? q : null;
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
// viaja: vive lejos pero va a estar en una localidad de la lista ("soy de Rafaela y el finde voy a Beltrán")
export type Lectura = Pistas & {
  otraLoc?: boolean; viaja?: boolean;
  intencion?: "precios" | "depositos" | "humano" | "otro" | "prohibido" | "no_vende" | "consulta";
};

// El texto con el que el cliente habría contestado la pregunta actual, si las pistas ya la responden
function respuestaDesde(e: Estado, p: Pistas, c: Config): { texto: string; campo: keyof Pistas } | null {
  const d = e.d;
  switch (e.step) {
    case "loc": case "out": return p.loc ? { texto: p.loc, campo: "loc" } : null;
    case "cat":
      // Llaves y monedas: la pregunta abierta por los tipos, sin quedarse solo con las llaves
      if (p.varias) { delete p.tipo; delete p.varias; return { texto: "monedas y llaves", campo: "mat" }; }
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
    case "qty":
      // Kilos de monedas que veníamos contando: pasan a ir por kilo
      if (p.cant && p.modo === "kg" && d.modo === "u" && d.mat === "Monedas" && !esLlave(d.tipo)) return { texto: `${p.cant} kg`, campo: "cant" };
      return p.cant && (!p.modo || p.modo === d.modo) ? { texto: String(p.cant), campo: "cant" } : null;
    // Nombró otro tipo ("también tengo de 50"): se suma al pedido
    case "mas":
      if (p.tipo && p.tipo !== MEZCLADAS && p.tipo !== d.tipo && !(d.items ?? []).some((x) => x.tipo === p.tipo)) return { texto: p.tipo, campo: "tipo" };
      return null;
    case "mod":
      // Con pocos kilos solo queda el depósito: eso ya se lo dijimos con la cotización
      if (p.ret === "Depósito") return { texto: "Llevo al depósito", campo: "ret" };
      if (soloDeposito(d, c)) return null;
      // La dirección que ya escribió vale como "pasen a buscarlo"
      if (p.dir && p.ret !== "Punto de encuentro" && esDireccion(norm(p.dir))) return { texto: p.dir, campo: "dir" };
      return p.ret ? { texto: p.ret, campo: "ret" } : null;
    case "addr": return p.dir ? { texto: p.dir, campo: "dir" } : null;
    default: return null;
  }
}

// Una pregunta que no es de precios, depósitos ni para hablar con Walter (eso lo resuelve procesar)
const esPregunta = (s: string) => /[?¿]/.test(s) &&
  !/(precio|cuanto pagan|cotizacion|a cuanto|horario|deposito|donde estan|hablar|humano|persona)/.test(norm(s));

// La IA saca datos también de la charla reciente: cuentan solo los que el bot todavía no tenía
// "Tengo de todo tipo" mientras ya van por kilo no es un dato nuevo
const traeDatos = (l: Lectura, e: Estado | null) =>
  !!l.cant || !!l.dir || !!l.items?.length || (["loc", "mat", "tipo"] as const).some((k) => l[k] && l[k] !== e?.d[k] &&
    !(k === "tipo" && l.tipo === MEZCLADAS && e?.d.modo === "kg"));

const PALABRA_INTENCION: Partial<Record<NonNullable<Lectura["intencion"]>, string>> =
  { precios: "precios", depositos: "deposito", humano: "hablar con Walter" };

/**
 * Como procesar, con lo que la IA entendió del mensaje: contesta de una las preguntas que el
 * cliente ya respondió ("tengo 3 kilos de cobre en Funes") y guarda el resto para más adelante.
 * Los precios, las cuentas y los textos siguen saliendo de procesar.
 * Con l null (tocó un botón, o la IA no respondió) solo se usan las pistas que ya estaban guardadas.
 */
export function procesarConLectura(estado: Estado | null, texto: string, c: Config, l: Lectura | null): Resultado {
  // Lo que no compramos corta ahí, sin cotizar con lo que haya entendido la IA
  if (l?.intencion === "prohibido" || (esProhibido(texto) && estado?.step !== "name" && estado?.step !== "addr")) {
    return rechazar(estado, c, true, texto);
  }
  // "¿Estás?": lo contesta procesar, sin que la IA lo lea como una consulta
  if (estado && esPing(texto) && !["name", "addr"].includes(estado.step)) {
    const r = procesar(estado, texto, c);
    return estado.p ? { ...r, estado: { ...r.estado, p: estado.p } } : r;
  }
  // No quiere vender ("gracias, no quiero nada"): se despide sin volver a preguntar
  // En "¿tenés de otro tipo?", un "no, gracias" cierra las monedas y sigue con el pedido
  if (l?.intencion === "no_vende" && !traeDatos(l, estado) && estado?.step !== "mas") {
    return {
      estado: { step: "done", d: estado?.d.loc ? { loc: estado.d.loc } : {} },
      respuestas: [{ text: "¡Dale, gracias por escribir! Cuando quieras vender algo, escribinos por acá." }],
    };
  }
  // La IA no la marcó pero es una pregunta ("¿me conviene por kilo?") sin datos nuevos: también se contesta
  if (l && !l.intencion && esPregunta(texto) && !traeDatos(l, estado) && estado &&
    !["name", "addr"].includes(estado.step)) l = { ...l, intencion: "consulta" };
  // Pregunta algo ("¿me conviene por kilo o por unidad?"): se contesta y se repite la pregunta en la que estábamos,
  // sin avanzar con lo que procesar entendería de las palabras sueltas
  if (l?.intencion === "consulta" && !traeDatos(l, estado) && estado && !["name", "addr"].includes(estado.step)) {
    const e: Estado = { step: estado.step, d: { ...estado.d }, ...(estado.p ? { p: estado.p } : {}) };
    // "¿Las cuento o las peso?" mientras le pedíamos kilos: la respuesta es contarlas, así que la pregunta que sigue es cuántas de cada una
    if (e.step === "qty" && e.d.mat === "Monedas" && e.d.modo === "kg" && tiposDe(c).length && /(cont|cuent|pes|conviene|unidad)/.test(norm(texto))) {
      e.step = "tipo"; delete e.d.modo;
    }
    return { estado: e, respuestas: [pregunta(e, c)], consulta: true };
  }
  // "¿Y cuánto valdrían las que tengo?": la cuenta de lo suyo, no la lista de precios
  if (estado && tieneCotizado(estado.d) && preguntaPorLoSuyo(texto) && !(l && traeDatos(l, estado)) && !["name", "addr"].includes(estado.step)) {
    const e: Estado = { step: estado.step, d: { ...estado.d }, ...(estado.p ? { p: estado.p } : {}) };
    return { estado: e, respuestas: [{ text: resumen(e.d, c) }, pregunta(e, c)] };
  }
  // Si arranca con una pregunta, primero el saludo
  if (l?.intencion === "consulta" && !estado) return { ...procesar(null, "", c), consulta: true };
  // Ofrece otra cosa (aluminio, hierro): solo antes de que esté cotizando algo, para no perder lo anotado
  if (l?.intencion === "otro" && !l.mat && !l.tipo && ["loc", "out", "cat", "done"].includes(estado?.step ?? "loc")) {
    return rechazar(estado, c, false, texto);
  }
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
  const p: Pistas = { ...(reinicio ? {} : estado?.p), ...(l ? pistasDe(l, c, texto) : {}) };

  // Si no nombró ningún lugar, en vez de "por ahora no retiramos ahí" le volvemos a preguntar
  if (l && estado?.step === "loc" && r.estado.step === "out" && !l.otraLoc && !p.loc && !l.intencion) {
    r = { estado: { step: "loc", d: r.estado.d }, respuestas: [{ text: "¿De qué localidad nos escribís? Así te digo si pasamos por ahí." }] };
  }

  const respuestas: Respuesta[] = [];
  let prefijo = "";
  for (let i = 0; i < 8 && !r.derivar && !r.pedido; i++) {
    // Mandó la lista de monedas: se cotiza toda junta y sigue con cómo lo entrega
    if (p.items?.length && ["cat", "unit", "tipo", "qty"].includes(r.estado.step) && (r.estado.step === "cat" || r.estado.d.mat === "Monedas")) {
      const items = p.items;
      delete p.items; delete p.mat; delete p.modo; delete p.tipo; delete p.cant;
      if (r.estado.step === "cat" && !prefijo && r.estado.d.loc && r.estado.d.loc !== estado?.d.loc) prefijo = `¡Genial, en ${r.estado.d.loc} trabajamos! `;
      respuestas.push(...r.respuestas.slice(0, -1));
      r = conLista(r.estado, items, c);
      continue;
    }
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
  // Vive lejos pero viene a una localidad donde trabajamos: sin decir que su ciudad queda cerca
  if (l?.viaja && r.estado.d.loc) {
    if (prefijo) prefijo = `Donde vivís no llegamos, pero en ${r.estado.d.loc} sí trabajamos. `;
    for (const [i, x] of respuestas.entries()) {
      respuestas[i] = { ...x, text: x.text.replace(`¡Genial, en ${r.estado.d.loc} trabajamos!`, `Donde vivís no llegamos, pero en ${r.estado.d.loc} sí trabajamos.`) };
    }
  }
  if (prefijo && respuestas.length && !respuestas.some((x) => x.text.startsWith("¡Genial, en ") || x.text.startsWith("Donde vivís"))) {
    respuestas[0] = { ...respuestas[0], text: prefijo + respuestas[0].text };
  }

  // Lo que ya quedó anotado no hace falta guardarlo como pista
  if (!["loc", "out", "cat"].includes(r.estado.step)) delete p.varias;
  for (const k of Object.keys(p) as (keyof Pistas)[]) if (k !== "varias" && r.estado.d[k] !== undefined) delete p[k];
  const estadoFinal: Estado = { step: r.estado.step, d: r.estado.d };
  if (Object.keys(p).length) estadoFinal.p = p;
  // Preguntó algo y además pasó datos: se avanza con los datos y también se le contesta la pregunta
  const consulta = l?.intencion === "consulta" && !r.derivar && !r.pedido && !["name", "addr"].includes(estado?.step ?? "") ? { consulta: true } : {};
  return { ...r, ...consulta, estado: estadoFinal, respuestas };
}

function pistasDe(l: Lectura, c: Config, texto = ""): Pistas {
  const p: Pistas = {};
  const n = norm(texto);
  if (/llave/.test(n) && /moneda/.test(n) && !l.cant && !l.items?.length) p.varias = true;
  if (l.loc && LOCALIDADES.some((x) => x.n === l.loc)) p.loc = l.loc;
  if (l.mat === "Monedas" || l.mat === "Cobre" || l.mat === "Bronce") p.mat = l.mat;
  if (l.modo === "kg" || l.modo === "u") p.modo = l.modo;
  if (l.tipo && (l.tipo === MEZCLADAS || tipoPorNombre(c, l.tipo))) p.tipo = l.tipo;
  if (typeof l.cant === "number" && l.cant > 0) p.cant = l.cant;
  if (l.ret === "Retiro a domicilio" || l.ret === "Punto de encuentro" || l.ret === "Depósito") p.ret = l.ret;
  if (typeof l.dir === "string" && l.dir.trim()) p.dir = l.dir.trim().slice(0, 120);
  const items = (l.items ?? []).flatMap((x): Linea[] => {
    if (!(typeof x?.cant === "number" && x.cant > 0)) return [];
    if (x.tipo === MEZCLADAS || x.modo === "kg") return [{ modo: "kg", cant: x.cant }];
    return tipoPorNombre(c, x.tipo) ? [{ modo: "u", tipo: x.tipo, cant: x.cant }] : [];
  });
  // Una sola clase ya la cubren tipo y cant; la lista sirve desde dos
  if (items.length > 1) p.items = items;
  return p;
}

const tieneCotizado = (d: Datos) => !!d.mat && d.cant != null && !!d.modo;
// Pregunta cuánto le pagan por lo que ya contó (no por un tipo ni la lista de precios)
const preguntaPorLoSuyo = (s: string) => {
  const n = norm(s);
  return /\b(cuanto|cuanta|total)\b/.test(n) && /\b(vale|valen|valdria|valdrian|seria|serian|sale|salen|saldria|me dan|me das|me pagan|me pagarian|es todo|da|dan)\b/.test(n) &&
    /\b(tengo|mias|mios|mis|eso|esas|esos|estas|estos|todo|entonces|en total|total|lo que)\b/.test(n) && !/\bcada\b/.test(n);
};

// Lo que lleva cotizado: cada clase con su total y la suma
function detalleTxt(d: Datos, c: Config) {
  return lineas(d).map((l) => {
    const r = cotizar(c, "Monedas", l.modo, l.cant, l.tipo);
    return `• ${lineaTxt({ mat: "Monedas", ...l })}: ${fmt(r.total)} (` + (l.modo === "u" ? `${fmt(r.precio)} cada una` : `${fmt(r.precio)} el kilo`) + ")";
  }).join("\n");
}
function resumen(d: Datos, c: Config) {
  if (d.mat !== "Monedas") return `Por ${lineaTxt(d)} te pagamos ${fmt(totalDe(d, c))}.`;
  if (!varias(d)) {
    const r = cotizar(c, "Monedas", d.modo!, d.cant!, d.tipo);
    return `Por ${lineaTxt(d)} te pagamos ${fmt(r.total)} (` + (d.modo === "u" ? `${fmt(r.precio)} cada una` : `${fmt(r.precio)} el kilo`) + ").";
  }
  return `Por lo que me pasaste te pagamos:\n${detalleTxt(d, c)}\nTotal: ${fmt(totalDe(d, c))}.`;
}

/** Cotiza la lista de monedas que mandó junta: cada clase con su total, la suma, y la pregunta de cómo lo entrega. */
function conLista(e: Estado, items: Linea[], c: Config): Resultado {
  const d: Datos = { ...e.d, mat: "Monedas" };
  const ult = items[items.length - 1];
  d.items = [...(d.items ?? []), ...items.slice(0, -1)];
  d.modo = ult.modo; d.cant = ult.cant;
  if (ult.tipo) d.tipo = ult.tipo; else delete d.tipo;
  const detalle = detalleTxt(d, c);
  const r = cerrarMonedas({ step: "mas", d }, c);
  // La suma va con el detalle; de cerrarMonedas queda lo que se confirma al retirar y la pregunta
  const fin = r.respuestas[0].text.replace(/^En total:[^\n]*\n/, "");
  return { ...r, respuestas: [
    { text: `Por lo que me pasaste te pagamos:\n${detalle}\nTotal: ${fmt(totalDe(d, c))}.\n${fin}` }, ...r.respuestas.slice(1),
  ] };
}

function cantidad(e: Estado, q: number, c: Config): Resultado {
  const d = e.d; d.cant = q;
  const r = cotizar(c, d.mat!, d.modo!, q, d.tipo);
  // Las monedas van por tipo: después de cada una pregunta si tiene de otro tipo, y al final suma todo
  if (d.mat === "Monedas") {
    e.step = "mas";
    return { estado: e, respuestas: [{ text: `Por ${lineaTxt(d)} te pagamos ${fmt(r.total)} (` +
      (d.modo === "u" ? `${fmt(r.precio)} cada una` : `hoy ${fmt(r.precio)} el kilo`) + ")." }, pregunta(e, c)] };
  }
  const text = `Por ${kgf(q)} de ${d.mat!.toLowerCase()} te pagamos ${fmt(r.total)} (${fmt(r.precio)} el kilo, precio ${r.tarifa}).` +
    (r.tarifa === "mayorista" ? "" : `\nDesde ${c.umbralMay} kg pagamos precio mayorista.`);
  e.step = "mod";
  const fin = soloDeposito(d, c) ? minTxt(d, c) : "El monto final se confirma al pesar en el momento del retiro.";
  return { estado: e, respuestas: [{ text: text + "\n" + fin }, pregunta(e, c)] };
}

// Cambia la cantidad de un tipo que ya estaba (o lo suma) y, si nombró otra localidad, también esa
function corregir(e: Estado, tipo: string, q: number, loc: string | null, c: Config): Resultado {
  const d = e.d;
  d.items = lineas(d).filter((l) => l.tipo !== tipo);
  d.modo = "u"; d.tipo = tipo; d.cant = q;
  if (!d.items.length) delete d.items;
  if (loc) d.loc = loc;
  delete d.ret; delete d.dir;
  e.step = "mod";
  const fin = soloDeposito(d, c) ? minTxt(d, c) : "El monto final se confirma al contarlas o pesarlas en el momento del retiro.";
  return { estado: e, respuestas: [{ text: `Listo, lo corrijo. ${resumen(d, c)}\n${fin}` }, pregunta(e, c)] };
}

// No tiene más monedas: con varios tipos, el total de todo, y sigue con cómo lo entrega
function cerrarMonedas(e: Estado, c: Config): Resultado {
  const d = e.d;
  e.step = "mod";
  const total = varias(d) ? `En total: ${queTxt(d)}, ${fmt(totalDe(d, c))}.\n` : "";
  const fin = soloDeposito(d, c) ? minTxt(d, c) : "El monto final se confirma al contarlas o pesarlas en el momento del retiro.";
  return { estado: e, respuestas: [{ text: total + fin }, pregunta(e, c)] };
}

function armarPedido(d: Datos, c: Config, dir: string | null): Pedido {
  // Las contadas también cuentan para la prioridad, pasadas a kilos; las llaves no son monedas.
  const monedas = lineas(d).filter((l) => !esLlave(l.tipo));
  const kilos = monedas.reduce((a, l) => a + (kilosLinea(l, c) ?? 0), 0);
  const base = { loc: d.loc!, mat: d.mat!, ret: d.ret!, nombre: d.nombre!, dir, prioridad: d.mat === "Monedas" && monedas.length > 0 && kilos >= c.umbralPrio };
  if (!varias(d)) {
    const r = cotizar(c, d.mat!, d.modo!, d.cant!, d.tipo);
    return { ...base, modo: d.modo!, tipo: d.tipo ?? null, cant: d.cant!, monto: Math.round(r.total), tarifa: r.tarifa, items: null };
  }
  // Varios tipos: cada línea con su precio. modo y cantidad resumen el pedido para lo que lee una sola línea:
  // todas contadas = unidades en total; si hay alguna por kilo, los kilos estimados de todo.
  const items = lineas(d).map((l) => {
    const r = cotizar(c, "Monedas", l.modo, l.cant, l.tipo);
    return { ...l, precio: r.precio, total: Math.round(r.total) };
  });
  const contadas = items.every((l) => l.modo === "u");
  const cant = contadas ? items.reduce((a, l) => a + l.cant, 0) : Math.round((kilosDe(d, c) ?? 0) * 10) / 10;
  return {
    ...base, modo: contadas ? "u" : "kg", tipo: null, cant, items,
    monto: items.reduce((a, l) => a + l.total, 0), tarifa: contadas ? "por unidad" : "varias",
  };
}
