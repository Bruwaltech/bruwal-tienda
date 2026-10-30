-- ============================================================
-- Bot de Walter: no leídos, visto y etiquetas en Bruwal Chat, como en WhatsApp
-- Correr DESPUÉS de 72-walter-avisos-push.sql
-- ============================================================
--
-- no_leidos: cuántos mensajes del cliente entraron desde la última vez que
-- Walter abrió la charla. Lo suma este trigger con cada mensaje que entra y
-- vuelve a 0 cuando Walter le escribe o la abre en el panel.
-- etiquetas: las que Walter le pone a la charla ("Importante", "Cliente nuevo").
-- estado_wa: lo que avisa WhatsApp de cada mensaje que sale (sent, delivered,
-- read, failed): las tildes del panel. Lo escribe walter-bot.

alter table public.walter_conversaciones
  add column if not exists no_leidos integer not null default 0,
  add column if not exists etiquetas text[] not null default '{}';

alter table public.walter_mensajes
  add column if not exists estado_wa text check (estado_wa in ('sent', 'delivered', 'read', 'failed'));

create index if not exists walter_mensajes_wa_id on public.walter_mensajes (wa_id) where wa_id is not null;

create or replace function public.walter_contar_no_leidos()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.direccion = 'entra' then
    update public.walter_conversaciones set no_leidos = no_leidos + 1
      where canal = new.canal and usuario = new.usuario;
  elsif new.autor = 'walter' then
    update public.walter_conversaciones set no_leidos = 0
      where canal = new.canal and usuario = new.usuario;
  end if;
  return null;
end $$;

drop trigger if exists walter_contar_no_leidos on public.walter_mensajes;
create trigger walter_contar_no_leidos after insert on public.walter_mensajes
  for each row execute function public.walter_contar_no_leidos();

-- El primer mensaje de un cliente nuevo entra antes de que exista su charla:
-- al crearla se cuentan los que ya estaban.
create or replace function public.walter_no_leidos_inicial()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.no_leidos := (select count(*) from public.walter_mensajes m
    where m.canal = new.canal and m.usuario = new.usuario and m.direccion = 'entra');
  return new;
end $$;

drop trigger if exists walter_no_leidos_inicial on public.walter_conversaciones;
create trigger walter_no_leidos_inicial before insert on public.walter_conversaciones
  for each row execute function public.walter_no_leidos_inicial();

revoke execute on function public.walter_contar_no_leidos() from public, anon, authenticated;
revoke execute on function public.walter_no_leidos_inicial() from public, anon, authenticated;

-- El panel marca leída (o no leída) la charla y le cambia las etiquetas
grant update (no_leidos, etiquetas) on public.walter_conversaciones to authenticated;
