-- ============================================================
--  BRUWAL — Costo de envío fijo por tienda, para sumarlo solo
--  cuando el cliente elige "Envío a domicilio" en el checkout.
--  Default null (sin cargo): ninguna tienda existente cambia de
--  comportamiento hasta que lo cargue en Configuración.
--  Correr en Supabase → SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es aditivo e idempotente.
-- ============================================================

alter table public.store_profiles
  add column if not exists costo_envio numeric;

NOTIFY pgrst, 'reload schema';

-- Verificación
select 'costo_envio agregado a store_profiles' as estado,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_profiles' and column_name='costo_envio') as columna;
