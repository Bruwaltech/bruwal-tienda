-- ============================================================
-- Bot de Walter: precio por tipo de moneda
-- ============================================================
-- Walter paga distinto cada moneda contada ($10, $2, 50 centavos...) y también
-- compra llaves por unidad. Los tipos viven en walter_config.data.monedas como
-- [{ "n": "$10", "u": 46, "kg": 111 }, ...]: nombre, precio por unidad y cuántas
-- entran en un kilo (para la prioridad de la hoja de ruta). Se cambian desde la
-- pestaña Precios del panel.
--
-- Acá solo se agrega en qué tipo quedó cada pedido contado por unidad.
-- ============================================================

alter table public.walter_pedidos add column if not exists tipo text;

comment on column public.walter_pedidos.tipo is
  'Tipo de moneda (o Llaves) de un pedido por unidad; null en los pedidos por kilo';
