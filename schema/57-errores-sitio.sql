-- Errores que le pasan a la gente en el sitio, anotados por seguimiento.js
-- a través de /api/error.
--
-- Solo el servidor (service role) lee y escribe: RLS activado y sin
-- políticas, así la clave pública no puede ni ver ni llenar la tabla.
--
-- Cada noche Claude revisa los que tienen revisado = false, arregla lo que
-- pueda en un PR y los marca como revisados con una nota.

create table if not exists public.errores_sitio (
  id         bigint generated always as identity primary key,
  creado     timestamptz not null default now(),
  tipo       text not null check (tipo in ('js', 'promesa', 'red', 'aviso')),
  mensaje    text not null,
  pagina     text,
  fuente     text,
  linea      int,
  columna    int,
  stack      text,
  estado     int,
  ancho      int,
  navegador  text,
  revisado   boolean not null default false,
  nota       text
);

create index if not exists errores_sitio_pendientes
  on public.errores_sitio (creado desc) where not revisado;

alter table public.errores_sitio enable row level security;

-- Resumen para mirar rápido: cada error distinto, cuántas veces pasó y cuándo.
create or replace view public.errores_sitio_resumen
with (security_invoker = true) as
select
  tipo,
  pagina,
  mensaje,
  count(*)                     as veces,
  min(creado)                  as primera_vez,
  max(creado)                  as ultima_vez,
  bool_and(revisado)           as revisado
from public.errores_sitio
group by tipo, pagina, mensaje
order by max(creado) desc;
