-- ============================================================
--  BRUWAL — Cuenta de Mercado Pago de cada tienda.
--
--  No confundir con el Mercado Pago de las suscripciones (lo que los
--  negocios le pagan a BRUWAL, api/mercadopago-webhook.js). Esto es la
--  cuenta DEL NEGOCIO, conectada por OAuth para leer sus cobros: cuánto
--  entró, cuánto se llevó Mercado Pago de comisión, cuánto le
--  retuvieron de impuestos y cuánto le quedó.
--
--  Correr en Supabase → SQL Editor. Aditivo e idempotente.
-- ------------------------------------------------------------
--  RLS prendida y SIN políticas, igual que store_ml_cuenta: guarda
--  tokens. Solo la toca api/mercadopago.js con la service role key.
-- ============================================================

create table if not exists public.store_mp_cuenta (
  store_slug       text primary key references public.store_profiles(slug) on delete cascade,
  mp_user_id       text not null,
  nickname         text,
  access_token     text not null,
  refresh_token    text,
  expira_en        timestamptz not null,           -- el token de MP dura 180 días
  conectado_en     timestamptz not null default now(),
  actualizado_en   timestamptz not null default now()
);

-- Sin índice único por mp_user_id, a diferencia de ML: acá solo se leen
-- cobros, y un dueño con dos negocios puede cobrar los dos con la misma
-- cuenta de Mercado Pago.

alter table public.store_mp_cuenta enable row level security;

select 'store_mp_cuenta lista' as estado;
