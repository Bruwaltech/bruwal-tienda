-- ============================================================
--  BRUWAL — Repuestos usados en una reparación (descuenta stock)
--  Correr en Supabase → SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es aditivo e idempotente.
-- ============================================================

-- Forma esperada del jsonb: [{"product_id":"...","name":"Pantalla iPhone 11","qty":1}, ...]
-- Los repuestos SON productos normales de store_products (con su propio
-- stock, "+ Reponer", etc.) — no se duplica ahí un catálogo aparte.
alter table public.store_reparaciones
  add column if not exists repuestos jsonb not null default '[]'::jsonb;
