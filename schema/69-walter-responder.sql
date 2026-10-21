-- ============================================================
-- Bot de Walter: contestar citando un mensaje
-- Correr DESPUÉS de 68-walter-fotos-audios.sql
-- ============================================================
--
-- WhatsApp le da un id a cada mensaje (wamid…). Lo guardamos para que Walter
-- pueda contestar desde el panel citando un mensaje, como "Responder" en
-- WhatsApp, y para mostrar en la charla qué mensaje citó el cliente.

alter table public.walter_mensajes add column if not exists wa_id text;
alter table public.walter_mensajes add column if not exists responde_a text;
comment on column public.walter_mensajes.wa_id is
  'Id de WhatsApp del mensaje (wamid…). null en Messenger y en los mensajes de antes de schema/69';
comment on column public.walter_mensajes.responde_a is
  'Si el mensaje cita a otro (Responder en WhatsApp), el wa_id del citado';
