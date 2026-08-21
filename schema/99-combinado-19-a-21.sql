-- ============================================================
--  BRUWAL — Script combinado: migraciones 19, 20 y 21
--  (multi-moneda, gastos, etiquetas con más info)
--
--  Correr UNA sola vez en Supabase → SQL Editor → pegar todo →
--  Run. Es aditivo e idempotente: si por error lo corrés dos
--  veces, no rompe nada ni duplica columnas.
-- ============================================================


-- ---------------------------------------------------------------
-- 19 — Multi-moneda (ARS/USD/EUR) para repuestos/equipos de
--       electrónica, convertido a ARS con el dólar blue
-- ---------------------------------------------------------------

alter table public.store_reparaciones
  add column if not exists costo_moneda      text,
  add column if not exists costo_original    numeric,
  add column if not exists costo_cotizacion  numeric,
  add column if not exists precio_moneda     text,
  add column if not exists precio_original   numeric,
  add column if not exists precio_cotizacion numeric;

alter table public.store_products
  add column if not exists moneda           text,
  add column if not exists precio_original  numeric,
  add column if not exists cotizacion       numeric;


-- ---------------------------------------------------------------
-- 20 — Gastos del negocio (impuestos, mercadería, publicidad...)
-- ---------------------------------------------------------------

create table if not exists public.store_gastos (
  id               uuid primary key default gen_random_uuid(),
  store_slug       text not null,
  concepto         text not null,
  categoria        text,
  monto            numeric not null default 0,
  moneda           text,
  monto_original   numeric,
  cotizacion       numeric,
  fecha            date not null default current_date,
  notas            text,
  created_at       timestamptz not null default now()
);

create index if not exists store_gastos_por_tienda on public.store_gastos(store_slug);

alter table public.store_gastos enable row level security;

drop policy if exists gastos_propios on public.store_gastos;
create policy gastos_propios on public.store_gastos for all
  using (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_gastos.store_slug and sp.user_id = auth.uid()))
  with check (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_gastos.store_slug and sp.user_id = auth.uid()));


-- ---------------------------------------------------------------
-- 21 — Más datos para las etiquetas: sucursal y estado del equipo
--       en reparaciones; IMEI, número interno y estado del equipo
--       en productos
-- ---------------------------------------------------------------

alter table public.store_reparaciones
  add column if not exists sucursal      text,
  add column if not exists estado_equipo text;

alter table public.store_products
  add column if not exists imei          text,
  add column if not exists numero        integer,
  add column if not exists estado_equipo text;


-- ---------------------------------------------------------------
-- Verificación final: si esto corrió bien, tiene que devolver una
-- fila con "store_gastos creada" y políticas = 1.
-- ---------------------------------------------------------------
select 'store_gastos creada' as estado,
       (select count(*) from pg_policies
        where schemaname='public' and tablename='store_gastos') as politicas;
