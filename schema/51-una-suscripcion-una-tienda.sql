-- Una suscripción de Mercado Pago no puede sostener dos cuentas.
--
-- PASÓ DE VERDAD, y es lo peor que puede pasar en un sistema de cobros: UNA
-- suscripción quedó asignada a CUATRO tiendas de cuatro dueños distintos.
-- Tres estaban usando el sistema con el pago de la cuarta, y nadie se habría
-- enterado — el panel les mostraba "Plan activo, gracias por confiar".
--
-- CÓMO PASÓ: el rescate por email (que existe porque Mercado Pago no guarda
-- el external_reference que mandamos en el link) comparaba así:
--
--   String(p.payer_email || '').toLowerCase() === String(email).toLowerCase()
--
-- Si Mercado Pago no devuelve payer_email en la búsqueda, ese lado queda en
-- '' — y cualquier cosa que también dé '' hace juego. Comparar dos vacíos y
-- darlos por iguales es regalar el acceso.
--
-- Ya se arregló en el código, dos veces: el email del pagador ahora tiene
-- que existir y contener '@', y antes de atar una suscripción se comprueba
-- que no sea de otra tienda.
--
-- Esto es la tercera red, la de abajo: aunque el código vuelva a fallar, la
-- base no deja que la misma suscripción aparezca en dos filas. Un índice no
-- se olvida ni se equivoca.

create unique index if not exists store_profiles_una_suscripcion_una_tienda
  on public.store_profiles (mp_preapproval_id)
  where mp_preapproval_id is not null;

comment on index public.store_profiles_una_suscripcion_una_tienda is
  'Una suscripción de Mercado Pago sostiene UNA sola tienda. Parcial: las que no tienen suscripción (plan a mano, cortesía, prueba) quedan fuera y pueden ser muchas.';

-- Verificado contra la base: intentar asignarle a otra tienda una
-- suscripción ya tomada devuelve unique_violation.
