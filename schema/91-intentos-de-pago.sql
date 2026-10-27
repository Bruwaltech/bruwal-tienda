-- ============================================================
--  BRUWAL — Intentos de pago de la suscripción
--
--  Cada vez que alguien aprieta "Suscribirme" en el panel queda una
--  fila: qué tienda, qué plan y a qué hora. Es lo que permite saber de
--  quién es una suscripción que llega SIN dueño (Mercado Pago no guarda
--  el external_reference del link y casi nunca da el email de quien
--  paga). Si en las horas previas a esa suscripción una sola tienda fue
--  a pagar ese plan, es de ella.
--
--  La escribe y la lee solo el servidor (api/suscripcion.js y el
--  webhook, con la service role). RLS prendido y sin políticas: desde
--  el navegador no se lee ni se escribe nada.
--
--  Correr en Supabase -> SQL Editor. Aditivo e idempotente.
-- ============================================================

create table if not exists public.store_intentos_pago (
  id         bigserial primary key,
  slug       text not null,
  plan       text not null check (plan in ('basic', 'pro')),
  creado     timestamptz not null default now(),
  -- La suscripción que se le atribuyó. Un intento sirve para UNA sola.
  usado_por  text
);

create index if not exists store_intentos_pago_creado
  on public.store_intentos_pago (creado);

alter table public.store_intentos_pago enable row level security;
revoke all on public.store_intentos_pago from anon, authenticated;

notify pgrst, 'reload schema';

-- Verificación
select 'intentos de pago listos' as estado,
       (select relrowsecurity from pg_class where oid = 'public.store_intentos_pago'::regclass) as rls,
       (select count(*) from pg_policies where tablename = 'store_intentos_pago') as politicas;
