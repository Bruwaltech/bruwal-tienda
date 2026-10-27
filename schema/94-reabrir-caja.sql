-- ============================================================
--  BRUWAL — Reabrir una caja que ya se cerró (arqueo por caja)
--
--  Pedido de Distribuidora JACI: el cajero cierra la caja y después
--  aparece una venta más, o se equivocó al contar. Hasta ahora una caja
--  cerrada no se podía volver a tocar (la política arqueos_cerrar de
--  88-arqueo-por-caja.sql solo deja hacer update mientras está abierta).
--
--  reabrir_arqueo(id): vuelve a abrir la caja de ese día. El cierre que
--  tenía NO se pierde: se guarda en cierres_anteriores (cuándo cerró,
--  cuánto esperaba, cuánto contó, la diferencia), así se ve si alguien
--  cierra y reabre para tapar un faltante. En el panel lo autoriza el
--  dueño con el PIN y queda en el registro de seguridad.
--
--  La política de update sigue igual: el panel no puede borrar el
--  cierre con un update común, solo con esta función.
--
--  Correr en Supabase -> SQL Editor. Aditivo e idempotente.
-- ============================================================

alter table public.store_arqueos
  add column if not exists cierres_anteriores jsonb not null default '[]'::jsonb;

create or replace function public.reabrir_arqueo(p_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update public.store_arqueos a
     set cierres_anteriores = a.cierres_anteriores || jsonb_build_array(jsonb_build_object(
           'cerrado_at', a.cerrado_at,
           'efectivo_esperado', a.efectivo_esperado,
           'efectivo_contado', a.efectivo_contado,
           'diferencia', a.diferencia,
           'reabierto_at', now())),
         cerrado_at = null,
         efectivo_esperado = null,
         efectivo_contado = null,
         diferencia = null
   where a.id = p_id
     and a.cerrado_at is not null
     and exists (
       select 1 from public.store_profiles sp
       where sp.slug = a.store_slug
         and (sp.user_id = auth.uid() or public.equipo_es_miembro(sp.slug)));
  if not found then
    raise exception 'No se encontró esa caja cerrada en tu tienda.';
  end if;
end;
$function$;

revoke execute on function public.reabrir_arqueo(uuid) from public, anon;
grant execute on function public.reabrir_arqueo(uuid) to authenticated;

notify pgrst, 'reload schema';

-- Verificación
select 'reabrir caja listo' as estado,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_arqueos' and column_name='cierres_anteriores') as col,
       (select count(*) from pg_proc where proname='reabrir_arqueo') as funcion;
