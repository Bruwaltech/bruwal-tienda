-- ============================================================
--  BRUWAL — Duración propia por servicio (en minutos). Nula = usa la
--  duración general de turnos de la tienda (store.turnos.intervalo).
--  Correr en Supabase → SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es aditivo e idempotente.
-- ============================================================

alter table public.store_products
  add column if not exists duracion_minutos integer;

NOTIFY pgrst, 'reload schema';

-- Verificación
select 'duracion_minutos agregada' as estado,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_products' and column_name='duracion_minutos') as columna;
