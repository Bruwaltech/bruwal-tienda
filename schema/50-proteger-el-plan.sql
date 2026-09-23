-- Una sola protección del plan, y que el multinegocio de Pro funcione.
--
-- CÓMO EMPEZÓ: buscando si alguien podía regalarse un plan desde el
-- navegador. La política sp_editar_propia deja al dueño actualizar toda su
-- fila de store_profiles, incluida la columna `plan`. Mirando solo las
-- políticas, el agujero parecía abierto.
--
-- NO LO ESTABA: ya había un trigger, proteger_campos_plan, que impedía
-- exactamente eso. No lo vi porque miré las políticas de RLS y no los
-- triggers. Agregué una segunda protección duplicada que, encima, corría
-- ANTES que la original y quedaba pisada por ella.
--
-- LO QUE SÍ FALTABA, y es lo que arregla este archivo:
--
-- 1. El trigger original forzaba plan='trial' en TODO insert. Un Pro que
--    agregaba un segundo negocio lo veía nacer bloqueado.
--
-- 2. Había un UNIQUE en user_id (una tienda por usuario) que quedó de
--    cuando la relación era 1 a 1. Con él, "Agregar tienda" fallaba con
--    "duplicate key value violates unique constraint". Es parte de lo que
--    se vende con Pro y no podía funcionar de ninguna manera.
--
-- El índice sale y en su lugar va la regla de negocio de verdad: UNA tienda
-- para todos, VARIAS solo con Pro. Un índice no puede expresar eso; el
-- trigger sí, y encima puede explicar por qué cuando dice que no.

drop index if exists public.store_profiles_user_id_unico;

-- Restos del intento duplicado.
drop trigger  if exists tr_proteger_campos_de_plan on public.store_profiles;
drop function if exists public.proteger_campos_de_plan();

create or replace function public.proteger_campos_plan()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  claims  text := nullif(current_setting('request.jwt.claims', true), '');
  rol_jwt text := '';
  mejor   text;
  cuantas integer;
begin
  -- OJO CON ESTO, que costó un rato: la función es SECURITY DEFINER para
  -- poder leer la tabla sin depender de las políticas. Eso hace que
  -- current_user sea el dueño (postgres) y NO el rol del navegador, así que
  -- la guarda original ("current_user not in ('authenticated','anon')")
  -- dejaba pasar todo. Medido: con esa versión el cliente se auto-asignaba
  -- 'pro'. Por eso el rol se mira por las dos puntas.
  --
  -- Y el claims se lee con red: si viene vacío o ilegible, el cast a jsonb
  -- tira error y el trigger abortaría la operación entera — nadie podría
  -- guardar nada en store_profiles.
  if claims is not null then
    begin
      rol_jwt := coalesce((claims::jsonb) ->> 'role', '');
    exception when others then
      rol_jwt := '';
    end;
  end if;

  if current_user not in ('authenticated', 'anon')
     and rol_jwt   not in ('authenticated', 'anon') then
    return new;   -- el servidor o una migración: ahí el plan se toca a propósito
  end if;

  if tg_op = 'UPDATE' then
    new.plan              := old.plan;
    new.trial_ends_at     := old.trial_ends_at;
    new.plan_vence        := old.plan_vence;
    new.mp_preapproval_id := old.mp_preapproval_id;
    new.plan_updated_at   := old.plan_updated_at;
    return new;
  end if;

  -- INSERT. El mejor plan que este usuario ya tiene en otra tienda suya.
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

  select count(*) into cuantas
    from public.store_profiles p
   where p.user_id = new.user_id;

  -- Varios negocios son de Pro (y de cortesía, que tiene todo). El mensaje
  -- se le muestra tal cual al que lo intenta.
  if cuantas > 0 and coalesce(mejor, '') not in ('pro', 'cortesia') then
    raise exception 'Tu plan permite un solo negocio. Con el plan Pro podes tener varios en la misma cuenta.'
      using errcode = 'check_violation';
  end if;

  -- El plan del negocio nuevo sale del que el usuario YA tiene, nunca de lo
  -- que mande el navegador. Sin ninguno, nace en prueba.
  new.plan              := coalesce(mejor, 'trial');
  new.trial_ends_at     := now();
  new.plan_vence        := null;
  new.mp_preapproval_id := null;
  new.plan_updated_at   := null;
  return new;
end;
$function$;

comment on function public.proteger_campos_plan() is
  'Única protección del plan: plan, plan_vence, trial_ends_at, mp_preapproval_id y plan_updated_at no se escriben desde el navegador. En un negocio nuevo el plan se hereda del que el usuario ya tiene, y tener más de uno requiere Pro.';

-- Verificación (probado contra la base real simulando el rol del navegador):
--   Pro agrega 2do negocio ......... nace con 'pro'
--   Sin Pro agrega 2do ............. rechazado con el mensaje
--   Cliente se pone 'pro' solo ..... queda como estaba
--   Cliente estira su prueba ....... queda como estaba
--   Servidor activa un plan ........ puede
