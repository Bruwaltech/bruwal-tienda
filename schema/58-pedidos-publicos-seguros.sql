-- Pedidos que entran desde la tienda pública: siempre como "pendiente".
--
-- EL PROBLEMA: la política ord_crear_publico deja insertar en orders a
-- cualquiera (es lo que permite que un cliente haga un pedido sin cuenta).
-- Pero deja insertar CUALQUIER columna: con la clave pública, que está a la
-- vista en el HTML, alguien podía cargarle a cualquier tienda una venta
-- "confirmado", "pagado" y con el total que quisiera. Eso entra en la caja,
-- los reportes y las comisiones como si fuera una venta real.
--
-- LA SOLUCIÓN: un trigger antes de insertar. Si quien inserta es el dueño de
-- la tienda, alguien de su equipo con permiso de ventas/pedidos, o el
-- servidor (service role), no se toca nada. Si es cualquier otro (el
-- cliente desde tienda.html), el pedido entra como pendiente y sin los
-- campos que solo el negocio puede poner. La tienda pública ya manda
-- exactamente eso, así que para el cliente no cambia nada.
--
-- Para deshacerlo: drop trigger pedidos_publicos_seguros on public.orders;

create or replace function public.pedido_publico_seguro()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  if auth.uid() is not null and (
       exists (select 1 from public.store_profiles sp
                where sp.slug = new.store_slug and sp.user_id = auth.uid())
       or public.equipo_puede_alguno(new.store_slug, array['vender', 'pedidos', 'cocina'])
     ) then
    return new;
  end if;

  new.estado               := 'pendiente';
  new.pagado               := false;
  new.saldo_pendiente      := 0;
  new.vendedor             := null;
  new.reparacion_id        := null;
  new.trade_in_descripcion := null;
  new.trade_in_valor       := null;
  new.pagos_divididos      := null;
  new.etapa                := null;
  new.created_at           := now();
  return new;
end $$;

drop trigger if exists pedidos_publicos_seguros on public.orders;
create trigger pedidos_publicos_seguros
  before insert on public.orders
  for each row execute function public.pedido_publico_seguro();
