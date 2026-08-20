-- ============================================================
--  BRUWAL — Quién atendió la venta de mostrador
--  Correr en Supabase → SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es aditivo e idempotente.
-- ============================================================

alter table public.orders
  add column if not exists vendedor text;
