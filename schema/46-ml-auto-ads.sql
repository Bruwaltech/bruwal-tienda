-- Pausar solas las campañas de Mercado Ads que están quemando plata.
--
-- Una sola columna: el interruptor. Apagado por defecto, porque esto apaga
-- publicidad en vivo y nadie tiene que descubrir que sus campañas se
-- frenaron porque el sistema decidió por su cuenta.
--
-- NO hace falta una columna para recordar cuáles pausamos nosotros, a
-- diferencia de lo que haría falta con las publicaciones. El motivo es
-- lindo: una campaña pausada deja de generar métricas, así que nunca puede
-- "mejorar" sola. No hay reactivación automática posible ni deseable —
-- volver a prenderla es una decisión humana, después de cambiar algo
-- (el precio, la publicación, el ACOS objetivo).

alter table public.store_profiles
  add column if not exists ml_auto_pausar_ads boolean not null default false;

comment on column public.store_profiles.ml_auto_pausar_ads is
  'Si está en true, BRUWAL pausa solo las campañas de Product Ads que gastan sin vender o que se pasan del ACOS objetivo. Nunca las reactiva: eso es decisión del vendedor.';

-- Campañas que el vendedor marcó "no la toques". Es la última palabra: por
-- más que los números digan que quema, si está acá no se pausa sola.
--
-- Hace falta porque las métricas no cuentan toda la historia. El caso real:
-- una campaña con métricas malas PORQUE el producto estuvo sin stock. Los
-- números dicen "gastó y no vendió", pero la causa ya se arregló y la
-- campaña está por arrancar. Ninguna regla puede saber eso; el vendedor sí.
alter table public.store_profiles
  add column if not exists ml_ads_no_tocar jsonb not null default '[]'::jsonb;

comment on column public.store_profiles.ml_ads_no_tocar is
  'Ids de campañas de Product Ads que el vendedor excluyó de la pausa automática.';

-- PostgREST cachea el esquema: sin esto la columna nueva no existe para la
-- API aunque esté creada en la base.
notify pgrst, 'reload schema';

-- Para comprobar que quedó:
select column_name, data_type, column_default
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'store_profiles'
   and column_name = 'ml_auto_pausar_ads';
