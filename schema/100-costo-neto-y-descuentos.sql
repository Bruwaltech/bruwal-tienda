-- ============================================================
--  BRUWAL — Costo neto + descuentos en la ficha del producto
--
--  Pedido de JACI (distribuidora): cargar el costo como viene en la
--  boleta del proveedor. Costo neto sin IVA, hasta 3 descuentos en
--  cascada y el IVA del artículo (alicuota_iva, schema/98). La cuenta
--  da el "costo final real", que se sigue guardando en `costo` (el que
--  usan el % de margen, Estadísticas y la valoración del stock).
--  Estas dos columnas solo guardan el detalle para volver a verlo.
--
--  Correr DESPUÉS de schema/98-iva-por-articulo.sql.
--  Correr en Supabase -> SQL Editor. Aditivo e idempotente.
-- ============================================================

alter table public.store_products
  add column if not exists costo_neto numeric;

alter table public.store_products
  add column if not exists costo_descuentos numeric[];

comment on column public.store_products.costo_neto is
  'Costo neto (sin IVA) de la boleta del proveedor. null = el costo se cargó directo.';
comment on column public.store_products.costo_descuentos is
  'Descuentos % en cascada sobre el costo neto, ej. {10,5}. null = sin descuentos.';
