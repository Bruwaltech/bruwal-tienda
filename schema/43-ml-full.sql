-- ============================================================
--  BRUWAL — Distinguir las ventas por Mercado Envíos FULL.
--
--  Con Full las unidades están en el depósito de Mercado Libre,
--  no en el local. Si una venta de una publicación Full le
--  descuenta stock al producto de BRUWAL, el mostrador termina
--  creyendo que tiene menos de lo que tiene: esa unidad nunca
--  estuvo ahí.
--
--  Entonces: las ventas Full registran el ingreso y la comisión,
--  pero NO tocan el stock local.
--
--  Correr en Supabase → SQL Editor. Aditivo e idempotente.
-- ============================================================

-- Cómo se despacha esa publicación, tal como lo informa Mercado
-- Libre: 'fulfillment' (Full), 'cross_docking', 'drop_off',
-- 'self_service'... null = todavía no se leyó.
alter table public.store_ml_vinculos
  add column if not exists logistica text;

-- En la orden se guardan dos cosas que antes no se distinguían:
--
--  sin_vincular: alguna línea de la venta no tenía con qué
--  corresponderse acá. ESA es la que hay que mirar y arreglar a
--  mano, y es distinta de "no se descontó porque era Full".
--
--  logistica: 'fulfillment' si la venta salió del depósito de ML.
alter table public.store_ml_ordenes
  add column if not exists sin_vincular boolean not null default false,
  add column if not exists logistica    text;

NOTIFY pgrst, 'reload schema';

-- Verificación: las tres en 1.
select 'full listo' as estado,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_ml_vinculos' and column_name='logistica')    as vinculos_logistica,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_ml_ordenes' and column_name='sin_vincular')  as ordenes_sin_vincular,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_ml_ordenes' and column_name='logistica')     as ordenes_logistica;
