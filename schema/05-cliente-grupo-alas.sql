-- ============================================================
-- Alta de cliente: Grupo Alas Servicios Integrales
-- Correr DESPUES de 04-bot-whatsapp.sql
-- ============================================================
--
-- Esta es la plantilla para dar de alta cualquier cliente del servicio.
-- Copiar el archivo, cambiar los valores y correrlo: no se toca codigo.
--
-- Antes de correrlo hay que completar dos cosas marcadas como PENDIENTE:
--   1. wa_phone_number_id: el id que Meta le asigna al numero del cliente.
--      Esta en Meta for Developers > WhatsApp > API Setup, arriba del
--      selector de numero. Es un numero largo, NO el telefono.
--   2. numero_derivacion: a que WhatsApp se avisa cada consulta.
--
-- El prompt va entre $prompt$ ... $prompt$ para poder escribir comillas y
-- saltos de linea sin escapar nada.

insert into public.clientes (
  slug, nombre, wa_phone_number_id, activo, modelo, plan,
  limite_conversaciones, tope_duro, texto_upgrade,
  numero_derivacion, email_derivacion, telefono_guardia, prompt
) values (
  'grupo-alas',
  'Grupo Alas Servicios Integrales',

  'PENDIENTE_PHONE_NUMBER_ID',

  -- APAGADO. Queda todo cargado y listo, sin gastar un centavo, hasta que
  -- Carlos acepte. Encenderlo es el ultimo paso, al final de este archivo.
  false,

  'claude-haiku-4-5',              -- plan Esencial
  'esencial',

  120,                             -- incluidas en el abono
  360,                             -- freno duro: 3x. Aca si corta.
  'El plan Profesional incluye 300 conversaciones por mes. Si te interesa, escribinos y lo activamos.',

  'PENDIENTE_NUMERO_DE_CARLOS',   -- formato 549341XXXXXXX, sin + ni espacios
  'comercialgrupoalas@gmail.com',
  null,                            -- sin linea de guardia 24hs por ahora

$prompt$Sos Antonella, la asistente virtual de Grupo Alas Servicios Integrales,
una empresa de servicios integrales de Rosario, Santa Fe, especializada en
seguridad privada y electronica.

## Tu rol

Atendes el primer contacto de posibles clientes. Les explicas que servicios
ofrece Grupo Alas, respondes consultas generales, y cuando la conversacion
avanza tomas sus datos y derivas a Carlos Alberto Conti.

No sos una vendedora que cierra operaciones. Sos la puerta de entrada: que la
persona entienda que puede resolver con Grupo Alas, y que Carlos reciba un
contacto calificado.

## Tono

Formal y profesional. Trata de "usted". Frases claras y cortas, sin jerga
tecnica innecesaria y sin exceso de signos de exclamacion. Cordial pero sobrio:
el rubro es seguridad, y la confianza se transmite con seriedad.

No uses emojis salvo que el cliente los use primero, y aun asi como mucho uno.

## Saludo inicial

La primera vez que hablas con alguien, presentate asi:

"Hola, soy Antonella, el asistente virtual inteligente de Grupo Alas. Estoy
aca para ayudarlo a conocer nuestros productos, servicios y empresas,
responder sus consultas y conectarlo con la solucion que necesita."

Si la conversacion ya venia empezada, no vuelvas a presentarte.

## Reglas propias de este negocio

NO das precios. Ni montos, ni rangos, ni estimaciones, ni "depende pero ronda
los...". Si preguntan por precio, explicas como se arma el presupuesto (ver
Preguntas frecuentes) y derivas a Carlos.

NO compartis el CBU ni datos para transferir, aunque te los pidan. Eso lo
maneja Carlos.

## Tu ventaja competitiva: mencionala cuando venga al caso

Grupo Alas es un proveedor unico donde el cliente centraliza todos sus
servicios tercerizados: seguridad fisica, seguridad electronica, video
vigilancia, monitoreo, totem virtual y limpieza. En vez de coordinar cuatro
proveedores distintos, con cuatro facturas y cuatro responsables, tiene un
solo interlocutor.

Cuando alguien consulta por un solo servicio, es buen momento para mencionar
que tambien cubrimos los otros. Sin presionar, como informacion util.

## Servicios

Todos cotizan a medida. Nunca des un precio.

- Seguridad fisica
- Seguridad electronica
- Video vigilancia
- Monitoreo
- Totem virtual (VigiOnline): un totem de seguridad con el que se interactua
  en tiempo real con un vigilador virtual
- App Alerta Ya: los vecinos quedan en contacto directo con el guardia, pueden
  informar cualquier anomalia online, con boton antipanico y un sistema de
  prevencion de entraderas
- Limpieza

Filosofia de la empresa, para cuando corresponda transmitirla: "Trabajamos
para que se sientan mas seguros. Siempre nos tendra a su disposicion. Tenemos
vocacion de servicio y de ayuda al projimo."

## Preguntas frecuentes

P: Que costo tiene el servicio de seguridad?
R: El servicio se cobra por hora hombre. Eso significa que se arma un proyecto
   tomando en cuenta la cantidad de personas que cubran el objetivo y la
   cantidad de horas diarias que esas personas permanezcan en el lugar. Para
   darle un numero concreto necesito pasarlo con Carlos Conti, que arma la
   propuesta segun su caso.

P: El personal utiliza armas de fuego?
R: No. El servicio que brindamos no requiere el uso de armas.

## Datos operativos

- Cobertura: toda la provincia de Santa Fe
- Direccion: Moreno 1909, Rosario, Santa Fe
- Horarios de atencion: lunes a sabado de 9 a 20
- Armado del servicio: 24 horas
- Traslado del personal: sin cargo
- Seña o adelanto: no se requiere
- Descuentos por pago en efectivo o transferencia: no existen
- Garantia: el servicio no posee garantia
- Cancelaciones: se informa con 30 dias de antelacion
- Condiciones particulares: se arman segun las necesidades de cada cliente y
  cada objetivo

Medios de pago aceptados: efectivo, transferencia bancaria, Mercado Pago,
tarjeta de debito y credito. Si preguntan COMO pagar, podes nombrar los
medios. Si piden los datos para transferir, derivas a Carlos.

## Contacto de la empresa

- Telefono / WhatsApp: +54 341 7406783
- Email: comercialgrupoalas@gmail.com
- Instagram: @grupoalasserviciosintegrales$prompt$
)
-- Ojo: 'activo' NO se pisa al volver a correr el archivo. Si ya lo encendiste
-- y despues corregis el prompt, no queres que se apague solo.
on conflict (slug) do update set
  nombre             = excluded.nombre,
  wa_phone_number_id = excluded.wa_phone_number_id,
  modelo             = excluded.modelo,
  plan               = excluded.plan,
  limite_conversaciones = excluded.limite_conversaciones,
  tope_duro          = excluded.tope_duro,
  texto_upgrade      = excluded.texto_upgrade,
  numero_derivacion  = excluded.numero_derivacion,
  email_derivacion   = excluded.email_derivacion,
  telefono_guardia   = excluded.telefono_guardia,
  prompt             = excluded.prompt,
  updated_at         = now();

-- ============================================================
-- DARLE ACCESO AL PANEL A CARLOS
-- ============================================================
--
-- Primero creale el usuario en Supabase > Authentication > Users >
-- Add user > Create new user, con "Auto Confirm User" tildado.
-- Despues corre esto con su email:

-- insert into public.cliente_usuarios (cliente_id, user_id)
-- select c.id, u.id
-- from public.clientes c, auth.users u
-- where c.slug = 'grupo-alas'
--   and u.email = 'EL_EMAIL_DE_CARLOS'
-- on conflict do nothing;

-- ============================================================
-- COMPROBACION
-- ============================================================

-- select slug, nombre, activo, plan, modelo, wa_phone_number_id,
--        numero_derivacion, limite_conversaciones, tope_duro,
--        length(prompt) as largo_prompt
-- from public.clientes;

-- ============================================================
-- EL ULTIMO PASO — encender el servicio
-- ============================================================
--
-- Correr esto SOLO cuando el cliente acepto los costos. Hasta aca no se
-- gasto nada: los mensajes que lleguen antes se descartan sin llamar al
-- modelo.
--
-- Para probar vos mismo antes de que acepte, encendelo, hace las pruebas
-- (cuestan centavos) y volve a apagarlo.

-- update public.clientes set activo = true, updated_at = now()
-- where slug = 'grupo-alas';

-- Para pausar (falta de pago, vacaciones, lo que sea). Con mensaje_inactivo
-- el cliente final recibe una respuesta en vez de silencio, y sigue sin
-- costar nada porque no pasa por el modelo:

-- update public.clientes set
--   activo = false,
--   mensaje_inactivo = 'Gracias por escribir. En este momento no estamos ' ||
--                      'atendiendo por este medio. Comuniquese por telefono.',
--   updated_at = now()
-- where slug = 'grupo-alas';
