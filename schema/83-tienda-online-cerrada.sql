-- 83: cerrar la tienda online de una tienda (sin tocar el panel ni la caja).
--
-- Para clientes que no quieren vender por internet (ej. distribuidora-jaci).
-- Se usa la misma lista de la 82: si features.ocultar_secciones incluye
-- "tienda_online", el link público muestra un cartel en vez del catálogo,
-- no se pueden mandar pedidos ni sacar turnos desde afuera, y el panel deja
-- de ofrecer el link. Productos, caja, ventas y etiquetas siguen igual.
--
-- Como features no lo puede leer la llave pública (73), la tienda pregunta
-- con tienda_online_cerrada(slug), que devuelve solo sí/no.
--
-- Para cerrarle la tienda online:
--   update public.store_profiles
--      set features = jsonb_set(features, '{ocultar_secciones}',
--            coalesce(features -> 'ocultar_secciones', '[]'::jsonb) || '["tienda_online"]'::jsonb)
--    where slug = '<slug>';
-- Para abrírsela de nuevo:
--   update public.store_profiles
--      set features = jsonb_set(features, '{ocultar_secciones}',
--            (features -> 'ocultar_secciones') - 'tienda_online')
--    where slug = '<slug>';

create or replace function public.tienda_online_cerrada(p_slug text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select coalesce(sp.features -> 'ocultar_secciones', '[]'::jsonb) ? 'tienda_online'
      from store_profiles sp
     where sp.slug = p_slug
  ), false);
$$;
grant execute on function public.tienda_online_cerrada(text) to anon, authenticated;

-- El cartel de la tienda se puede saltear llamando a la API a mano: esto
-- frena el pedido o el turno en la base. Pasan el servidor (bot, webhooks),
-- el dueño y su equipo (la caja también guarda en orders).
-- Mismo criterio de rol que proteger_features (76).
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

  if not public.tienda_online_cerrada(new.store_slug) then
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

drop trigger if exists tr_frenar_pedido_tienda_cerrada on public.orders;
create trigger tr_frenar_pedido_tienda_cerrada
  before insert on public.orders
  for each row execute function public.frenar_pedido_tienda_cerrada();

drop trigger if exists tr_frenar_turno_tienda_cerrada on public.store_turnos;
create trigger tr_frenar_turno_tienda_cerrada
  before insert on public.store_turnos
  for each row execute function public.frenar_pedido_tienda_cerrada();

comment on column public.store_profiles.features is
  'Módulos opcionales de la tienda, ej. {"envios_flex": true, "ocultar_secciones": ["pedidos", "tienda_online"]}. Lo pone solo el administrador: el navegador no lo puede cambiar (trigger proteger_features).';
