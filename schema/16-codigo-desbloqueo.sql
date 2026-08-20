-- ============================================================
--  BRUWAL — Código/patrón de desbloqueo del equipo en reparación
--  Correr en Supabase → SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es aditivo e idempotente.
-- ============================================================

alter table public.store_reparaciones
  add column if not exists codigo_desbloqueo text;

-- A propósito NO se imprime en la etiqueta (schema/14): la etiqueta queda
-- pegada al equipo físico, así que mostrar ahí la clave sería dejarla a la
-- vista de cualquiera que tenga el teléfono en la mano. Solo se ve adentro
-- del panel, protegido por las mismas políticas de store_reparaciones
-- (sin acceso público, solo el dueño de la tienda).
