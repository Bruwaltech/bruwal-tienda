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
-- ultimo_*: el último mensaje de la charla, para mostrarlo en la lista como
-- WhatsApp sin leer todos los mensajes. Lo pone el mismo trigger.

alter table public.walter_conversaciones
  add column if not exists no_leidos integer not null default 0,
  add column if not exists etiquetas text[] not null default '{}',
  add column if not exists ultimo_texto text,
  add column if not exists ultimo_direccion text,
  add column if not exists ultimo_autor text,
  add column if not exists ultimo_creado timestamptz;

alter table public.walter_mensajes
  add column if not exists estado_wa text check (estado_wa in ('sent', 'delivered', 'read', 'failed'));

create index if not exists walter_mensajes_wa_id on public.walter_mensajes (wa_id) where wa_id is not null;

create or replace function public.walter_contar_no_leidos()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.walter_conversaciones set
    no_leidos = case when new.direccion = 'entra' then no_leidos + 1 when new.autor = 'walter' then 0 else no_leidos end,
    ultimo_texto = left(new.texto, 200), ultimo_direccion = new.direccion, ultimo_autor = new.autor, ultimo_creado = new.creado
    where canal = new.canal and usuario = new.usuario;
  return null;
end $$;

drop trigger if exists walter_contar_no_leidos on public.walter_mensajes;
create trigger walter_contar_no_leidos after insert on public.walter_mensajes
  for each row execute function public.walter_contar_no_leidos();

-- El primer mensaje de un cliente nuevo entra antes de que exista su charla:
-- al crearla se cuentan los que ya estaban.
create or replace function public.walter_no_leidos_inicial()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  u public.walter_mensajes%rowtype;
begin
  new.no_leidos := (select count(*) from public.walter_mensajes m
    where m.canal = new.canal and m.usuario = new.usuario and m.direccion = 'entra');
  select * into u from public.walter_mensajes m where m.canal = new.canal and m.usuario = new.usuario
    order by m.id desc limit 1;
  if found then
    new.ultimo_texto := left(u.texto, 200); new.ultimo_direccion := u.direccion;
    new.ultimo_autor := u.autor; new.ultimo_creado := u.creado;
  end if;
  return new;
end $$;

drop trigger if exists walter_no_leidos_inicial on public.walter_conversaciones;
create trigger walter_no_leidos_inicial before insert on public.walter_conversaciones
  for each row execute function public.walter_no_leidos_inicial();

-- Las charlas que ya estaban toman su último mensaje
update public.walter_conversaciones c set
  ultimo_texto = left(u.texto, 200), ultimo_direccion = u.direccion, ultimo_autor = u.autor, ultimo_creado = u.creado
from (select distinct on (canal, usuario) canal, usuario, texto, direccion, autor, creado
      from public.walter_mensajes order by canal, usuario, id desc) u
where u.canal = c.canal and u.usuario = c.usuario and c.ultimo_creado is null;

revoke execute on function public.walter_contar_no_leidos() from public, anon, authenticated;
revoke execute on function public.walter_no_leidos_inicial() from public, anon, authenticated;

-- El panel marca leída (o no leída) la charla y le cambia las etiquetas
grant update (no_leidos, etiquetas) on public.walter_conversaciones to authenticated;
