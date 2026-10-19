-- ============================================================
-- Bot de Walter: la hoja de ruta le llega a Walter, y lo que se usó en el mes
-- Correr DESPUÉS de 70-walter-varias-monedas.sql
-- ============================================================
--
-- 1) Al aprobar la hoja de ruta, walter-bot se la manda a Walter a su WhatsApp
--    personal (walter_config.data.waWalter). Si él no le escribió al bot en las
--    últimas 24 horas, va la plantilla hoja_ruta con un botón "Ver las paradas":
--    al tocarlo le llega el detalle, que queda guardado en texto.
-- 2) walter_uso: llamadas y tokens de la IA por día, para la pestaña Uso del
--    panel. La escribe solo walter-bot (service_role) con walter_sumar_uso; el
--    panel no la lee directo: la pide a walter-bot (accion uso).

alter table public.walter_rutas add column if not exists texto text;
alter table public.walter_rutas add column if not exists enviada timestamptz;
comment on column public.walter_rutas.texto is
  'La hoja de ruta como se la manda walter-bot a Walter por WhatsApp (paradas en orden, montos, link de Maps)';
comment on column public.walter_rutas.enviada is
  'Cuándo le llegó a Walter el detalle. null si todavía no (por ejemplo, esperando que toque Ver las paradas)';

create table if not exists public.walter_uso (
  dia date not null,
  servicio text not null,             -- 'ia' (Haiku) o 'transcripcion' (audios a texto)
  llamadas integer not null default 0,
  entrada bigint not null default 0,  -- tokens de entrada (ia) o segundos de audio aproximados (transcripcion)
  salida bigint not null default 0,   -- tokens de salida (ia)
  primary key (dia, servicio)
);
alter table public.walter_uso enable row level security;
revoke all on public.walter_uso from anon, authenticated;

create or replace function public.walter_sumar_uso(p_servicio text, p_entrada bigint, p_salida bigint)
returns void language sql security definer set search_path = public as $$
  insert into public.walter_uso (dia, servicio, llamadas, entrada, salida)
  values ((now() at time zone 'America/Argentina/Buenos_Aires')::date, p_servicio, 1, coalesce(p_entrada, 0), coalesce(p_salida, 0))
  on conflict (dia, servicio) do update set
    llamadas = public.walter_uso.llamadas + 1,
    entrada = public.walter_uso.entrada + excluded.entrada,
    salida = public.walter_uso.salida + excluded.salida;
$$;
revoke execute on function public.walter_sumar_uso(text, bigint, bigint) from public, anon, authenticated;
grant execute on function public.walter_sumar_uso(text, bigint, bigint) to service_role;
