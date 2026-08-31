-- ============================================================
--  BRUWAL — Tres cosas que le faltaban a una pizzeria
--  Correr en Supabase -> SQL Editor. Aditivo e idempotente.
--
--  1) pausado: "hoy no hay". Se acaba la fugazzeta a las 22 y hasta ahora
--     la unica forma de sacarla del menu era borrar el producto y volver
--     a cargarlo al otro dia, con foto y precio de nuevo.
--     No se usa el stock para esto a proposito: en gastronomia nadie lleva
--     stock de pizzas (las variantes de comida arrancan en 9999), asi que
--     poner el stock en 0 no es un mecanismo que el negocio use.
--
--  2) demora_texto: "listo en 30 a 40 minutos". Es lo primero que pregunta
--     el cliente y no habia donde decirlo. Es texto libre y no un numero
--     porque la respuesta real suele ser "30 a 40, los viernes una hora".
--
--  3) aclaraciones: lo que el cliente escribe al hacer el pedido -- "sin
--     sal", "cortada en 8", "el timbre no anda, llamar". Hasta ahora solo
--     se podia con agregados a $0, que no cubre lo escrito a mano.
-- ============================================================

alter table public.store_products
  add column if not exists pausado boolean not null default false;

alter table public.store_profiles
  add column if not exists demora_texto text;

alter table public.orders
  add column if not exists aclaraciones text;

NOTIFY pgrst, 'reload schema';

-- Verificacion: tienen que dar 1, 1 y 1
select
  (select count(*) from information_schema.columns
   where table_schema='public' and table_name='store_products' and column_name='pausado')      as pausado,
  (select count(*) from information_schema.columns
   where table_schema='public' and table_name='store_profiles' and column_name='demora_texto') as demora,
  (select count(*) from information_schema.columns
   where table_schema='public' and table_name='orders' and column_name='aclaraciones')         as aclaraciones;
