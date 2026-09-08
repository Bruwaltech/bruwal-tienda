-- ============================================================
--  BRUWAL — Hora de entrega del pedido y demora del local.
--
--  Dos datos distintos, y por eso dos columnas:
--
--  · store_profiles.demora_minutos: cuanto esta tardando el
--    local AHORA. Lo fija el cocinero de un toque y cambia
--    varias veces por noche (a las 21 hay media hora de cola,
--    a las 23 no hay nadie). Sirve para SUGERIR una hora.
--
--  · orders.hora_entrega: para cuando es ESE pedido. Casi
--    siempre es "ahora + demora", pero cuando el cliente pide
--    "para las 22" manda el cliente. Guardado en el pedido, no
--    calculado al vuelo, porque si no cambia solo cuando el
--    cocinero mueve la demora — y una promesa hecha al cliente
--    no se puede mover sola.
--
--  Es timestamptz y no un "22:00" suelto a proposito: a las
--  23:50 se toman pedidos para las 00:30, que son del dia
--  siguiente. Con solo la hora, ese pedido se ordenaria primero
--  en la cola en vez de ultimo.
--
--  El NOTIFY del final NO es opcional: PostgREST cachea el
--  esquema y sin recargarlo rechaza las columnas nuevas como si
--  no existieran.
--
--  Correr en Supabase -> SQL Editor. Es idempotente.
-- ============================================================

alter table public.orders
  add column if not exists hora_entrega timestamptz;

alter table public.store_profiles
  add column if not exists demora_minutos integer;

-- La cocina mira la cola por hora de entrega, no por hora de carga.
create index if not exists orders_hora_entrega_idx
  on public.orders (store_slug, hora_entrega);

NOTIFY pgrst, 'reload schema';

-- Verificación
select 'entrega lista' as estado,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='orders'
          and column_name='hora_entrega') as col_hora_entrega,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_profiles'
          and column_name='demora_minutos') as col_demora_minutos;
