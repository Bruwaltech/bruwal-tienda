-- Un producto en varias categorías a la vez.
--
-- Caso real: un combo de iluminación que tiene que aparecer en "Combos" Y en
-- "Iluminación". Hasta ahora `category` era un solo texto, así que ponerlo
-- en una lo sacaba de la otra.
--
-- POR QUÉ SE AGREGA UNA COLUMNA EN VEZ DE CONVERTIR `category` EN LISTA:
-- `category` la lee media aplicación — el buscador, el acomodador, el orden
-- de la vidriera, los vínculos de Mercado Libre, las estadísticas por rubro,
-- la tienda. Convertirla obligaría a tocar todo eso de una sola vez, y
-- cualquier lugar que se olvide deja de encontrar productos sin avisar.
--
-- Así, `category` sigue siendo LA categoría principal (la que ya funciona en
-- todos lados) y `categorias` suma las demás. Un producto que nunca se toca
-- se comporta exactamente igual que antes.

alter table public.store_products
  add column if not exists categorias jsonb not null default '[]'::jsonb;

comment on column public.store_products.categorias is
  'Categorías ADICIONALES del producto, además de category. La principal sigue siendo category; esta lista son las otras en las que también aparece.';

-- PostgREST cachea el esquema: sin esto la columna nueva no existe para la
-- API aunque esté creada en la base.
notify pgrst, 'reload schema';

-- Para comprobar que quedó:
select column_name, data_type, column_default
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'store_products'
   and column_name = 'categorias';
