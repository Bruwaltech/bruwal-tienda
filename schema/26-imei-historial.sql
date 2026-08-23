-- ============================================================
--  BRUWAL — Historial real por IMEI: ingreso, venta, reparación,
--  buscable desde cualquier pantalla. Antes el IMEI era un campo de
--  texto suelto en productos y otro sin relación en reparaciones —
--  ahora ambos flujos escriben en la misma línea de tiempo por equipo.
--  Correr en Supabase → SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es aditivo e idempotente.
-- ============================================================

create table if not exists public.store_imei_eventos (
  id          uuid primary key default gen_random_uuid(),
  store_slug  text not null,
  imei        text not null,
  tipo        text not null check (tipo in ('ingreso','venta','reparacion','nota')),
  detalle     text,
  monto       numeric,
  fecha       timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index if not exists store_imei_eventos_por_imei on public.store_imei_eventos(store_slug, imei);

alter table public.store_imei_eventos enable row level security;

-- Mismo criterio que store_gastos: sin acceso público, solo el dueño de
-- la tienda lee y escribe sus propios eventos.
drop policy if exists imei_eventos_propios on public.store_imei_eventos;
create policy imei_eventos_propios on public.store_imei_eventos for all
  using (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_imei_eventos.store_slug and sp.user_id = auth.uid()))
  with check (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_imei_eventos.store_slug and sp.user_id = auth.uid()));

NOTIFY pgrst, 'reload schema';

-- Verificación
select 'store_imei_eventos creada' as estado,
       (select count(*) from pg_policies
        where schemaname='public' and tablename='store_imei_eventos') as politicas;
