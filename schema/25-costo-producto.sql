-- ============================================================
--  BRUWAL — Costo de producto, para calcular margen en Estadísticas.
--  Protegido con el mismo PIN que Gastos y Costo/Margen de reparaciones
--  (ver schema/22-pin-costos-proveedor.sql).
--  Correr en Supabase → SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es aditivo e idempotente.
-- ============================================================

alter table public.store_products
  add column if not exists costo numeric;

-- Sin esto, Postgrest puede seguir rechazando "costo" como columna
-- desconocida un rato después del ALTER — ya pasó dos veces (medio_pago
-- en orders y en store_gastos). Correrlo siempre evita ese susto.
NOTIFY pgrst, 'reload schema';

-- Verificación
select 'costo agregado a store_products' as estado,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_products' and column_name='costo') as columna;
