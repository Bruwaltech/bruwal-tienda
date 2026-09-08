-- ============================================================
--  BRUWAL — Precio en oferta.
--
--  El producto pasa a tener DOS precios: `price` sigue siendo el
--  de lista (el que se muestra tachado) y `precio_oferta` es lo
--  que realmente se cobra mientras la oferta esté puesta.
--
--  Se agrega una columna en vez de bajar `price` a secas por dos
--  motivos concretos:
--    · sin el precio viejo no hay tachado ni "12% OFF", que es
--      justo lo que hace que la oferta se lea como oferta;
--    · al sacar la oferta, el precio de lista vuelve solo — no
--      hay que acordarse de cuánto valía antes.
--
--  Vacía (null) = producto sin oferta, todo funciona como siempre.
--  El código ignora una oferta que no sea menor al precio de
--  lista, asi que un valor mal cargado no rompe nada: simplemente
--  no se aplica.
--
--  El NOTIFY del final NO es opcional: PostgREST cachea el
--  esquema y sin recargarlo rechaza la columna nueva como si no
--  existiera.
--
--  Correr en Supabase -> SQL Editor. Es idempotente.
-- ============================================================

alter table public.store_products
  add column if not exists precio_oferta numeric;

NOTIFY pgrst, 'reload schema';

-- Verificación
select 'oferta lista' as estado,
       (select count(*) from information_schema.columns
        where table_schema = 'public'
          and table_name  = 'store_products'
          and column_name = 'precio_oferta') as columna_precio_oferta;
