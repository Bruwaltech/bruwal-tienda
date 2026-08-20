-- ============================================================
--  BRUWAL — El ingreso de una reparación entregada cuenta como venta
--  Correr en Supabase → SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es aditivo e idempotente.
-- ============================================================

-- Referencia opcional: de qué reparación salió ese pedido, para poder
-- cruzarlos después. No lleva "on delete cascade": si se borra la ficha
-- de reparación, el pedido (la plata que ya entró) queda igual.
alter table public.orders
  add column if not exists reparacion_id uuid references public.store_reparaciones(id) on delete set null;
