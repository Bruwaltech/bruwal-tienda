-- ============================================================
--  BRUWAL — Arreglo del aviso de seguridad de Supabase (03/11/2026)
--
--  1) CRÍTICO. La tabla de respaldo respaldo_precios_kitzone_20261028
--     (408 filas: nombre, precio, oferta y COSTO de Kitzone) se creó
--     sin RLS, así que cualquiera con la URL del proyecto y la clave
--     pública podía leerla, cambiarla o borrarla. La app no la usa:
--     es una copia de seguridad. Se prende RLS sin políticas y se le
--     sacan los permisos a anon/authenticated. Queda solo para el
--     SQL Editor / service role, igual que los otros respaldos.
--
--  2) Funciones de trigger expuestas por /rest/v1/rpc. Son funciones
--     que solo deben correr como trigger; Postgres revisa el permiso
--     EXECUTE al crear el trigger, no cada vez que se dispara, así que
--     sacarles EXECUTE no cambia nada en tiendas, caja ni pagos.
--
--  3) register_sale (vieja, la app no la llama): se le saca a anon.
--     Igual exigía estar logueado (auth.uid()).
--
--  4) search_path fijo en las 7 funciones que el asesor marca, para
--     que nadie pueda "colar" otra tabla/función con el mismo nombre.
--
--  Correr en Supabase -> SQL Editor. Idempotente. No borra datos.
-- ============================================================

-- 1) Respaldo de precios Kitzone del 28/10
alter table if exists public.respaldo_precios_kitzone_20261028 enable row level security;
revoke all on public.respaldo_precios_kitzone_20261028 from anon, authenticated;

-- 2) Funciones de trigger: nadie las llama a mano
revoke execute on function public.congelar_afiliado_del_pedido()   from public, anon, authenticated;
revoke execute on function public.enforce_product_limit()          from public, anon, authenticated;
revoke execute on function public.equipo_proteger_producto()       from public, anon, authenticated;
revoke execute on function public.frenar_pedido_tienda_cerrada()   from public, anon, authenticated;
revoke execute on function public.handle_new_user()                from public, anon, authenticated;
revoke execute on function public.proteger_campos_plan()           from public, anon, authenticated;
revoke execute on function public.proteger_features()              from public, anon, authenticated;
revoke execute on function public.trg_precio_actualizado()         from public, anon, authenticated;
revoke execute on function public.trg_escalones_en_porcentaje()    from public, anon, authenticated;

-- 3) register_sale: solo usuarios logueados
revoke execute on function public.register_sale(uuid, integer) from public, anon;
grant  execute on function public.register_sale(uuid, integer) to authenticated;

-- 4) search_path fijo
alter function public.handle_new_user()                 set search_path = public, extensions;
alter function public.enforce_product_limit()           set search_path = public, extensions;
alter function public.register_sale(uuid, integer)      set search_path = public, extensions;
alter function public.slugify(text)                     set search_path = public, extensions;
alter function public.generate_unique_slug(text)        set search_path = public, extensions;
alter function public.trg_precio_actualizado()          set search_path = public, extensions;
alter function public.trg_escalones_en_porcentaje()     set search_path = public, extensions;

notify pgrst, 'reload schema';

-- Verificación: tiene que dar rls = true y anon_lee = false
select c.relrowsecurity as rls,
       has_table_privilege('anon', 'public.respaldo_precios_kitzone_20261028', 'select') as anon_lee
from pg_class c
where c.oid = 'public.respaldo_precios_kitzone_20261028'::regclass;

-- ------------------------------------------------------------
--  Para volver atrás (si hiciera falta):
--  alter table public.respaldo_precios_kitzone_20261028 disable row level security;
--  grant execute on function public.<funcion>() to public;
--  alter function public.<funcion>() reset search_path;
-- ------------------------------------------------------------
