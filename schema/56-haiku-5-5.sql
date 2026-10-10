-- ============================================================
-- Permitir Claude Haiku 5.5 en el bot de WhatsApp
-- Correr DESPUES de 04-bot-whatsapp.sql
-- ============================================================
--
-- Haiku 5.5 cuesta una decima parte de Haiku 4.5. Para un cliente con ~1.800
-- conversaciones por mes es la diferencia entre ~USD 110 y ~USD 11 de IA.
-- El nombre de la restriccion es el que Postgres le puso solo en 04.

alter table public.clientes drop constraint if exists clientes_modelo_check;
alter table public.clientes add constraint clientes_modelo_check
  check (modelo in ('claude-haiku-4-5', 'claude-haiku-5-5', 'claude-sonnet-5', 'claude-opus-5'));
