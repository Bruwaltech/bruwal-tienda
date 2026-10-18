-- ============================================================
-- Bruwal Chat: Walter atiende las charlas desde el panel
-- Correr DESPUÉS de 63-bruwal-chat.sql y 66-walter-aviso-dia.sql
-- ============================================================
--
-- Walter contesta desde el panel y el mensaje sale por el número del bot, así
-- el cliente nunca ve su WhatsApp personal. Mientras él atiende una charla el
-- bot no contesta en ella; cuando termina, se la devuelve. Mandar, borrar una
-- charla y cargar un contacto nuevo los hace walter-bot (?tarea=panel), que
-- revisa que quien llama esté habilitado: acá solo se agrega lo que el panel
-- lee y la pausa, que el panel cambia directo.

-- Quién escribió cada mensaje que sale: el bot o Walter desde el panel.
alter table public.walter_mensajes add column if not exists autor text
  check (autor in ('bot', 'walter'));
comment on column public.walter_mensajes.autor is
  'Mensajes que salen: bot o walter (escrito desde el panel). null en los viejos y en los que entran';

-- Con la charla en pausa, el bot guarda lo que llega pero no contesta.
alter table public.walter_conversaciones add column if not exists bot_pausado boolean not null default false;
comment on column public.walter_conversaciones.bot_pausado is
  'true mientras Walter atiende la charla desde el panel: el bot no contesta';

-- Los contactos que Walter carga a mano traen la localidad que él anotó.
alter table public.walter_conversaciones add column if not exists localidad text;

-- El panel marca atendida y pausa o devuelve la charla al bot.
grant update (pide_humano, bot_pausado) on public.walter_conversaciones to authenticated;

-- El panel se actualiza solo: Realtime le avisa cuando entra un mensaje, un
-- pedido o cambia una charla. Realtime aplica las mismas políticas de lectura,
-- así que solo le llega a quien está habilitado.
do $$
declare t text;
begin
  foreach t in array array['walter_mensajes', 'walter_pedidos', 'walter_conversaciones'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
