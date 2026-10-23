-- 73 · La llave publica (anon) deja de leer costos, proveedor, IMEI,
-- pin_costos y la suscripcion de Mercado Pago.
--
-- Hasta aca prod_lectura_publica y sp_lectura_publica son `using (true)` y
-- anon tenia SELECT sobre la tabla entera: cualquiera con la llave publica
-- (esta en el codigo de la tienda) leia el costo de cada producto, los datos
-- del proveedor y el hash del PIN de costos de cada negocio.
--
-- ORDEN: esto va DESPUES de deployar tienda.html e index.html con columnas
-- explicitas. Un select('*') de anon contra estas tablas da 42501 apenas
-- corre esta migracion.
--
-- Columna nueva que la tienda publica necesite: sumarla al grant de abajo Y a
-- COLS_PERFIL_PUBLICO / COLS_PRODUCTO_PUBLICO en tienda.html e index.html.
-- Si no, anon no la ve (el revoke de tabla no se hereda a columnas nuevas).
--
-- Solo cambia anon. El panel (authenticated) sigue igual: eso es la fase 2.
-- user_id queda legible a proposito: las politicas `to public` de orders,
-- store_turnos y otras comparan sp.user_id, y anon las evalua.

revoke select on public.store_profiles from anon;
grant select (
  id, user_id, slug, business_name, phone, created_at, website, instagram, location,
  description, image_url, email, lat, lng, mensaje_envio, plan, trial_ends_at, plan_updated_at,
  google_url, categorias, medios_pago, turnos, eslogan, portada_url, tema, hace_reparaciones,
  rubro_manual, plan_vence, costo_envio, horario_local, demora_texto, demora_minutos,
  ml_reputacion, transferencia, ofrece_envio, es_demo
) on public.store_profiles to anon;
-- Quedan cerradas para anon: pin_costos, mp_preapproval_id, balanza,
-- ml_auto_pausar_ads, ml_ads_no_tocar, bienvenida_enviada_en, referido_por,
-- referido_en.

revoke select on public.store_products from anon;
grant select (
  id, store_slug, name, description, price, image_url, category, stock, in_stock, ean,
  created_at, updated_at, imagenes, opciones, tipo, tiene_variantes, variante_campos, variantes,
  specs, solo_interno, moneda, precio_original, cotizacion, numero, estado_equipo,
  duracion_minutos, mostrar_precio, unidad_medida, unidad_nombre, pausado, precio_oferta, orden,
  categorias, ml_nota, ml_opiniones, ml_link, ml_es_catalogo, ml_opiniones_al, precios_por_cantidad
) on public.store_products to anon;
-- Quedan cerradas para anon: costo, costo_moneda, costo_original,
-- costo_cotizacion, proveedor_nombre, proveedor_telefono, proveedor_email,
-- imei, insumos, plu_balanza, stock_ultima_carga, fecha_ultima_carga,
-- pendiente_restauracion.

notify pgrst, 'reload schema';
