-- ============================================================
--  BRUWAL — Más datos por reparación: marca, IMEI y tipo de servicio
--  Correr en Supabase → SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es aditivo e idempotente.
-- ============================================================

alter table public.store_reparaciones
  add column if not exists marca text,
  add column if not exists imei text,
  add column if not exists tipo_servicio jsonb not null default '[]'::jsonb;

-- tipo_servicio guarda una lista de strings, ej: ["Cambio de pantalla", "Batería"]
