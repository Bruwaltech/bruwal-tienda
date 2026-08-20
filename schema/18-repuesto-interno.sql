-- ============================================================
--  BRUWAL — Productos de uso interno (repuestos), no se venden
--  en la tienda pública
--  Correr en Supabase → SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es aditivo e idempotente.
-- ============================================================

-- false por defecto: ningún producto existente cambia de comportamiento.
-- true = nunca aparece en tienda.html, solo se usa desde el panel (por
-- ejemplo, como repuesto en una reparación).
alter table public.store_products
  add column if not exists solo_interno boolean not null default false;
