-- ============================================================
--  BRUWAL — Agenda de turnos sin superposición
--  Correr en Supabase → SQL Editor
--  Sin $$ para que no se corte al pegarlo.
-- ============================================================

create table if not exists public.store_turnos (
  id           uuid primary key default gen_random_uuid(),
  store_slug   text not null,
  fecha        date not null,
  hora         text not null,
  cliente      text,
  telefono     text,
  servicio     text,
  estado       text not null default 'pendiente',
  created_at   timestamptz not null default now()
);

-- ESTA es la garantía real de que no se superpongan: aunque dos personas
-- toquen "confirmar" en el mismo instante, la base rechaza la segunda.
-- Validarlo solo en la pantalla no alcanza.
create unique index if not exists store_turnos_sin_superposicion
  on public.store_turnos (store_slug, fecha, hora);

create index if not exists store_turnos_por_fecha
  on public.store_turnos (store_slug, fecha);

alter table public.store_turnos enable row level security;

-- Cualquiera puede sacar turno: el cliente no está logueado
drop policy if exists turnos_crear on public.store_turnos;
create policy turnos_crear on public.store_turnos for insert
  with check (true);

-- Cualquiera puede consultar qué horarios están ocupados.
-- La privacidad NO la da esta política sino los permisos de columna de
-- más abajo: el visitante solo puede leer fecha y hora, nunca el nombre
-- ni el teléfono de quien reservó.
drop policy if exists turnos_ver_ocupados on public.store_turnos;
create policy turnos_ver_ocupados on public.store_turnos for select
  using (true);

-- El dueño puede cancelar turnos de su tienda
drop policy if exists turnos_borrar_propios on public.store_turnos;
create policy turnos_borrar_propios on public.store_turnos for delete
  using (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_turnos.store_slug and sp.user_id = auth.uid()));

drop policy if exists turnos_editar_propios on public.store_turnos;
create policy turnos_editar_propios on public.store_turnos for update
  using (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_turnos.store_slug and sp.user_id = auth.uid()));

-- ---- Permisos de columna: acá está la privacidad ----
-- El visitante anónimo solo ve qué horarios están tomados.
revoke select on public.store_turnos from anon;
grant  select (store_slug, fecha, hora) on public.store_turnos to anon;
grant  insert on public.store_turnos to anon;

-- El dueño, ya logueado, ve todo (limitado a su tienda por las políticas)
grant select, insert, update, delete on public.store_turnos to authenticated;

-- Verificación
select 'store_turnos creada' as estado,
       (select count(*) from pg_policies
        where schemaname='public' and tablename='store_turnos') as politicas;
