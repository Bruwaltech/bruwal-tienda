-- ============================================================
--  BRUWAL — Caja: medio de pago en ventas, gastos y cobros de
--  fiado, más movimientos manuales (aportes, retiros) que no
--  vienen de una venta ni de un gasto.
--  Correr en Supabase → SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es aditivo e idempotente.
-- ============================================================

-- 'Efectivo' | 'Débito' | 'Crédito' | 'Transferencia' | 'Mercado Pago'
-- null = sin especificar (todo lo cargado antes de este cambio).
alter table public.orders
  add column if not exists medio_pago text;

alter table public.store_gastos
  add column if not exists medio_pago text;

alter table public.store_pagos
  add column if not exists medio_pago text;

create table if not exists public.store_movimientos_caja (
  id          uuid primary key default gen_random_uuid(),
  store_slug  text not null,
  tipo        text not null check (tipo in ('ingreso','egreso')),
  concepto    text not null,
  monto       numeric not null default 0,
  medio_pago  text,
  fecha       date not null default current_date,
  notas       text,
  created_at  timestamptz not null default now()
);

create index if not exists store_movimientos_caja_por_tienda on public.store_movimientos_caja(store_slug);

alter table public.store_movimientos_caja enable row level security;

-- Mismo criterio que store_gastos y store_pagos: sin acceso público,
-- solo el dueño de la tienda lee y escribe sus propios movimientos.
drop policy if exists movimientos_caja_propios on public.store_movimientos_caja;
create policy movimientos_caja_propios on public.store_movimientos_caja for all
  using (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_movimientos_caja.store_slug and sp.user_id = auth.uid()))
  with check (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_movimientos_caja.store_slug and sp.user_id = auth.uid()));

-- Verificación
select 'caja agregada' as estado,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='orders' and column_name='medio_pago') as col_orders,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_gastos' and column_name='medio_pago') as col_gastos,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_pagos' and column_name='medio_pago') as col_pagos,
       (select count(*) from pg_policies
        where schemaname='public' and tablename='store_movimientos_caja') as politicas;
