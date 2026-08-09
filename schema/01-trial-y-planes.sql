-- ============================================================
--  BRUWAL — Prueba gratis de 15 días y planes de suscripción
--  Correr en Supabase → SQL Editor → New query → Run
--
--  Es idempotente: se puede correr varias veces sin romper nada.
--  Es aditivo: no borra ni modifica datos existentes.
-- ============================================================

-- 1) Columnas nuevas -----------------------------------------
alter table public.store_profiles
  add column if not exists plan              text not null default 'trial',
  add column if not exists trial_ends_at     timestamptz,
  add column if not exists plan_updated_at   timestamptz,
  add column if not exists mp_preapproval_id text;

-- 2) Las tiendas nuevas arrancan con 15 días de prueba --------
alter table public.store_profiles
  alter column trial_ends_at set default (now() + interval '15 days');

-- 3) Backfill: a las tiendas que ya existen les contamos
--    los 15 días desde el día que se registraron.
update public.store_profiles
set trial_ends_at = created_at + interval '15 days'
where trial_ends_at is null;

-- 4) Valores permitidos en 'plan'
--    trial    = prueba gratis en curso
--    basic/pro= suscripción paga activa
--    cortesia = cuenta exenta, sin cargo y sin vencimiento
--    cancelado= se dio de baja
alter table public.store_profiles
  drop constraint if exists store_profiles_plan_check;

alter table public.store_profiles
  add constraint store_profiles_plan_check
  check (plan in ('trial', 'basic', 'pro', 'cortesia', 'cancelado'));

-- 5) Cuentas exentas: NOVALIS y Wabi import ------------------
--    Acceso completo, sin cargo y sin fecha de vencimiento.
update public.store_profiles
set plan            = 'cortesia',
    plan_updated_at = now()
where slug in ('novalis-5lf0q', 'wabi-import-rsmq3');

-- 6) Verificación --------------------------------------------
select business_name,
       plan,
       trial_ends_at,
       plan_updated_at
from public.store_profiles
order by created_at;

-- NOTA: la función de apoyo tienda_activa() vive en el archivo
-- 02-politicas-seguridad.sql. Se separó porque los delimitadores $$
-- se cortaban al pegarse en el editor SQL de Supabase, y acá no
-- hace falta: recién se usa cuando activemos las políticas.
