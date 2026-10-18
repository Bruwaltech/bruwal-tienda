-- ============================================================
-- Bot de Walter: aviso del día apenas Walter lo pone
-- ============================================================
-- Cuando Walter le pone día y turno a un pedido en el panel, la tarea de avisos
-- (cada 15 minutos) se lo dice al cliente si la charla sigue abierta (hasta 24
-- horas después de su último mensaje). aviso_dia queda en 'enviado' o, si ya no
-- se le podía escribir libre, en 'sin ventana' (le llega solo el recordatorio).
-- Si Walter cambia el día o el turno, vuelve a null y se avisa de nuevo.
-- ============================================================

alter table public.walter_pedidos add column if not exists aviso_dia text
  check (aviso_dia in ('enviado', 'sin ventana'));

comment on column public.walter_pedidos.aviso_dia is
  'Si al cliente se le avisó el día apenas Walter lo puso: enviado, sin ventana (pasaron 24 h) o null';

-- Los pedidos que ya tenían día no reciben el aviso nuevo de golpe
update public.walter_pedidos set aviso_dia = 'sin ventana' where dia is not null and aviso_dia is null;

create or replace function public.walter_pedido_reprogramado()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.dia is distinct from old.dia or new.turno is distinct from old.turno then
    new.aviso_enviado := null;
    new.respuesta_aviso := null;
    new.aviso_dia := null;
    if new.estado in ('nuevo', 'agendado') then
      new.estado := case when new.dia is not null and new.turno is not null
                         then 'agendado' else 'nuevo' end;
    end if;
  end if;
  return new;
end;
$$;
