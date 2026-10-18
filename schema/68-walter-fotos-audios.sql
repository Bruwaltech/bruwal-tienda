-- ============================================================
-- Bot de Walter: fotos y audios
-- Correr DESPUÉS de 67-walter-panel-charlas.sql
-- ============================================================
--
-- Las fotos, audios y archivos que mandan los clientes (y las fotos que Walter
-- manda desde el panel) se guardan en el bucket privado walter-media. El panel
-- no lee el bucket directo: le pide a walter-bot (?tarea=panel, accion medios)
-- links firmados, así el acceso lo decide el mismo control que mandar mensajes.

alter table public.walter_mensajes add column if not exists media_tipo text
  check (media_tipo in ('imagen', 'audio', 'video', 'documento', 'sticker'));
alter table public.walter_mensajes add column if not exists media_path text;
comment on column public.walter_mensajes.media_tipo is
  'Si el mensaje trae una foto, audio, video, documento o sticker. null en los de solo texto';
comment on column public.walter_mensajes.media_path is
  'Dónde quedó el archivo en el bucket walter-media. null si no se pudo bajar de Meta';

-- Privado y hasta 16 MB (lo máximo que WhatsApp deja mandar de audio y video)
insert into storage.buckets (id, name, public, file_size_limit)
values ('walter-media', 'walter-media', false, 16777216)
on conflict (id) do nothing;
