-- ============================================================
-- BRUWAL Chat/Bot IA — estructura multi-cliente
-- Pegar en Supabase > SQL Editor > New query > Run
-- ============================================================
--
-- Un solo webhook y una sola base atienden a todos los clientes del servicio.
-- Cada mensaje que entra trae el id del numero de WhatsApp que lo recibio, y
-- ese id es el que decide de que cliente es la conversacion.
--
-- Dar de alta un cliente nuevo es insertar una fila en public.clientes.
-- No se toca codigo. Ver 05-cliente-grupo-alas.sql como plantilla.

-- ============================================================
-- 1) CLIENTES DEL SERVICIO
-- ============================================================

create table if not exists public.clientes (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  nombre text not null,

  -- El id que Meta le asigna al numero de WhatsApp del cliente. Es lo que
  -- llega en cada webhook y lo que usamos para saber a quien pertenece la
  -- conversacion. Sin esto no hay forma de separar un cliente de otro.
  wa_phone_number_id text not null unique,

  -- Como habla el asistente de ESTE cliente: su nombre, sus servicios, sus
  -- reglas. Las reglas comunes a todos (formato de WhatsApp, uso de las
  -- herramientas, captura de datos) viven en el codigo y se anteponen a esto.
  prompt text not null,

  -- Que modelo atiende a este cliente: es lo que separa un plan de otro.
  -- Cambiarlo es un update, no un deploy.
  --
  -- Ojo con el cacheo del prompt: cada modelo tiene su propio minimo de tokens
  -- para que funcione (Haiku 4.5 pide 4096, Sonnet 5 pide 1024, Opus 5 pide
  -- 512). Nuestro prefijo mide ~2600, asi que en Haiku NO se cachea y cada
  -- llamada paga el prompt entero. No falla ni avisa: simplemente no aplica.
  -- Sigue siendo el mas barato de los tres igual.
  modelo text not null default 'claude-sonnet-5'
    check (modelo in ('claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5')),

  -- Nombre del plan contratado, para el panel y la facturacion.
  plan text,

  -- Cuantas conversaciones incluye el abono. Pasarse NO corta el servicio:
  -- las de mas quedan marcadas como excedente para facturarlas. Cortar
  -- automaticamente le haria perder clientes reales al negocio, y la culpa
  -- se la llevaria el servicio.
  -- null = sin limite.
  limite_conversaciones integer check (limite_conversaciones > 0),

  -- El freno de verdad. Aca SI se corta: el bot deja de llamar al modelo y
  -- responde un mensaje fijo. Existe para que un pico raro -- un aviso que se
  -- viraliza, alguien mandando mensajes a proposito -- no se convierta en una
  -- factura sin techo. Poner unas 3 veces el limite incluido.
  -- null = nunca corta.
  tope_duro integer check (tope_duro > 0),

  -- Que ofrecerle cuando se esta quedando sin conversaciones. Se manda tal
  -- cual, asi que conviene que diga el plan y el precio concretos.
  -- Ej: 'El plan Profesional incluye 300 conversaciones por $X al mes.'
  texto_upgrade text,

  -- Ultimo periodo (YYYY-MM) en que ya se aviso de cada umbral, para no
  -- repetir el mismo aviso en cada mensaje que entra.
  aviso_previo_periodo text,    -- al 80% del limite, con la oferta de upgrade
  aviso_limite_periodo text,    -- al llegar al limite incluido
  aviso_tope_periodo text,      -- al cortar por tope duro

  -- A donde se avisa cuando el bot deriva. Formato internacional sin signos:
  -- 5493411234567
  numero_derivacion text,
  email_derivacion text,

  -- Solo para rubros donde tiene sentido (seguridad, salud). Si esta vacio, el
  -- bot deriva unicamente al 911 ante una emergencia.
  telefono_guardia text,

  -- El interruptor del servicio. En false el webhook recibe los mensajes pero
  -- NO llama al modelo: no se gasta un centavo. Es lo que permite dejar todo
  -- instalado y configurado antes de que el cliente acepte, y tambien lo que
  -- se usa para pausar a alguien que dejo de pagar.
  activo boolean not null default false,

  -- Que contestar mientras esta apagado. Se manda sin pasar por el modelo,
  -- asi que no cuesta nada.
  -- null = silencio total, que es lo correcto antes de publicar el numero.
  -- Con texto = util para una pausa, para que el cliente final no crea que
  -- el negocio lo esta ignorando.
  mensaje_inactivo text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- 2) QUIEN PUEDE VER LOS DATOS DE CADA CLIENTE
-- ============================================================
--
-- Tabla aparte y no una columna en clientes porque un cliente puede tener
-- varias personas mirando el panel (el dueño y quien atiende, por ejemplo).

create table if not exists public.cliente_usuarios (
  cliente_id uuid not null references public.clientes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (cliente_id, user_id)
);

-- Consultar cliente_usuarios desde una politica de cliente_usuarios seria
-- recursivo y Postgres lo corta con un error. Una funcion security definer
-- rompe el ciclo: corre con permisos del dueño y no vuelve a aplicar RLS.
create or replace function public.mis_clientes()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select cliente_id from public.cliente_usuarios where user_id = auth.uid()
$$;

-- ============================================================
-- 3) HISTORIAL DE CONVERSACION
-- ============================================================

create table if not exists public.wa_mensajes (
  id bigserial primary key,
  cliente_id uuid not null references public.clientes(id) on delete cascade,
  telefono text not null,
  rol text not null check (rol in ('user', 'assistant')),
  texto text not null,
  -- El id que asigna Meta, unico a nivel global. Sirve para no procesar dos
  -- veces el mismo mensaje cuando Meta reintenta el webhook. Las respuestas
  -- del bot no tienen id: en Postgres los nulos no chocan entre si con unique.
  wa_message_id text unique,
  created_at timestamptz not null default now()
);

-- El indice arranca por cliente_id porque toda consulta -- del bot o del
-- panel -- filtra primero por cliente.
create index if not exists wa_mensajes_conversacion_idx
  on public.wa_mensajes (cliente_id, telefono, id desc);

-- ============================================================
-- 3b) CONVERSACIONES — lo que se cuenta contra el plan
-- ============================================================
--
-- Una conversacion no es un mensaje: es una persona hablando con el bot
-- dentro de una ventana de 24 horas. Si vuelve a escribir tres dias despues,
-- eso es una conversacion nueva. Es la misma unidad que usa Meta para su
-- ventana de servicio, asi que es facil de explicarle al cliente.

create table if not exists public.wa_conversaciones (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references public.clientes(id) on delete cascade,
  telefono text not null,

  -- YYYY-MM en hora de Argentina. El mes se corta a medianoche local y no en
  -- UTC: si no, todo lo que entra entre las 21 y las 24 del ultimo dia se
  -- facturaria al mes siguiente.
  periodo text not null,

  iniciada_at timestamptz not null default now(),
  ultima_actividad timestamptz not null default now(),
  mensajes integer not null default 1,

  -- Se marca al crearla si el cliente ya paso su limite incluido. Es lo que
  -- se factura como excedente a fin de mes.
  excedente boolean not null default false
);

-- Para encontrar la conversacion abierta de un telefono
create index if not exists wa_conversaciones_abierta_idx
  on public.wa_conversaciones (cliente_id, telefono, ultima_actividad desc);

-- Para contar el consumo del periodo
create index if not exists wa_conversaciones_periodo_idx
  on public.wa_conversaciones (cliente_id, periodo);

-- Contar con una funcion y no trayendo las filas: a 400 conversaciones por mes
-- traerlas todas para hacer length() funciona, pero deja de funcionar solo.
-- Sin security definer a proposito: la llama el webhook con la service role,
-- que ya ignora RLS. Ponersela la convertiria en una puerta de escalada de
-- privilegios si alguna vez quedara expuesta, sin ganar nada.
-- El search_path fijo si va: es lo que evita que alguien cree una tabla con
-- el mismo nombre en otro esquema y se la haga leer a la funcion.
create or replace function public.contar_conversaciones(p_cliente uuid, p_periodo text)
returns integer
language sql
stable
set search_path = public
as $$
  select count(*)::int
  from public.wa_conversaciones
  where cliente_id = p_cliente and periodo = p_periodo
$$;

-- ============================================================
-- 4) CONTACTOS CAPTURADOS
-- ============================================================

create table if not exists public.wa_leads (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references public.clientes(id) on delete cascade,
  telefono text not null,

  nombre text,
  apellido text,
  empresa text,
  email text,
  ciudad text,
  telefono_alternativo text,
  servicio_interes text,
  tipo_objetivo text,
  notas text,

  -- Lo escribe el bot
  derivado boolean not null default false,
  derivado_at timestamptz,
  motivo_derivacion text,

  -- Lo escribe la persona desde el panel
  atendido boolean not null default false,
  atendido_at timestamptz,
  notas_internas text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Un contacto por telefono POR CLIENTE: el mismo numero puede consultarle a
  -- dos clientes distintos del servicio y son dos fichas separadas.
  unique (cliente_id, telefono)
);

create index if not exists wa_leads_pendientes_idx
  on public.wa_leads (cliente_id, atendido, updated_at desc);

-- ============================================================
-- 5) SEGURIDAD
-- ============================================================
--
-- El webhook escribe con la service role key, que ignora RLS. Las politicas
-- de abajo son unicamente para el panel: definen que puede ver y tocar una
-- persona logueada desde el navegador.
--
-- Sin esto, la clave publica que ya circula en el front del sitio podria leer
-- las conversaciones de los clientes de todos.

alter table public.clientes           enable row level security;
alter table public.cliente_usuarios   enable row level security;
alter table public.wa_mensajes        enable row level security;
alter table public.wa_leads           enable row level security;
alter table public.wa_conversaciones  enable row level security;

-- Supabase le da permisos amplios por defecto a los roles del navegador.
-- Los sacamos y devolvemos solo lo necesario, columna por columna donde
-- corresponde.
revoke all on public.clientes           from anon, authenticated;
revoke all on public.cliente_usuarios   from anon, authenticated;
revoke all on public.wa_mensajes        from anon, authenticated;
revoke all on public.wa_leads           from anon, authenticated;
revoke all on public.wa_conversaciones  from anon, authenticated;

-- Contar es cosa del webhook, que usa la service role y no pasa por aca.
revoke all on function public.contar_conversaciones(uuid, text) from anon, authenticated;

grant select on public.clientes           to authenticated;
grant select on public.cliente_usuarios   to authenticated;
grant select on public.wa_mensajes        to authenticated;
grant select on public.wa_leads           to authenticated;
grant select on public.wa_conversaciones  to authenticated;

-- El panel solo puede marcar atendido y anotar. Nada de tocar los datos que
-- capturo el bot: si alguien edita el telefono de un lead, se rompe el vinculo
-- con su conversacion.
grant update (atendido, atendido_at, notas_internas) on public.wa_leads to authenticated;

drop policy if exists "ve sus clientes" on public.clientes;
create policy "ve sus clientes" on public.clientes
  for select to authenticated
  using (id in (select public.mis_clientes()));

drop policy if exists "ve sus vinculos" on public.cliente_usuarios;
create policy "ve sus vinculos" on public.cliente_usuarios
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "ve sus mensajes" on public.wa_mensajes;
create policy "ve sus mensajes" on public.wa_mensajes
  for select to authenticated
  using (cliente_id in (select public.mis_clientes()));

drop policy if exists "ve sus leads" on public.wa_leads;
create policy "ve sus leads" on public.wa_leads
  for select to authenticated
  using (cliente_id in (select public.mis_clientes()));

drop policy if exists "ve su consumo" on public.wa_conversaciones;
create policy "ve su consumo" on public.wa_conversaciones
  for select to authenticated
  using (cliente_id in (select public.mis_clientes()));

drop policy if exists "marca sus leads" on public.wa_leads;
create policy "marca sus leads" on public.wa_leads
  for update to authenticated
  using (cliente_id in (select public.mis_clientes()))
  with check (cliente_id in (select public.mis_clientes()));

-- ============================================================
-- 6) VISTA PARA EL PANEL
-- ============================================================
--
-- security_invoker hace que la vista respete las politicas de quien consulta.
-- Sin eso, una vista corre con permisos de su dueño y saltea RLS: cualquiera
-- logueado veria los leads de todos los clientes.

create or replace view public.v_leads
with (security_invoker = true) as
select
  l.*,
  (select count(*) from public.wa_mensajes m
    where m.cliente_id = l.cliente_id and m.telefono = l.telefono) as mensajes,
  (select max(m.created_at) from public.wa_mensajes m
    where m.cliente_id = l.cliente_id and m.telefono = l.telefono) as ultimo_mensaje
from public.wa_leads l;

grant select on public.v_leads to authenticated;

-- Consumo del periodo, para que el panel muestre cuanto va del plan.
create or replace view public.v_consumo
with (security_invoker = true) as
select
  cliente_id,
  periodo,
  count(*)::int as conversaciones,
  count(*) filter (where excedente)::int as excedentes,
  max(ultima_actividad) as ultima_actividad
from public.wa_conversaciones
group by cliente_id, periodo;

grant select on public.v_consumo to authenticated;
