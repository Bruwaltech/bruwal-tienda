-- ============================================================
--  BRUWAL — Pago dividido en un pedido (pedido de Empire Pizzas).
--
--  "Paga la mitad en efectivo y la mitad por transferencia." Hasta ahora
--  un pedido tenía UN medio_pago (texto) y no había dónde anotar cuánto
--  entró por cada uno, así que la caja no cerraba.
--
--  pagos_divididos: [{ medio, monto }, ...] — solo cuando se paga con más
--  de un medio. En ese caso medio_pago queda como "Efectivo + Transferencia"
--  para todo lo que ya lo lee como texto (ticket, listados), y la Caja
--  reparte el ingreso por medio con estos montos.
--  Null = pagó con un solo medio, el de medio_pago, como siempre.
-- ============================================================

alter table public.orders
  add column if not exists pagos_divididos jsonb;
