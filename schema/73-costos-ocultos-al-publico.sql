-- ============================================================
--  BRUWAL — El costo y el proveedor de los productos dejan de ser públicos.
--  Correr en Supabase → SQL Editor DESPUÉS de mergear el PR que cambia
--  tienda.html (si se corre antes, la tienda pública deja de cargar los
--  productos hasta que se suba el tienda.html nuevo).
--
--  Por qué: store_products se lee sin sesión (rol anon) para mostrar la
--  tienda, y la política de lectura es "true" con permiso sobre la tabla
--  entera. Con la clave pública que está en cualquier página, cualquiera
--  podía pedir /rest/v1/store_products?select=costo,proveedor_nombre,...
--  de TODAS las tiendas: costos, márgenes y teléfonos de proveedores.
--
--  Cómo: al rol anon se le saca el permiso sobre la tabla entera y se le
--  da columna por columna, todas menos las de costo y proveedor. El dueño
--  (rol authenticated) sigue viendo todo como hasta ahora.
--
--  OJO AL AGREGAR COLUMNAS: una columna nueva de store_products NO queda
--  visible para la tienda pública hasta darle el permiso:
--      grant select (columna_nueva) on public.store_products to anon;
--  y hay que sumarla a CAMPOS_PRODUCTO_PUBLICOS en tienda.html.
--  Volver a correr este archivo también la habilita (salvo que sea de costo
--  o proveedor). Es idempotente.
-- ============================================================

revoke select on public.store_products from anon;

do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'store_products'
     and column_name not in ('costo', 'costo_moneda', 'costo_original', 'costo_cotizacion',
                             'proveedor_nombre', 'proveedor_telefono', 'proveedor_email');
  execute format('grant select (%s) on public.store_products to anon', cols);
end $$;

NOTIFY pgrst, 'reload schema';

-- Verificación: las dos primeras tienen que dar false y la tercera true
select has_column_privilege('anon', 'public.store_products', 'costo', 'select') as anon_ve_costo,
       has_column_privilege('anon', 'public.store_products', 'proveedor_telefono', 'select') as anon_ve_proveedor,
       has_column_privilege('anon', 'public.store_products', 'price', 'select') as anon_ve_precio;
