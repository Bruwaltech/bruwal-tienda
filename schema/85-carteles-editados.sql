-- ============================================================
--  BRUWAL — Carteles de oferta editados
--
--  store_profiles.carteles: cómo quedaron los carteles de oferta
--  editados en Productos → Carteles de oferta
--  ({estilo:{color, formato}, editados:{id_producto:{...}}}),
--  así se ven igual desde cualquier compu. No es pública (73).
--
--  El filtro "Bajaron de precio" lee store_precio_historial (86).
--
--  Correr en Supabase -> SQL Editor. Aditivo e idempotente.
-- ============================================================

alter table public.store_profiles
  add column if not exists carteles jsonb;

notify pgrst, 'reload schema';

-- Verificación
select 'carteles editados' as estado,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_profiles' and column_name='carteles') as col_carteles;
