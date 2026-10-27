-- ============================================================
--  BRUWAL — Checkout: elegir el vendedor de una lista y textos
--  de "Aclaraciones" a gusto de cada tienda (pedido de Kit zone)
--
--  1) store_profiles.textos_checkout: lo que el negocio escribe en
--     Configuración para el campo "Aclaraciones" del checkout.
--     {"aclaraciones_titulo": "...", "aclaraciones_ayuda": "..."}
--     null = los textos de siempre. La edita el dueño como el resto
--     del perfil; la llave pública no la lee (73), por eso sale por
--     la función de abajo.
--
--  2) checkout_de_tienda(slug): lo que la tienda pública necesita
--     para armar el checkout, en una sola llamada:
--       - afiliados: los vendedores activos (código y nombre, y el
--         descuento que le dan al cliente). Sin comisión ni teléfono,
--         igual que afiliado_de_tienda().
--       - textos: los de (1).
--     La comisión la sigue poniendo la base al guardar el pedido
--     (trigger de 60-afiliados.sql), no el navegador.
--
--  Correr en Supabase -> SQL Editor. Aditivo e idempotente.
-- ============================================================

alter table public.store_profiles
  add column if not exists textos_checkout jsonb;

create or replace function public.checkout_de_tienda(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  select jsonb_build_object(
    'afiliados', coalesce((
      select jsonb_agg(jsonb_build_object(
               'codigo', a.codigo, 'nombre', a.nombre, 'descuento_pct', a.descuento_pct)
             order by lower(a.nombre))
        from public.store_afiliados a
       where a.store_slug = p_slug and a.activo), '[]'::jsonb),
    'textos', (select sp.textos_checkout from public.store_profiles sp where sp.slug = p_slug)
  );
$function$;

grant execute on function public.checkout_de_tienda(text) to anon, authenticated;

notify pgrst, 'reload schema';

-- Verificación
select 'checkout listo' as estado,
       (select count(*) from information_schema.columns
         where table_schema='public' and table_name='store_profiles' and column_name='textos_checkout') as col_textos,
       public.checkout_de_tienda('kitzone') -> 'afiliados' as afiliados_kitzone;
