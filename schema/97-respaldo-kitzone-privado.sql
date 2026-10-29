-- ============================================================
--  BRUWAL — Respaldo de precios de Kitzone del 28/10, privado
--
--  La tabla respaldo_precios_kitzone_20261028 se creó sin RLS, así
--  que con la clave pública de la tienda cualquiera podía leer los
--  408 productos con su COSTO, y también modificar o borrar el
--  respaldo.
--
--  Queda igual que el respaldo anterior (respaldo_precios_kitzone_20261009):
--  RLS prendido, sin políticas y sin permisos para anon/authenticated.
--  Solo se lee desde el SQL Editor. No borra ni cambia ninguna fila.
--
--  Correr en Supabase -> SQL Editor. Idempotente.
-- ============================================================

alter table if exists public.respaldo_precios_kitzone_20261028 enable row level security;
revoke all on table public.respaldo_precios_kitzone_20261028 from anon, authenticated;

-- Verificación: rls = true y permisos = 0
select 'respaldo kitzone privado' as estado,
       (select relrowsecurity from pg_class where oid = 'public.respaldo_precios_kitzone_20261028'::regclass) as rls,
       (select count(*) from information_schema.role_table_grants
         where table_name = 'respaldo_precios_kitzone_20261028'
           and grantee in ('anon', 'authenticated')) as permisos;
