-- ============================================================
--  BRUWAL — Insumos de un servicio: qué descuenta del stock cada
--  vez que se vende.
--
--  Caso real (peluquería): un corte con barba gasta 1 hoja de
--  afeitar y 1 tira de las que van al cuello. El rollo trae 100
--  tiras, así que se carga como un producto con stock 100 y cada
--  servicio descuenta 1. Una hoja puede rendir dos cortes: ahí la
--  cantidad es 0,5 (el stock es numeric desde
--  schema/32-venta-por-medida.sql, así que admite decimales).
--
--  Formato: [{ "producto_id": "uuid", "cantidad": 1 }]
--  Vacío = el servicio no descuenta nada, que es como venía
--  funcionando todo hasta ahora.
--
--  Es jsonb y no una tabla aparte por lo mismo que variantes y
--  specs: se lee y se escribe siempre junto con el producto, nunca
--  por separado, y así no hace falta un join ni una migración de
--  datos.
--
--  Correr en Supabase -> SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es aditivo e idempotente.
-- ============================================================

alter table public.store_products
  add column if not exists insumos jsonb not null default '[]'::jsonb;

NOTIFY pgrst, 'reload schema';

-- Verificación
select 'insumos lista en store_products' as estado,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_products' and column_name='insumos') as columna;
