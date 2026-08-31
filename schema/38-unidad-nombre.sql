-- ============================================================
--  BRUWAL — Como se cuenta un producto ("hoja", "tira", "sobre")
--  Correr en Supabase -> SQL Editor. Aditivo e idempotente.
--
--  Por que hace falta: una caja de 12 hojas de afeitar entra como stock
--  12, y el corte se lleva 1. Pero "1" a secas no dice nada: en la ficha
--  del servicio y en el panel de insumos queria leerse "1 hoja".
--
--  OJO: no confundir con unidad_medida. Esa define que el producto se
--  VENDE fraccionado (por metro, por kilo) y cambia como se cobra y como
--  se descuenta. Esta es solo el nombre con el que el negocio cuenta las
--  unidades enteras: no cambia ningun calculo, solo como se lee.
--
--  Se guarda en singular ("hoja"). El plural lo arma la pantalla.
--  null = se sigue leyendo "unidad" / "unidades", como hasta ahora.
-- ============================================================

alter table public.store_products
  add column if not exists unidad_nombre text;

NOTIFY pgrst, 'reload schema';

-- Verificacion
select 'unidad_nombre agregado' as estado,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_products'
          and column_name='unidad_nombre') as columna;
