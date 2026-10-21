-- ============================================================
--  BRUWAL — Envíos Flex: simulador y gestión de la mensajería
--  del corredor Rosario – San Lorenzo.
--
--  Por ahora es solo de Novalis. No es una pestaña "de Novalis"
--  a mano: va detrás de un flag por tienda, para poder darla a
--  otras tiendas más adelante sin reescribir nada.
--
--  1) store_profiles.features: los módulos opcionales de cada
--     tienda ({"envios_flex": true}). Lo pone SOLO el
--     administrador, desde acá. El dueño puede editar el resto de
--     su fila desde el navegador (sp_editar_propia), así que un
--     trigger le impide tocar esta columna, igual que con el plan.
--
--  2) flex_params / flex_vendedores / flex_repartidores /
--     flex_liquidaciones: cada fila la ve y la edita solo el dueño
--     de la tienda, Y solo si la tienda tiene el flag prendido. Sin
--     el flag, aunque alguien arme la consulta a mano, no ve nada.
--
--  3) Novalis: flag prendido y precargada como vendedora activa en
--     San Lorenzo.
--
--  Correr en Supabase -> SQL Editor. Aditivo e idempotente.
-- ============================================================


-- ------------------------------------------------------------
--  1) El flag por tienda
-- ------------------------------------------------------------
alter table public.store_profiles
  add column if not exists features jsonb not null default '{}'::jsonb;

comment on column public.store_profiles.features is
  'Módulos opcionales de la tienda, ej. {"envios_flex": true}. Lo pone solo el administrador: el navegador no lo puede cambiar (trigger proteger_features).';

-- Mismo criterio que proteger_campos_plan (ver 50-proteger-el-plan.sql):
-- el rol se mira por current_user Y por el JWT, porque al ser SECURITY
-- DEFINER current_user es el dueño de la función y no el del navegador.
create or replace function public.proteger_features()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  claims  text := nullif(current_setting('request.jwt.claims', true), '');
  rol_jwt text := '';
begin
  if claims is not null then
    begin
      rol_jwt := coalesce((claims::jsonb) ->> 'role', '');
    exception when others then
      rol_jwt := '';
    end;
  end if;

  if current_user not in ('authenticated', 'anon')
     and rol_jwt   not in ('authenticated', 'anon') then
    return new;   -- el servidor o una migración
  end if;

  if tg_op = 'UPDATE' then
    new.features := old.features;
  else
    new.features := '{}'::jsonb;
  end if;
  return new;
end;
$function$;

drop trigger if exists tr_proteger_features on public.store_profiles;
create trigger tr_proteger_features
  before insert or update on public.store_profiles
  for each row execute function public.proteger_features();

-- ¿El usuario logueado es dueño de esta tienda y la tienda tiene Envíos
-- Flex? SECURITY DEFINER para leer store_profiles sin depender de sus
-- políticas (y sin recursión). La fase 2 (otros vendedores, Bruno viendo
-- todo) se resuelve cambiando solo esta función.
create or replace function public.flex_habilitado(p_slug text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from store_profiles sp
     where sp.slug = p_slug
       and sp.user_id = auth.uid()
       and coalesce((sp.features ->> 'envios_flex')::boolean, false)
  );
$$;
revoke execute on function public.flex_habilitado(text) from public, anon;
grant execute on function public.flex_habilitado(text) to authenticated;


-- ------------------------------------------------------------
--  2) Tablas
-- ------------------------------------------------------------

-- Los supuestos del simulador. Un JSON y no columnas: son números que se
-- van a ir agregando a medida que el negocio se defina, y el panel ya
-- trae los valores por defecto para lo que falte.
create table if not exists public.flex_params (
  store_slug  text primary key references public.store_profiles(slug) on delete cascade,
  params      jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- Las 4 zonas del corredor, de sur a norte. localidad acepta 'otra' para
-- un vendedor fuera del corredor; la zona de un repartidor no.
create table if not exists public.flex_vendedores (
  id               uuid primary key default gen_random_uuid(),
  store_slug       text not null references public.store_profiles(slug) on delete cascade,
  nombre           text not null,
  localidad        text not null default 'rosario'
                   check (localidad in ('rosario', 'baigorria', 'bermudez', 'san_lorenzo', 'otra')),
  rubro            text,
  contacto         text,
  usa_flex         boolean not null default false,
  paq_dia_est      numeric(8,1) not null default 0 check (paq_dia_est >= 0),
  precio_acordado  numeric(12,2) check (precio_acordado >= 0),   -- null = el precio general
  estado           text not null default 'prospecto'
                   check (estado in ('prospecto', 'contactado', 'activo', 'descartado')),
  notas            text,
  created_at       timestamptz not null default now()
);

create index if not exists flex_vendedores_tienda on public.flex_vendedores (store_slug);

create table if not exists public.flex_repartidores (
  id              uuid primary key default gen_random_uuid(),
  store_slug      text not null references public.store_profiles(slug) on delete cascade,
  nombre          text not null,
  zona            text not null default 'rosario'
                  check (zona in ('rosario', 'baigorria', 'bermudez', 'san_lorenzo')),
  vehiculo        text not null default 'moto' check (vehiculo in ('auto', 'moto', 'utilitario')),
  telefono        text,
  alias_mp        text,   -- CVU o alias de Mercado Pago
  monotributo     text not null default 'no' check (monotributo in ('si', 'tramite', 'no')),
  estado          text not null default 'candidato' check (estado in ('candidato', 'activo', 'pausado')),
  pago_x_paquete  numeric(12,2) check (pago_x_paquete >= 0),   -- null = el pago general
  created_at      timestamptz not null default now()
);

create index if not exists flex_repartidores_tienda on public.flex_repartidores (store_slug);

-- Una fila por semana, por repartidor o vendedor. ref_id apunta a
-- flex_repartidores o flex_vendedores según `tipo`. El monto se guarda
-- calculado: si la semana que viene cambia el precio, lo ya liquidado no
-- se mueve.
create table if not exists public.flex_liquidaciones (
  id            uuid primary key default gen_random_uuid(),
  store_slug    text not null references public.store_profiles(slug) on delete cascade,
  semana_inicio date not null check (extract(isodow from semana_inicio) = 1),   -- siempre lunes
  tipo          text not null check (tipo in ('repartidor', 'vendedor')),
  ref_id        uuid not null,
  cantidad      integer not null default 0 check (cantidad >= 0),
  cruzados      integer not null default 0 check (cruzados >= 0),
  monto         numeric(12,2) not null default 0,
  factura_ok    boolean not null default false,   -- solo repartidor: recibimos su Factura C
  pagado_ok     boolean not null default false,   -- repartidor: le pagamos / vendedor: nos pagó
  updated_at    timestamptz not null default now()
);

create unique index if not exists flex_liquidaciones_unica
  on public.flex_liquidaciones (store_slug, semana_inicio, tipo, ref_id);


-- ------------------------------------------------------------
--  RLS: dueño de la tienda + flag prendido
-- ------------------------------------------------------------
alter table public.flex_params        enable row level security;
alter table public.flex_vendedores    enable row level security;
alter table public.flex_repartidores  enable row level security;
alter table public.flex_liquidaciones enable row level security;

drop policy if exists flex_params_propios on public.flex_params;
create policy flex_params_propios on public.flex_params for all to authenticated
  using (public.flex_habilitado(store_slug))
  with check (public.flex_habilitado(store_slug));

drop policy if exists flex_vendedores_propios on public.flex_vendedores;
create policy flex_vendedores_propios on public.flex_vendedores for all to authenticated
  using (public.flex_habilitado(store_slug))
  with check (public.flex_habilitado(store_slug));

drop policy if exists flex_repartidores_propios on public.flex_repartidores;
create policy flex_repartidores_propios on public.flex_repartidores for all to authenticated
  using (public.flex_habilitado(store_slug))
  with check (public.flex_habilitado(store_slug));

drop policy if exists flex_liquidaciones_propias on public.flex_liquidaciones;
create policy flex_liquidaciones_propias on public.flex_liquidaciones for all to authenticated
  using (public.flex_habilitado(store_slug))
  with check (public.flex_habilitado(store_slug));

-- anon no tiene nada que hacer acá.
revoke all on public.flex_params, public.flex_vendedores,
              public.flex_repartidores, public.flex_liquidaciones from anon;

NOTIFY pgrst, 'reload schema';


-- ------------------------------------------------------------
--  3) Novalis
-- ------------------------------------------------------------
update public.store_profiles
   set features = coalesce(features, '{}'::jsonb) || '{"envios_flex": true}'::jsonb
 where slug = 'novalis';

insert into public.flex_vendedores (store_slug, nombre, localidad, rubro, usa_flex, estado, notas)
select 'novalis', 'Novalis', 'san_lorenzo', 'Suplementos', true, 'activo',
       'Tienda propia. Flex ya activado en Mercado Libre.'
 where exists (select 1 from public.store_profiles where slug = 'novalis')
   and not exists (select 1 from public.flex_vendedores
                    where store_slug = 'novalis' and lower(nombre) = 'novalis');


-- Verificación: tienen que dar todos 1 (y tiendas_con_flex, solo Novalis).
select
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='store_profiles' and column_name='features') as col_features,
  (select count(*) from pg_trigger where tgname='tr_proteger_features')                     as trigger_features,
  (select count(*) from information_schema.tables
    where table_schema='public' and table_name='flex_liquidaciones')                         as tabla_liquidaciones,
  (select string_agg(slug, ', ') from public.store_profiles
    where coalesce((features ->> 'envios_flex')::boolean, false))                             as tiendas_con_flex;
