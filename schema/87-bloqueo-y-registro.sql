-- ============================================================
--  BRUWAL — Bloquear acciones sensibles con PIN + registro de intentos
--
--  1. store_profiles.bloquear_sensibles: el interruptor de
--     Configuración → "Bloquear acciones sensibles". Con el PIN puesto,
--     anular ventas, tocar la caja, cambiar precios o stock, borrar
--     productos/gastos, entrar a Configuración y editar el ticket piden
--     el PIN (o la huella) cada vez. Apagado = como siempre. Lo prende y
--     lo apaga el dueño desde el panel (no es un feature del admin).
--  2. store_registro_seguridad: cada vez que alguien intenta una de esas
--     acciones queda anotado (autorizado, PIN mal o cancelado), con el
--     nombre de la compu. Solo se puede agregar y leer: ni el panel ni
--     la API pueden borrar o cambiar una fila, así el que se equivocó
--     "a propósito" no puede limpiar el rastro.
--
--  La columna nueva no es pública: 73-columnas-publicas.sql le da a anon
--  solo las columnas que nombra.
--
--  Correr en Supabase -> SQL Editor. Aditivo e idempotente.
-- ============================================================

alter table public.store_profiles
  add column if not exists bloquear_sensibles boolean not null default false;

create table if not exists public.store_registro_seguridad (
  id          uuid primary key default gen_random_uuid(),
  store_slug  text not null,
  accion      text not null,                 -- "Anular venta", "Editar producto"…
  detalle     text,                          -- qué venta, qué producto, el monto
  resultado   text not null check (resultado in ('autorizado','pin_mal','cancelado')),
  equipo      text,                          -- el nombre que se le puso a esa compu
  created_at  timestamptz not null default now()
);

create index if not exists store_registro_seguridad_por_tienda
  on public.store_registro_seguridad(store_slug, created_at desc);

alter table public.store_registro_seguridad enable row level security;

-- El dueño (o un miembro activo del equipo) agrega y lee las de su tienda.
-- No hay política de update ni de delete: nadie las cambia desde afuera.
drop policy if exists registro_seguridad_agregar on public.store_registro_seguridad;
create policy registro_seguridad_agregar on public.store_registro_seguridad
  for insert to authenticated
  with check (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_registro_seguridad.store_slug
      and (sp.user_id = auth.uid() or public.equipo_es_miembro(sp.slug))));

drop policy if exists registro_seguridad_leer on public.store_registro_seguridad;
create policy registro_seguridad_leer on public.store_registro_seguridad
  for select to authenticated
  using (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_registro_seguridad.store_slug
      and (sp.user_id = auth.uid() or public.equipo_es_miembro(sp.slug))));

notify pgrst, 'reload schema';

-- Verificación
select 'bloqueo y registro listos' as estado,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_profiles' and column_name='bloquear_sensibles') as col_bloquear,
       (select count(*) from pg_policies
        where schemaname='public' and tablename='store_registro_seguridad') as politicas;
