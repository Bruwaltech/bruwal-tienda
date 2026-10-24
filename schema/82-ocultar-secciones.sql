-- 82: secciones del panel que se ocultan por tienda.
--
-- features.ocultar_secciones es una lista con las secciones que esa tienda no
-- usa. Valores posibles: "pedidos", "mercadolibre", "fiado", "afiliados".
-- Solo se esconde la pestaña del panel (y el "Fiado" de la caja si se oculta
-- "fiado"); los datos no se tocan. Como todo features, lo pone solo el
-- administrador (trigger proteger_features de la 76).
--
-- No cambia el esquema: solo actualiza la descripción de la columna.
-- Para ocultar secciones a una tienda:
--   update public.store_profiles
--      set features = features || '{"ocultar_secciones": ["afiliados","mercadolibre","fiado","pedidos"]}'::jsonb
--    where slug = '<slug>';
-- Para devolvérselas:
--   update public.store_profiles set features = features - 'ocultar_secciones' where slug = '<slug>';

comment on column public.store_profiles.features is
  'Módulos opcionales de la tienda, ej. {"envios_flex": true, "ocultar_secciones": ["pedidos"]}. Lo pone solo el administrador: el navegador no lo puede cambiar (trigger proteger_features).';
