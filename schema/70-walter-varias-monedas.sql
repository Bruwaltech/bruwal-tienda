-- ============================================================
-- Bot de Walter: varios tipos de moneda en un mismo pedido
-- Correr DESPUÉS de 69-walter-responder.sql
-- ============================================================
--
-- Después de cada tipo de moneda el bot pregunta "¿Tenés monedas de otro tipo?"
-- y va sumando. Cada tipo queda como una línea en items. modo, tipo y cantidad
-- siguen resumiendo el pedido para lo que lee una sola línea: con todas
-- contadas, las unidades en total (tipo null); si alguna va por kilo, los kilos
-- estimados de todo. Los pedidos de un solo tipo siguen igual, con items null.

alter table public.walter_pedidos add column if not exists items jsonb;
comment on column public.walter_pedidos.items is
  'Con varios tipos de moneda: [{modo: u|kg, tipo, cant, precio, total}]. null si el pedido es de un solo tipo';
