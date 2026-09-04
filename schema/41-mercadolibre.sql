-- ============================================================
--  BRUWAL — Integración con Mercado Libre (etapa 1: conectar la
--  cuenta y preparar el terreno para vincular publicaciones).
--
--  Correr en Supabase → SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es aditivo e idempotente.
-- ============================================================


-- ------------------------------------------------------------
--  1) La cuenta de Mercado Libre de cada tienda.
--
--  ATENCIÓN con esta tabla: guarda los tokens de acceso a la cuenta
--  de ML del vendedor. Tiene RLS prendida y A PROPÓSITO NO TIENE
--  NINGUNA POLÍTICA — o sea que con la clave anon (la que usa el
--  navegador) no la puede leer nadie, ni siquiera el dueño de la
--  tienda. La única forma de tocarla es desde las funciones de
--  /api con la service role key, que salta RLS.
--
--  Si algún día hace falta mostrar algo de acá en el panel, se
--  agrega un endpoint que devuelva SOLO lo que no es secreto
--  (nickname, si está conectada, cuándo vence). Nunca una política
--  de lectura sobre esta tabla.
-- ------------------------------------------------------------
create table if not exists public.store_ml_cuenta (
  store_slug       text primary key references public.store_profiles(slug) on delete cascade,
  ml_user_id       text not null,
  nickname         text,
  access_token     text not null,
  refresh_token    text not null,
  expira_en        timestamptz not null,           -- el access token dura 6 horas
  conectado_en     timestamptz not null default now(),
  actualizado_en   timestamptz not null default now()
);

-- Una misma cuenta de Mercado Libre no puede estar conectada a dos
-- tiendas: las notificaciones de ML vienen identificadas por user_id,
-- así que si estuviera repetida no se sabría a qué tienda descontarle
-- el stock.
create unique index if not exists store_ml_cuenta_ml_user
  on public.store_ml_cuenta(ml_user_id);

alter table public.store_ml_cuenta enable row level security;


-- ------------------------------------------------------------
--  2) Qué publicación de ML es qué producto de BRUWAL.
--
--  Esto sí es catálogo, no secretos: el dueño lo lee y lo escribe
--  desde el panel como cualquier otra tabla suya.
--
--  ml_variation_id en null = publicación sin variantes. Cuando la
--  publicación tiene variantes (talle, color), el stock vive en la
--  variante y no en el ítem, así que cada una se vincula por
--  separado con el producto que le corresponde.
-- ------------------------------------------------------------
create table if not exists public.store_ml_vinculos (
  id               uuid primary key default gen_random_uuid(),
  store_slug       text not null references public.store_profiles(slug) on delete cascade,
  product_id       uuid not null references public.store_products(id) on delete cascade,
  ml_item_id       text not null,
  ml_variation_id  text,
  titulo_ml        text,                           -- copia del título, para mostrarlo sin pedirlo a ML
  creado_en        timestamptz not null default now()
);

-- Una publicación (o una variante) apunta a UN solo producto. El
-- coalesce es porque en Postgres dos nulls no chocan entre sí, y sin
-- eso la misma publicación sin variantes podría vincularse dos veces.
create unique index if not exists store_ml_vinculos_unico
  on public.store_ml_vinculos(store_slug, ml_item_id, coalesce(ml_variation_id, ''));

create index if not exists store_ml_vinculos_por_producto
  on public.store_ml_vinculos(product_id);

alter table public.store_ml_vinculos enable row level security;

drop policy if exists ml_vinculos_propios on public.store_ml_vinculos;
create policy ml_vinculos_propios on public.store_ml_vinculos for all
  using (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_ml_vinculos.store_slug and sp.user_id = auth.uid()))
  with check (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_ml_vinculos.store_slug and sp.user_id = auth.uid()));


-- ------------------------------------------------------------
--  3) Las ventas de Mercado Libre que ya procesamos.
--
--  Es la tabla que evita descontar el stock dos veces. Mercado Libre
--  reintenta las notificaciones y además avisa cada vez que la orden
--  cambia de estado, así que la MISMA venta llega muchas veces. La
--  clave primaria es el id de la orden en ML: la primera vez se
--  descuenta el stock y se marca acá; las siguientes solo actualizan
--  el estado.
-- ------------------------------------------------------------
create table if not exists public.store_ml_ordenes (
  ml_order_id      text primary key,
  store_slug       text not null references public.store_profiles(slug) on delete cascade,
  estado           text,                           -- 'paid', 'cancelled', lo que diga ML
  stock_descontado boolean not null default false,
  order_id         uuid,                           -- el pedido que se creó en orders, si se creó
  total            numeric,
  comprador        text,
  detalle          jsonb,                          -- lo que devolvió ML, para poder auditar
  creado_en        timestamptz not null default now(),
  actualizado_en   timestamptz not null default now()
);

create index if not exists store_ml_ordenes_por_tienda
  on public.store_ml_ordenes(store_slug, creado_en desc);

alter table public.store_ml_ordenes enable row level security;

drop policy if exists ml_ordenes_propias on public.store_ml_ordenes;
create policy ml_ordenes_propias on public.store_ml_ordenes for select
  using (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_ml_ordenes.store_slug and sp.user_id = auth.uid()));
-- Escribe solo el webhook, con service role. Por eso no hay política
-- de insert ni de update para el dueño.


-- Recarga del esquema: PostgREST cachea las tablas y sin esto puede
-- seguir diciendo que no existen.
NOTIFY pgrst, 'reload schema';


-- Verificación: las tres tablas en 1, y 3 políticas (vinculos: all,
-- ordenes: select... la de all cuenta como una).
select 'mercado libre listo' as estado,
       (select count(*) from information_schema.tables
        where table_schema='public' and table_name='store_ml_cuenta')   as tabla_cuenta,
       (select count(*) from information_schema.tables
        where table_schema='public' and table_name='store_ml_vinculos') as tabla_vinculos,
       (select count(*) from information_schema.tables
        where table_schema='public' and table_name='store_ml_ordenes')  as tabla_ordenes,
       (select count(*) from pg_policies
        where schemaname='public' and tablename='store_ml_cuenta')      as politicas_cuenta_debe_ser_0;
