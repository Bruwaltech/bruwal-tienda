-- ============================================================
--  BRUWAL — Pago dividido en un pedido (pedido de Empire Pizzas).
--
--  "Paga la mitad en efectivo y la mitad por transferencia." Un pedido
--  tenía UN medio_pago (texto) y no había dónde anotar cuánto entró por
--  cada uno, así que la caja y el arqueo no cerraban.
--
--  pagos_divididos: [{ medio, monto }, ...] — solo cuando se paga con más
--  de un medio. En ese caso medio_pago queda como "Efectivo + Transferencia"
--  para todo lo que ya lo lee como texto (ticket, listados), y la Caja y el
--  arqueo reparten el ingreso por medio con estos montos.
--  Null = pagó con un solo medio, el de medio_pago, como siempre.
--
--  La columna YA EXISTE en producción (26/10/2026): este archivo queda como
--  registro. Es aditivo e idempotente, correrlo de nuevo no cambia nada.
-- ============================================================

alter table public.orders
  add column if not exists pagos_divididos jsonb;
