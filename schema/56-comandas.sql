-- ============================================================
--  BRUWAL — Panel de comandas (pizzerias, hamburgueserias, etc.)
--  Correr en Supabase -> SQL Editor. Aditivo e idempotente.
--
--  1) etapa: por donde va el pedido EN LA COCINA. Es una columna
--     aparte de "estado" a proposito: "estado" dice si el pedido
--     cuenta como venta (pendiente / confirmado / cancelado) y de
--     eso cuelgan el stock, la caja y las estadisticas. La cocina
--     necesita otra cosa: nuevo -> en preparacion -> listo ->
--     entregado. Mezclarlas en una sola columna obligaba a tocar
--     todo lo que ya lee "estado".
--     Puede quedar en null: las ventas de mostrador y los pedidos
--     viejos no pasan por la cocina y no aparecen en el tablero.
--
--  2) pagado: si la comanda ya esta abonada o hay que cobrarla al
--     entregar. Es independiente del medio de pago: una transferencia
--     puede no haber llegado todavia y un efectivo se cobra en la puerta.
--
--  3) tipo_entrega / direccion / direccion_detalle: la direccion
--     iba solo en el WhatsApp y no quedaba en el pedido, asi que el
--     panel no podia mostrar el mapa ni quien lo recibe.
-- ============================================================

alter table public.orders
  add column if not exists etapa text
    check (etapa in ('nuevo', 'en_preparacion', 'listo', 'entregado'));

alter table public.orders
  add column if not exists pagado boolean not null default false;

alter table public.orders
  add column if not exists tipo_entrega text;

alter table public.orders
  add column if not exists direccion text;

alter table public.orders
  add column if not exists direccion_detalle text;

NOTIFY pgrst, 'reload schema';

-- Verificacion: tienen que dar todos 1
select
  (select count(*) from information_schema.columns
   where table_schema='public' and table_name='orders' and column_name='etapa')             as etapa,
  (select count(*) from information_schema.columns
   where table_schema='public' and table_name='orders' and column_name='pagado')            as pagado,
  (select count(*) from information_schema.columns
   where table_schema='public' and table_name='orders' and column_name='tipo_entrega')      as tipo_entrega,
  (select count(*) from information_schema.columns
   where table_schema='public' and table_name='orders' and column_name='direccion')         as direccion,
  (select count(*) from information_schema.columns
   where table_schema='public' and table_name='orders' and column_name='direccion_detalle') as direccion_detalle;
