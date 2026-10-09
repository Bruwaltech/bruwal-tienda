-- ============================================================
-- Alta del chatbot: Wabi import (tienda de Walter)
-- Correr DESPUES de 04-bot-whatsapp.sql
-- ============================================================
--
-- Es la primera tienda que usa el chatbot desde su propio panel. El boton
-- "Chatbot" del dashboard aparece cuando existe un cliente del bot con el
-- MISMO slug que la tienda (aca, 'wabi-import') y el usuario de la tienda
-- esta vinculado en cliente_usuarios. Para habilitarlo en otra tienda se
-- copia este archivo y se cambia el slug.
--
-- Antes de correrlo hay que completar lo marcado como PENDIENTE:
--   1. wa_phone_number_id: el id que Meta le asigna al numero de WhatsApp de
--      la tienda (Meta for Developers > WhatsApp > API Setup). NO el telefono.
--   2. numero_derivacion: a que WhatsApp se avisa cada consulta derivada.
--   3. El prompt: que vende Wabi import, como habla, que no tiene que decir.
--
-- Queda APAGADO (activo = false): el panel ya se puede usar, y el bot no
-- llama al modelo ni gasta nada hasta que se encienda al final.

insert into public.clientes (
  slug, nombre, wa_phone_number_id, activo, modelo, plan,
  limite_conversaciones, tope_duro, texto_upgrade,
  numero_derivacion, prompt
) values (
  'wabi-import',                   -- tiene que ser igual al slug de la tienda
  'Wabi import',

  'PENDIENTE_PHONE_NUMBER_ID',

  false,

  'claude-haiku-4-5',
  'esencial',

  120,
  360,
  null,

  'PENDIENTE_NUMERO_DE_WALTER',    -- formato 549341XXXXXXX, sin + ni espacios

$prompt$PENDIENTE: perfil del negocio. Quien es el asistente, que productos
vende Wabi import, como se compra y se envia, horarios, y que derivar a
Walter. Ver 05-cliente-grupo-alas.sql como ejemplo.$prompt$
)
on conflict (slug) do nothing;

-- ============================================================
-- QUIEN VE EL PANEL
-- ============================================================
--
-- El dueño de la tienda, el mismo usuario con el que entra al dashboard.
-- Sin esto el boton no aparece: la base no le devuelve el cliente.

insert into public.cliente_usuarios (cliente_id, user_id)
select c.id, s.user_id
from public.clientes c
join public.store_profiles s on s.slug = c.slug
where c.slug = 'wabi-import'
on conflict do nothing;

-- ============================================================
-- EL ULTIMO PASO — encender el bot
-- ============================================================

-- update public.clientes set activo = true, updated_at = now()
-- where slug = 'wabi-import';
