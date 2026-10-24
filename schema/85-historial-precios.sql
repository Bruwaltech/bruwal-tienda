-- ============================================================
--  BRUWAL — Historial de precios y carteles editables
--
--  1. store_precios_historial: cada vez que a un producto le
--     cambia el precio, la oferta o el costo queda una fila con
--     el antes y el después. Lo llena un trigger, así cuenta
--     venga de donde venga (formulario, Excel, aumento por %,
--     dólar, botón de oferta, SQL). Nadie la puede editar ni
--     borrar desde el panel: es el registro de qué se tocó.
--     `quien` dice si fue el dueño, alguien del equipo o el
--     sistema (cron, servidor, SQL a mano).
--  2. store_profiles.carteles: cómo quedaron los carteles de
--     oferta editados ({estilo:{...}, editados:{id:{...}}}),
--     así se ven igual desde cualquier compu.
--
--  Correr en Supabase -> SQL Editor. Aditivo e idempotente.
--  Si el MCP da timeout, correr cada sentencia sola.
-- ============================================================

create table if not exists public.store_precios_historial (
  id              bigint generated always as identity primary key,
  store_slug      text not null,
  producto_id     uuid not null,
  nombre          text,
  precio_antes    numeric,
  precio_despues  numeric,
  oferta_antes    numeric,
  oferta_despues  numeric,
  costo_antes     numeric,
  costo_despues   numeric,
  quien           text not null default 'sistema',   -- 'duenio' | 'equipo' | 'sistema'
  user_id         uuid,
  created_at      timestamptz not null default now()
);

create index if not exists store_precios_historial_por_tienda
  on public.store_precios_historial(store_slug, created_at desc);

create index if not exists store_precios_historial_por_producto
  on public.store_precios_historial(producto_id, created_at desc);

alter table public.store_precios_historial enable row level security;

-- Solo lectura: el dueño o un miembro activo del equipo (75). No hay
-- política de insert/update/delete: escribe únicamente el trigger.
drop policy if exists precios_historial_lectura on public.store_precios_historial;
create policy precios_historial_lectura on public.store_precios_historial
  for select to authenticated
  using (
    exists (select 1 from public.store_profiles sp
             where sp.slug = store_precios_historial.store_slug and sp.user_id = auth.uid())
    or public.equipo_es_miembro(store_slug)
  );

-- SECURITY DEFINER para poder insertar sin política de insert.
create or replace function public.trg_precios_historial()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_quien text := 'sistema';
begin
  if new.price is not distinct from old.price
     and new.precio_oferta is not distinct from old.precio_oferta
     and new.costo is not distinct from old.costo then
    return new;
  end if;
  if auth.uid() is not null then
    v_quien := case when exists (select 1 from store_profiles sp
                                  where sp.slug = new.store_slug and sp.user_id = auth.uid())
                    then 'duenio' else 'equipo' end;
  end if;
  insert into store_precios_historial
    (store_slug, producto_id, nombre, precio_antes, precio_despues,
     oferta_antes, oferta_despues, costo_antes, costo_despues, quien, user_id)
  values
    (new.store_slug, new.id, new.name, old.price, new.price,
     old.precio_oferta, new.precio_oferta, old.costo, new.costo, v_quien, auth.uid());
  return new;
end;
$function$;

drop trigger if exists trg_precios_historial on public.store_products;
create trigger trg_precios_historial
  after update on public.store_products
  for each row execute function public.trg_precios_historial();


alter table public.store_profiles
  add column if not exists carteles jsonb;

notify pgrst, 'reload schema';

-- Verificación
select 'historial de precios' as estado,
       (select count(*) from pg_policies where schemaname='public' and tablename='store_precios_historial') as politicas,
       (select count(*) from pg_trigger where tgname='trg_precios_historial') as trigger,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_profiles' and column_name='carteles') as col_carteles;
