-- ============================================================
--  BRUWAL — Balanza etiquetadora (Systel / Kretz).
--
--  Caso real: una forrajería pesa 12,5 kg de balanceado. La
--  balanza imprime una etiqueta con un EAN-13 que arma el propio
--  comercio, y adentro de ese número viene QUÉ producto es y
--  CUÁNTO pesó. El lector de códigos que el panel ya tiene puede
--  leerlo: solo falta saber cómo está armado ese número.
--
--  Por eso son dos datos y no uno:
--   · store_profiles.balanza  -> cómo arma el código ESA balanza
--   · store_products.plu_balanza -> con qué número está cargado
--     cada producto adentro de la balanza
--
--  No hay formato fijo a propósito. En una Systel el patrón se
--  configura en la propia balanza (ej. "20PPPPIIIII"), así que
--  acá se copia el mismo y listo — no hay que reconfigurar la
--  balanza de nadie.
--
--  El NOTIFY del final NO es opcional: PostgREST cachea el
--  esquema y sin recargarlo rechaza las columnas nuevas como si
--  no existieran.
--
--  Correr en Supabase -> SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es idempotente.
-- ============================================================

-- 1) Cómo arma el código de barras la balanza de esta tienda.
--    null = no usa balanza, que es como funcionó siempre.
--    { "formato": "20PPPPIIIII", "decimalesImporte": 2 }
alter table public.store_profiles
  add column if not exists balanza jsonb;

-- 2) El código (PLU) con el que este producto está cargado en la
--    balanza. Va como text y no como integer a propósito: los
--    ceros a la izquierda son parte del código impreso ("0123").
alter table public.store_products
  add column if not exists plu_balanza text;

-- Buscar el producto por su PLU es lo que pasa en CADA escaneo de
-- etiqueta, con el vendedor esperando frente al cliente.
create index if not exists store_products_plu_balanza_idx
  on public.store_products (store_slug, plu_balanza);

NOTIFY pgrst, 'reload schema';

-- Verificación
select 'balanza lista' as estado,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_profiles' and column_name='balanza') as columna_balanza,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_products' and column_name='plu_balanza') as columna_plu;
