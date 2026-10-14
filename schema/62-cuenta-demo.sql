-- ============================================================
--  BRUWAL — Cuenta demo para mostrar el sistema en reuniones.
--
--  Una tienda marcada con es_demo = true muestra arriba del panel
--  una barra para elegir el rubro (celulares, ropa, peluquería,
--  comida, cafetería, vape, kiosco), escribir el nombre del negocio
--  del cliente y cargar productos, ventas del último mes, turnos y
--  reparaciones de ejemplo. El mismo botón resetea la demo: BORRA
--  todo lo de esa tienda y la vuelve a armar (ver demo.js).
--
--  Por eso es_demo lo pone solo el administrador, desde acá.
--
--  PASOS:
--   1. Crear una cuenta normal en bruwal (registrarse) con el mail
--      que va a usar la demo, por ejemplo demo@... — cualquier rubro.
--   2. Cambiar el mail de abajo y correr todo esto en
--      Supabase → SQL Editor. Aditivo e idempotente.
--   3. Entrar al panel con esa cuenta: aparece la barra 🎬.
-- ============================================================

alter table public.store_profiles
  add column if not exists es_demo boolean not null default false;

comment on column public.store_profiles.es_demo is
  'Tienda de demostración: el panel ofrece cargar datos de ejemplo por rubro, BORRANDO lo que tenga. No sale en el sitemap.';

NOTIFY pgrst, 'reload schema';

-- Marcar la cuenta demo. Cortesía: acceso completo sin vencimiento, para
-- que no se trabe en medio de una reunión.
update public.store_profiles
   set es_demo = true,
       plan = 'cortesia',
       plan_vence = null
 where user_id = (select id from auth.users where lower(email) = lower('CAMBIAR-POR-EL-MAIL-DE-LA-DEMO'));

-- Verificación: tiene que aparecer la tienda demo con plan cortesia.
select slug, business_name, plan, es_demo
  from public.store_profiles
 where es_demo;
