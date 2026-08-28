-- ============================================================
--  BRUWAL — Duración del turno, para que no se superpongan.
--
--  Caso real: un corte empieza 8:45 y dura una hora. Hasta ahora
--  el sistema solo marcaba ocupado el slot exacto de las 8:45, así
--  que dejaba tomar 9:00, 9:15 y 9:30 encima del mismo cliente.
--
--  Por qué una columna propia y no leer la duración del servicio:
--  store_turnos.servicio es TEXTO (el nombre del servicio, o varios
--  separados por coma), no una relación con store_products. Buscar
--  el producto por nombre sería frágil y además la duración podría
--  cambiar después y correr turnos ya reservados. La duración se
--  congela en el turno al momento de reservarlo.
--
--  null = turnos viejos, de antes de esta funcionalidad: se tratan
--  como un slot, que es exactamente como se comportaban.
--
--  Correr en Supabase -> SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es aditivo e idempotente.
-- ============================================================

alter table public.store_turnos
  add column if not exists duracion_minutos integer;

-- IMPRESCINDIBLE: la tienda pública consulta los turnos como visitante
-- anónimo para saber qué horarios están tomados, y ese acceso es por
-- COLUMNA (ver schema/03-turnos.sql). Sin sumar la duración acá, la tienda
-- seguiría viendo solo la hora de inicio y volvería a ofrecer horarios que
-- en realidad están pisados. Sigue sin poder leer nombre ni teléfono.
grant select (store_slug, fecha, hora, duracion_minutos) on public.store_turnos to anon;

NOTIFY pgrst, 'reload schema';

-- Verificación
select 'duracion_minutos lista en store_turnos' as estado,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_turnos' and column_name='duracion_minutos') as columna;
