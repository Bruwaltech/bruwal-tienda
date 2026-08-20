-- ============================================================
--  BRUWAL — Paleta de colores por tienda
--  Correr en Supabase → SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es aditivo e idempotente.
-- ============================================================

-- Sin esta columna (o con tema = null), la tienda se ve exactamente como
-- siempre: los colores de BRUWAL por defecto. Nada cambia para las tiendas
-- que ya están usando la plataforma hasta que el dueño elija una paleta.
alter table public.store_profiles
  add column if not exists tema jsonb;

-- Forma esperada del jsonb (se arma y se lee desde el panel, no hace falta
-- crear nada más acá):
--   { "tarjetas": "#F5EDE0", "texto": "#1A1A1A", "banner": "#E8DCC4",
--     "opacidadPortada": 35 }
