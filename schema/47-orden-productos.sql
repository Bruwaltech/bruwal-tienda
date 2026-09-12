-- El orden en que el cliente ve los productos dentro de una categoría.
--
-- Hasta ahora salían como venían de la base (alfabético por nombre), así que
-- el vendedor no tenía forma de poner adelante lo que más le conviene
-- mostrar: lo que más margen deja, lo que está por vencer, la novedad.
-- En una vidriera de verdad eso lo decide el dueño; acá lo decidía el
-- abecedario.
--
-- null = "no lo ordené". Esos van DESPUÉS de los ordenados, alfabéticos
-- entre ellos. La diferencia con poner 0 importa: si los sin ordenar
-- arrancaran en 0 quedarían todos primeros, y ordenar tres productos
-- mandaría el resto del catálogo al frente sin que nadie lo pida.

alter table public.store_products
  add column if not exists orden integer;

comment on column public.store_products.orden is
  'Posición en la vidriera dentro de su categoría (1 = primero). null = sin ordenar, van al final por nombre.';

-- Buscar "los de esta tienda ordenados" es lo que hace la tienda en cada
-- carga. Sin índice, con catálogos grandes se nota.
create index if not exists store_products_orden_idx
  on public.store_products (store_slug, orden);

-- PostgREST cachea el esquema: sin esto la columna nueva no existe para la
-- API aunque esté creada en la base.
notify pgrst, 'reload schema';

-- Para comprobar que quedó:
select column_name, data_type
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'store_products'
   and column_name = 'orden';
