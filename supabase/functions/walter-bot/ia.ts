// Lectura con Claude Haiku de lo que el cliente escribe libremente ("tengo 3 kilos de cobre en Funes").
// La IA solo interpreta: devuelve datos sueltos y el bot sigue armando las respuestas, los precios y
// las cuentas como siempre. Si no hay clave o la llamada falla, el bot anda igual sin ella.
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
      intencion: nulo({ type: "string", enum: ["precios", "depositos", "humano"] }),
    },
    required: ["localidad", "material", "modo", "tipo", "cantidad", "entrega", "intencion"],
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
- intencion: "precios" si pregunta cuánto pagan sin dar cantidad, "depositos" si pregunta dónde están o el horario, "humano" si pide hablar con una persona. Si no, null.`;
}

let cliente: Anthropic | null = null;

/** Lo que Haiku entendió del mensaje, o null si no se pudo leer (sin clave, error, demora). */
export async function leer(apiKey: string, texto: string, estado: Estado | null, c: Config): Promise<Lectura | null> {
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
      messages: [{ role: "user", content: `${contexto}\n\nMensaje del cliente:\n${texto}` }],
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
    if (j.intencion) l.intencion = j.intencion;
    return l;
  } catch (e) {
    if (e instanceof Anthropic.APIError) console.error("ia:", e.status, e.message);
    else console.error("ia:", e);
    return null;
  }
}
