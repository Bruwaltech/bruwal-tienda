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
export type Estado = { step: string; d: Datos };
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
export const tiposDe = (c: Config) => (c.monedas ?? []).filter((t) => t && t.n && t.u > 0);
const esLlave = (n?: string) => /llave/i.test(n ?? "");
const tipoPorNombre = (c: Config, n?: string) => tiposDe(c).find((t) => t.n === n);
// "monedas de $10", "llaves"
const nombreTipo = (n: string) => (esLlave(n) ? "llaves" : "monedas de " + n);

/** El tipo que nombra el cliente: un tipo de la configuración, MEZCLADAS, o null si no se entiende. */
export function findTipo(c: Config, s: string): string | null {
  const n = norm(s);
  if (/mezcl|varias|surtid|de todo/.test(n)) return MEZCLADAS;
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
      text: "¿De qué monedas son? Si tenés de varias, elegí Mezcladas y las cotizamos por kilo.",
      options: [...tiposDe(c).map((t) => t.n), MEZCLADAS],
    };
    case "qty":
      if (d.mat === "Monedas") {
        if (d.modo !== "u") return { text: "¿Cuántos kilos tenés, aproximadamente?" };
        return { text: `¿Cuántas ${d.tipo ? nombreTipo(d.tipo) : "monedas"} son, más o menos?` };
      }
      return { text: `¿Cuántos kilos de ${d.mat?.toLowerCase()} tenés en total?` };
    case "mod":
      if (soloDeposito(d, c)) return { text: "¿Lo traés al depósito?", options: ["Llevo al depósito", "Hablar con Walter"] };
      return { text: "¿Cómo preferís hacerlo?", options: ["Retiro a domicilio", "Punto de encuentro", "Llevo al depósito"] };
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

  if (/(empezar de nuevo|reiniciar)/.test(n)) return procesar(null, "", c);
  if (n === "otra localidad") { e.step = "loc"; return out(pregunta(e, c)); }
  if (/(hablar|humano|persona|walter)/.test(n) && e.step !== "name" && e.step !== "addr") {
    return { ...out({ text: "Listo, le aviso a Walter y te escribe por acá apenas pueda. 🙌" }, pregunta(e, c)), derivar: true };
  }
  if (/(horario|deposito|donde estan)/.test(n) && e.step !== "addr" && e.step !== "mod") return out({ text: depositos(c) }, pregunta(e, c));
  if (/(precio|cuanto pagan|cotizacion|a cuanto)/.test(n) && parseNum(t) === null) return out({ text: precios(c) }, pregunta(e, c));

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
      if (mat === "Monedas") { e.step = "unit"; return out(pregunta(e, c)); }
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
        d.modo = "kg";
        return out({ text: `Si están mezcladas, las pesamos: pagamos ${fmt(c.monedaKg)} el kilo.` }, pregunta(e, c));
      }
      d.tipo = tipo;
      return out(pregunta(e, c));
    }
    case "qty": {
      const q = parseNum(t);
      if (!q || q <= 0) {
        return out({ text: d.modo === "u"
          ? `Pasame un número aproximado de ${esLlave(d.tipo) ? "llaves" : "monedas"}, por ejemplo 2500.`
          : "Pasame los kilos con un número, por ejemplo 12 o 7,5." });
      }
      return cantidad(e, q, c);
    }
    case "mod": {
      if (/domicilio|casa|busquen|retir/.test(n)) d.ret = "Retiro a domicilio";
      else if (/encuentro|punto|nos vemos/.test(n)) d.ret = "Punto de encuentro";
      else if (/deposito|llevo|voy/.test(n)) d.ret = "Depósito";
      else return out(pregunta(e, c));
      if (d.ret !== "Depósito" && soloDeposito(d, c)) { delete d.ret; return out({ text: minTxt(d, c) }, pregunta(e, c)); }
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
      e.step = "addr"; return out(pregunta(e, c));
    }
    case "addr": {
      d.dir = t.slice(0, 120);
      e.step = "done";
      const p = armarPedido(d, c, d.dir);
      return {
        ...out({
          text: `¡Listo, ${d.nombre}! Quedó anotado:\n• ${queTxt(d)}\n• ${d.ret} en ${d.loc}\n• Estimado: ${fmt(p.monto)}\n\n` +
            `Walter arma los recorridos y te avisamos por acá el día y si pasamos a la mañana o a la tarde.` +
            (p.prioridad ? "\n\nComo es una buena cantidad, te ponemos entre los primeros del recorrido." : ""),
          options: ["Empezar de nuevo"],
        }),
        pedido: p,
      };
    }
    default: return out(pregunta(e, c));
  }
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
