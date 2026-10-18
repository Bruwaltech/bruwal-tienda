// Lectura con Claude Haiku de lo que el cliente escribe libremente ("tengo 3 kilos de cobre en Funes").
// La IA interpreta (devuelve datos sueltos) y le da tono a lo que contesta el bot, pero las respuestas,
// los precios y las cuentas los sigue armando el bot. Si no hay clave o la llamada falla, anda igual sin ella.
import Anthropic from "npm:@anthropic-ai/sdk@0.132.1";
import { type Config, type Estado, LOCALIDADES, type Lectura, MEZCLADAS, tiposDe } from "./bot.ts";

const MODELO = "claude-haiku-5-5";

const PREGUNTAS: Record<string, string> = {
  loc: "de qué localidad escribe", out: "si quiere probar con otra localidad", cat: "qué quiere vender",
  unit: "si las monedas están contadas o pesadas", tipo: "de qué tipo son las monedas, o si van por kilo", qty: "cuánto tiene",
  mod: "si se lo pasamos a buscar (y en ese caso la dirección), nos encontramos en un punto o lo lleva al depósito",
};

const nulo = (s: Record<string, unknown>) => ({ anyOf: [s, { type: "null" }] });

function esquema(c: Config) {
  const tipos = [...tiposDe(c).map((t) => t.n), MEZCLADAS];
  return {
    type: "object",
    properties: {
      localidad: nulo({ type: "string", enum: [...LOCALIDADES.map((l) => l.n), "Otra"] }),
      material: nulo({ type: "string", enum: ["Monedas", "Cobre", "Bronce"] }),
      modo: nulo({ type: "string", enum: ["kg", "u"] }),
      tipo: nulo({ type: "string", enum: tipos }),
      cantidad: nulo({ type: "number" }),
      entrega: nulo({ type: "string", enum: ["Retiro a domicilio", "Punto de encuentro", "Depósito"] }),
      direccion: nulo({ type: "string" }),
      intencion: nulo({ type: "string", enum: ["precios", "depositos", "humano", "otro", "prohibido", "no_vende", "consulta"] }),
    },
    required: ["localidad", "material", "modo", "tipo", "cantidad", "entrega", "direccion", "intencion"],
    additionalProperties: false,
  };
}

function sistema(c: Config) {
  const tipos = tiposDe(c).map((t) => t.n).join(", ") || "(sin tipos cargados)";
  return `Leés mensajes de WhatsApp que clientes le mandan a Punto Metales, un negocio de la zona de Rosario (Argentina) que compra monedas, llaves, cobre y bronce. Tu tarea es solo extraer datos del mensaje; otro sistema contesta.

Campos (null si el mensaje no lo dice claramente; no adivines):
- localidad: una de la lista si el cliente nombra una (aceptá apodos, abreviaturas y errores de tipeo: "Gdor Baigorria" es Baigorria, "Pto San Martín" es Puerto General San Martín). "Otra" si nombra un lugar que no está en la lista.
- material: Monedas, Cobre o Bronce. Las llaves cuentan como Monedas, con tipo de llave.
- modo: "kg" si habla de peso (kilos, bolsa de X kg), "u" si habla de cantidad de unidades contadas.
- tipo: el tipo de moneda si lo dice. Tipos: ${tipos}. "${MEZCLADAS}" si son de varias clases.
- cantidad: el número de kilos o de unidades, según el modo ("unos tres kilos" = 3, "dos mil monedas" = 2000, "medio kilo" = 0.5).
- entrega: si quiere que se lo pasen a buscar ("Retiro a domicilio"), encontrarse en algún lugar ("Punto de encuentro") o llevarlo él ("Depósito").
- direccion: la calle y el número donde pasar a buscarlo, tal como los escribió, si los escribió.
- intencion: "precios" si pregunta cuánto pagan sin dar cantidad, "depositos" si pregunta dónde están o el horario, "humano" si pide hablar con una persona. "prohibido" si ofrece medidores (de agua, gas o luz), placas o cosas de cementerio, cables telefónicos, piezas con numeración o de la vía pública, o algo que parezca robado. "otro" si ofrece algo que claramente no es monedas, llaves, cobre ni bronce (aluminio, hierro, plomo, electrodomésticos); los cables o caños de cobre no son "otro". "no_vende" si dice que no quiere vender, que solo consultaba o se despide (gracias, chau, por ahora no). "consulta" si hace una pregunta que no es solo de precios ni de depósitos y que hay que contestarle antes de seguir (qué le conviene, cómo funciona el retiro, si tiene que mandar algo, si pagan en efectivo). Si no, null.

Te paso también la charla reciente. Si en mensajes anteriores del cliente hay datos que el bot todavía no anotó (por ejemplo dijo "tengo monedas" y nadie le contestó), extraelos también.`;
}

let cliente: Anthropic | null = null;

/** Lo que Haiku entendió del mensaje, o null si no se pudo leer (sin clave, error, demora). */
export async function leer(apiKey: string, texto: string, estado: Estado | null, c: Config, charla = ""): Promise<Lectura | null> {
  if (!apiKey) return null;
  // El bot espera la lectura antes de contestar: si tarda, sigue sin ella
  cliente ??= new Anthropic({ apiKey, timeout: 6000, maxRetries: 0 });
  const contexto = estado
    ? `Ya sabemos: ${JSON.stringify(estado.d)}. El bot le acaba de preguntar ${PREGUNTAS[estado.step] ?? "si quiere algo más"}.`
    : "Es el primer mensaje de la charla.";
  try {
    const res = await cliente.messages.create({
      model: MODELO,
      max_tokens: 1024,
      system: sistema(c),
      output_config: { effort: "low", format: { type: "json_schema", schema: esquema(c) } },
      messages: [{ role: "user", content: `${contexto}${charla ? `\n\nCharla reciente:\n${charla}` : ""}\n\nMensaje del cliente:\n${texto}` }],
    });
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
    if (j.material) l.mat = j.material;
    if (j.modo) l.modo = j.modo;
    if (j.tipo) l.tipo = j.tipo;
    if (typeof j.cantidad === "number") l.cant = j.cantidad;
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

const ESTILO = `Sos quien atiende el WhatsApp de Punto Metales, un negocio chico de la zona de Rosario que compra monedas, llaves, cobre y bronce. Te paso el mensaje del cliente y lo que el sistema le quiere contestar, con los precios y las cuentas ya hechos. Escribí lo mismo como lo escribiría una persona del negocio en WhatsApp: rioplatense (vos, tenés, dale), cálido y natural, frases cortas, sin sonar a formulario. No copies las frases del sistema: decilo con tus palabras, y si el cliente contó algo o hizo una pregunta, reaccioná a eso primero.

Ejemplo. Sistema: "¡Genial, en Funes trabajamos! Por 3 kg de cobre te pagamos $45.000 ($15.000 el kilo, precio minorista). El monto final se confirma al pesar en el momento del retiro." Vos: "¡Buenísimo! A Funes vamos 👌 Por esos 3 kg de cobre serían $45.000, a $15.000 el kilo. Lo terminamos de confirmar cuando lo pesamos al retirarlo."

Reglas:
- Una respuesta tuya por cada respuesta del sistema, en el mismo orden.
- Los datos van exactos: montos, precios, kilos, cantidades, direcciones, horarios, nombres y localidades, con el mismo formato ($75.000, 7,5 kg). No agregues números.
- No inventes datos, promesas ni condiciones. Si el sistema hace una pregunta, la tuya también la hace al final.
- Cuando hay opciones, el cliente las ve como botones abajo del mensaje: no hace falta enumerarlas, pero si nombrás una, con el mismo nombre. Lo que está entre comillas va tal cual, con comillas.
- Como mucho un emoji por mensaje. Nada de "estimado" ni "le informamos".
- Si viene la charla reciente, no repitas frases que el bot ya dijo y no vuelvas a saludar si ya saludó.`;

// Los datos que la respuesta reescrita tiene que conservar sí o sí: montos, números y textos entre comillas
const datosDe = (s: string) => (s.match(/\$\s?\d+(?:[.,]\d+)*|\d+(?:[.,]\d+)*|"[^"]+"/g) ?? []).map((x) => x.replace(/\$\s/, "$"));

/**
 * Las respuestas con el tono de una persona. Los números salen del bot: si Haiku cambia o pierde
 * alguno, si tarda o si falla, esa respuesta va con el texto original.
 */
export async function redactar(apiKey: string, cliente_dijo: string, rs: { text: string; options?: string[] }[], charla = "") {
  if (!apiKey || !rs.length) return rs;
  cliente ??= new Anthropic({ apiKey, timeout: 6000, maxRetries: 0 });
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
        ...(charla ? { charla_reciente: charla } : {}),
        respuestas: rs.map((r) => (r.options?.length ? { texto: r.text, opciones: r.options } : { texto: r.text })),
      }) }],
    });
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

/** Cada monto, número y texto entre comillas del original aparece en la reescrita, y no hay números nuevos. */
export function conservaDatos(original: string, nueva: string): boolean {
  const a = datosDe(original), b = datosDe(nueva);
  const quedan = [...b];
  for (const x of a) {
    const i = quedan.indexOf(x);
    if (i < 0) return false;
    quedan.splice(i, 1);
  }
  return quedan.length === 0;
}

// ---------- Preguntas: Haiku contesta con lo que sabe el negocio, sin inventar ----------

const RESPONDER = `Atendés el WhatsApp de Punto Metales, que compra monedas, llaves, cobre y bronce en la zona de Rosario. El cliente hizo una pregunta. Contestala en rioplatense, corto (una a tres frases), cálido, como una persona del negocio.

Usá solo los datos que te paso. Si la respuesta no está ahí, decí que eso lo confirma Walter. No inventes precios, horarios, formas de pago ni promesas, y no hagas preguntas: el sistema sigue la charla después de tu respuesta. Si los datos ya dicen qué le conviene, decíselo directo con esos números, aunque no sepas cuánto tiene.`;

/** Respuesta a una pregunta del cliente, con los números sacados de hechos; null si no se pudo o si inventó un número. */
export async function contestar(apiKey: string, pregunta: string, hechos: string, charla = ""): Promise<string | null> {
  if (!apiKey) return null;
  cliente ??= new Anthropic({ apiKey, timeout: 6000, maxRetries: 0 });
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
      messages: [{ role: "user", content: JSON.stringify({ datos_del_negocio: hechos, ...(charla ? { charla_reciente: charla } : {}), pregunta }) }],
    });
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
