-- ============================================================
--  BRUWAL — El equipo tomado en parte de pago puede cargarse listo
--  para vender o pendiente de restauración (pantalla, batería,
--  limpieza, etc. antes de poder publicarlo).
--  Correr en Supabase → SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es aditivo e idempotente.
-- ============================================================

alter table public.store_products
  add column if not exists pendiente_restauracion boolean not null default false;

-- Verificación
select 'pendiente_restauracion agregada' as estado,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_products'
          and column_name='pendiente_restauracion') as columna;
