-- ============================================================
--  BRUWAL — IVA por artículo (tique fiscal en la Hasar)
--
--  La caja de la distribuidora manda cada venta a la impresora fiscal
--  Hasar, que discrimina el IVA. Casi todo es 21%, pero JACI vende
--  harinas y legumbres al 10,5% (el cierre Z del 02/11 muestra IVA 10,5%).
--  null = 21%.
--
--  Correr en Supabase -> SQL Editor. Aditivo e idempotente.
-- ============================================================

alter table public.store_products
  add column if not exists alicuota_iva numeric;

comment on column public.store_products.alicuota_iva is
  'IVA del artículo para el tique fiscal (21, 10.5, 27, 0 = exento). null = 21.';

-- JACI: los 22 artículos que su sistema viejo (ARTICU.DBF, campo IMPUESTO)
-- tiene al 10,5%. Por código de barras y, los que no tienen, por nombre.
update public.store_products
   set alicuota_iva = 10.5
 where store_slug = 'distribuidora-jaci'
   and (ean in ('7790070562180', '7790681000316', '7790681000330', '7790681000286', '7790681000354', '7790681000378', '7790681000361', '7790681002037', '7792180004871', '7792180140708', '7792180004567', '7792350004595', '7790070507921', '7798049540382', '7792180139320', '7798049540368', '7792180134516', '7792180136671', '7792180134509', '7792180141095')
        or upper(trim(name)) in ('HARINA BLANCAFLOR LEUDANTEX1KG X15U', 'HARINA PUREZA 0000 X10K'));
