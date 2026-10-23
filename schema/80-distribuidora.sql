-- ============================================================
--  BRUWAL — Distribuidora: ticket a gusto y combos en la caja
--
--  1. store_profiles.ticket: el diseño del ticket que arma cada
--     tienda en Configuración → Diseño del ticket (nombre, texto del
--     encabezado, pie, qué datos salen, ancho del papel). null = el
--     ticket de siempre.
--  2. store_products.combo_en_caja: un combo (producto con sus
--     partes cargadas) que se cobra solo cuando pasan sus partes por
--     Ventas. Lo usa el rubro Distribuidora.
--
--  Ninguna de las dos es pública: la tienda online no las lee, y
--  73-columnas-publicas.sql le da a anon solo la lista de columnas
--  que nombra, así que no hay que tocar nada más.
--
--  Correr en Supabase -> SQL Editor. Aditivo e idempotente.
-- ============================================================

alter table public.store_profiles
  add column if not exists ticket jsonb;

alter table public.store_products
  add column if not exists combo_en_caja boolean not null default false;

notify pgrst, 'reload schema';

-- Verificación
select 'distribuidora lista' as estado,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_profiles' and column_name='ticket') as col_ticket,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_products' and column_name='combo_en_caja') as col_combo_en_caja;
