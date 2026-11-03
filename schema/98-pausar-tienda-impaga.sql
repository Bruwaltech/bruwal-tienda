-- ============================================================
--  BRUWAL — 98: pausar la tienda online del que no tiene la
--  suscripción al día.
--
--  QUE HACE: el link público sigue mostrando el catálogo, pero con el cartel
--  "esta tienda no tiene habilitado el servicio de venta online": sin
--  carrito, sin WhatsApp, y no entran pedidos ni turnos desde afuera. El panel NO se toca: el dueño entra, ve el aviso con el botón
--  para pagar, y en cuanto se acredita el pago la tienda vuelve sola (la
--  regla se calcula cada vez, no hay nada que "despausar" a mano).
--
--  CUANDO SE PAUSA (todo en días de Argentina):
--   * Nunca: cortesía, la cuenta demo y las de la lista 'excepciones' del
--     ajuste (nacen ahí josefina y demo-bruwal, pedido de Bruno 03/11).
--   * Plan basic/pro con fecha de corte (se dio de baja, o se lo pusimos a
--     mano): DIAS_GRACIA_VENCIDO días después de esa fecha.
--   * Plan basic/pro con una cuota rechazada que Mercado Pago no pudo
--     cobrar: DIAS_GRACIA_COBRO días después del PRIMER rechazo, si en el
--     medio no entró ningún cobro. Nunca en el primer rechazo: MP reintenta
--     varias veces y el cliente recibe el mail de la 97 en cada intento.
--   * Prueba terminada o plan cancelado: DIAS_GRACIA_VENCIDO días después
--     de que se le terminó (la más tardía entre fin de prueba y corte).
--
--  KILL SWITCH: la fila 'pausar_tiendas_impagas' de bruwal_ajustes.
--    Apagar todo de una:
--      update public.bruwal_ajustes set valor = jsonb_set(valor, '{activo}', 'false')
--       where clave = 'pausar_tiendas_impagas';
--    Prender:  lo mismo con 'true'.
--    Cambiar los días de gracia: jsonb_set(valor, '{dias_gracia_cobro}', '14'), etc.
--  Excepción para UNA tienda (ej. arregló por fuera): sumarla a la lista,
--      update public.bruwal_ajustes
--         set valor = jsonb_set(valor, '{excepciones}', (valor -> 'excepciones') || '["<slug>"]')
--       where clave = 'pausar_tiendas_impagas';
--
--  NACE APAGADO. Se prende a mano cuando Bruno decide.
--
--  Correr en Supabase -> SQL Editor. Aditivo e idempotente.
-- ============================================================

-- 1) Ajustes globales de BRUWAL (solo servidor / SQL Editor).
create table if not exists public.bruwal_ajustes (
  clave         text primary key,
  valor         jsonb not null,
  actualizado_en timestamptz not null default now()
);
alter table public.bruwal_ajustes enable row level security;
revoke all on public.bruwal_ajustes from anon, authenticated;

insert into public.bruwal_ajustes (clave, valor)
values ('pausar_tiendas_impagas',
        '{"activo": false, "dias_gracia_vencido": 3, "dias_gracia_cobro": 10,
          "excepciones": ["josefina-indumentaria-y-accesorios", "demo-bruwal"]}'::jsonb)
on conflict (clave) do nothing;

-- 2) Cuota rechazada sin cobrar. La escriben el webhook y la revisión diaria
--    (api/_cobro-rechazado.js) con la service role: una fila por tienda
--    desde el PRIMER rechazo, y se borra cuando entra un cobro. Va atada a
--    la suscripción: si el cliente se suscribe de nuevo (otro
--    mp_preapproval_id), la fila vieja deja de contar sola.
create table if not exists public.suscripcion_cobro_impago (
  slug            text primary key,
  preapproval_id  text not null,
  desde           timestamptz not null,
  ultimo_cobro_id text,
  actualizado_en  timestamptz not null default now()
);
alter table public.suscripcion_cobro_impago enable row level security;
revoke all on public.suscripcion_cobro_impago from anon, authenticated;

-- 3) La regla, en un solo lugar. Devuelve el estado completo; lo usan las
--    dos funciones de abajo. No se expone directo (dice el motivo).
create or replace function public.estado_pausa_tienda(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  aj        jsonb;
  activo    boolean;
  g_vencido int;
  g_cobro   int;
  hoy       date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  sp        record;
  ci        record;
  fin       date;
  pausa_el  date := null;
  motivo    text := null;
begin
  select valor into aj from bruwal_ajustes where clave = 'pausar_tiendas_impagas';
  activo    := coalesce((aj ->> 'activo')::boolean, false);
  g_vencido := coalesce((aj ->> 'dias_gracia_vencido')::int, 3);
  g_cobro   := coalesce((aj ->> 'dias_gracia_cobro')::int, 10);

  select slug, plan, plan_vence, trial_ends_at, mp_preapproval_id, es_demo
    into sp from store_profiles where slug = p_slug;
  if not found or coalesce(sp.es_demo, false) or sp.plan = 'cortesia'
     or coalesce(aj -> 'excepciones', '[]'::jsonb) ? p_slug then
    return jsonb_build_object('pausada', false, 'activo', activo);
  end if;

  if sp.plan in ('basic', 'pro') then
    -- plan_vence es "hasta el día anterior inclusive" (igual que el panel).
    if sp.plan_vence is not null then
      pausa_el := sp.plan_vence + g_vencido;
      motivo   := 'vencido';
    end if;
    if sp.mp_preapproval_id is not null then
      select * into ci from suscripcion_cobro_impago c
       where c.slug = p_slug and c.preapproval_id = sp.mp_preapproval_id;
      if found then
        fin := (ci.desde at time zone 'America/Argentina/Buenos_Aires')::date + g_cobro;
        if pausa_el is null or fin < pausa_el then
          pausa_el := fin;
          motivo   := 'cobro';
        end if;
      end if;
    end if;
  else
    -- trial, cancelado o cualquier otro: no paga.
    fin := greatest(sp.plan_vence,
                    (sp.trial_ends_at at time zone 'America/Argentina/Buenos_Aires')::date);
    if fin is not null then
      pausa_el := fin + g_vencido;
      motivo   := 'vencido';
    end if;
  end if;

  return jsonb_build_object(
    'activo',   activo,
    'pausada',  activo and pausa_el is not null and hoy >= pausa_el,
    'pausa_el', pausa_el,
    'motivo',   motivo
  );
end;
$$;
revoke execute on function public.estado_pausa_tienda(text) from public, anon, authenticated;

-- 4) Para la tienda pública: solo sí/no, sin el motivo (que un cliente del
--    negocio no tiene por qué saber que no pagó).
create or replace function public.tienda_online_pausada(p_slug text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((public.estado_pausa_tienda(p_slug) ->> 'pausada')::boolean, false);
$$;
grant execute on function public.tienda_online_pausada(text) to anon, authenticated;

-- 4b) Para el mapa de la portada y el sitemap: las pausadas no se listan.
create or replace function public.tiendas_online_pausadas()
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select sp.slug from store_profiles sp
   where sp.slug is not null
     and coalesce((public.estado_pausa_tienda(sp.slug) ->> 'pausada')::boolean, false);
$$;
grant execute on function public.tiendas_online_pausadas() to anon, authenticated;

-- 5) Para el panel: el estado completo, solo al dueño o a su equipo.
create or replace function public.mi_pausa_tienda(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (select 1 from store_profiles sp where sp.slug = p_slug and sp.user_id = auth.uid())
      or exists (select 1 from store_miembros m
                  where m.store_slug = p_slug and m.user_id = auth.uid() and m.activo)
    then public.estado_pausa_tienda(p_slug)
    else null
  end;
$$;
revoke execute on function public.mi_pausa_tienda(text) from public, anon;
grant execute on function public.mi_pausa_tienda(text) to authenticated;

-- 6) El cartel se puede saltear llamando a la API a mano: el mismo freno de
--    la 83 (pedidos y turnos desde afuera) ahora también mira la pausa.
--    Idéntica a la 83 salvo la condición.
create or replace function public.frenar_pedido_tienda_cerrada()
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

  if not public.tienda_online_cerrada(new.store_slug)
     and not public.tienda_online_pausada(new.store_slug) then
    return new;
  end if;

  if auth.uid() is not null and (
       exists (select 1 from store_profiles sp
                where sp.slug = new.store_slug and sp.user_id = auth.uid())
       or exists (select 1 from store_miembros m
                   where m.store_slug = new.store_slug and m.user_id = auth.uid() and m.activo)
     ) then
    return new;
  end if;

  raise exception 'tienda_online_cerrada' using errcode = 'P0001';
end;
$function$;

notify pgrst, 'reload schema';

-- Verificación: qué tiendas quedarían pausadas SI se prende (con el switch
-- apagado 'pausada' da false para todas; esto simula prendido).
select sp.slug, sp.business_name, sp.plan,
       e ->> 'motivo'   as motivo,
       e ->> 'pausa_el' as se_pausa_el,
       (e ->> 'pausa_el')::date <= (now() at time zone 'America/Argentina/Buenos_Aires')::date as pausada_si_se_prende
  from store_profiles sp,
       lateral (select public.estado_pausa_tienda(sp.slug) as e) x
 where e ->> 'pausa_el' is not null
 order by pausada_si_se_prende desc, sp.slug;
