-- ============================================================
--  BRUWAL — Preguntas de compradores de Mercado Libre.
--
--  Esto NO crea nada nuevo: la tabla ya está en producción, creada a
--  mano desde el panel de Supabase (migración `create_store_ml_preguntas`).
--  Este archivo la deja escrita en el repo, que es donde tiene que estar
--  para que se sepa qué hay en la base sin tener que ir a mirarla.
--
--  Está sacado de la base real, no de memoria: columnas, índices,
--  restricciones y política leídas de information_schema y pg_policies.
--
--  Es idempotente: correrlo sobre la base que ya la tiene no cambia nada.
--
--  POR QUÉ IMPORTA TENERLO ACÁ: hoy mismo apareció el costo de no
--  hacerlo. schema/22-caja.sql quedó a medio correr —los dos primeros
--  ALTER sí, la tabla no— y el módulo Caja estuvo pidiendo una tabla
--  inexistente desde agosto, devolviendo 404 en cada carga del panel.
--  Nadie lo notó porque el repo decía una cosa y la base otra.
-- ============================================================

create table if not exists public.store_ml_preguntas (
  -- El id de la pregunta en Mercado Libre es la clave: así el sync puede
  -- hacer upsert y volver a correr las veces que haga falta sin duplicar
  -- nada ni tener que borrar antes.
  ml_question_id  text primary key,
  store_slug      text not null references public.store_profiles(slug),
  ml_item_id      text not null,
  -- El título se guarda aunque sea de ML: sin esto, mostrar las preguntas
  -- agrupadas por publicación obligaría a ir a buscar los títulos a la
  -- API de ML cada vez que se abre la pantalla.
  titulo_item     text,
  fecha           timestamptz,
  pregunta        text,
  respuesta       text,
  -- 'UNANSWERED' | 'ANSWERED' | 'CLOSED_UNANSWERED' | 'UNDER_REVIEW'
  estado          text,
  sincronizado_en timestamptz not null default now()
);

-- Las preguntas se leen agrupadas por publicación, y siempre dentro de una
-- tienda. Ese es el orden del índice.
create index if not exists store_ml_preguntas_store_item_idx
  on public.store_ml_preguntas (store_slug, ml_item_id);

alter table public.store_ml_preguntas enable row level security;

-- SOLO LECTURA, y solo de lo propio.
--
-- No hay política de insert ni de update a propósito: lo único que escribe
-- acá es la Edge Function ml-preguntas, que usa el service role y por lo
-- tanto no pasa por RLS. Si el navegador pudiera escribir, un cliente
-- podría inventarse preguntas o borrar las que no quiere contestar.
drop policy if exists "dueno lee sus preguntas ML" on public.store_ml_preguntas;
create policy "dueno lee sus preguntas ML" on public.store_ml_preguntas
  for select using (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_ml_preguntas.store_slug
      and sp.user_id = auth.uid()));

notify pgrst, 'reload schema';

-- Verificación
select 'preguntas ML' as estado,
       (select count(*) from information_schema.tables
         where table_schema='public' and table_name='store_ml_preguntas') as tabla,
       (select count(*) from pg_policies
         where schemaname='public' and tablename='store_ml_preguntas') as politicas,
       (select rowsecurity from pg_tables
         where schemaname='public' and tablename='store_ml_preguntas') as rls;
