-- ============================================================
-- Bruwal Chat: el área de chatbots para clientes, tengan o no tienda
-- Correr DESPUÉS de 04-bot-whatsapp.sql y 62-bot-walter.sql
-- ============================================================
--
-- Bruwal Chat es el panel de /chat (/asistente sigue andando). Usa el mismo
-- login y la misma base que el resto de BRUWAL: cada negocio es una fila de
-- public.clientes y lo ven los usuarios vinculados en cliente_usuarios. Un
-- negocio sin tienda entra igual.
--
-- Hay dos tipos de chatbot y el panel muestra lo que corresponde a cada uno:
--   ia       el asistente con IA de api/whatsapp.js. Panel: contactos.
--   monedas  el bot de flujo fijo de Walter (walter-bot). Panel: pedidos,
--            hoja de ruta, precios y charlas.

-- ============================================================
-- 1) TIPO DE CHATBOT
-- ============================================================

alter table public.clientes
  add column if not exists tipo text not null default 'ia' check (tipo in ('ia', 'monedas'));

-- ============================================================
-- 2) WALTER COMO CLIENTE
-- ============================================================

insert into public.clientes (slug, nombre, tipo, wa_phone_number_id, prompt, activo)
values (
  'walter-monedas',
  'Punto Metales',
  'monedas',
  -- Su número de WhatsApp NO va acá: lo atiende walter-bot con la app de Meta
  -- de Walter. La columna es obligatoria y única, así que lleva un valor que
  -- nunca llega en un mensaje. Por las dudas, api/whatsapp.js solo busca
  -- clientes de tipo ia.
  'no-aplica-walter',
  'Sin IA: responde el flujo fijo de supabase/functions/walter-bot.',
  -- walter-bot no mira esta columna: el bot responde desde que Meta está conectado.
  true
)
on conflict (slug) do nothing;

-- El panel de Walter lo ve quien esté vinculado a este cliente.
alter table public.walter_config
  add column if not exists cliente_id uuid references public.clientes (id);

update public.walter_config
set cliente_id = (select id from public.clientes where slug = 'walter-monedas')
where id = 1 and cliente_id is null;

-- Para vincular a Walter (o a quien lo ayude) cuando tenga su usuario:
--
--   insert into public.cliente_usuarios (cliente_id, user_id)
--   select c.id, u.id from public.clientes c, auth.users u
--   where c.slug = 'walter-monedas' and u.email = 'EMAIL_DE_WALTER'
--   on conflict do nothing;

-- ============================================================
-- 3) HOJAS DE RUTA APROBADAS
-- ============================================================

-- Walter revisa la hoja de ruta de cada día y turno y la aprueba antes de
-- salir. Se guarda el orden que aprobó: si después entra o se cae un pedido,
-- el panel avisa que la hoja cambió y hay que volver a mirarla.
create table if not exists public.walter_rutas (
  dia date not null,
  turno text not null check (turno in ('Mañana', 'Tarde')),
  paradas bigint[] not null,          -- ids de walter_pedidos, en el orden aprobado
  aprobada timestamptz not null default now(),
  primary key (dia, turno)
);
alter table public.walter_rutas enable row level security;

-- La conversación de un cliente se lee entera y en orden.
create index if not exists walter_mensajes_charla on public.walter_mensajes (canal, usuario, id);

-- ============================================================
-- 4) REPROGRAMAR UN RETIRO VUELVE A AVISAR
-- ============================================================

-- walter-bot manda un solo aviso por pedido: lo marca en aviso_enviado. Si
-- Walter le cambia el día o el turno, ese aviso ya no sirve: se borra para que
-- salga el nuevo, y la respuesta que había dado el cliente deja de valer.
-- De paso el estado sigue a la agenda: con día y turno es agendado; sin, nuevo.
create or replace function public.walter_pedido_reprogramado()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.dia is distinct from old.dia or new.turno is distinct from old.turno then
    new.aviso_enviado := null;
    new.respuesta_aviso := null;
    if new.estado in ('nuevo', 'agendado') then
      new.estado := case when new.dia is not null and new.turno is not null
                         then 'agendado' else 'nuevo' end;
    end if;
  end if;
  return new;
end;
$$;

create or replace trigger walter_pedido_reprogramado
  before update of dia, turno on public.walter_pedidos
  for each row execute function public.walter_pedido_reprogramado();

-- ============================================================
-- 5) QUÉ VE Y QUÉ TOCA EL PANEL
-- ============================================================

-- true si quien está logueado está vinculado al cliente de Walter. Security
-- definer por lo mismo que mis_clientes_bot() (en 04-bot-whatsapp.sql figura
-- con su nombre viejo, mis_clientes): lee sin volver a aplicar RLS, y así la
-- política de walter_config puede consultar walter_config sin que Postgres
-- corte por recursión.
create or replace function public.walter_usuario_habilitado()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.walter_config c
    join public.cliente_usuarios cu on cu.cliente_id = c.cliente_id
    where c.id = 1 and cu.user_id = auth.uid()
  );
$$;
revoke all on function public.walter_usuario_habilitado() from public, anon;
grant execute on function public.walter_usuario_habilitado() to authenticated;

-- Supabase le da permisos amplios por defecto a los roles del navegador. Los
-- sacamos y devolvemos solo lo necesario, columna por columna donde
-- corresponde. walter-bot usa la service role y no pasa por acá.
revoke all on public.walter_config         from anon, authenticated;
revoke all on public.walter_conversaciones from anon, authenticated;
revoke all on public.walter_pedidos        from anon, authenticated;
revoke all on public.walter_mensajes       from anon, authenticated;
revoke all on public.walter_rutas          from anon, authenticated;

grant select on public.walter_config         to authenticated;
grant select on public.walter_conversaciones to authenticated;
grant select on public.walter_pedidos        to authenticated;
grant select on public.walter_mensajes       to authenticated;
grant select on public.walter_rutas          to authenticated;

-- Precios y ajustes: el bloque entero, como lo guarda el panel.
grant update (data, actualizado) on public.walter_config to authenticated;

-- Pedidos: solo la agenda y el estado. Lo que contó el cliente (cantidad,
-- dirección, monto cotizado) no se toca desde el panel.
grant update (dia, turno, estado) on public.walter_pedidos to authenticated;

-- Charlas: marcar que ya se habló con quien pidió una persona.
grant update (pide_humano) on public.walter_conversaciones to authenticated;

-- Hojas de ruta: aprobar y volver a aprobar (el upsert escribe también la clave).
grant insert (dia, turno, paradas, aprobada), update (dia, turno, paradas, aprobada)
  on public.walter_rutas to authenticated;

drop policy if exists "panel de walter ve la config" on public.walter_config;
create policy "panel de walter ve la config" on public.walter_config
  for select to authenticated
  using ((select public.walter_usuario_habilitado()));

drop policy if exists "panel de walter cambia la config" on public.walter_config;
create policy "panel de walter cambia la config" on public.walter_config
  for update to authenticated
  using ((select public.walter_usuario_habilitado()))
  with check ((select public.walter_usuario_habilitado()));

drop policy if exists "panel de walter ve los pedidos" on public.walter_pedidos;
create policy "panel de walter ve los pedidos" on public.walter_pedidos
  for select to authenticated
  using ((select public.walter_usuario_habilitado()));

drop policy if exists "panel de walter agenda los pedidos" on public.walter_pedidos;
create policy "panel de walter agenda los pedidos" on public.walter_pedidos
  for update to authenticated
  using ((select public.walter_usuario_habilitado()))
  with check ((select public.walter_usuario_habilitado()));

drop policy if exists "panel de walter ve las charlas" on public.walter_conversaciones;
create policy "panel de walter ve las charlas" on public.walter_conversaciones
  for select to authenticated
  using ((select public.walter_usuario_habilitado()));

drop policy if exists "panel de walter marca las charlas" on public.walter_conversaciones;
create policy "panel de walter marca las charlas" on public.walter_conversaciones
  for update to authenticated
  using ((select public.walter_usuario_habilitado()))
  with check ((select public.walter_usuario_habilitado()));

drop policy if exists "panel de walter ve los mensajes" on public.walter_mensajes;
create policy "panel de walter ve los mensajes" on public.walter_mensajes
  for select to authenticated
  using ((select public.walter_usuario_habilitado()));

drop policy if exists "panel de walter ve las rutas" on public.walter_rutas;
create policy "panel de walter ve las rutas" on public.walter_rutas
  for select to authenticated
  using ((select public.walter_usuario_habilitado()));

drop policy if exists "panel de walter aprueba rutas" on public.walter_rutas;
create policy "panel de walter aprueba rutas" on public.walter_rutas
  for insert to authenticated
  with check ((select public.walter_usuario_habilitado()));

drop policy if exists "panel de walter vuelve a aprobar rutas" on public.walter_rutas;
create policy "panel de walter vuelve a aprobar rutas" on public.walter_rutas
  for update to authenticated
  using ((select public.walter_usuario_habilitado()))
  with check ((select public.walter_usuario_habilitado()));
