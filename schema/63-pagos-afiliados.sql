-- ============================================================
--  BRUWAL — Cuándo cobra cada afiliado y qué se le pagó.
--
--  La comisión de un mes se paga el mes siguiente, el día que el
--  dueño arregló con cada afiliado (dia_pago, del 1 al 28 para
--  que exista en todos los meses). Así el afiliado ve en su panel
--  "lo de octubre lo cobrás el 10/11", igual que Mercado Pago le
--  dice al negocio cuándo tiene la plata disponible.
--
--  store_afiliado_pagos: un renglón por cada pago que el dueño
--  marca. Puede haber más de uno por mes: si un pedido de octubre
--  se confirma después de haber pagado octubre, se paga la
--  diferencia aparte. gasto_id es el gasto que se anotó en Caja,
--  para borrarlo junto con el pago si se deshace.
--
--  Necesita schema/60-afiliados.sql corrido antes.
--  Correr en Supabase -> SQL Editor. Aditivo e idempotente.
-- ============================================================

alter table public.store_afiliados
  add column if not exists dia_pago smallint not null default 10
  check (dia_pago between 1 and 28);

create table if not exists public.store_afiliado_pagos (
  id           uuid primary key default gen_random_uuid(),
  store_slug   text not null references public.store_profiles(slug) on delete cascade,
  afiliado_id  uuid not null references public.store_afiliados(id) on delete cascade,
  mes          text not null check (mes ~ '^\d{4}-\d{2}$'),
  monto        numeric(12,2) not null check (monto > 0),
  gasto_id     uuid,
  pagado_en    timestamptz not null default now()
);

create index if not exists store_afiliado_pagos_afiliado_idx
  on public.store_afiliado_pagos (afiliado_id, mes);

alter table public.store_afiliado_pagos enable row level security;

drop policy if exists afiliado_pagos_propios on public.store_afiliado_pagos;
create policy afiliado_pagos_propios on public.store_afiliado_pagos for all
  using (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_afiliado_pagos.store_slug and sp.user_id = auth.uid()))
  with check (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_afiliado_pagos.store_slug and sp.user_id = auth.uid()));

NOTIFY pgrst, 'reload schema';

-- Verificación: tienen que dar 1, 1 y 1
select
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='store_afiliados' and column_name='dia_pago') as col_dia_pago,
  (select count(*) from information_schema.tables
    where table_schema='public' and table_name='store_afiliado_pagos')                     as tabla_pagos,
  (select count(*) from pg_policies where policyname='afiliado_pagos_propios')              as politica;
