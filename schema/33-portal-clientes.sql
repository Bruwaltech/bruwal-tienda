-- ============================================================
--  BRUWAL — Portal del cliente: link único para que cada cliente
--  vea y descargue su estado de cuenta (fiado) y el estado de
--  sus reparaciones, sin registrarse ni tener contraseña.
--
--  Por qué un token y no un login: en BRUWAL el "cliente" no es
--  una entidad con cuenta — es el texto de orders.customer_name.
--  No hay de dónde sacar credenciales, y nadie se registraría en
--  un portal para ver que debe $8.000. El dueño le manda el link
--  por WhatsApp, que es por donde ya se hablan.
--
--  El token se genera en la base (gen_random_uuid dos veces = 64
--  caracteres hex) para que no dependa de que el navegador tenga
--  un generador seguro. Es imposible de adivinar por fuerza bruta.
--
--  Correr en Supabase -> SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es aditivo e idempotente.
-- ============================================================

create table if not exists public.store_clientes_token (
  id             uuid primary key default gen_random_uuid(),
  store_slug     text not null,
  cliente_nombre text not null,
  token          text not null unique
                   default replace(gen_random_uuid()::text, '-', '') ||
                           replace(gen_random_uuid()::text, '-', ''),
  revocado       boolean not null default false,
  created_at     timestamptz not null default now()
);

-- Un solo link por cliente y por tienda: pedirlo dos veces devuelve
-- el mismo, así el que ya se mandó por WhatsApp nunca deja de andar.
create unique index if not exists store_clientes_token_unico
  on public.store_clientes_token(store_slug, cliente_nombre);

create index if not exists store_clientes_token_por_token
  on public.store_clientes_token(token);

alter table public.store_clientes_token enable row level security;

-- Igual que store_pagos y store_reparaciones: sin acceso público.
-- El portal NO lee esta tabla desde el navegador — lo hace el
-- endpoint api/estado-cuenta.js con la service role key, que
-- devuelve únicamente los datos del cliente dueño de ese token.
-- Si esto fuera legible con la clave pública, cualquiera podría
-- listar los tokens de todos y ver las deudas de todo el mundo.
drop policy if exists clientes_token_propios on public.store_clientes_token;
create policy clientes_token_propios on public.store_clientes_token
  for all
  using (store_slug in (select slug from public.store_profiles where user_id = auth.uid()))
  with check (store_slug in (select slug from public.store_profiles where user_id = auth.uid()));

NOTIFY pgrst, 'reload schema';

-- Verificación
select 'store_clientes_token creada' as estado,
       (select count(*) from information_schema.tables
        where table_schema='public' and table_name='store_clientes_token') as tabla;
