-- ============================================================
--  BRUWAL — Costo de producto en dólares (rubro electrónica).
--  El equipo se compra en USD y se vende en pesos: el costo en
--  USD queda fijo y, cuando el dueño cambia la cotización del
--  dólar en el panel, se recalcula lo que vale en pesos (el costo
--  y el precio de venta, manteniendo el margen).
--  Mismo patrón que store_reparaciones (19-multimoneda): "costo"
--  sigue siendo el monto en pesos que usan margen y estadísticas;
--  estas columnas son la memoria del monto en USD.
--  Correr en Supabase → SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es aditivo e idempotente.
-- ============================================================

alter table public.store_products
  add column if not exists costo_moneda      text,      -- 'USD', null = pesos
  add column if not exists costo_original    numeric,   -- costo tal cual se tipeó, en USD
  add column if not exists costo_cotizacion  numeric;   -- dólar usado para pasarlo a pesos

NOTIFY pgrst, 'reload schema';

-- Verificación
select 'costo en dólares agregado' as estado,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_products'
          and column_name in ('costo_moneda','costo_original','costo_cotizacion')) as columnas;
