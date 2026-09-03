-- ============================================================
--  BRUWAL — Empleados y fichadas (control de horarios)
--  Correr en Supabase → SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es aditivo e idempotente.
--
--  La "tarjeta" es simplemente un texto. Un lector NFC/RFID USB en modo
--  teclado tipea el número de la tarjeta y da Enter, igual que el lector
--  de códigos de barras que ya usa el panel. Así que acá entra lo mismo
--  venga de una tarjeta NFC, de un llavero RFID, de un QR impreso en el
--  carnet o tipeado a mano — al sistema le da igual.
-- ============================================================

create table if not exists public.store_empleados (
  id               uuid primary key default gen_random_uuid(),
  store_slug       text not null,
  nombre           text not null,
  rol              text,                           -- Peluquero, Cocinero, Cajero… lo que escriba el dueño
  tarjeta          text,                           -- UID de la tarjeta / QR / lo que tipee el lector
  valor_hora       numeric,                        -- SIEMPRE en ARS, mismo criterio que costo/precio en el resto
  activo           boolean not null default true,  -- se desactiva en vez de borrarse: las fichadas viejas siguen valiendo
  notas            text,
  created_at       timestamptz not null default now()
);

create index if not exists store_empleados_por_tienda on public.store_empleados(store_slug);

-- Dos empleados de la MISMA tienda no pueden compartir tarjeta: si pasara,
-- una marca no sabría de quién es. Entre tiendas distintas no molesta.
-- Es índice parcial porque la mayoría arranca sin tarjeta (null), y varios
-- nulls no chocan entre sí.
create unique index if not exists store_empleados_tarjeta_unica
  on public.store_empleados(store_slug, tarjeta)
  where tarjeta is not null;


create table if not exists public.store_fichadas (
  id               uuid primary key default gen_random_uuid(),
  store_slug       text not null,
  empleado_id      uuid not null references public.store_empleados(id) on delete cascade,
  tipo             text not null,                  -- 'entrada' | 'salida'
  momento          timestamptz not null default now(),
  origen           text,                           -- 'tarjeta' | 'pantalla' | 'manual'
  created_at       timestamptz not null default now()
);

create index if not exists store_fichadas_por_tienda on public.store_fichadas(store_slug);
create index if not exists store_fichadas_por_empleado on public.store_fichadas(empleado_id, momento);


alter table public.store_empleados enable row level security;
alter table public.store_fichadas  enable row level security;

-- Igual que store_gastos: sin acceso público, solo el dueño de la tienda.
drop policy if exists empleados_propios on public.store_empleados;
create policy empleados_propios on public.store_empleados for all
  using (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_empleados.store_slug and sp.user_id = auth.uid()))
  with check (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_empleados.store_slug and sp.user_id = auth.uid()));

drop policy if exists fichadas_propias on public.store_fichadas;
create policy fichadas_propias on public.store_fichadas for all
  using (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_fichadas.store_slug and sp.user_id = auth.uid()))
  with check (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_fichadas.store_slug and sp.user_id = auth.uid()));

-- Verificación
select 'store_empleados y store_fichadas creadas' as estado,
       (select count(*) from pg_policies
        where schemaname='public' and tablename in ('store_empleados','store_fichadas')) as politicas;
