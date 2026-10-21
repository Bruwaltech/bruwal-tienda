-- ============================================================
--  BRUWAL — Envíos Flex: cada envío guardado
--
--  Hasta ahora la pestaña Envíos Flex leía los envíos de Mercado
--  Libre en vivo (últimos 14 días, máximo 40) y no quedaba nada.
--  Con esta tabla cada envío Flex queda registrado, con su estado,
--  su zona del corredor y la fecha de entrega. Es la base del
--  despacho del día y de la liquidación por paquete real.
--
--  QUIÉN ESCRIBE: solo el servidor (service role), desde
--    - api/ml-webhook.js: tópicos `shipments` y `orders_v2`;
--    - api/mercadolibre.js, acción flex_envios: el botón
--      "Actualizar desde Mercado Libre" rellena los últimos 14 días.
--  El dueño de la tienda la lee, y puede editarla (la asignación a
--  un repartidor va a vivir acá), pero no insertar: un envío que no
--  vino de Mercado Libre no es un envío Flex.
--
--  Mismo criterio de acceso que 76-envios-flex.sql: dueño de la
--  tienda Y flag envios_flex prendido (flex_habilitado()).
--
--  Correr en Supabase -> SQL Editor. Aditivo e idempotente.
--  Además, en el DevCenter de Mercado Libre, en la aplicación,
--  tildar el tópico "shipments" en Notificaciones.
-- ============================================================

create table if not exists public.flex_envios (
  envio_id               text primary key,             -- id del envío en ML: único en todo ML
  store_slug             text not null references public.store_profiles(slug) on delete cascade,
  orden_id               text,
  estado                 text,                          -- status de ML: ready_to_ship, shipped, delivered, not_delivered, cancelled...
  subestado              text,
  fecha_venta            timestamptz,
  fecha_entrega          timestamptz,                   -- status_history.date_delivered
  ciudad                 text,
  zona                   text check (zona in ('rosario', 'baigorria', 'bermudez', 'san_lorenzo', 'otra')),
  cp                     text,
  direccion              text,                          -- para la hoja de ruta; solo la ve el dueño
  total_venta            numeric(12,2),
  productos              jsonb not null default '[]'::jsonb,
  costo_comprador        numeric(12,2),
  costo_vendedor         numeric(12,2),
  compensacion_vendedor  numeric(12,2),
  costo_bruto            numeric(12,2),
  creado_en              timestamptz not null default now(),
  actualizado_en         timestamptz not null default now()
);

create index if not exists flex_envios_tienda_venta   on public.flex_envios (store_slug, fecha_venta desc);
create index if not exists flex_envios_tienda_entrega on public.flex_envios (store_slug, fecha_entrega);

alter table public.flex_envios enable row level security;

drop policy if exists flex_envios_leer on public.flex_envios;
create policy flex_envios_leer on public.flex_envios for select to authenticated
  using (public.flex_habilitado(store_slug));

drop policy if exists flex_envios_editar on public.flex_envios;
create policy flex_envios_editar on public.flex_envios for update to authenticated
  using (public.flex_habilitado(store_slug))
  with check (public.flex_habilitado(store_slug));

revoke all on public.flex_envios from anon;
revoke insert, delete on public.flex_envios from authenticated;

NOTIFY pgrst, 'reload schema';


-- Verificación: tabla_envios = 1 y politicas = 2.
select
  (select count(*) from information_schema.tables
    where table_schema='public' and table_name='flex_envios')                  as tabla_envios,
  (select count(*) from pg_policies
    where schemaname='public' and tablename='flex_envios')                     as politicas;
