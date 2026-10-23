-- ============================================================
--  BRUWAL — Cerrar las tablas de respaldo que quedaron abiertas.
--
--  Tres tablas de respaldo hechas a mano en public quedaron con RLS
--  DESACTIVADO, y en Supabase anon/authenticated tienen permisos sobre
--  todo lo de public: cualquiera con la llave pública (la del HTML del
--  panel) las podía leer, y también editar o borrar, por /rest/v1.
--    - respaldo_carolina_20261002       (1 fila de store_profiles, con
--                                        email, teléfono y pin_costos)
--    - backup_duplicados_ml_20260930    (65 filas de orders/store_gastos
--                                        borradas como duplicadas de ML)
--    - backup_tienda_borrada_pelustars  (11 filas de la tienda demo)
--
--  RLS activado y SIN políticas = desde el navegador (anon y
--  authenticated) no se ve ni se toca nada. La service role y el SQL
--  Editor siguen leyéndolas igual, así que el respaldo sigue sirviendo.
--  No borra nada ni cambia datos. Probado antes en una transacción
--  abortada: anon pasó de 1/65/11 filas visibles a 0/0/0.
--
--  backup_planes_20260922 ya tenía RLS sin políticas: no se toca.
--  Cada ALTER va con "if exists" para que el archivo se pueda volver a
--  correr aunque alguna de estas tablas se borre más adelante.
-- ============================================================

alter table if exists public.respaldo_carolina_20261002      enable row level security;
alter table if exists public.backup_duplicados_ml_20260930   enable row level security;
alter table if exists public.backup_tienda_borrada_pelustars enable row level security;

-- Verificación: las tres tienen que dar rls = true y 0 políticas.
select c.relname as tabla,
       c.relrowsecurity as rls,
       (select count(*) from pg_policies p
         where p.schemaname = 'public' and p.tablename = c.relname) as politicas
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('respaldo_carolina_20261002',
                    'backup_duplicados_ml_20260930',
                    'backup_tienda_borrada_pelustars',
                    'backup_planes_20260922')
order by 1;
