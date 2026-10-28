-- ============================================================
--  BRUWAL — Padrón de clientes (distribuidora)
--
--  La distribuidora ya tiene su base de clientes cargada en el sistema
--  viejo (cuenta, nombre, domicilio, teléfono). La manda en Excel y se
--  carga desde Clientes → "Cargar clientes desde Excel". Con eso, al
--  vender, el nombre del cliente se sugiere y el remito sale con su
--  domicilio sin tener que escribirlo cada vez.
--
--  Cada carga REEMPLAZA el padrón entero de la tienda (es la foto del
--  Excel). Las ventas no se tocan: siguen guardando el nombre como texto.
--
--  Correr en Supabase -> SQL Editor. Aditivo e idempotente.
-- ============================================================

create table if not exists public.store_clientes_padron (
  id          uuid primary key default gen_random_uuid(),
  store_slug  text not null,
  codigo      text,              -- número de cuenta del sistema viejo
  nombre      text not null,
  domicilio   text,
  localidad   text,
  telefono    text,
  cuit        text,
  created_at  timestamptz not null default now()
);

create index if not exists store_clientes_padron_por_tienda
  on public.store_clientes_padron(store_slug);

alter table public.store_clientes_padron enable row level security;

-- El dueño (o un miembro activo del equipo) ve, carga y borra los de su tienda.
drop policy if exists clientes_padron_todo on public.store_clientes_padron;
create policy clientes_padron_todo on public.store_clientes_padron
  for all to authenticated
  using (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_clientes_padron.store_slug
      and (sp.user_id = auth.uid() or public.equipo_es_miembro(sp.slug))))
  with check (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_clientes_padron.store_slug
      and (sp.user_id = auth.uid() or public.equipo_es_miembro(sp.slug))));

notify pgrst, 'reload schema';

-- Verificación
-- select count(*) from public.store_clientes_padron where store_slug = 'distribuidora-jaci';
