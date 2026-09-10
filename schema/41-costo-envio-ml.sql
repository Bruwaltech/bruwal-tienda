-- Costo del envío que absorbe el vendedor en una venta de Mercado Libre.
--
-- POR QUÉ HACE FALTA: hasta ahora la ganancia de una venta de ML se calculaba
-- como bruto − comisión − costo de la mercadería. Faltaba el envío, que en
-- una venta real fueron $11.000 que el vendedor puso de su bolsillo y que no
-- figuraban en ningún lado. Una ganancia sin ese número miente para arriba.
--
-- El dato no viene en la orden: vive en /shipments/{id}/costs, que es otra
-- llamada a la API. Ahí, senders[].cost es "the final shipping cost for each
-- user" — o sea lo que termina pagando el vendedor, ya con los descuentos
-- aplicados. Eso es lo que se guarda acá.
--
-- Queda en null cuando: la venta es un retiro en el local (no hay envío),
-- Mercado Libre todavía no devolvió los costos, o es una venta vieja de antes
-- de este cambio. Null significa "no lo sabemos", que NO es lo mismo que
-- cero: el panel muestra la ganancia solo cuando tiene todos los números.

alter table public.store_ml_ordenes
  add column if not exists costo_envio numeric;

comment on column public.store_ml_ordenes.costo_envio is
  'Lo que paga el VENDEDOR por el envío (senders[].cost de /shipments/{id}/costs). null = no se pudo averiguar o no hubo envío.';

-- PostgREST cachea el esquema: sin esto, la columna nueva no existe para la
-- API y el webhook falla con PGRST204 aunque la columna esté creada.
notify pgrst, 'reload schema';

-- Para comprobar que quedó:
select column_name, data_type
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'store_ml_ordenes'
   and column_name = 'costo_envio';
