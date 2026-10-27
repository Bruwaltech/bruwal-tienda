-- ============================================================
--  BRUWAL — Stock que ya pidió alguien y la tienda todavía no
--  confirmó
--
--  El stock se descuenta recién cuando el negocio confirma el
--  pedido en el panel. Mientras tanto la tienda pública seguía
--  mostrando "Queda 1", y un producto con una sola unidad se podía
--  pedir una y otra vez (pasó en las pruebas de Kit zone).
--
--  reservado_en_pedidos(slug): cuántas unidades de cada producto
--  están en pedidos PENDIENTES de las últimas 48 horas. La tienda
--  se las resta al stock que muestra y no deja pedir más de lo que
--  queda libre. Pasadas las 48 h un pedido que nadie confirmó deja
--  de reservar: si no, uno abandonado bloquearía el producto para
--  siempre.
--
--  Solo devuelve product_id y una suma: nada del cliente.
--
--  Correr en Supabase -> SQL Editor. Aditivo e idempotente.
-- ============================================================

create or replace function public.reservado_en_pedidos(p_slug text)
returns table (product_id text, unidades numeric)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select it ->> 'product_id' as product_id,
         sum(coalesce(nullif(it ->> 'qty', '')::numeric, 1)) as unidades
    from public.orders o
   cross join lateral jsonb_array_elements(
           case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end) it
   where o.store_slug = p_slug
     and o.estado = 'pendiente'
     and o.created_at > (now() at time zone 'utc') - interval '48 hours'
     and it ->> 'product_id' is not null
   group by 1;
$function$;

grant execute on function public.reservado_en_pedidos(text) to anon, authenticated;

notify pgrst, 'reload schema';

-- Verificación
select 'reservas listas' as estado, count(*) as productos_reservados
  from public.reservado_en_pedidos('kitzone');
