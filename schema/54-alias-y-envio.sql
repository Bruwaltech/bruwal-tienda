-- ============================================================
--  BRUWAL — Datos para transferencia y "hago envíos o no".
--
--  transferencia: { alias, cbu, titular } que el negocio carga UNA vez en
--  Configuración. Se muestra en la venta de mostrador (para dictárselo o
--  mostrárselo al cliente), en el checkout de la tienda cuando el cliente
--  elige Transferencia o Mercado Pago, y en el ticket. Es un dato que el
--  negocio quiere que se vea: va en la tabla pública a propósito.
--
--  ofrece_envio: hasta ahora el checkout SIEMPRE ofrecía "Envío a
--  domicilio" para productos físicos. Una pizzería que solo trabaja con
--  retiro no tenía cómo sacarlo. Default true: las tiendas que ya existen
--  siguen igual que hoy.
-- ============================================================

alter table public.store_profiles
  add column if not exists transferencia jsonb,
  add column if not exists ofrece_envio boolean not null default true;
