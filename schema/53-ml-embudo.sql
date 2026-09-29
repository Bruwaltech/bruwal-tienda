-- ============================================================
--  BRUWAL — Embudo de conversión por publicación de Mercado Libre.
--
--  PARA QUÉ: hoy se ve cuánto se vendió, pero no cuánta gente MIRÓ y no
--  compró. Esa diferencia es la que dice dónde se está perdiendo plata:
--
--    · Visitas y ninguna venta  → no es un problema de publicidad. Es el
--      precio, la foto o la ficha. Meterle plata a Ads ahí es tirarla.
--    · Convierte bien, pocas visitas → ESA es la que conviene publicitar.
--
--  Sin este dato las dos cosas se adivinan, que es exactamente lo que
--  veníamos haciendo.
--
--  POR QUÉ GUARDA UNA FOTO POR DÍA (fecha_corte está en la clave):
--  /visits/items devuelve el total de un rango, no el detalle día por día.
--  Si hubiera una sola fila por publicación, cada sincronizada pisaría la
--  anterior y nunca se podría saber si una publicación MEJORÓ después de
--  cambiarle el precio o la foto. Con la foto diaria, comparar contra la
--  semana pasada sale solo.
--
--  La ventana (dias) también está en la clave: 7 y 30 días contestan
--  preguntas distintas y no tienen por qué pisarse.
--
--  Es aditivo e idempotente.
-- ============================================================

create table if not exists public.store_ml_embudo (
  store_slug     text not null references public.store_profiles(slug),
  ml_item_id     text not null,
  dias           integer not null,
  fecha_corte    date not null default current_date,

  titulo         text,
  visitas        integer not null default 0,
  -- ventas = cantidad de ÓRDENES; unidades = cuántos potes salieron. No es
  -- lo mismo: una orden de 3 unidades es una conversión, no tres.
  ventas         integer not null default 0,
  unidades       numeric not null default 0,
  facturado      numeric not null default 0,

  -- La calcula la base y no quien escribe: así no puede quedar
  -- desactualizada respecto de visitas y unidades. Es EL número que se
  -- mira; no tiene que depender de que el que guarda se acuerde.
  conversion     numeric generated always as (
                   case when visitas > 0
                        then round((unidades / visitas::numeric) * 100, 2)
                        else null end
                 ) stored,

  actualizado_en timestamptz not null default now(),

  primary key (store_slug, ml_item_id, dias, fecha_corte)
);

-- Se lee siempre "lo último de esta tienda para esta ventana".
create index if not exists store_ml_embudo_lectura
  on public.store_ml_embudo (store_slug, dias, fecha_corte desc);

alter table public.store_ml_embudo enable row level security;

-- SOLO LECTURA, y solo lo propio. Igual que store_ml_preguntas: lo único
-- que escribe es la Edge Function con el service role. Si el navegador
-- pudiera escribir, cualquiera podría maquillar sus propios números.
drop policy if exists "dueno lee su embudo ML" on public.store_ml_embudo;
create policy "dueno lee su embudo ML" on public.store_ml_embudo
  for select using (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_ml_embudo.store_slug
      and sp.user_id = auth.uid()));

notify pgrst, 'reload schema';

-- Verificación
select 'embudo ML' as estado,
       (select count(*) from information_schema.tables
         where table_schema='public' and table_name='store_ml_embudo') as tabla,
       (select count(*) from pg_policies
         where schemaname='public' and tablename='store_ml_embudo') as politicas,
       (select rowsecurity from pg_tables
         where schemaname='public' and tablename='store_ml_embudo') as rls;
