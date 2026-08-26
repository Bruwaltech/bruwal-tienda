-- ============================================================
--  BRUWAL — Mostrar/ocultar el precio de un producto en la tienda pública.
--  Default true: ningún producto existente cambia de comportamiento.
--  Correr en Supabase → SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es aditivo e idempotente.
-- ============================================================

alter table public.store_products
  add column if not exists mostrar_precio boolean not null default true;

NOTIFY pgrst, 'reload schema';

-- Verificación
select 'mostrar_precio agregado a store_products' as estado,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_products' and column_name='mostrar_precio') as columna;
