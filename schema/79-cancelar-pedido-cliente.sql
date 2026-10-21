-- ============================================================
--  BRUWAL — El cliente puede cancelar su pedido de la tienda
--
--  Después de "¡Pedido enviado!" la tienda online muestra un botón
--  "Cancelar pedido". Sirve mientras el negocio todavía no lo
--  confirmó (estado 'pendiente'); uno ya confirmado se cancela
--  hablando con el negocio, como siempre.
--
--  El cliente no tiene sesión, así que no puede tocar la tabla
--  orders. La tienda le da a cada pedido un código al azar
--  (token_cliente) que solo conoce el navegador que lo hizo, y la
--  función de abajo cancela el pedido que tenga ese código.
--
--  Correr en Supabase -> SQL Editor. Aditivo e idempotente.
-- ============================================================

alter table public.orders
  add column if not exists token_cliente uuid;

-- Un indice parcial: solo los pedidos de la tienda llevan código.
create index if not exists orders_token_cliente
  on public.orders (token_cliente) where token_cliente is not null;

-- Devuelve 'cancelado', 'ya_confirmado' (el negocio lo confirmó antes)
-- o 'no_encontrado'.
create or replace function public.cancelar_pedido_cliente(p_token uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_estado text;
begin
  if p_token is null then
    return 'no_encontrado';
  end if;

  select coalesce(estado, 'pendiente') into v_estado
    from public.orders
   where token_cliente = p_token
   limit 1;

  if not found then
    return 'no_encontrado';
  end if;
  if v_estado = 'cancelado' then
    return 'cancelado';
  end if;
  if v_estado <> 'pendiente' then
    return 'ya_confirmado';
  end if;

  update public.orders
     set estado = 'cancelado'
   where token_cliente = p_token
     and coalesce(estado, 'pendiente') = 'pendiente';
  return 'cancelado';
end;
$function$;

grant execute on function public.cancelar_pedido_cliente(uuid) to anon, authenticated;

-- Verificación
select 'cancelar pedido agregado' as estado,
       (select count(*) from information_schema.columns
         where table_schema = 'public' and table_name = 'orders' and column_name = 'token_cliente') as columna,
       (select count(*) from pg_proc where proname = 'cancelar_pedido_cliente') as funcion;
