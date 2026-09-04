-- ============================================================
--  BRUWAL — Vincular tambien a nivel VARIANTE.
--
--  Una publicación de Mercado Libre con talles o colores tiene el
--  stock adentro de cada variante, no en el ítem. Para descontar
--  bien hay que saber que la variante "M / Rojo" de la publicación
--  es la combinación "Talle:M~Color:Rojo" del producto de acá.
--
--  ml_variation_id ya existía; lo que faltaba era el otro lado:
--  qué combinación local le corresponde.
--
--  Correr en Supabase → SQL Editor. Aditivo e idempotente.
-- ============================================================

-- La clave de combinación tal como la arma el panel: los atributos
-- ordenados alfabéticamente, "Color:Rojo~Talle:M". Es la misma que
-- usa claveVariante() en dashboard/index.html, así que si cambia
-- allá hay que cambiarla acá.
--
-- null = la publicación no tiene variantes y el vínculo es del
-- producto entero, que es como venía funcionando.
alter table public.store_ml_vinculos
  add column if not exists variante_local text;

NOTIFY pgrst, 'reload schema';

-- Verificación
select 'variante_local lista' as estado,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_ml_vinculos'
          and column_name='variante_local') as columna;
