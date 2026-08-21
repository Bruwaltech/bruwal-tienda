-- ============================================================
--  BRUWAL — Multi-moneda (ARS/USD/EUR) para repuestos/equipos de
--  electrónica, convertido a ARS con el dólar blue de dolarapi.com
--  Correr en Supabase → SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es aditivo e idempotente.
-- ============================================================

-- store_reparaciones: costo/precio siguen siendo el monto YA CONVERTIDO
-- a ARS (para no tocar ningún cálculo existente: Dashboard, margen,
-- avanzarReparacion() al insertar en orders, etc.). Estas columnas nuevas
-- son solo "memoria" de lo que se tipeó en el modal, para poder mostrarlo
-- de nuevo — quedan en null si la reparación se cargó en ARS (el caso de
-- siempre, y el único para rubros que no son electrónica).
alter table public.store_reparaciones
  add column if not exists costo_moneda      text,      -- 'USD' | 'EUR', null = ARS
  add column if not exists costo_original    numeric,   -- monto tal cual se tipeó, en costo_moneda
  add column if not exists costo_cotizacion  numeric,   -- venta del blue/EUR usada al guardar (snapshot)
  add column if not exists precio_moneda     text,
  add column if not exists precio_original   numeric,
  add column if not exists precio_cotizacion numeric;

-- store_products: mismo patrón — price sigue en ARS convertido.
alter table public.store_products
  add column if not exists moneda           text,      -- 'USD' | 'EUR', null = ARS
  add column if not exists precio_original  numeric,
  add column if not exists cotizacion       numeric;

-- Verificación
select 'multi-moneda agregada' as estado,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_reparaciones'
          and column_name in ('costo_moneda','costo_original','costo_cotizacion',
                               'precio_moneda','precio_original','precio_cotizacion')) as columnas_reparaciones,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_products'
          and column_name in ('moneda','precio_original','cotizacion')) as columnas_products;
