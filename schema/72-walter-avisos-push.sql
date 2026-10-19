-- ============================================================
-- Bot de Walter: avisos al celular o la compu, aunque el panel esté cerrado
-- Correr DESPUÉS de 71-walter-ruta-y-uso.sql
-- ============================================================
--
-- Cada aparato donde Walter toca "Activar avisos" se suscribe a Web Push y
-- queda acá. Cuando escribe un cliente, walter-bot le manda un aviso a cada
-- uno y el service worker del sitio (/sw.js) lo muestra. Si el aparato se dio
-- de baja (404/410), walter-bot borra la fila. La escribe y la lee solo
-- walter-bot (service_role): el panel pasa por ?tarea=panel.
--
-- Las claves VAPID van en el secreto VAPID_KEYS de la Edge Function (o en
-- Vault como walter_vapid_keys): el JSON que exporta @negrel/webpush.

create table if not exists public.walter_push (
  endpoint text primary key,
  p256dh text not null,
  auth text not null,
  user_id uuid,
  aparato text,                       -- el navegador, para reconocerlo
  creado timestamptz not null default now()
);
alter table public.walter_push enable row level security;
revoke all on public.walter_push from anon, authenticated;
