// Lógica de la charla del bot de Walter. Sin dependencias: recibe el estado guardado,
// el texto del cliente y la configuración, y devuelve el estado nuevo y las respuestas.

export type Config = {
  monedaKg: number; monedaU: number;
  cobreMin: number; cobreMay: number; bronceMin: number; bronceMay: number;
  umbralMay: number; umbralPrio: number;
  depPA: string; depPAh: string; depSL: string; depSLh: string;
  horaNoche?: string; horaManana?: string;
  saludo: string;
};

export type Datos = {
  loc?: string; mat?: "Monedas" | "Cobre" | "Bronce"; modo?: "kg" | "u"; cant?: number;
  ret?: "Retiro a domicilio" | "Punto de encuentro" | "Depósito"; nombre?: string; dir?: string;
};
export type Estado = { step: string; d: Datos };
export type Respuesta = { text: string; options?: string[] };
export type Pedido = Required<Pick<Datos, "loc" | "mat" | "modo" | "cant" | "ret" | "nombre">> & {
  dir: string | null; monto: number; tarifa: string; prioridad: boolean;
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
  (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
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

export function cotizar(c: Config, mat: string, modo: string, cant: number) {
  if (mat === "Monedas") {
    const precio = modo === "u" ? c.monedaU : c.monedaKg;
    return { precio, total: cant * precio, tarifa: modo === "u" ? "por unidad" : "por kilo" };
  }
  const may = cant >= c.umbralMay;
  const precio = mat === "Cobre" ? (may ? c.cobreMay : c.cobreMin) : (may ? c.bronceMay : c.bronceMin);
  return { precio, total: cant * precio, tarifa: may ? "mayorista" : "minorista" };
}

const cantTxt = (modo?: string, cant?: number) =>
  modo === "u" ? (cant ?? 0).toLocaleString("es-AR") + " unidades" : kgf(cant ?? 0);

function depositos(c: Config) {
  return `📍 Depósito San Lorenzo: ${c.depSL}\n${c.depSLh}\n\n📍 Depósito Pueblo Andino: ${c.depPA}\n${c.depPAh}`;
}
function precios(c: Config) {
  return `Precios de hoy:\n• Monedas: ${fmt(c.monedaKg)} el kilo o ${fmt(c.monedaU)} por unidad\n` +
    `• Cobre: ${fmt(c.cobreMin)}/kg (desde ${c.umbralMay} kg: ${fmt(c.cobreMay)}/kg)\n` +
    `• Bronce: ${fmt(c.bronceMin)}/kg (desde ${c.umbralMay} kg: ${fmt(c.bronceMay)}/kg)`;
}

function pregunta(e: Estado): Respuesta {
  const d = e.d;
  switch (e.step) {
    case "loc": return { text: "¿De qué localidad nos escribís?" };
    case "cat": return { text: "¿Qué querés vender?", options: ["Monedas", "Cobre", "Bronce"] };
    case "unit": return { text: "¿Las tenés contadas o pesadas?", options: ["Por kilo", "Por unidad"] };
    case "qty":
      if (d.mat === "Monedas") return { text: d.modo === "u" ? "¿Cuántas monedas son, más o menos?" : "¿Cuántos kilos tenés, aproximadamente?" };
      return { text: `¿Cuántos kilos de ${d.mat?.toLowerCase()} tenés en total?` };
    case "mod": return { text: "¿Cómo preferís hacerlo?", options: ["Retiro a domicilio", "Punto de encuentro", "Llevo al depósito"] };
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
    return { estado: e, respuestas: [{ text: c.saludo }] };
  }
  const e: Estado = { step: estado.step, d: { ...estado.d } };
  const d = e.d;
  const t = texto.trim();
  const n = norm(t);
  const out = (...r: Respuesta[]): Resultado => ({ estado: e, respuestas: r });

  if (/(empezar de nuevo|reiniciar)/.test(n)) return procesar(null, "", c);
  if (n === "otra localidad") { e.step = "loc"; return out(pregunta(e)); }
  if (/(hablar|humano|persona|walter)/.test(n) && e.step !== "name" && e.step !== "addr") {
    return { ...out({ text: "Listo, le aviso a Walter y te escribe por acá apenas pueda. 🙌" }, pregunta(e)), derivar: true };
  }
  if (/(horario|deposito|donde estan)/.test(n) && e.step !== "addr" && e.step !== "mod") return out({ text: depositos(c) }, pregunta(e));
  if (/(precio|cuanto pagan|cotizacion|a cuanto)/.test(n) && parseNum(t) === null) return out({ text: precios(c) }, pregunta(e));

  switch (e.step) {
    case "out":
      if (!findLoc(t)) return out(pregunta(e));
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
      const mat = /moneda/.test(n) ? "Monedas" : /cobre/.test(n) ? "Cobre" : /bronce/.test(n) ? "Bronce" : null;
      if (!mat) return out({ text: "Compramos monedas, cobre y bronce. ¿Cuál de esos tenés?", options: ["Monedas", "Cobre", "Bronce"] });
      d.mat = mat;
      if (mat === "Monedas") { e.step = "unit"; return out(pregunta(e)); }
      d.modo = "kg"; e.step = "qty"; return out(pregunta(e));
    }
    case "unit": {
      if (/unidad|contad|cantidad/.test(n)) d.modo = "u";
      else if (/kilo|kg|pesad/.test(n)) d.modo = "kg";
      else return out(pregunta(e));
      e.step = "qty";
      const q = parseNum(t);
      return q ? cantidad(e, q, c) : out(pregunta(e));
    }
    case "qty": {
      const q = parseNum(t);
      if (!q || q <= 0) return out({ text: d.modo === "u" ? "Pasame un número aproximado de monedas, por ejemplo 2500." : "Pasame los kilos con un número, por ejemplo 12 o 7,5." });
      return cantidad(e, q, c);
    }
    case "mod": {
      if (/domicilio|casa|busquen|retir/.test(n)) d.ret = "Retiro a domicilio";
      else if (/encuentro|punto|nos vemos/.test(n)) d.ret = "Punto de encuentro";
      else if (/deposito|llevo|voy/.test(n)) d.ret = "Depósito";
      else return out(pregunta(e));
      e.step = "name"; return out(pregunta(e));
    }
    case "name": {
      d.nombre = t.slice(0, 40);
      if (d.ret === "Depósito") {
        e.step = "done";
        return {
          ...out({ text: `Perfecto, ${d.nombre}. Te esperamos en el depósito:\n\n${depositos(c)}\n\nTraelas y las pesamos ahí mismo.`, options: ["Empezar de nuevo"] }),
          pedido: armarPedido(d, c, null),
        };
      }
      e.step = "addr"; return out(pregunta(e));
    }
    case "addr": {
      d.dir = t.slice(0, 120);
      e.step = "done";
      const p = armarPedido(d, c, d.dir);
      return {
        ...out({
          text: `¡Listo, ${d.nombre}! Quedó anotado:\n• ${cantTxt(d.modo, d.cant)} de ${d.mat?.toLowerCase()}\n• ${d.ret} en ${d.loc}\n• Estimado: ${fmt(p.monto)}\n\n` +
            `Walter arma los recorridos y te avisamos por acá el día y si pasamos a la mañana o a la tarde.` +
            (p.prioridad ? "\n\nComo es una buena cantidad, te ponemos entre los primeros del recorrido." : ""),
          options: ["Empezar de nuevo"],
        }),
        pedido: p,
      };
    }
    default: return out(pregunta(e));
  }
}

function cantidad(e: Estado, q: number, c: Config): Resultado {
  const d = e.d; d.cant = q;
  const r = cotizar(c, d.mat!, d.modo!, q);
  let text: string;
  if (d.mat === "Monedas") text = `Por ${cantTxt(d.modo, q)} de monedas te pagamos ${fmt(r.total)} (hoy ${fmt(r.precio)} ${r.tarifa}).`;
  else text = `Por ${kgf(q)} de ${d.mat!.toLowerCase()} te pagamos ${fmt(r.total)} (${fmt(r.precio)} el kilo, precio ${r.tarifa}).` +
    (r.tarifa === "mayorista" ? "" : `\nDesde ${c.umbralMay} kg pagamos precio mayorista.`);
  e.step = "mod";
  return { estado: e, respuestas: [{ text: text + "\nEl monto final se confirma al pesar en el momento del retiro." }, pregunta(e)] };
}

function armarPedido(d: Datos, c: Config, dir: string | null): Pedido {
  const r = cotizar(c, d.mat!, d.modo!, d.cant!);
  return {
    loc: d.loc!, mat: d.mat!, modo: d.modo!, cant: d.cant!, ret: d.ret!, nombre: d.nombre!, dir,
    monto: Math.round(r.total), tarifa: r.tarifa,
    prioridad: d.mat === "Monedas" && d.modo === "kg" && d.cant! >= c.umbralPrio,
  };
}
