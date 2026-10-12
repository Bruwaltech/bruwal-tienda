-- ============================================================
--  BRUWAL — Pagar un pedido de la tienda con Mercado Pago.
--
--  El cliente elige "Mercado Pago" en el checkout, la tienda le
--  arma un link de pago con la cuenta de MP del negocio (la que
--  se conecta en Configuración, schema/59) y, cuando MP avisa que
--  el pago se aprobó, api/mercadopago.js marca el pedido como
--  pagado. El panel lo confirma solo la próxima vez que refresca,
--  con la misma lógica de stock que el botón Confirmar.
--
--  mp_pago_id: el id del pago en Mercado Pago. Único, para que el
--  mismo aviso repetido (MP reintenta) no se registre dos veces.
--  mp_monto: lo que pagó el cliente de verdad. El panel solo
--  confirma solo si cubre el total del pedido.
--
--  Necesita schema/59-mercadopago-tiendas.sql corrido antes.
--  Correr en Supabase -> SQL Editor. Aditivo e idempotente.
-- ============================================================

alter table public.orders
  add column if not exists mp_pago_id text;

alter table public.orders
  add column if not exists mp_monto numeric(12,2);

create unique index if not exists orders_mp_pago_unico
  on public.orders (mp_pago_id)
  where mp_pago_id is not null;

-- El pedido lo inserta el cliente anónimo y podría mandar un mp_pago_id
-- inventado para que el panel lo confirme como pagado. Al insertar se
-- borran siempre: el único que los escribe es api/mercadopago.js, con un
-- UPDATE, después de verificar el pago contra Mercado Pago.
create or replace function public.limpiar_pago_mp_del_pedido()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  new.mp_pago_id := null;
  new.mp_monto := null;
  return new;
end;
$function$;

create or replace trigger tr_limpiar_pago_mp_del_pedido
  before insert on public.orders
  for each row execute function public.limpiar_pago_mp_del_pedido();

NOTIFY pgrst, 'reload schema';

-- Verificación: tienen que dar 2 y 1
select
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='orders'
      and column_name in ('mp_pago_id','mp_monto'))                              as columnas_mp,
  (select count(*) from pg_trigger where tgname='tr_limpiar_pago_mp_del_pedido')  as trigger_limpieza;
