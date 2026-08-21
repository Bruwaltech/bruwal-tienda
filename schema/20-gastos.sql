-- ============================================================
--  BRUWAL — Gastos del negocio (impuestos, mercadería, publicidad...)
--  Correr en Supabase → SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es aditivo e idempotente.
-- ============================================================

create table if not exists public.store_gastos (
  id               uuid primary key default gen_random_uuid(),
  store_slug       text not null,
  concepto         text not null,
  categoria        text,                          -- Impuestos, Mercadería, Publicidad, Repuestos, Otro (o lo que escriba)
  monto            numeric not null default 0,     -- SIEMPRE en ARS (convertido si vino en USD/EUR) — mismo criterio que costo/precio en reparaciones
  moneda           text,                           -- 'USD' | 'EUR', null = se cargó directo en ARS
  monto_original   numeric,                        -- monto tal cual se tipeó, en "moneda"
  cotizacion       numeric,                        -- venta del blue/EUR usada al guardar (snapshot)
  fecha            date not null default current_date,
  notas            text,
  created_at       timestamptz not null default now()
);

create index if not exists store_gastos_por_tienda on public.store_gastos(store_slug);

alter table public.store_gastos enable row level security;

-- Igual que store_reparaciones: sin acceso público, solo el dueño de la tienda.
drop policy if exists gastos_propios on public.store_gastos;
create policy gastos_propios on public.store_gastos for all
  using (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_gastos.store_slug and sp.user_id = auth.uid()))
  with check (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_gastos.store_slug and sp.user_id = auth.uid()));

-- Verificación
select 'store_gastos creada' as estado,
       (select count(*) from pg_policies
        where schemaname='public' and tablename='store_gastos') as politicas;
