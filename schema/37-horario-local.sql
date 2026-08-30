-- ============================================================
--  BRUWAL — Horario de atencion del local (gastronomia)
--  Correr en Supabase -> SQL Editor. Aditivo e idempotente.
--
--  Por que hace falta: la tienda tomaba pedidos las 24 horas. Una
--  pizzeria que abre 19:00 y cierra 00:30 recibia pedidos a las 4 de
--  la manana y los veia al mediodia siguiente.
--
--  OJO: no confundir con store_profiles.turnos. Eso es la agenda de
--  una peluqueria (que horarios puede reservar un cliente). Esto es
--  otra cosa: si el local esta abierto o cerrado AHORA.
--
--  Forma del jsonb:
--    {
--      "activo": true,                  -- mostrar abierto/cerrado en la tienda
--      "bloquearCerrado": false,        -- ademas, no dejar pedir con el local cerrado
--      "dias": {
--        "0": { "activo": false, "franjas": [] },
--        "5": { "activo": true,  "franjas": [{"desde":"19:00","hasta":"00:30"}] }
--      }
--    }
--
--  Domingo = 0 ... Sabado = 6, mismo criterio que Date.getDay() en el
--  resto del codigo. "hasta" menor que "desde" significa que cierra
--  despues de medianoche (19:00 a 00:30), no que este mal cargado.
-- ============================================================

alter table public.store_profiles
  add column if not exists horario_local jsonb;

-- Verificacion
select 'horario del local agregado' as estado,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_profiles'
          and column_name='horario_local') as columnas;
