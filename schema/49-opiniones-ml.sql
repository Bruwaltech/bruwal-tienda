-- Las opiniones de Mercado Libre, guardadas acá para que la tienda las
-- muestre sin depender de ML.
--
-- POR QUÉ SE GUARDAN Y NO SE PIDEN EN VIVO:
-- la tienda pública no tiene el token del vendedor (vive del lado del
-- servidor), y pedirle a Mercado Libre una llamada por producto en cada
-- visita sería lento y se comería el límite de la API. Igual que el stock
-- cruzado: se saca una foto cada tanto y la tienda lee el dato ya guardado.

alter table public.store_products
  add column if not exists ml_nota          numeric(2,1),
  add column if not exists ml_opiniones     integer,
  add column if not exists ml_link          text,
  add column if not exists ml_es_catalogo   boolean,
  add column if not exists ml_opiniones_al  timestamptz;

comment on column public.store_products.ml_nota is
  'Nota promedio de la publicación en Mercado Libre (1 a 5). null = sin opiniones o sin publicación vinculada.';
comment on column public.store_products.ml_opiniones is
  'Cuántas opiniones tiene esa publicación.';
comment on column public.store_products.ml_link is
  'permalink de la publicación, para mandar al cliente a leerlas.';
comment on column public.store_products.ml_es_catalogo is
  'true = la publicación va por catálogo, así que las opiniones son DEL PRODUCTO y pueden ser de compras a otros vendedores. La tienda lo aclara.';
comment on column public.store_products.ml_opiniones_al is
  'Cuándo se tomó la foto. Sirve para no repetirla todos los minutos y para avisar si quedó vieja.';

-- La reputación del vendedor es del NEGOCIO, no de un producto: cuántas
-- ventas hizo y qué porcentaje salió bien. Es lo más cercano a "cómo
-- atiende" que Mercado Libre puede decir, y va una sola vez por tienda.
alter table public.store_profiles
  add column if not exists ml_reputacion jsonb;

comment on column public.store_profiles.ml_reputacion is
  'Reputación del vendedor en Mercado Libre: {ventas, positivas, nivel, al}. null = nunca se leyó.';

-- PostgREST cachea el esquema: sin esto las columnas nuevas no existen para
-- la API aunque estén creadas en la base.
notify pgrst, 'reload schema';

-- Para comprobar que quedó (tienen que salir 6 filas):
select table_name, column_name
  from information_schema.columns
 where table_schema = 'public'
   and column_name in ('ml_nota','ml_opiniones','ml_link','ml_es_catalogo','ml_opiniones_al','ml_reputacion')
 order by table_name, column_name;
