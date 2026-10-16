-- ============================================================
-- Bruwal Chat: bot de Walter (compra monedas por kilo, cobre y bronce)
-- YA APLICADO en la base el 13/10/2026. Se puede volver a correr sin duplicar nada.
-- ============================================================
--
-- Es un bot de flujo fijo, sin IA: cotiza y toma pedidos de retiro por WhatsApp
-- y por Messenger. Lo atiende la Edge Function walter-bot
-- (supabase/functions/walter-bot), no api/whatsapp.js: Walter tiene su propia
-- app de Meta y su propio webhook.
--
-- Todas las tablas llevan el prefijo walter_ y RLS activado. La función usa la
-- service role; lo que puede ver y tocar el panel de Bruwal Chat está en
-- 63-bruwal-chat.sql.

-- ------------------------------------------------------------
-- 1) TABLAS
-- ------------------------------------------------------------

-- Precios, umbrales, depósitos y saludo. Una sola fila; la edita Walter desde
-- el panel y el bot la lee en cada mensaje, así que un cambio de precio corre
-- desde el mensaje siguiente.
create table if not exists public.walter_config (
  id int primary key default 1 check (id = 1),
  data jsonb not null,
  actualizado timestamptz not null default now()
);

insert into public.walter_config (id, data) values (1, '{
  "monedaKg": 9000, "monedaU": 45,
  "cobreMin": 11000, "cobreMay": 12500,
  "bronceMin": 7000, "bronceMay": 8200,
  "umbralMay": 50, "umbralPrio": 10,
  "horaNoche": "21:00", "horaManana": "09:00",
  "depPA": "(dirección a confirmar)", "depPAh": "A coordinar según disponibilidad",
  "depSL": "(dirección a confirmar)", "depSLh": "Lunes a viernes de 14:00 a 17:30 hs",
  "saludo": "¡Hola! 👋 Soy el asistente de Walter. Compramos monedas, cobre y bronce y pasamos a retirar por tu zona.\n¿De qué localidad nos escribís?"
}'::jsonb) on conflict (id) do nothing;

create table if not exists public.walter_conversaciones (
  canal text not null check (canal in ('whatsapp', 'messenger')),
  usuario text not null,              -- número de WhatsApp o id de Messenger
  nombre_perfil text,
  estado jsonb,                       -- paso de la charla y datos tomados
  pide_humano boolean not null default false,
  actualizado timestamptz not null default now(),
  primary key (canal, usuario)
);

create table if not exists public.walter_pedidos (
  id bigint generated always as identity primary key,
  creado timestamptz not null default now(),
  canal text not null,
  usuario text not null,
  nombre text not null,
  localidad text not null,
  material text not null check (material in ('Monedas', 'Cobre', 'Bronce')),
  modo text not null check (modo in ('kg', 'u')),
  cantidad numeric not null,
  retiro text not null,
  direccion text,
  monto numeric not null,
  tarifa text not null,
  prioridad boolean not null default false,
  dia date,                           -- lo asigna Walter
  turno text check (turno in ('Mañana', 'Tarde')),
  estado text not null default 'nuevo' check (estado in ('nuevo', 'agendado', 'retirado', 'cancelado')),
  aviso_enviado timestamptz,
  respuesta_aviso text
);
create index if not exists walter_pedidos_dia on public.walter_pedidos (dia, turno);

create table if not exists public.walter_mensajes (
  id bigint generated always as identity primary key,
  creado timestamptz not null default now(),
  canal text not null,
  usuario text not null,
  direccion text not null check (direccion in ('entra', 'sale')),
  texto text
);

alter table public.walter_config enable row level security;
alter table public.walter_conversaciones enable row level security;
alter table public.walter_pedidos enable row level security;
alter table public.walter_mensajes enable row level security;

-- ------------------------------------------------------------
-- 2) CLAVES
-- ------------------------------------------------------------

-- Las que inventamos nosotros (no son de Meta) se generan al azar acá adentro
-- y quedan cifradas en Vault: no aparecen en ningún archivo.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'walter_avisos_secret') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
      'walter_avisos_secret', 'Bot de Walter: clave entre pg_cron y la función walter-bot');
  end if;
  if not exists (select 1 from vault.secrets where name = 'walter_verify_token') then
    perform vault.create_secret(
      'walter-' || left(replace(gen_random_uuid()::text, '-', ''), 12),
      'walter_verify_token', 'Bot de Walter: token de verificación del webhook de Meta');
  end if;
end $$;

-- Los tokens de Meta van como secretos de la función o en Vault con el mismo
-- prefijo: walter_meta_app_secret, walter_wa_token, walter_wa_phone_id,
-- walter_fb_page_token. La función busca primero en sus secretos y después acá.
--
-- Devuelve solo secretos con prefijo walter_; nunca otros de la tienda.
create or replace function public.walter_secreto(p_nombre text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'walter_' || lower(p_nombre) limit 1;
$$;
revoke all on function public.walter_secreto(text) from public, anon, authenticated;
grant execute on function public.walter_secreto(text) to service_role;
comment on function public.walter_secreto(text) is
  'Bot de Walter: devuelve solo secretos de Vault con prefijo walter_. Solo para service_role (Edge Function walter-bot).';

-- ------------------------------------------------------------
-- 3) AVISOS AUTOMÁTICOS
-- ------------------------------------------------------------

-- pg_cron llama a la función cada 15 minutos. Ella decide qué mandar: el turno
-- mañana se avisa la noche anterior y el turno tarde a la mañana del mismo día,
-- a la hora que Walter haya puesto en el panel.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

-- Con el mismo nombre, cron.schedule reemplaza el trabajo en vez de duplicarlo.
select cron.schedule('walter-avisos', '*/15 * * * *', $job$
  select net.http_post(
    url := 'https://qduguqazpxjjpxjfnkif.supabase.co/functions/v1/walter-bot?tarea=avisos',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-avisos-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'walter_avisos_secret')),
    body := '{}'::jsonb
  );
$job$);
