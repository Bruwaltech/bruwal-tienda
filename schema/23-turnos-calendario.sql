-- ============================================================
--  BRUWAL — Agenda con calendario: el dueño puede bloquear un
--  horario sin cargar un cliente (almuerzo, permiso, lo que sea),
--  igual que ya puede cargar un turno con cliente a mano.
--  Correr en Supabase → SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es aditivo e idempotente.
-- ============================================================

-- true = horario bloqueado por el dueño, sin cliente asociado.
-- false (default) = turno real, reservado por un cliente o cargado
-- a mano por el dueño con sus datos.
alter table public.store_turnos
  add column if not exists bloqueado boolean not null default false;

-- Recordatorio manual: el dueño lo dispara con un clic desde el panel
-- (abre WhatsApp con el mensaje ya armado). Esta columna solo evita que
-- el mismo turno se ofrezca dos veces en la lista de "para recordar",
-- no confirma que el cliente lo haya leído.
alter table public.store_turnos
  add column if not exists recordatorio_enviado boolean not null default false;

-- Verificación
select 'bloqueo y recordatorio de turnos agregado' as estado,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_turnos'
          and column_name in ('bloqueado','recordatorio_enviado')) as columnas;
