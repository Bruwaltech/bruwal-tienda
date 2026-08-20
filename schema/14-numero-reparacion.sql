-- ============================================================
--  BRUWAL — Número de ticket por reparación (para la etiqueta
--  que se le pega al equipo)
--  Correr en Supabase → SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es aditivo e idempotente.
-- ============================================================

alter table public.store_reparaciones
  add column if not exists numero integer;
