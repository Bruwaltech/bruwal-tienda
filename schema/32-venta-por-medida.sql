-- ============================================================
--  BRUWAL — Venta fraccionada (por metro / por kilo).
--
--  Caso real: una ferretería compra un rollo de 50 metros de
--  manguera y vende 12,5 metros. Hasta ahora el stock era
--  INTEGER, así que "12,5" era imposible de guardar.
--
--  OJO: esta es la primera migración del proyecto que CAMBIA una
--  columna existente en vez de agregar una nueva. integer->numeric
--  es una conversión que ensancha el tipo: no pierde datos y los
--  valores que ya estaban cargados quedan idénticos (5 sigue
--  siendo 5). No hace falta tocar ninguna fila.
--
--  El NOTIFY del final NO es opcional: PostgREST cachea el tipo de
--  cada columna, y sin recargar el esquema sigue rechazando los
--  decimales como si la columna fuera integer.
--
--  Correr en Supabase -> SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es idempotente.
-- ============================================================

-- 1) Stock con decimales (38,5 metros / 0,25 kilos)
alter table public.store_products
  alter column stock type numeric;

alter table public.store_products
  alter column min_stock type numeric;

-- 2) En qué unidad se mide ese stock.
--    null = se vende por unidad, que es como funcionó siempre:
--    ninguna tienda existente cambia de comportamiento.
--    'metro' | 'kilo'
alter table public.store_products
  add column if not exists unidad_medida text;

NOTIFY pgrst, 'reload schema';

-- Verificación
select 'venta por medida lista' as estado,
       (select data_type from information_schema.columns
        where table_schema='public' and table_name='store_products' and column_name='stock') as tipo_stock,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_products' and column_name='unidad_medida') as columna_unidad;
