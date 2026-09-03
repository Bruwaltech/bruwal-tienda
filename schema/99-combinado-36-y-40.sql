-- ============================================================
--  BRUWAL — Combinado de lo que quedó pendiente de correr:
--    · 36-balanza.sql            (balanza etiquetadora)
--    · 40-empleados-fichadas.sql (empleados y control de horas)
--    · columnas que usa el importador de Excel (por si acaso)
--
--  Se puede correr entero de una vez, y se puede correr varias
--  veces: todo es aditivo e idempotente. Si algo ya estaba, no
--  hace nada y no falla.
--
--  Sin $$, para que no se corte al pegarlo en el SQL Editor.
--  Correr en Supabase → SQL Editor → Run.
-- ============================================================


-- ------------------------------------------------------------
--  0) ANTES: qué hay y qué falta. Mirá este resultado primero.
--     Cada columna dice 1 si ya existe y 0 si falta.
-- ------------------------------------------------------------
select
  'ANTES' as momento,
  (select count(*) from information_schema.tables
   where table_schema='public' and table_name='store_empleados')   as tabla_empleados,
  (select count(*) from information_schema.tables
   where table_schema='public' and table_name='store_fichadas')    as tabla_fichadas,
  (select count(*) from information_schema.columns
   where table_schema='public' and table_name='store_profiles' and column_name='balanza')      as col_balanza,
  (select count(*) from information_schema.columns
   where table_schema='public' and table_name='store_products' and column_name='plu_balanza')  as col_plu,
  (select count(*) from information_schema.columns
   where table_schema='public' and table_name='store_products' and column_name='costo')        as col_costo,
  (select count(*) from information_schema.columns
   where table_schema='public' and table_name='store_products' and column_name='solo_interno') as col_solo_interno;


-- ============================================================
--  BLOQUE A — EMPLEADOS Y FICHADAS  (era schema/40)
--
--  La "tarjeta" es simplemente un texto. Un lector NFC/RFID USB en modo
--  teclado tipea el número de la tarjeta y da Enter, igual que el lector
--  de códigos de barras que ya usa el panel. Así que acá entra lo mismo
--  venga de una tarjeta NFC, de un llavero RFID, de un QR impreso en el
--  carnet o tipeado a mano — al sistema le da igual.
-- ============================================================

create table if not exists public.store_empleados (
  id               uuid primary key default gen_random_uuid(),
  store_slug       text not null,
  nombre           text not null,
  rol              text,                           -- Peluquero, Cocinero, Cajero… lo que escriba el dueño
  tarjeta          text,                           -- UID de la tarjeta / QR / lo que tipee el lector
  valor_hora       numeric,                        -- SIEMPRE en ARS, mismo criterio que costo/precio en el resto
  activo           boolean not null default true,  -- se desactiva en vez de borrarse: las fichadas viejas siguen valiendo
  notas            text,
  created_at       timestamptz not null default now()
);

create index if not exists store_empleados_por_tienda on public.store_empleados(store_slug);

-- Dos empleados de la MISMA tienda no pueden compartir tarjeta: si pasara,
-- una marca no sabría de quién es. Entre tiendas distintas no molesta.
-- Es índice parcial porque la mayoría arranca sin tarjeta (null), y varios
-- nulls no chocan entre sí.
create unique index if not exists store_empleados_tarjeta_unica
  on public.store_empleados(store_slug, tarjeta)
  where tarjeta is not null;


create table if not exists public.store_fichadas (
  id               uuid primary key default gen_random_uuid(),
  store_slug       text not null,
  empleado_id      uuid not null references public.store_empleados(id) on delete cascade,
  tipo             text not null,                  -- 'entrada' | 'salida'
  momento          timestamptz not null default now(),
  origen           text,                           -- 'tarjeta' | 'pantalla' | 'manual'
  created_at       timestamptz not null default now()
);

create index if not exists store_fichadas_por_tienda on public.store_fichadas(store_slug);
create index if not exists store_fichadas_por_empleado on public.store_fichadas(empleado_id, momento);


alter table public.store_empleados enable row level security;
alter table public.store_fichadas  enable row level security;

-- Igual que store_gastos: sin acceso público, solo el dueño de la tienda.
drop policy if exists empleados_propios on public.store_empleados;
create policy empleados_propios on public.store_empleados for all
  using (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_empleados.store_slug and sp.user_id = auth.uid()))
  with check (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_empleados.store_slug and sp.user_id = auth.uid()));

drop policy if exists fichadas_propias on public.store_fichadas;
create policy fichadas_propias on public.store_fichadas for all
  using (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_fichadas.store_slug and sp.user_id = auth.uid()))
  with check (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_fichadas.store_slug and sp.user_id = auth.uid()));


-- ============================================================
--  BLOQUE B — BALANZA ETIQUETADORA  (era schema/36)
--
--  Son dos datos y no uno:
--   · store_profiles.balanza      -> cómo arma el código ESA balanza
--   · store_products.plu_balanza  -> con qué número está cargado cada
--     producto adentro de la balanza
-- ============================================================

-- Cómo arma el código de barras la balanza de esta tienda.
-- null = no usa balanza, que es como funcionó siempre.
-- { "formato": "20PPPPIIIII", "decimalesImporte": 2 }
alter table public.store_profiles
  add column if not exists balanza jsonb;

-- El código (PLU) con el que este producto está cargado en la balanza.
-- Va como text y no como integer a propósito: los ceros a la izquierda
-- son parte del código impreso ("0123").
alter table public.store_products
  add column if not exists plu_balanza text;

-- Buscar el producto por su PLU es lo que pasa en CADA escaneo de
-- etiqueta, con el vendedor esperando frente al cliente.
create index if not exists store_products_plu_balanza_idx
  on public.store_products (store_slug, plu_balanza);


-- ============================================================
--  BLOQUE C — COLUMNAS QUE ESCRIBE EL IMPORTADOR DE EXCEL
--
--  Estas ya deberían existir de las migraciones 18, 22 y 25. Van de
--  nuevo por seguridad: el importador escribe costo, proveedor y
--  solo_interno, y si alguna falta la importación entera falla con
--  "column does not exist". Si ya están, estas cuatro líneas no hacen
--  absolutamente nada.
-- ============================================================

alter table public.store_products
  add column if not exists costo               numeric,
  add column if not exists proveedor_nombre    text,
  add column if not exists proveedor_telefono  text,
  add column if not exists proveedor_email     text,
  add column if not exists solo_interno        boolean not null default false;


-- ------------------------------------------------------------
--  RECARGA DEL ESQUEMA — NO ES OPCIONAL.
--  PostgREST cachea las tablas y columnas: sin esto puede seguir
--  rechazando lo nuevo como si no existiera.
-- ------------------------------------------------------------
NOTIFY pgrst, 'reload schema';


-- ------------------------------------------------------------
--  DESPUÉS: tiene que dar 1 en todo, y 2 políticas.
-- ------------------------------------------------------------
select
  'DESPUES' as momento,
  (select count(*) from information_schema.tables
   where table_schema='public' and table_name='store_empleados')   as tabla_empleados,
  (select count(*) from information_schema.tables
   where table_schema='public' and table_name='store_fichadas')    as tabla_fichadas,
  (select count(*) from pg_policies
   where schemaname='public' and tablename in ('store_empleados','store_fichadas')) as politicas,
  (select count(*) from information_schema.columns
   where table_schema='public' and table_name='store_profiles' and column_name='balanza')      as col_balanza,
  (select count(*) from information_schema.columns
   where table_schema='public' and table_name='store_products' and column_name='plu_balanza')  as col_plu,
  (select count(*) from information_schema.columns
   where table_schema='public' and table_name='store_products' and column_name='costo')        as col_costo,
  (select count(*) from information_schema.columns
   where table_schema='public' and table_name='store_products' and column_name='solo_interno') as col_solo_interno;


-- ============================================================
--  APARTE — Ponerte el plan Pro a TU tienda para poder probar
--  Empleados y el reloj.
--
--  Está comentado a propósito: cambia el plan de una tienda real,
--  así que lo corrés a mano si querés. Reemplazá el slug por el de
--  tu tienda y sacale los guiones del principio.
--
--  update public.store_profiles set plan = 'cortesia' where slug = 'TU-SLUG';
--
--  Para ver qué tienda y qué plan tenés hoy:
--    select slug, business_name, plan, trial_ends_at from public.store_profiles order by created_at;
-- ============================================================
