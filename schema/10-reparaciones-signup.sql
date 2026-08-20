-- ============================================================
--  BRUWAL — "¿Hacés reparaciones?" al registrarse
--  Correr en Supabase → SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es aditivo e idempotente.
-- ============================================================

-- Además de detectar el rubro por palabras clave (celular/electrónica en
-- el nombre o la descripción), esta columna deja prender Reparaciones a
-- mano: la tilda el dueño al registrarse (o después, en Configuración).
alter table public.store_profiles
  add column if not exists hace_reparaciones boolean not null default false;
