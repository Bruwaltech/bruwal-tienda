-- ============================================================
--  BRUWAL — Precio por cantidad en porcentaje
--
--  Pedido de Walter: en los escalones mayoristas poder poner
--  directamente el % ("desde 10 u., un 5% menos") en vez del precio.
--  El panel guarda cada escalón así:
--      {"desde": 10, "precio": 9500, "descuento": 5}
--  "precio" sigue estando (ya calculado) para que la tienda y la
--  caja no cambien nada. "descuento" dice que ese precio sale del
--  precio de lista.
--
--  Este trigger recalcula "precio" cada vez que cambia el precio del
--  producto por cualquier camino: a mano, ajuste en lote, dólar,
--  lista de precios de Excel o Mercado Libre. Los escalones sin
--  "descuento" (precio fijo) no se tocan.
--
--  Mismo redondeo que el panel: pesos redondos; con precios chicos
--  (menos de 100) se dejan los centavos.
--
--  Sin esto el panel funciona igual, solo que un cambio de precio que
--  no pase por el formulario dejaría el escalón con el precio viejo.
--
--  Correr en Supabase -> SQL Editor. Aditivo e idempotente.
-- ============================================================

create or replace function public.trg_escalones_en_porcentaje()
returns trigger
language plpgsql
as $function$
begin
  if new.precios_por_cantidad is null
     or jsonb_typeof(new.precios_por_cantidad) <> 'array'
     or not (new.price > 0) then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.price is not distinct from old.price
     and new.precios_por_cantidad is not distinct from old.precios_por_cantidad then
    return new;
  end if;
  if not exists (
    select 1 from jsonb_array_elements(new.precios_por_cantidad) e
    where jsonb_typeof(e->'descuento') = 'number') then
    return new;
  end if;

  new.precios_por_cantidad := (
    select jsonb_agg(
             case
               when jsonb_typeof(t.e->'descuento') = 'number'
                and (t.e->>'descuento')::numeric > 0
                and (t.e->>'descuento')::numeric < 100
               then jsonb_set(t.e, '{precio}', to_jsonb(
                      case when new.price >= 100
                           then round(new.price * (1 - (t.e->>'descuento')::numeric / 100))
                           else round(new.price * (1 - (t.e->>'descuento')::numeric / 100), 2)
                      end))
               else t.e
             end
             order by t.ord)
    from jsonb_array_elements(new.precios_por_cantidad) with ordinality as t(e, ord));
  return new;
end;
$function$;

-- Antes que trg_precio_actualizado (los before triggers van por orden
-- alfabético), así la fecha de "precio actualizado" ve el escalón nuevo.
drop trigger if exists trg_escalones_en_porcentaje on public.store_products;
create trigger trg_escalones_en_porcentaje
  before insert or update on public.store_products
  for each row execute function public.trg_escalones_en_porcentaje();

-- Verificación
select 'escalones en porcentaje listo' as estado,
       (select count(*) from pg_trigger where tgname = 'trg_escalones_en_porcentaje') as trigger;
