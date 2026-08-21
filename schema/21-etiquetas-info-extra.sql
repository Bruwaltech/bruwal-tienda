-- ============================================================
--  BRUWAL — Más datos para las etiquetas térmicas: sucursal y estado
--  del equipo en reparaciones; IMEI, número interno y estado del
--  equipo en productos (equipos en stock para la venta).
--  Correr en Supabase → SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es aditivo e idempotente.
-- ============================================================

alter table public.store_reparaciones
  add column if not exists sucursal      text,   -- opcional, para negocios con más de un local
  add column if not exists estado_equipo text;    -- ej: "usado como nuevo", "batería 87%"

alter table public.store_products
  add column if not exists imei          text,    -- equipos en stock para vender (no confundir con el imei de una reparación)
  add column if not exists numero        integer, -- ID interno para la etiqueta ("P-0123"), mismo criterio que store_reparaciones.numero
  add column if not exists estado_equipo text;

-- Verificación
select 'etiquetas info extra agregada' as estado,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_reparaciones'
          and column_name in ('sucursal','estado_equipo')) as columnas_reparaciones,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_products'
          and column_name in ('imei','numero','estado_equipo')) as columnas_products;
