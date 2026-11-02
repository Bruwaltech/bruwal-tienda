-- ============================================================
--  BRUWAL — Avisos de cobro rechazado de la suscripción
--
--  Cuando Mercado Pago no puede cobrar una cuota, reintenta varias
--  veces. A cada intento fallido le corresponde UN mail al cliente,
--  nunca dos: esta tabla es la marca. La clave es el cobro de Mercado
--  Pago (authorized_payment) más el número de reintento, así el mismo
--  aviso que llega dos veces (webhook + revisión diaria, o Mercado Pago
--  que repite el webhook) no manda otro correo.
--
--  La escribe y la lee solo el servidor (webhook y revisión diaria,
--  con la service role). RLS prendido y sin políticas.
--
--  Correr en Supabase -> SQL Editor. Aditivo e idempotente.
-- ============================================================

create table if not exists public.suscripcion_avisos_cobro (
  cobro_id   text not null,          -- id del authorized_payment de Mercado Pago
  intento    int  not null default 0, -- retry_attempt de Mercado Pago
  slug       text not null,
  enviado_en timestamptz not null default now(),
  primary key (cobro_id, intento)
);

alter table public.suscripcion_avisos_cobro enable row level security;
revoke all on public.suscripcion_avisos_cobro from anon, authenticated;

notify pgrst, 'reload schema';

-- Verificación
select 'avisos de cobro listos' as estado,
       (select relrowsecurity from pg_class where oid = 'public.suscripcion_avisos_cobro'::regclass) as rls,
       (select count(*) from pg_policies where tablename = 'suscripcion_avisos_cobro') as politicas;
