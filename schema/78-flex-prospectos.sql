-- ============================================================
--  BRUWAL — Envíos Flex: Puerto San Martín y prospectos de ML
--
--  1) El corredor suma una quinta zona, Puerto General San Martín,
--     al norte de San Lorenzo. Entra en las tres tablas que
--     guardan zona o localidad.
--  2) flex_vendedores guarda de qué cuenta de Mercado Libre salió
--     un prospecto (botón "Buscar en Mercado Libre" de la pestaña
--     Vendedores), para no cargar dos veces al mismo vendedor.
--
--  Correr en Supabase -> SQL Editor. Aditivo e idempotente.
-- ============================================================

alter table public.flex_vendedores drop constraint if exists flex_vendedores_localidad_check;
alter table public.flex_vendedores add constraint flex_vendedores_localidad_check
  check (localidad in ('rosario', 'baigorria', 'bermudez', 'san_lorenzo', 'puerto_san_martin', 'otra'));

alter table public.flex_repartidores drop constraint if exists flex_repartidores_zona_check;
alter table public.flex_repartidores add constraint flex_repartidores_zona_check
  check (zona in ('rosario', 'baigorria', 'bermudez', 'san_lorenzo', 'puerto_san_martin'));

alter table public.flex_envios drop constraint if exists flex_envios_zona_check;
alter table public.flex_envios add constraint flex_envios_zona_check
  check (zona in ('rosario', 'baigorria', 'bermudez', 'san_lorenzo', 'puerto_san_martin', 'otra'));

alter table public.flex_vendedores add column if not exists ml_seller_id text;
alter table public.flex_vendedores add column if not exists ml_link text;

create unique index if not exists flex_vendedores_ml_unico
  on public.flex_vendedores (store_slug, ml_seller_id) where ml_seller_id is not null;


-- Verificación: tienen que dar 1 y 2.
select
  (select count(*) from pg_indexes where indexname = 'flex_vendedores_ml_unico') as indice_ml,
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='flex_vendedores'
      and column_name in ('ml_seller_id', 'ml_link'))                              as columnas_ml;
