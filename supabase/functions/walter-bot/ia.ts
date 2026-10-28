// Lectura con Claude Haiku de lo que el cliente escribe libremente ("tengo 3 kilos de cobre en Funes").
// La IA interpreta (devuelve datos sueltos) y le da tono a lo que contesta el bot, pero las respuestas,
// los precios y las cuentas los sigue armando el bot. Si no hay clave o la llamada falla, anda igual sin ella.
import Anthropic from "npm:@anthropic-ai/sdk@0.132.1";
import { type Config, type Estado, LOCALIDADES, type Lectura, MEZCLADAS, tiposDe } from "./bot.ts";

const MODELO = "claude-haiku-5-5";

const PREGUNTAS: Record<string, string> = {
  loc: "de qué localidad escribe", out: "si quiere probar con otra localidad", cat: "qué quiere vender",
  unit: "si las monedas están contadas o pesadas", tipo: "qué monedas tiene y cuántas de cada una, o si van por kilo", qty: "cuánto tiene",
  mas: "si tiene monedas de otro tipo para sumar al mismo pedido",
  mod: "si se lo pasamos a buscar (y en ese caso la dirección), nos encontramos en un punto o lo lleva al depósito",
};

const nulo = (s: Record<string, unknown>) => ({ anyOf: [s, { type: "null" }] });

function esquema(c: Config) {
  const tipos = [...tiposDe(c).map((t) => t.n), MEZCLADAS];
  return {
    type: "object",
    properties: {
      localidad: nulo({ type: "string", enum: [...LOCALIDADES.map((l) => l.n), "Otra"] }),
      viaja: nulo({ type: "boolean" }),
      material: nulo({ type: "string", enum: ["Monedas", "Cobre", "Bronce"] }),
      modo: nulo({ type: "string", enum: ["kg", "u"] }),
      tipo: nulo({ type: "string", enum: tipos }),
      cantidad: nulo({ type: "number" }),
      monedas: nulo({ type: "array", items: {
        type: "object", properties: { tipo: { type: "string", enum: tipos }, cantidad: { type: "number" } },
        required: ["tipo", "cantidad"], additionalProperties: false,
      } }),
      entrega: nulo({ type: "string", enum: ["Retiro a domicilio", "Punto de encuentro", "Depósito"] }),
      direccion: nulo({ type: "string" }),
      intencion: nulo({ type: "string", enum: ["precios", "depositos", "humano", "otro", "prohibido", "no_vende", "consulta"] }),
    },
    required: ["localidad", "viaja", "material", "modo", "tipo", "cantidad", "monedas", "entrega", "direccion", "intencion"],
    additionalProperties: false,
  };
}

function sistema(c: Config) {
  const tipos = tiposDe(c).map((t) => t.n).join(", ") || "(sin tipos cargados)";
  return `Leés mensajes de WhatsApp que clientes le mandan a Punto Metales, un negocio de la zona de Rosario (Argentina) que compra monedas, llaves, cobre y bronce. Tu tarea es solo extraer datos del mensaje; otro sistema contesta.

Campos (null si el mensaje no lo dice claramente; no adivines):
- localidad: una de la lista si el cliente nombra una (aceptá apodos, abreviaturas y errores de tipeo: "Gdor Baigorria" es Baigorria, "Pto San Martín" es Puerto General San Martín). Los barrios y zonas de Rosario (zona norte, zona sur, zona oeste, centro, macrocentro, Fisherton, Alberdi, Echesortu, Arroyito, La Florida) cuentan como Rosario. "Otra" si nombra un lugar que no está en la lista. Si vive en un lugar que no está en la lista pero va a estar en uno que sí (viaja, va de visita, pasa por ahí), la localidad es la de la lista.
- viaja: true en ese caso (vive lejos y va a estar en una localidad de la lista); si no, null.
- material: Monedas, Cobre o Bronce. Las llaves cuentan como Monedas, con tipo de llave.
- modo: "kg" si habla de peso (kilos, bolsa de X kg), "u" si habla de cantidad de unidades contadas.
- tipo: el tipo de moneda si lo dice. Tipos: ${tipos}. "${MEZCLADAS}" si son de varias clases.
- cantidad: el número de kilos o de unidades, según el modo ("unos tres kilos" = 3, "dos mil monedas" = 2000, "medio kilo" = 0.5).
- monedas: si nombra dos o más clases de monedas con su cantidad, una entrada por clase ("145 de 1, 58 de 50" = $1: 145 y 50 centavos: 58; "$2 ---> 230 u" = $2: 230). Las de "25" sin color, si hay doradas y plateadas, no las adivines: dejalas afuera. Las que van por kilo, tipo ${MEZCLADAS} y la cantidad en kilos. Con una sola clase o ninguna, null. También las que dijo en mensajes anteriores de la charla reciente que el bot todavía no anotó.
- entrega: si quiere que se lo pasen a buscar ("Retiro a domicilio"), encontrarse en algún lugar ("Punto de encuentro") o llevarlo él ("Depósito").
- direccion: la calle y el número donde pasar a buscarlo, tal como los escribió, si los escribió.
- intencion: "precios" si pregunta cuánto pagan sin dar cantidad, "depositos" si pregunta dónde están o el horario, "humano" si pide hablar con una persona. "prohibido" si ofrece medidores (de agua, gas o luz), placas o cosas de cementerio, cables telefónicos, piezas con numeración o de la vía pública, o algo que parezca robado. "otro" si ofrece algo que claramente no es monedas, llaves, cobre ni bronce (aluminio, hierro, plomo, electrodomésticos); los cables o caños de cobre no son "otro". "no_vende" si dice que no quiere vender, que solo consultaba o se despide (gracias, chau, por ahora no). "consulta" si hace una pregunta que no es solo de precios ni de depósitos y que hay que contestarle antes de seguir (qué le conviene, cómo funciona el retiro, si tiene que mandar algo, si pagan en efectivo). Si no, null.

Te paso también la charla reciente. Si en mensajes anteriores del cliente hay datos que el bot todavía no anotó (por ejemplo dijo "tengo monedas" y nadie le contestó), extraelos también.`;
}

let cliente: Anthropic | null = null;
// Con la charla reciente en el pedido, Haiku a veces pasa los 6 segundos: con 12 casi siempre llega
const nuevoCliente = (apiKey: string) => new Anthropic({ apiKey, timeout: 12000, maxRetries: 0 });

// Para contar lo que se usa de la IA (pestaña Uso del panel): index.ts lo guarda en walter_uso
let alUsar: ((entrada: number, salida: number) => void) | null = null;
export function contarUso(f: (entrada: number, salida: number) => void) { alUsar = f; }
const anotar = (res: { usage?: { input_tokens?: number; output_tokens?: number } }) => {
  try { alUsar?.(res.usage?.input_tokens ?? 0, res.usage?.output_tokens ?? 0); } catch { /* no frena la respuesta */ }
};

/** Lo que Haiku entendió del mensaje, o null si no se pudo leer (sin clave, error, demora). */
export async function leer(apiKey: string, texto: string, estado: Estado | null, c: Config, charla = ""): Promise<Lectura | null> {
  if (!apiKey) return null;
  // El bot espera la lectura antes de contestar: si tarda, sigue sin ella
  cliente ??= nuevoCliente(apiKey);
  const contexto = estado
    ? `Ya sabemos: ${JSON.stringify(estado.d)}. El bot le acaba de preguntar ${PREGUNTAS[estado.step] ?? "si quiere algo más"}.`
    : "Es el primer mensaje de la charla.";
  try {
    const res = await cliente.messages.create({
      model: MODELO,
      // Con listas largas o varios mensajes juntos, 1024 no alcanzaba (stop_reason max_tokens)
      max_tokens: 4096,
      system: sistema(c),
      output_config: { effort: "low", format: { type: "json_schema", schema: esquema(c) } },
      messages: [{ role: "user", content: `${contexto}${charla ? `\n\nCharla reciente:\n${charla}` : ""}\n\nMensaje del cliente:\n${texto}` }],
    });
    anotar(res);
    if (res.stop_reason !== "end_turn") {
      console.error("ia: stop_reason", res.stop_reason);
      return null;
    }
    const bloque = res.content.find((b) => b.type === "text");
    if (!bloque || bloque.type !== "text") return null;
    const j = JSON.parse(bloque.text);
    const l: Lectura = {};
    if (j.localidad === "Otra") l.otraLoc = true;
    else if (j.localidad) l.loc = j.localidad;
    if (j.viaja === true && j.localidad && j.localidad !== "Otra") l.viaja = true;
    if (j.material) l.mat = j.material;
    if (j.modo) l.modo = j.modo;
    if (j.tipo) l.tipo = j.tipo;
    if (typeof j.cantidad === "number") l.cant = j.cantidad;
    if (Array.isArray(j.monedas) && j.monedas.length) {
      l.items = j.monedas.map((x: { tipo: string; cantidad: number }) => (x.tipo === MEZCLADAS ? { modo: "kg" as const, cant: x.cantidad } : { modo: "u" as const, tipo: x.tipo, cant: x.cantidad }));
    }
    if (j.entrega) l.ret = j.entrega;
    if (j.direccion) l.dir = j.direccion;
    if (j.intencion) l.intencion = j.intencion;
    return l;
  } catch (e) {
    if (e instanceof Anthropic.APIError) console.error("ia:", e.status, e.message);
    else console.error("ia:", e);
    return null;
  }
}

// ---------- Redacción: Haiku le da tono de persona a las respuestas que ya armó el bot ----------

const ESTILO = `Sos quien atiende el WhatsApp de Punto Metales, un negocio chico de la zona de Rosario que compra monedas, llaves, cobre y bronce. Te paso el mensaje del cliente y lo que el sistema le quiere contestar, con los precios y las cuentas ya hechos. Escribí lo mismo como lo escribiría una persona del negocio en WhatsApp: rioplatense, natural, frases cortas, sin sonar a formulario ni a bot. No copies las frases del sistema: decilo con tus palabras, y si el cliente contó algo o hizo una pregunta, reaccioná a eso primero.

Si te paso "como_escribe_el_equipo", son charlas reales de quien atiende el negocio: escribí como esa persona (largo de los mensajes, saludos, cómo pregunta, si usa signos o no). De esos ejemplos tomá solo el estilo, nunca los datos: ni precios, ni días, ni lugares, ni nombres.

Ejemplo. Sistema: "¡Genial, en Funes trabajamos! Por 3 kg de cobre te pagamos $45.000 ($15.000 el kilo, precio minorista). El monto final se confirma al pesar en el momento del retiro." Vos: "A Funes vamos. Por esos 3 kg de cobre serían $45.000, a $15.000 el kilo. Lo confirmamos cuando lo pesamos al retirarlo."

Reglas:
- Una respuesta tuya por cada respuesta del sistema, en el mismo orden.
- Los datos van exactos: montos, precios, kilos, cantidades, direcciones, horarios, nombres y localidades, con el mismo formato ($75.000, 7,5 kg). No agregues números.
- Lo que el sistema pone "por ejemplo" lo podés sacar o acortar: muchas veces alcanza con "¿cuántas tenés de cada una?".
- No inventes datos, promesas ni condiciones. Si el sistema hace una pregunta, la tuya también la hace al final.
- No agregues nada que el sistema no diga: ni distancias, ni si un lugar queda cerca o lejos, ni lugares, días u horarios para encontrarse. Si el cliente propone algo (un lugar, un día), no lo aceptes ni lo confirmes: eso lo arregla alguien del equipo. Podés decir que lo tenés en cuenta, nada más.
- No digas cómo te llamás ni firmes con un nombre.
- No cambies palabras que no entendés del mensaje del cliente ni las repitas si suenan raras (los audios pasados a texto traen errores).
- Cuando hay opciones, el cliente las ve como botones abajo del mensaje: no hace falta enumerarlas, pero si nombrás una, con el mismo nombre. Lo que está entre comillas va tal cual, con comillas.
- Sin emojis, salvo que el cliente los use. Nada de "estimado", "le informamos", "¡Genial!" ni "¡Perfecto!".
- Si el cliente trata de usted, tratalo de usted; si no, de vos.
- Corto, como en un chat: una o dos frases por mensaje, una sola pregunta. Las listas de precios y el resumen del pedido van como vienen.
- Si viene la charla reciente, no repitas frases que el bot ya dijo y no vuelvas a saludar si ya saludó. Si el bot ya hizo esta misma pregunta, hacela con otras palabras y más corta. Si el cliente dijo que después te pasa los datos ("ahí te digo", "bancame"), no le vuelvas a pedir lo mismo: decile que lo esperás.`;

// Los datos que la respuesta reescrita tiene que conservar sí o sí: montos, números y textos entre comillas
const datosDe = (s: string) => (s.match(/\$\s?\d+(?:[.,]\d+)*|\d+(?:[.,]\d+)*|"[^"]+"/g) ?? []).map((x) => x.replace(/\$\s/, "$"));

/**
 * Las respuestas con el tono de una persona. Los números salen del bot: si Haiku cambia o pierde
 * alguno, si tarda o si falla, esa respuesta va con el texto original.
 */
export async function redactar(apiKey: string, cliente_dijo: string, rs: { text: string; options?: string[] }[], charla = "", ejemplos = "") {
  if (!apiKey || !rs.length) return rs;
  cliente ??= nuevoCliente(apiKey);
  try {
    const res = await cliente.messages.create({
      model: MODELO,
      max_tokens: 2048,
      system: ESTILO,
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: {
          type: "object", properties: { respuestas: { type: "array", items: { type: "string" } } },
          required: ["respuestas"], additionalProperties: false,
        } },
      },
      messages: [{ role: "user", content: JSON.stringify({
        cliente: cliente_dijo,
        ...(ejemplos ? { como_escribe_el_equipo: ejemplos } : {}),
        ...(charla ? { charla_reciente: charla } : {}),
        respuestas: rs.map((r) => (r.options?.length ? { texto: r.text, opciones: r.options } : { texto: r.text })),
      }) }],
    });
    anotar(res);
    if (res.stop_reason !== "end_turn") { console.error("ia: redactar stop_reason", res.stop_reason); return rs; }
    const bloque = res.content.find((b) => b.type === "text");
    if (!bloque || bloque.type !== "text") return rs;
    const nuevas: unknown = JSON.parse(bloque.text).respuestas;
    if (!Array.isArray(nuevas) || nuevas.length !== rs.length) return rs;
    return rs.map((r, i) => {
      const t = typeof nuevas[i] === "string" ? (nuevas[i] as string).trim() : "";
      return t && conservaDatos(r.text, t) && t.length <= (r.options?.length ? 1024 : 2000) ? { ...r, text: t } : r;
    });
  } catch (e) {
    if (e instanceof Anthropic.APIError) console.error("ia: redactar", e.status, e.message);
    else console.error("ia: redactar", e);
    return rs;
  }
}

// "Por ejemplo: 50 de $1 y 20 de 50 centavos." Esos números la reescrita los puede sacar
const EJEMPLO = /por ejemplo:?[^.?!\n]*/gi;

/**
 * Cada monto, número y texto entre comillas del original aparece en la reescrita, y no hay números nuevos.
 * Los de un "por ejemplo" pueden quedar o no.
 */
export function conservaDatos(original: string, nueva: string): boolean {
  const a = datosDe(original.replace(EJEMPLO, "")), b = datosDe(nueva);
  const quedan = [...b];
  for (const x of a) {
    const i = quedan.indexOf(x);
    if (i < 0) return false;
    quedan.splice(i, 1);
  }
  const ejemplos = (original.match(EJEMPLO) ?? []).flatMap(datosDe);
  return quedan.every((x) => ejemplos.includes(x));
}

// ---------- Preguntas: Haiku contesta con lo que sabe el negocio, sin inventar ----------

const RESPONDER = `Atendés el WhatsApp de Punto Metales, que compra monedas, llaves, cobre y bronce en la zona de Rosario. El cliente hizo una pregunta. Contestala en rioplatense, corto (una a tres frases), cálido, como una persona del negocio.

Usá solo los datos que te paso. Si la respuesta no está ahí, decí que eso lo confirma alguien del equipo. No inventes precios, horarios, formas de pago ni promesas, y no hagas preguntas: el sistema sigue la charla después de tu respuesta. Si los datos ya dicen qué le conviene, decíselo directo con esos números, aunque no sepas cuánto tiene.

Si te paso "como_escribe_el_equipo", son charlas reales del negocio: copiá el estilo (corto, sin emojis, usted o vos según el cliente), nunca los datos. No digas cómo te llamás.`;

/** Respuesta a una pregunta del cliente, con los números sacados de hechos; null si no se pudo o si inventó un número. */
export async function contestar(apiKey: string, pregunta: string, hechos: string, charla = "", ejemplos = ""): Promise<string | null> {
  if (!apiKey) return null;
  cliente ??= nuevoCliente(apiKey);
  try {
    const res = await cliente.messages.create({
      model: MODELO,
      max_tokens: 1024,
      system: RESPONDER,
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: {
          type: "object", properties: { respuesta: { type: "string" } }, required: ["respuesta"], additionalProperties: false,
        } },
      },
      messages: [{ role: "user", content: JSON.stringify({ datos_del_negocio: hechos, ...(ejemplos ? { como_escribe_el_equipo: ejemplos } : {}), ...(charla ? { charla_reciente: charla } : {}), pregunta }) }],
    });
    anotar(res);
    if (res.stop_reason !== "end_turn") { console.error("ia: contestar stop_reason", res.stop_reason); return null; }
    const bloque = res.content.find((b) => b.type === "text");
    if (!bloque || bloque.type !== "text") return null;
    const t = String(JSON.parse(bloque.text).respuesta ?? "").trim();
    // Cada número de la respuesta tiene que estar en los datos (o en la pregunta)
    const num = (x: string) => x.replace("$", "");
    const validos = new Set([...datosDe(hechos), ...datosDe(pregunta)].map(num));
    if (!t || t.length > 600 || datosDe(t).some((x) => !x.startsWith('"') && !validos.has(num(x)))) return null;
    return t;
  } catch (e) {
    if (e instanceof Anthropic.APIError) console.error("ia: contestar", e.status, e.message);
    else console.error("ia: contestar", e);
    return null;
  }
}
