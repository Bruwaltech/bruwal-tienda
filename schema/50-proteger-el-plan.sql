-- Que nadie pueda regalarse un plan desde el navegador.
--
-- EL AGUJERO: la política sp_editar_propia deja al dueño actualizar TODA su
-- fila de store_profiles (auth.uid() = user_id). Eso incluye las columnas
-- plan, plan_vence y trial_ends_at. Cualquier cliente con la consola del
-- navegador abierta podía hacer:
--
--   sb.from('store_profiles').update({ plan: 'pro' }).eq('slug', 'su-tienda')
--
-- y quedarse con el plan Pro sin pagar. Lo mismo estirándose el trial.
--
-- Y por el lado del INSERT: "Agregar tienda" (una función del plan Pro)
-- inserta con `plan: currentStore.plan`. La validación de que sea Pro estaba
-- solo en el panel, o sea en la computadora del cliente, o sea en ningún
-- lado: bastaba con insertar una tienda nueva con plan 'pro' a mano.
--
-- POR QUÉ UN TRIGGER Y NO PERMISOS POR COLUMNA: con GRANTs por columna hay
-- que enumerar todas las columnas que SÍ se pueden escribir, y este esquema
-- gana columnas seguido (categorias, ml_reputacion, orden...). Cada columna
-- nueva quedaría fuera del permiso y el panel dejaría de poder guardarla, en
-- silencio. El trigger no se entera de las columnas nuevas: protege tres y
-- deja pasar el resto.

create or replace function public.proteger_campos_de_plan()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  rol   text := coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '');
  mejor text;
begin
  -- Solo se protege contra los roles del navegador. El servidor
  -- (service_role), las migraciones y el SQL directo somos nosotros: ahí el
  -- plan se toca a propósito, y es el único camino que verifica el pago
  -- contra Mercado Pago.
  if rol not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- Los tres campos quedan como estaban, pase lo que pase. Ningún flujo
    -- legítimo del panel los escribe desde el navegador: se comprobó.
    new.plan          := old.plan;
    new.plan_vence    := old.plan_vence;
    new.trial_ends_at := old.trial_ends_at;
    return new;
  end if;

  -- INSERT. El caso legítimo es el Pro que agrega un segundo negocio y le
  -- hereda su plan. Entonces el plan de la tienda nueva no se toma de lo que
  -- mande el navegador, sino del que ese usuario YA tiene en otra tienda
  -- suya: el Pro sigue funcionando igual y el que no tiene nada no puede
  -- inventarse uno.
  select p.plan into mejor
    from public.store_profiles p
   where p.user_id = new.user_id
     and p.plan in ('pro', 'cortesia', 'basic')
   order by case p.plan
              when 'pro'      then 1
              when 'cortesia' then 2
              else 3
            end
   limit 1;

  new.plan          := coalesce(mejor, 'trial');
  new.plan_vence    := null;
  new.trial_ends_at := now();   -- igual que el default: nace sin prueba
  return new;
end;
$$;

drop trigger if exists tr_proteger_campos_de_plan on public.store_profiles;

create trigger tr_proteger_campos_de_plan
  before insert or update on public.store_profiles
  for each row execute function public.proteger_campos_de_plan();

comment on function public.proteger_campos_de_plan() is
  'Impide que plan, plan_vence y trial_ends_at se escriban desde el navegador. Solo el servidor (service_role), que verifica el pago contra Mercado Pago, puede cambiarlos.';
