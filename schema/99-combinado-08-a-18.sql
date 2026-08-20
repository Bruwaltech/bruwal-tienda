-- ============================================================
--  BRUWAL — Script combinado: migraciones 08, 10 a 18
--  (la 09 -tema de color- ya la corriste, por eso no está acá)
--
--  Correr UNA sola vez en Supabase → SQL Editor → pegar todo →
--  Run. Es aditivo e idempotente: si por error lo corrés dos
--  veces, no rompe nada ni duplica columnas.
-- ============================================================


-- ---------------------------------------------------------------
-- 08 — Reparaciones (ficha de equipo) + toma de equipo usado
-- ---------------------------------------------------------------

create table if not exists public.store_reparaciones (
  id               uuid primary key default gen_random_uuid(),
  store_slug       text not null,
  cliente_nombre   text not null,
  cliente_telefono text,
  equipo           text not null,          -- ej: "iPhone 11 128GB"
  problema         text,                   -- diagnóstico / falla reportada
  costo            numeric not null default 0,   -- lo que le cuesta al vendedor (repuesto, etc.)
  precio           numeric not null default 0,   -- lo que le cobra al cliente
  estado           text not null default 'recibido'
                     check (estado in ('recibido', 'en_reparacion', 'listo', 'entregado')),
  notas            text,
  fecha_recibido   timestamptz not null default now(),
  fecha_entregado  timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists store_reparaciones_por_tienda on public.store_reparaciones(store_slug);

alter table public.store_reparaciones enable row level security;

-- Igual que store_pagos: sin acceso público, solo el dueño de la tienda.
drop policy if exists reparaciones_propias on public.store_reparaciones;
create policy reparaciones_propias on public.store_reparaciones for all
  using (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_reparaciones.store_slug and sp.user_id = auth.uid()))
  with check (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_reparaciones.store_slug and sp.user_id = auth.uid()));

-- Toma de equipo usado como parte de pago (venta de mostrador): se guarda
-- en el mismo pedido, no en una tabla aparte.
alter table public.orders
  add column if not exists trade_in_descripcion text,
  add column if not exists trade_in_valor numeric;


-- ---------------------------------------------------------------
-- 10 — "¿Hacés reparaciones?" al registrarse
-- ---------------------------------------------------------------

-- Además de detectar el rubro por palabras clave (celular/electrónica en
-- el nombre o la descripción), esta columna deja prender Reparaciones a
-- mano: la tilda el dueño al registrarse (o después, en Configuración).
alter table public.store_profiles
  add column if not exists hace_reparaciones boolean not null default false;


-- ---------------------------------------------------------------
-- 11 — Quién atendió la venta de mostrador
-- ---------------------------------------------------------------

alter table public.orders
  add column if not exists vendedor text;


-- ---------------------------------------------------------------
-- 12 — Características técnicas por producto (batería, almacenamiento,
--       RAM, estado, etc.)
-- ---------------------------------------------------------------

-- Forma esperada del jsonb: [{"clave":"Batería","valor":"87%"}, ...]
-- A propósito NO son variantes (no llevan stock propio): la batería de un
-- celular usado es un dato del equipo puntual, no una combinación que se
-- vende por separado.
alter table public.store_products
  add column if not exists specs jsonb not null default '[]'::jsonb;


-- ---------------------------------------------------------------
-- 13 — Más datos por reparación: marca, IMEI y tipo de servicio
-- ---------------------------------------------------------------

alter table public.store_reparaciones
  add column if not exists marca text,
  add column if not exists imei text,
  add column if not exists tipo_servicio jsonb not null default '[]'::jsonb;

-- tipo_servicio guarda una lista de strings, ej: ["Cambio de pantalla", "Batería"]


-- ---------------------------------------------------------------
-- 14 — Número de ticket por reparación (para la etiqueta que se le
--       pega al equipo)
-- ---------------------------------------------------------------

alter table public.store_reparaciones
  add column if not exists numero integer;


-- ---------------------------------------------------------------
-- 15 — El ingreso de una reparación entregada cuenta como venta
-- ---------------------------------------------------------------

-- Referencia opcional: de qué reparación salió ese pedido, para poder
-- cruzarlos después. No lleva "on delete cascade": si se borra la ficha
-- de reparación, el pedido (la plata que ya entró) queda igual.
alter table public.orders
  add column if not exists reparacion_id uuid references public.store_reparaciones(id) on delete set null;


-- ---------------------------------------------------------------
-- 16 — Código/patrón de desbloqueo del equipo en reparación
-- ---------------------------------------------------------------

alter table public.store_reparaciones
  add column if not exists codigo_desbloqueo text;

-- A propósito NO se imprime en la etiqueta: la etiqueta queda pegada al
-- equipo físico, así que mostrar ahí la clave sería dejarla a la vista de
-- cualquiera que tenga el teléfono en la mano. Solo se ve adentro del
-- panel, protegido por las mismas políticas de store_reparaciones (sin
-- acceso público, solo el dueño de la tienda).


-- ---------------------------------------------------------------
-- 17 — Repuestos usados en una reparación (descuenta stock)
-- ---------------------------------------------------------------

-- Forma esperada del jsonb: [{"product_id":"...","name":"Pantalla iPhone 11","qty":1}, ...]
-- Los repuestos SON productos normales de store_products (con su propio
-- stock, "+ Reponer", etc.) — no se duplica ahí un catálogo aparte.
alter table public.store_reparaciones
  add column if not exists repuestos jsonb not null default '[]'::jsonb;


-- ---------------------------------------------------------------
-- 18 — Productos de uso interno (repuestos), no se venden en la
--       tienda pública
-- ---------------------------------------------------------------

-- false por defecto: ningún producto existente cambia de comportamiento.
-- true = nunca aparece en tienda.html, solo se usa desde el panel (por
-- ejemplo, como repuesto en una reparación).
alter table public.store_products
  add column if not exists solo_interno boolean not null default false;


-- ---------------------------------------------------------------
-- Verificación final: si esto corrió bien, tiene que devolver una
-- fila con "store_reparaciones creada" y políticas = 1.
-- ---------------------------------------------------------------
select 'store_reparaciones creada' as estado,
       (select count(*) from pg_policies
        where schemaname='public' and tablename='store_reparaciones') as politicas;
