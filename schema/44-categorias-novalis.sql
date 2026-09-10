-- ============================================================
--  BRUWAL — Categorías de los productos de Novalis
--
--  El código de tienda.html ya agrupa y filtra por categoría
--  perfectamente (buscá "categoriasDeLaTienda" si querés verlo);
--  lo que faltaba era el dato: la mayoría de los productos de
--  Novalis tenían category vacío o null, así que quedaban todos
--  mezclados en "También en la tienda".
--
--  Se actualiza por id, no por nombre, para no depender de que el
--  texto coincida exacto. Correr en Supabase → SQL Editor → Run.
--  Es idempotente: correrlo de nuevo dos veces da el mismo resultado.
-- ============================================================

-- ---------- Proteínas ----------------------------------------
update public.store_products set category = 'Proteínas'
where id = 'a18ad7f3-60a6-4041-b37b-36542ffdc14b'; -- Proteína Whey Protein Novalis 900g Sin Tacc

-- ---------- Combos ---------------------------------------------
update public.store_products set category = 'Combos'
where id in (
  'd248aff1-53cf-42db-a1e0-185b0488abc4', -- Combo Proteína Whey 907g + Creatina Monohidratada 250g
  '52c9dc4e-753d-4a6d-8a80-3eb2c13add84', -- Combo Fitness: Whey + Creatina + Bisglicinato de Mg Vainilla
  '41c0e7c2-13de-4fd7-9c24-81e9d51c4824', -- Combo Whey + Creatina + Shaker Vainilla
  '4826e281-b109-4254-85d8-bd1ff05c9c83', -- Combo Whey + Creatina + Shaker Chocolate
  '89ae3248-ceeb-48fa-bc3d-fda12330fc8c', -- Combo Whey + Shaker Vainilla
  'e61e2114-c5e6-4e82-b764-9798972dad85', -- Combo Whey + Shaker Chocolate
  '300e7a69-1b2c-491e-a782-d3f4bcbd9027'  -- Combo Creatina + Shaker
);

-- ---------- Creatina ---------------------------------------------
update public.store_products set category = 'Creatina'
where id in (
  '33dc7e3a-56d5-42e4-90f5-2e6de061b192', -- creatina novalis (ya la tenía, se deja igual)
  'b4250e67-5215-4634-ae25-6ef1d5b97a35'  -- Creatina Pack x2
);

-- ---------- Magnesio -----------------------------------------
update public.store_products set category = 'Magnesio'
where id = '3aa2e2f1-22e3-4d11-89a5-8227a3652586'; -- Bisciglinato (ya la tenía, se deja igual)

-- ---------- Accesorios -------------------------------------------
-- Los dos shakers sueltos (no van dentro de un combo): no encajan en
-- ninguna de las cuatro categorías de arriba, así que quedan en la suya.
update public.store_products set category = 'Accesorios'
where id in (
  'e093f933-ae77-461f-8ab0-d9ad28802a2d', -- vaso shaker
  'eeff1042-77a3-4420-b04b-c59f691dd25a'  -- Shaker Novalis Black Edition 600ml
);

NOTIFY pgrst, 'reload schema';

-- Verificación: cuántos productos quedaron en cada categoría
select category, count(*) as productos
from public.store_products
where store_slug = 'novalis' and solo_interno = false
group by category
order by category;
