-- 56 — Usuarios del equipo: cada empleado entra con SU usuario y contraseña.
--
-- Hasta ahora el panel tenia un solo login (el del dueño) y el "vendedor" era
-- un texto. Una cadena de comida necesita que cada cajero entre con lo suyo:
-- que quede quien vendio, y que el cajero no vea la caja ni toque precios.
--
-- REGLA DE ESTA MIGRACION: es 100% aditiva. No se modifica ni se borra
-- ninguna politica existente del dueño. Las politicas de Postgres del mismo
-- comando se suman con OR, asi que agregar "equipo_*" solo ABRE acceso a los
-- miembros; lo que el dueño ya podia hacer queda exactamente igual.
--
-- Las cuentas (auth.users) NO se crean desde el navegador: las crea la Edge
-- Function `equipo` con la service role, despues de verificar que quien pide
-- es el dueño de la tienda. Por eso esta tabla no tiene politica de INSERT ni
-- de DELETE para usuarios comunes.

-- ---------------------------------------------------------------------------
-- 1) La tabla
-- ---------------------------------------------------------------------------
create table if not exists public.store_miembros (
  id           uuid primary key default gen_random_uuid(),
  store_slug   text not null references public.store_profiles(slug) on update cascade on delete cascade,
  user_id      uuid not null unique references auth.users(id) on delete cascade,
  empleado_id  uuid references public.store_empleados(id) on delete set null,
  usuario      text not null check (usuario ~ '^[a-z0-9][a-z0-9._-]{1,29}$'),
  nombre       text not null check (length(trim(nombre)) between 1 and 60),
  rol          text not null default 'cajero'
               check (rol in ('encargado', 'cajero', 'cocina', 'personalizado')),
  permisos     jsonb not null default '{}'::jsonb check (jsonb_typeof(permisos) = 'object'),
  activo       boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (store_slug, usuario)
);

create index if not exists store_miembros_store_slug_idx on public.store_miembros (store_slug);

alter table public.store_miembros enable row level security;

-- ---------------------------------------------------------------------------
-- 2) ¿Puede este usuario hacer X en esta tienda?
--    SECURITY DEFINER para poder leer store_miembros desde adentro de las
--    politicas de otras tablas sin depender de las politicas de esta.
--    Solo tiendas Pro o cortesia: los usuarios del equipo son parte de Pro,
--    igual que la solapa Empleados (ver tienePlanPro() en el panel).
--    El permiso se compara contra el jsonb 'true' y no con un cast a boolean:
--    un valor raro guardado a mano daria error de cast y tiraria la politica.
-- ---------------------------------------------------------------------------
create or replace function public.equipo_puede(p_slug text, p_permiso text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from store_miembros m
      join store_profiles sp on sp.slug = m.store_slug
     where m.user_id    = auth.uid()
       and m.store_slug = p_slug
       and m.activo
       and sp.plan in ('pro', 'cortesia')
       and (m.permisos -> p_permiso) = 'true'::jsonb
  );
$$;

create or replace function public.equipo_puede_alguno(p_slug text, p_permisos text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from store_miembros m
      join store_profiles sp on sp.slug = m.store_slug
     where m.user_id    = auth.uid()
       and m.store_slug = p_slug
       and m.activo
       and sp.plan in ('pro', 'cortesia')
       and exists (select 1 from unnest(p_permisos) x where (m.permisos -> x) = 'true'::jsonb)
  );
$$;

-- ---------------------------------------------------------------------------
-- 3) Politicas de la tabla nueva
-- ---------------------------------------------------------------------------
-- El dueño ve a su equipo y puede cambiarle nombre, rol y permisos.
create policy equipo_miembros_dueno_ver on public.store_miembros
  for select using (exists (select 1 from public.store_profiles sp
                             where sp.slug = store_miembros.store_slug and sp.user_id = auth.uid()));

create policy equipo_miembros_dueno_editar on public.store_miembros
  for update using (exists (select 1 from public.store_profiles sp
                             where sp.slug = store_miembros.store_slug and sp.user_id = auth.uid()))
  with check (exists (select 1 from public.store_profiles sp
                       where sp.slug = store_miembros.store_slug and sp.user_id = auth.uid()));

-- Cada miembro ve su propia fila (asi el panel sabe a que tienda entra y que
-- puede hacer).
create policy equipo_miembros_yo on public.store_miembros
  for select using (user_id = auth.uid());

-- Desde el navegador solo se pueden cambiar estas tres columnas. user_id,
-- store_slug y activo los maneja la Edge Function (activo va junto con el
-- bloqueo de la cuenta; si se tocara solo aca quedarian desparejos).
revoke insert, update, delete on public.store_miembros from anon, authenticated;
grant select on public.store_miembros to authenticated;
grant update (nombre, rol, permisos) on public.store_miembros to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Acceso del equipo a las tablas que ya existen (solo politicas NUEVAS)
-- ---------------------------------------------------------------------------
-- Pedidos y ventas. El INSERT ya es publico (ord_crear_publico).
create policy equipo_pedidos_ver on public.orders
  for select using (public.equipo_puede_alguno(store_slug, array['vender', 'pedidos', 'cocina']));

create policy equipo_pedidos_editar on public.orders
  for update using (public.equipo_puede_alguno(store_slug, array['vender', 'pedidos', 'cocina']))
  with check (public.equipo_puede_alguno(store_slug, array['vender', 'pedidos', 'cocina']));

create policy equipo_pedidos_anular on public.orders
  for delete using (public.equipo_puede(store_slug, 'anular'));

-- Productos. La lectura ya es publica. Vender necesita UPDATE para descontar
-- stock; el trigger de abajo se encarga de que un cajero solo cambie stock.
create policy equipo_productos_editar on public.store_products
  for update using (public.equipo_puede_alguno(store_slug, array['vender', 'productos']))
  with check (public.equipo_puede_alguno(store_slug, array['vender', 'productos']));

create policy equipo_productos_crear on public.store_products
  for insert with check (public.equipo_puede(store_slug, 'productos'));

create policy equipo_productos_borrar on public.store_products
  for delete using (public.equipo_puede(store_slug, 'productos'));

-- Caja y gastos.
create policy equipo_caja on public.store_movimientos_caja
  for all using (public.equipo_puede(store_slug, 'caja'))
  with check (public.equipo_puede(store_slug, 'caja'));

create policy equipo_gastos on public.store_gastos
  for all using (public.equipo_puede(store_slug, 'caja'))
  with check (public.equipo_puede(store_slug, 'caja'));

-- Pagos (cobros de fiado y de pedidos).
create policy equipo_pagos on public.store_pagos
  for all using (public.equipo_puede_alguno(store_slug, array['caja', 'fiado']))
  with check (public.equipo_puede_alguno(store_slug, array['caja', 'fiado']));

-- Link de estado de cuenta del fiado.
create policy equipo_clientes_token on public.store_clientes_token
  for all using (public.equipo_puede(store_slug, 'fiado'))
  with check (public.equipo_puede(store_slug, 'fiado'));

-- Reparaciones e historial de IMEI.
create policy equipo_reparaciones on public.store_reparaciones
  for all using (public.equipo_puede(store_slug, 'reparaciones'))
  with check (public.equipo_puede(store_slug, 'reparaciones'));

create policy equipo_imei_eventos on public.store_imei_eventos
  for all using (public.equipo_puede(store_slug, 'reparaciones'))
  with check (public.equipo_puede(store_slug, 'reparaciones'));

-- Agenda de turnos (ver y crear ya son publicos).
create policy equipo_turnos_editar on public.store_turnos
  for update using (public.equipo_puede(store_slug, 'turnos'))
  with check (public.equipo_puede(store_slug, 'turnos'));

create policy equipo_turnos_borrar on public.store_turnos
  for delete using (public.equipo_puede(store_slug, 'turnos'));

-- ---------------------------------------------------------------------------
-- 5) Un cajero vende (descuenta stock) pero no cambia precios
--    RLS no puede limitar columnas por usuario, asi que lo hace un trigger:
--    si quien edita es del equipo y NO tiene el permiso 'productos', de todo
--    el cambio solo se acepta stock y variantes (el stock por variante vive
--    adentro de variantes). El resto de la fila vuelve a como estaba.
--    Sale enseguida para el dueño y para el servidor (auth.uid() null:
--    webhooks de Mercado Libre, migraciones), que son el 99% de los casos.
-- ---------------------------------------------------------------------------
create or replace function public.equipo_proteger_producto()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stock     numeric;
  v_variantes jsonb;
begin
  if auth.uid() is null then
    return new;
  end if;

  if exists (select 1 from store_profiles sp
              where sp.slug = old.store_slug and sp.user_id = auth.uid()) then
    return new;
  end if;

  if public.equipo_puede(old.store_slug, 'productos') then
    return new;
  end if;

  v_stock     := new.stock;
  v_variantes := new.variantes;
  new := old;
  new.stock     := v_stock;
  new.variantes := v_variantes;
  return new;
end;
$$;

drop trigger if exists trg_equipo_proteger_producto on public.store_products;
create trigger trg_equipo_proteger_producto
  before update on public.store_products
  for each row execute function public.equipo_proteger_producto();
