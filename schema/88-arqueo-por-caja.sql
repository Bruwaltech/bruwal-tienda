-- ============================================================
--  BRUWAL — Arqueo diario por caja (una por compu)
--
--  Para negocios con varios cajeros en varias compus (Distribuidora
--  JACI: 3 cajas). Cada compu tiene un nombre ("Caja 1", lo pone
--  Configuración y vive en ese navegador). Cada día cada caja:
--    1. abre con un fondo de cambio (por defecto $20.000),
--    2. si se queda sin cambio, carga un "ingreso de cambio",
--    3. cierra contando el efectivo: el panel calcula lo que tendría
--       que haber y anota la diferencia.
--
--  1. store_profiles.arqueo_por_caja / arqueo_fondo: el interruptor de
--     Configuración y el fondo con que arranca cada caja.
--  2. orders.caja y store_movimientos_caja.caja: de qué compu salió la
--     venta o el movimiento. null = como siempre (sin arqueo por caja).
--  3. store_arqueos: una fila por caja por día. Se puede agregar, leer y
--     cerrar (update), pero no borrar.
--
--  Nada de esto es público: 73-columnas-publicas.sql le da a anon solo
--  las columnas que nombra.
--
--  Correr en Supabase -> SQL Editor. Aditivo e idempotente.
-- ============================================================

alter table public.store_profiles
  add column if not exists arqueo_por_caja boolean not null default false;
alter table public.store_profiles
  add column if not exists arqueo_fondo numeric not null default 20000;

alter table public.orders
  add column if not exists caja text;
alter table public.store_movimientos_caja
  add column if not exists caja text;

create table if not exists public.store_arqueos (
  id                 uuid primary key default gen_random_uuid(),
  store_slug         text not null,
  caja               text not null,             -- el nombre de la compu
  fecha              date not null,             -- el día en Argentina
  fondo_inicial      numeric not null default 0,
  abierto_at         timestamptz not null default now(),
  cerrado_at         timestamptz,
  efectivo_esperado  numeric,                   -- lo que calculó el panel al cerrar
  efectivo_contado   numeric,                   -- lo que contó el cajero
  diferencia         numeric,                   -- contado - esperado
  notas              text,
  created_at         timestamptz not null default now(),
  unique (store_slug, caja, fecha)
);

create index if not exists store_arqueos_por_tienda on public.store_arqueos(store_slug, fecha desc);

alter table public.store_arqueos enable row level security;

drop policy if exists arqueos_agregar on public.store_arqueos;
create policy arqueos_agregar on public.store_arqueos
  for insert to authenticated
  with check (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_arqueos.store_slug
      and (sp.user_id = auth.uid() or public.equipo_es_miembro(sp.slug))));

drop policy if exists arqueos_leer on public.store_arqueos;
create policy arqueos_leer on public.store_arqueos
  for select to authenticated
  using (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_arqueos.store_slug
      and (sp.user_id = auth.uid() or public.equipo_es_miembro(sp.slug))));

-- Cerrar = update. Solo mientras esté abierta: una caja cerrada no se
-- vuelve a tocar desde el panel.
drop policy if exists arqueos_cerrar on public.store_arqueos;
create policy arqueos_cerrar on public.store_arqueos
  for update to authenticated
  using (cerrado_at is null and exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_arqueos.store_slug
      and (sp.user_id = auth.uid() or public.equipo_es_miembro(sp.slug))))
  -- Sin esto el using vale también para la fila nueva, y una fila con
  -- cerrado_at puesto nunca pasaría: no se podría cerrar ninguna caja.
  with check (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_arqueos.store_slug
      and (sp.user_id = auth.uid() or public.equipo_es_miembro(sp.slug))));

notify pgrst, 'reload schema';

-- Verificación
select 'arqueo por caja listo' as estado,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_profiles' and column_name in ('arqueo_por_caja','arqueo_fondo')) as cols_perfil,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='orders' and column_name='caja') as col_orders,
       (select count(*) from pg_policies
        where schemaname='public' and tablename='store_arqueos') as politicas;
