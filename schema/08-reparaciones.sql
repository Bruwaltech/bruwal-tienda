-- ============================================================
--  BRUWAL — Reparaciones (ficha de equipo con cotización y
--  seguimiento) y toma de equipo usado como parte de pago.
--  Correr en Supabase → SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es aditivo e idempotente.
-- ============================================================

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

-- ---- Toma de equipo usado como parte de pago (venta de mostrador) --------
-- Se guarda en el mismo pedido, no en una tabla aparte: es un descuento
-- sobre esa venta puntual, no una entidad propia con seguimiento.
alter table public.orders
  add column if not exists trade_in_descripcion text,
  add column if not exists trade_in_valor numeric;

-- Verificación
select 'store_reparaciones creada' as estado,
       (select count(*) from pg_policies
        where schemaname='public' and tablename='store_reparaciones') as politicas;
