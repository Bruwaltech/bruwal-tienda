-- ============================================================
--  BRUWAL — Fecha hasta la que un plan pago sigue activo después de
--  cancelarse. Null = no hay cancelación pendiente, el plan sigue
--  activo sin fecha límite (como hasta ahora).
--  Correr en Supabase → SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es aditivo e idempotente.
-- ============================================================

alter table public.store_profiles
  add column if not exists plan_vence date;

NOTIFY pgrst, 'reload schema';

-- Verificación
select 'plan_vence agregado' as estado,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_profiles' and column_name='plan_vence') as columna;
