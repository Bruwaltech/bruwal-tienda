-- ============================================================
--  BRUWAL — Historial de cambios de precio
--
--  Cada vez que a un producto le cambia el precio, la oferta o el
--  costo queda una fila en store_precio_historial: qué producto,
--  cuánto valía antes, cuánto vale ahora, cuándo, quién y de dónde
--  vino el cambio (a mano, Excel, cambio masivo, Mercado Libre...).
--
--  Lo escribe un trigger, así no se escapa ningún cambio aunque
--  venga de un camino nuevo del panel o del servidor. Una venta NO
--  deja registro (solo mueve el stock), y una lista de Excel que
--  trae el mismo precio que ya estaba tampoco: solo se anota lo que
--  cambió de verdad. Dar de alta un producto no es un cambio.
--
--  El panel avisa el origen y el nombre de la compu (el de "Bloquear
--  acciones" de la 84) con dos encabezados, x-bruwal-origen y
--  x-bruwal-equipo, que el trigger lee de request.headers. Si no
--  vienen (servidor, SQL a mano) queda 'sistema'.
--
--  Nadie puede escribir ni borrar filas desde la app: no hay
--  política de insert/update/delete, solo lee el dueño o el equipo.
--
--  Correr en Supabase -> SQL Editor. Aditivo e idempotente.
-- ============================================================

create table if not exists public.store_precio_historial (
  id          bigint generated always as identity primary key,
  store_slug  text not null,
  product_id  uuid not null,          -- sin FK: el historial queda aunque se borre el producto
  producto    text,                   -- el nombre en ese momento
  campo       text not null,          -- 'precio' | 'oferta' | 'costo'
  antes       numeric,
  despues     numeric,
  origen      text not null default 'sistema',
  equipo      text,                   -- nombre de la compu/caja (URL-encoded)
  usuario     text,                   -- mail de la sesión
  created_at  timestamptz not null default now()
);

create index if not exists store_precio_historial_por_tienda
  on public.store_precio_historial(store_slug, created_at desc);
create index if not exists store_precio_historial_por_producto
  on public.store_precio_historial(product_id, created_at desc);

alter table public.store_precio_historial enable row level security;

drop policy if exists precio_historial_lectura on public.store_precio_historial;
create policy precio_historial_lectura on public.store_precio_historial
  for select to authenticated
  using (
    exists (select 1 from public.store_profiles sp
             where sp.slug = store_precio_historial.store_slug and sp.user_id = auth.uid())
    or public.equipo_es_miembro(store_slug)
  );

create or replace function public.trg_precio_historial()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  h       json;
  v_orig  text;
  v_eq    text;
  v_user  text;
begin
  if new.price is not distinct from old.price
     and new.precio_oferta is not distinct from old.precio_oferta
     and new.costo is not distinct from old.costo then
    return new;
  end if;

  begin
    h := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    h := null;
  end;
  v_orig := left(coalesce(nullif(h ->> 'x-bruwal-origen', ''), 'sistema'), 30);
  v_eq   := left(nullif(h ->> 'x-bruwal-equipo', ''), 120);
  v_user := left(nullif(auth.jwt() ->> 'email', ''), 120);

  if new.price is distinct from old.price then
    insert into store_precio_historial(store_slug, product_id, producto, campo, antes, despues, origen, equipo, usuario)
    values (new.store_slug, new.id, new.name, 'precio', old.price, new.price, v_orig, v_eq, v_user);
  end if;
  if new.precio_oferta is distinct from old.precio_oferta then
    insert into store_precio_historial(store_slug, product_id, producto, campo, antes, despues, origen, equipo, usuario)
    values (new.store_slug, new.id, new.name, 'oferta', old.precio_oferta, new.precio_oferta, v_orig, v_eq, v_user);
  end if;
  if new.costo is distinct from old.costo then
    insert into store_precio_historial(store_slug, product_id, producto, campo, antes, despues, origen, equipo, usuario)
    values (new.store_slug, new.id, new.name, 'costo', old.costo, new.costo, v_orig, v_eq, v_user);
  end if;
  return new;
end;
$function$;

revoke execute on function public.trg_precio_historial() from public, anon, authenticated;

drop trigger if exists trg_precio_historial on public.store_products;
create trigger trg_precio_historial
  after update of price, precio_oferta, costo on public.store_products
  for each row execute function public.trg_precio_historial();

notify pgrst, 'reload schema';

-- Verificación
select 'historial de precios' as estado,
       (select count(*) from pg_policies where schemaname='public' and tablename='store_precio_historial') as politicas,
       (select count(*) from pg_trigger where tgname='trg_precio_historial') as trigger;
