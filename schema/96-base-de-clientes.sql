-- ============================================================
--  BRUWAL — Base de clientes (pedido de JACI, 28/10)
--
--  Hasta ahora un cliente no era una tabla: existia como el nombre
--  repetido en sus ventas (orders.customer_name). Una distribuidora
--  que ya tiene su cartera cargada en otro sistema necesita traerla
--  ENTERA, con dirección y CUIT, aunque esos clientes todavía no le
--  compraron nada por Bruwal.
--
--  store_clientes es esa libreta: se llena importando un Excel desde
--  Clientes → "Importar clientes" (o editando uno). Al vender, si el
--  nombre está en la libreta, la venta se guarda con su dirección y
--  teléfono, y el remito sale con el domicilio ya puesto.
--
--  Las ventas siguen guardando el nombre como texto: nada de lo que ya
--  existe cambia. Sin esta migración el panel funciona igual que antes
--  y solo avisa al querer importar.
--
--  Correr en Supabase -> SQL Editor. Aditivo e idempotente.
-- ============================================================

create table if not exists public.store_clientes (
  id          uuid primary key default gen_random_uuid(),
  store_slug  text not null,
  nombre      text not null,
  codigo      text,          -- el número de cliente en su sistema viejo
  telefono    text,
  cuit        text,
  direccion   text,
  localidad   text,
  email       text,
  notas       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists store_clientes_por_tienda
  on public.store_clientes(store_slug, nombre);

alter table public.store_clientes enable row level security;

-- Igual que el resto de la caja: el dueño y los miembros del equipo.
-- Dentro de un "if not exists" y no con drop + create, así se puede
-- correr dos veces sin borrar nada.
do $$
begin
  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'store_clientes'
                   and policyname = 'clientes_propios') then
    create policy clientes_propios on public.store_clientes for all
      to authenticated
      using (exists (
        select 1 from public.store_profiles sp
        where sp.slug = store_clientes.store_slug
          and (sp.user_id = auth.uid() or public.equipo_es_miembro(sp.slug))))
      with check (exists (
        select 1 from public.store_profiles sp
        where sp.slug = store_clientes.store_slug
          and (sp.user_id = auth.uid() or public.equipo_es_miembro(sp.slug))));
  end if;
end $$;
