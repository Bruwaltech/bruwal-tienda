-- ============================================================
--  BRUWAL — Rubro elegido a mano, para pisar la detección automática
--  por palabras clave del nombre/descripción. Sirve para el caso real
--  (una tienda cuyo nombre no dice qué vende, como pasó con Wabi
--  Import) y para probar cómo se ve cada rubro sin reescribir el
--  nombre real de la tienda.
--  Correr en Supabase → SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es aditivo e idempotente.
-- ============================================================

-- null/'' = automático (detecta por palabras clave, como siempre).
-- 'indumentaria' | 'electronica' | 'comida' | 'bebidas' | 'otro'
alter table public.store_profiles
  add column if not exists rubro_manual text;

NOTIFY pgrst, 'reload schema';

-- Verificación
select 'rubro_manual agregado' as estado,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_profiles' and column_name='rubro_manual') as columna;
