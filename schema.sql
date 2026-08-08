-- ============================================================
-- BRUWAL STOCK — esquema de base de datos para Supabase
-- Pegar todo este archivo en Supabase > SQL Editor > New query > Run
-- ============================================================

-- 1) PERFILES (uno por usuario, se crea solo al registrarse)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  business_name text,
  plan text not null default 'free',
  mp_subscription_id text,
  created_at timestamptz not null default now()
);

-- migración segura si la tabla ya existía con el check viejo ('free','paid')
update public.profiles set plan = 'pro' where plan = 'paid';
alter table public.profiles drop constraint if exists profiles_plan_check;
alter table public.profiles add constraint profiles_plan_check check (plan in ('free','basic','pro'));

-- datos de contacto y tipo de cuenta (tienda o repartidor)
alter table public.profiles add column if not exists phone text;
alter table public.profiles add column if not exists account_type text not null default 'tienda';
alter table public.profiles drop constraint if exists profiles_account_type_check;
alter table public.profiles add constraint profiles_account_type_check check (account_type in ('tienda','repartidor'));

-- datos del vehículo, solo para cuentas de tipo 'repartidor'
alter table public.profiles add column if not exists vehicle_type text;
alter table public.profiles add column if not exists license_plate text;
alter table public.profiles add column if not exists has_insurance boolean not null default false;
alter table public.profiles add column if not exists has_helmet boolean not null default false;
alter table public.profiles add column if not exists has_delivery_box boolean not null default false;

-- dirección pública de la tienda (bruwaltech.com.ar/mi-tienda)
create extension if not exists unaccent;
alter table public.profiles add column if not exists slug text unique;

create or replace function public.slugify(input text)
returns text as $$
  select nullif(trim(both '-' from regexp_replace(lower(unaccent(coalesce(input,''))), '[^a-z0-9]+', '-', 'g')), '');
$$ language sql immutable;

create or replace function public.generate_unique_slug(base_name text)
returns text as $$
declare
  base_slug text;
  final_slug text;
  counter int := 1;
  reserved text[] := array['app','www','admin','api','tienda','panel','robots.txt','sitemap.xml','og-image.jpg','brand-tagline.jpg','llms.txt','_redirects'];
begin
  base_slug := coalesce(public.slugify(base_name), 'tienda');
  final_slug := base_slug;
  while exists (select 1 from public.profiles where slug = final_slug) or final_slug = any(reserved) loop
    counter := counter + 1;
    final_slug := base_slug || '-' || counter;
  end loop;
  return final_slug;
end;
$$ language plpgsql;

alter table public.profiles enable row level security;

drop policy if exists "Ver mi propio perfil" on public.profiles;
create policy "Ver mi propio perfil"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "Actualizar mi propio perfil" on public.profiles;
create policy "Actualizar mi propio perfil"
  on public.profiles for update
  using (auth.uid() = id);

-- crea el perfil automáticamente cuando alguien se registra
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (
    id, email, business_name, phone, account_type,
    vehicle_type, license_plate, has_insurance, has_helmet, has_delivery_box, slug
  )
  values (
    new.id, new.email,
    new.raw_user_meta_data->>'business_name',
    new.raw_user_meta_data->>'phone',
    coalesce(new.raw_user_meta_data->>'account_type', 'tienda'),
    new.raw_user_meta_data->>'vehicle_type',
    new.raw_user_meta_data->>'license_plate',
    coalesce((new.raw_user_meta_data->>'has_insurance')::boolean, false),
    coalesce((new.raw_user_meta_data->>'has_helmet')::boolean, false),
    coalesce((new.raw_user_meta_data->>'has_delivery_box')::boolean, false),
    public.generate_unique_slug(new.raw_user_meta_data->>'business_name')
  );
  return new;
end;
$$ language plpgsql security definer;

-- les da slug a las cuentas que ya existían antes de este cambio (una por una,
-- para que cada slug nuevo tenga en cuenta los que se acaban de asignar)
do $$
declare
  r record;
begin
  for r in select id, business_name from public.profiles where slug is null loop
    update public.profiles set slug = public.generate_unique_slug(r.business_name) where id = r.id;
  end loop;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 2) PRODUCTOS (stock de cada usuario)
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  ean text,
  category text,
  stock int not null default 0,
  min_stock int not null default 0,
  price numeric(12,2) not null default 0,
  provider text,
  created_at timestamptz not null default now()
);

alter table public.products add column if not exists image_url text;

create index if not exists products_user_id_idx on public.products(user_id);
create index if not exists products_ean_idx on public.products(user_id, ean);

alter table public.products enable row level security;

drop policy if exists "Ver mis productos" on public.products;
create policy "Ver mis productos"
  on public.products for select
  using (auth.uid() = user_id);

drop policy if exists "Insertar mis productos" on public.products;
create policy "Insertar mis productos"
  on public.products for insert
  with check (auth.uid() = user_id);

drop policy if exists "Editar mis productos" on public.products;
create policy "Editar mis productos"
  on public.products for update
  using (auth.uid() = user_id);

drop policy if exists "Borrar mis productos" on public.products;
create policy "Borrar mis productos"
  on public.products for delete
  using (auth.uid() = user_id);

-- límite de 10 productos en plan free (se aplica en la base, no solo en la pantalla)
create or replace function public.enforce_product_limit()
returns trigger as $$
declare
  user_plan text;
  product_count int;
begin
  select plan into user_plan from public.profiles where id = new.user_id;
  if user_plan = 'free' then
    select count(*) into product_count from public.products where user_id = new.user_id;
    if product_count >= 10 then
      raise exception 'FREE_PLAN_LIMIT_REACHED';
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists check_product_limit on public.products;
create trigger check_product_limit
  before insert on public.products
  for each row execute function public.enforce_product_limit();

-- 3) VENTAS (historial, descuenta stock)
create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  product_name text not null,
  qty int not null check (qty > 0),
  unit_price numeric(12,2) not null,
  total numeric(12,2) not null,
  created_at timestamptz not null default now()
);

create index if not exists sales_user_id_idx on public.sales(user_id);

alter table public.sales enable row level security;

drop policy if exists "Ver mis ventas" on public.sales;
create policy "Ver mis ventas"
  on public.sales for select
  using (auth.uid() = user_id);

drop policy if exists "Insertar mis ventas" on public.sales;
create policy "Insertar mis ventas"
  on public.sales for insert
  with check (auth.uid() = user_id);

-- función que registra una venta y descuenta stock de forma atómica
create or replace function public.register_sale(p_product_id uuid, p_qty int)
returns public.sales as $$
declare
  v_product public.products;
  v_sale public.sales;
begin
  select * into v_product from public.products
    where id = p_product_id and user_id = auth.uid()
    for update;

  if not found then
    raise exception 'PRODUCT_NOT_FOUND';
  end if;

  if v_product.stock < p_qty then
    raise exception 'INSUFFICIENT_STOCK';
  end if;

  update public.products
    set stock = stock - p_qty
    where id = p_product_id;

  insert into public.sales (user_id, product_id, product_name, qty, unit_price, total)
    values (auth.uid(), p_product_id, v_product.name, p_qty, v_product.price, v_product.price * p_qty)
    returning * into v_sale;

  return v_sale;
end;
$$ language plpgsql security definer;

-- 4) FOTOS DE PRODUCTOS (Storage) — para subir imágenes desde el celu/compu
insert into storage.buckets (id, name, public)
  values ('product-images', 'product-images', true)
  on conflict (id) do nothing;

drop policy if exists "Subir mis fotos de producto" on storage.objects;
create policy "Subir mis fotos de producto"
  on storage.objects for insert
  with check (bucket_id = 'product-images' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Reemplazar mis fotos de producto" on storage.objects;
create policy "Reemplazar mis fotos de producto"
  on storage.objects for update
  using (bucket_id = 'product-images' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Borrar mis fotos de producto" on storage.objects;
create policy "Borrar mis fotos de producto"
  on storage.objects for delete
  using (bucket_id = 'product-images' and (storage.foldername(name))[1] = auth.uid()::text);

-- 5) VIDRIERA PÚBLICA — lo que ve un comprador sin loguearse en bruwaltech.com.ar/tu-tienda
-- Solo nombre, foto, precio y disponibilidad. La cantidad exacta de stock nunca se expone acá.
create or replace view public.store_profiles as
  select slug, business_name, phone
  from public.profiles
  where account_type = 'tienda' and slug is not null;

grant select on public.store_profiles to anon, authenticated;

create or replace view public.store_products as
  select
    p.id,
    pr.slug as store_slug,
    p.name,
    p.image_url,
    p.category,
    p.price,
    (p.stock > 0) as in_stock
  from public.products p
  join public.profiles pr on pr.id = p.user_id
  where pr.account_type = 'tienda' and pr.slug is not null;

grant select on public.store_products to anon, authenticated;

-- 6) PEDIDOS REALES de clientes (sin cuenta) hacia una tienda
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  business_user_id uuid not null references auth.users(id) on delete cascade,
  customer_name text,
  customer_phone text,
  items jsonb not null,
  total numeric(12,2) not null,
  status text not null default 'nuevo' check (status in ('nuevo','en_preparacion','listo','entregado','cancelado')),
  created_at timestamptz not null default now()
);

create index if not exists orders_business_user_id_idx on public.orders(business_user_id);

alter table public.orders enable row level security;

drop policy if exists "Ver mis pedidos" on public.orders;
create policy "Ver mis pedidos"
  on public.orders for select
  using (auth.uid() = business_user_id);

drop policy if exists "Actualizar mis pedidos" on public.orders;
create policy "Actualizar mis pedidos"
  on public.orders for update
  using (auth.uid() = business_user_id);

-- función pública (sin login) que arma un pedido validando productos y precios reales
-- del lado del servidor, así un cliente no puede inventar precios ni pedir de otra tienda.
create or replace function public.place_order(
  p_slug text,
  p_items jsonb,
  p_customer_name text,
  p_customer_phone text
)
returns public.orders as $$
declare
  v_business_id uuid;
  v_item jsonb;
  v_product public.products;
  v_total numeric(12,2) := 0;
  v_qty int;
  v_order public.orders;
begin
  select id into v_business_id from public.profiles where slug = p_slug and account_type = 'tienda';
  if v_business_id is null then
    raise exception 'STORE_NOT_FOUND';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_ORDER';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid and user_id = v_business_id;
    if not found then
      raise exception 'PRODUCT_NOT_FOUND';
    end if;
    v_qty := greatest(1, coalesce((v_item->>'qty')::int, 1));
    v_total := v_total + (v_product.price * v_qty);
  end loop;

  insert into public.orders (business_user_id, customer_name, customer_phone, items, total)
    values (v_business_id, nullif(trim(p_customer_name), ''), nullif(trim(p_customer_phone), ''), p_items, v_total)
    returning * into v_order;

  return v_order;
end;
$$ language plpgsql security definer;

grant execute on function public.place_order(text, jsonb, text, text) to anon, authenticated;
