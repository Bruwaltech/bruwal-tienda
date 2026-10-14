-- ============================================================
--  BRUWAL — Afiliados: gente que recomienda la tienda y cobra
--  un porcentaje de lo que vende.
--
--  Un entrenador, un gimnasio o un conocido comparte su link
--  (tienda.com/novalis?ref=JUAN). El cliente que entra por ahí
--  queda marcado y su pedido se guarda con el código del
--  afiliado. El panel suma lo vendido por cada uno y cuánto hay
--  que pagarle a fin de mes.
--
--  1) store_afiliados: solo el dueño de la tienda la ve. Lleva la
--     comisión, que el cliente no tiene por qué conocer.
--
--  2) afiliado_de_tienda(): lo único público. Dice si un código
--     existe y qué descuento le da al cliente, nada más.
--
--  3) orders.afiliado_*: la comisión se congela en el pedido con
--     un trigger, igual que la duración del turno: si el mes que
--     viene le subís la comisión a alguien, lo ya vendido no
--     cambia. Y la pone la base, no el navegador: el pedido lo
--     arma el cliente y podría mandar el porcentaje que quiera.
--
--  Correr en Supabase -> SQL Editor. Aditivo e idempotente.
-- ============================================================

create table if not exists public.store_afiliados (
  id              uuid primary key default gen_random_uuid(),
  store_slug      text not null references public.store_profiles(slug) on delete cascade,
  codigo          text not null check (codigo ~ '^[A-Za-z0-9_-]{2,30}$'),
  nombre          text not null,
  telefono        text,
  comision_pct    numeric(5,2) not null default 15 check (comision_pct >= 0 and comision_pct <= 100),
  descuento_pct   numeric(5,2) not null default 0  check (descuento_pct >= 0 and descuento_pct <= 50),
  activo          boolean not null default true,
  created_at      timestamptz not null default now()
);

-- "juan" y "JUAN" son el mismo afiliado: el código se tipea a mano.
create unique index if not exists store_afiliados_codigo_unico
  on public.store_afiliados (store_slug, lower(codigo));

alter table public.store_afiliados enable row level security;

drop policy if exists afiliados_propios on public.store_afiliados;
create policy afiliados_propios on public.store_afiliados for all
  using (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_afiliados.store_slug and sp.user_id = auth.uid()))
  with check (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_afiliados.store_slug and sp.user_id = auth.uid()));

-- Lo que ve la tienda pública. Sin comisión ni teléfono.
create or replace function public.afiliado_de_tienda(p_slug text, p_codigo text)
returns table (codigo text, nombre text, descuento_pct numeric)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select a.codigo, a.nombre, a.descuento_pct
    from public.store_afiliados a
   where a.store_slug = p_slug
     and lower(a.codigo) = lower(trim(p_codigo))
     and a.activo
   limit 1;
$function$;

grant execute on function public.afiliado_de_tienda(text, text) to anon, authenticated;

alter table public.orders
  add column if not exists afiliado_codigo text;

alter table public.orders
  add column if not exists afiliado_comision_pct numeric(5,2);

-- Cuánto se le descontó al cliente por venir con el código. Va aparte
-- para que la comisión se calcule sobre lo que de verdad se cobró por
-- los productos, sin el envío.
alter table public.orders
  add column if not exists afiliado_descuento numeric(12,2);

create index if not exists orders_afiliado_idx
  on public.orders (store_slug, afiliado_codigo)
  where afiliado_codigo is not null;

-- SECURITY DEFINER porque el que inserta es el cliente anónimo, que no
-- puede leer store_afiliados. Solo en INSERT: después el dueño puede
-- corregir a mano el pedido si hace falta.
create or replace function public.congelar_afiliado_del_pedido()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_afiliado public.store_afiliados;
begin
  if new.afiliado_codigo is null or trim(new.afiliado_codigo) = '' then
    new.afiliado_codigo := null;
    new.afiliado_comision_pct := null;
    new.afiliado_descuento := null;
    return new;
  end if;

  select * into v_afiliado
    from public.store_afiliados a
   where a.store_slug = new.store_slug
     and lower(a.codigo) = lower(trim(new.afiliado_codigo))
     and a.activo
   limit 1;

  if v_afiliado.id is null then
    -- Código inventado o dado de baja: el pedido entra igual, sin afiliado.
    new.afiliado_codigo := null;
    new.afiliado_comision_pct := null;
    new.afiliado_descuento := null;
    return new;
  end if;

  new.afiliado_codigo := v_afiliado.codigo;
  new.afiliado_comision_pct := v_afiliado.comision_pct;
  if v_afiliado.descuento_pct = 0 then
    new.afiliado_descuento := null;
  end if;
  return new;
end;
$function$;

drop trigger if exists tr_congelar_afiliado_del_pedido on public.orders;
create trigger tr_congelar_afiliado_del_pedido
  before insert on public.orders
  for each row execute function public.congelar_afiliado_del_pedido();

NOTIFY pgrst, 'reload schema';

-- Verificación: tienen que dar todos 1
select
  (select count(*) from information_schema.tables
   where table_schema='public' and table_name='store_afiliados')                                   as tabla_afiliados,
  (select count(*) from information_schema.columns
   where table_schema='public' and table_name='orders' and column_name='afiliado_codigo')        as col_codigo,
  (select count(*) from information_schema.columns
   where table_schema='public' and table_name='orders' and column_name='afiliado_comision_pct')  as col_comision,
  (select count(*) from pg_trigger where tgname='tr_congelar_afiliado_del_pedido')                as trigger_pedido;
