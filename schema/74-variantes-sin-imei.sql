-- 74 · Copia de `variantes` sin el IMEI de cada unidad, para la tienda.
--
-- Los celulares guardan cada equipo dentro de variantes[].imeis con su IMEI,
-- GB, bateria, color y precio. La tienda necesita todo eso para mostrar el
-- rango de precios y las opciones, MENOS el IMEI. Una columna no se puede
-- recortar por clave con un grant, asi que se mantiene una copia limpia.
--
-- Esta migracion es SOLO aditiva y va ANTES de deployar tienda.html, que lee
-- `variantes:variantes_publicas`. La 75 es la que le saca `variantes` a anon.
--
-- El trigger se llama trg_variantes_publicas a proposito: los BEFORE de
-- Postgres corren por orden alfabetico y tiene que correr DESPUES de
-- trg_equipo_proteger_producto, que puede reemplazar la fila entera.

create or replace function public.variantes_sin_imei(v jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select case
    when v is null or jsonb_typeof(v) <> 'array' then v
    else coalesce((
      select jsonb_agg(
        case when jsonb_typeof(e) = 'object' then
          (e - 'imei') ||
          case when jsonb_typeof(e -> 'imeis') = 'array' then
            jsonb_build_object('imeis', (
              -- Unidad vieja guardada como texto = solo el IMEI: queda {}
              -- (la tienda la cuenta igual como una unidad lista).
              select coalesce(jsonb_agg(
                case when jsonb_typeof(u) = 'object' then u - 'imei' else '{}'::jsonb end
                order by o), '[]'::jsonb)
              from jsonb_array_elements(e -> 'imeis') with ordinality x(u, o)))
          else '{}'::jsonb end
        else e end
        order by i)
      from jsonb_array_elements(v) with ordinality y(e, i)), '[]'::jsonb)
  end
$$;

alter table public.store_products add column if not exists variantes_publicas jsonb;

create or replace function public.trg_variantes_publicas()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.variantes_publicas := public.variantes_sin_imei(new.variantes);
  return new;
end
$$;

drop trigger if exists trg_variantes_publicas on public.store_products;
create trigger trg_variantes_publicas
  before insert or update on public.store_products
  for each row execute function public.trg_variantes_publicas();

update public.store_products
   set variantes_publicas = public.variantes_sin_imei(variantes)
 where variantes is not null;

grant select (variantes_publicas) on public.store_products to anon;

notify pgrst, 'reload schema';
