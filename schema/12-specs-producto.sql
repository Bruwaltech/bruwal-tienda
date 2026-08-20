-- ============================================================
--  BRUWAL — Características técnicas por producto (batería,
--  almacenamiento, RAM, estado, etc.)
--  Correr en Supabase → SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es aditivo e idempotente.
-- ============================================================

-- Forma esperada del jsonb: [{"clave":"Batería","valor":"87%"}, ...]
-- A propósito NO son variantes (no llevan stock propio): la batería de un
-- celular usado es un dato del equipo puntual, no una combinación que se
-- vende por separado.
alter table public.store_products
  add column if not exists specs jsonb not null default '[]'::jsonb;
