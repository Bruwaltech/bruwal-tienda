-- ============================================================
--  BRUWAL — Fiado (cuenta corriente) y última carga de stock
--  Correr en Supabase → SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es aditivo e idempotente.
-- ============================================================

-- ---- Última carga de stock ----------------------------------
-- stock_ultima_carga: el TOTAL que quedó justo después de la última
-- reposición (no la cantidad que se sumó). Sirve de referencia fija
-- para comparar contra el stock actual sin hacer cuentas.
alter table public.store_products
  add column if not exists stock_ultima_carga int,
  add column if not exists fecha_ultima_carga timestamptz;

-- ---- Fiado -----------------------------------------------------
alter table public.orders
  add column if not exists saldo_pendiente numeric not null default 0;

create table if not exists public.store_pagos (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid references public.orders(id) on delete cascade,
  store_slug    text not null,
  customer_name text,
  monto         numeric not null,
  nota          text,
  created_at    timestamptz not null default now()
);

create index if not exists store_pagos_por_orden on public.store_pagos(order_id);
create index if not exists store_pagos_por_tienda on public.store_pagos(store_slug);

alter table public.store_pagos enable row level security;

-- A diferencia de store_turnos, acá NO hay acceso público: el fiado es
-- una decisión del vendedor, no algo que un comprador anónimo pueda
-- autoasignarse. Solo el dueño de la tienda lee y escribe.
drop policy if exists pagos_propios on public.store_pagos;
create policy pagos_propios on public.store_pagos for all
  using (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_pagos.store_slug and sp.user_id = auth.uid()))
  with check (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_pagos.store_slug and sp.user_id = auth.uid()));

-- Verificación
select 'store_pagos creada' as estado,
       (select count(*) from pg_policies
        where schemaname='public' and tablename='store_pagos') as politicas;
