-- ============================================================
--  BRUWAL — Distribuidora: listas de precios con nombre y
--  productos sin actualizar
--
--  1. store_listas_precios: cada vez que la tienda actualiza
--     productos (una lista de Excel, o cambios a mano en el día)
--     queda un registro con nombre editable y el detalle de qué
--     producto cambió y cómo ("precio $1.000 → $1.200").
--  2. store_products.precio_actualizado_at: la última vez que se
--     tocó el precio, la oferta, el costo o el precio por cantidad.
--     Lo pone un trigger, así cuenta igual venga del panel, de un
--     Excel o del dólar. Una venta NO lo mueve (solo cambia stock).
--     Arranca con la fecha de alta o de última modificación.
--  3. store_profiles.productos_viejos: qué hacer con los productos
--     que pasan X meses sin actualizar ({meses, accion}), donde
--     accion es 'avisar' (por defecto) o 'pausar'. Borrar solo no
--     existe a propósito: se borra a mano desde el aviso.
--
--  Correr en Supabase -> SQL Editor. Aditivo e idempotente.
-- ============================================================

create table if not exists public.store_listas_precios (
  id          uuid primary key default gen_random_uuid(),
  store_slug  text not null,
  nombre      text not null,
  origen      text not null default 'excel',   -- 'excel' | 'manual'
  archivo     text,
  dia         date,                             -- para juntar los cambios a mano del mismo día
  cambios     jsonb not null default '[]'::jsonb,  -- [{id, nombre, detalle:[...]}]
  cantidad    integer not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists store_listas_precios_por_tienda
  on public.store_listas_precios(store_slug, created_at desc);

alter table public.store_listas_precios enable row level security;

drop policy if exists listas_precios_propias on public.store_listas_precios;
create policy listas_precios_propias on public.store_listas_precios for all
  using (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_listas_precios.store_slug and sp.user_id = auth.uid()))
  with check (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_listas_precios.store_slug and sp.user_id = auth.uid()));


alter table public.store_products
  add column if not exists precio_actualizado_at timestamptz;

update public.store_products
   set precio_actualizado_at = coalesce(updated_at, created_at, now())
 where precio_actualizado_at is null;

create or replace function public.trg_precio_actualizado()
returns trigger
language plpgsql
as $function$
begin
  if tg_op = 'INSERT' then
    new.precio_actualizado_at := coalesce(new.precio_actualizado_at, now());
  elsif new.price is distinct from old.price
     or new.precio_oferta is distinct from old.precio_oferta
     or new.costo is distinct from old.costo
     or new.precios_por_cantidad is distinct from old.precios_por_cantidad
     or new.precio_actualizado_at is distinct from old.precio_actualizado_at then
    -- El "Ya lo revisé" del panel manda la fecha a mano: se respeta.
    if new.precio_actualizado_at is not distinct from old.precio_actualizado_at then
      new.precio_actualizado_at := now();
    end if;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_precio_actualizado on public.store_products;
create trigger trg_precio_actualizado
  before insert or update on public.store_products
  for each row execute function public.trg_precio_actualizado();


alter table public.store_profiles
  add column if not exists productos_viejos jsonb;

notify pgrst, 'reload schema';

-- Verificación
select 'listas y productos viejos' as estado,
       (select count(*) from pg_policies where schemaname='public' and tablename='store_listas_precios') as politicas,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_products' and column_name='precio_actualizado_at') as col_precio_actualizado,
       (select count(*) from pg_trigger where tgname='trg_precio_actualizado') as trigger,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_profiles' and column_name='productos_viejos') as col_productos_viejos;
