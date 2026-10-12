-- ============================================================
--  BRUWAL — Borrar dos tablas de respaldo que ya no hacen falta.
--  Lo pidió el dueño el 2026-10-04.
--
--  - respaldo_carolina_20261002: 1 fila con la versión vieja del perfil
--    de carolinacocina-essen, de cuando estaba en trial y sin
--    configurar. La tienda sigue existiendo (plan pro) y tiene todo lo
--    que tenía el respaldo y más, así que no se pierde nada.
--  - backup_tienda_borrada_pelustars: 11 filas de la tienda demo
--    Pelustars, borrada el 2026-10-01 (perfil, 3 productos, 2 pedidos,
--    4 turnos y 1 token de cliente). Eran datos de prueba.
--
--  Antes de borrar se exportaron las dos a
--  Documents\BRUWAL\respaldos-borrados\*.json. El md5 de cada archivo
--  coincide con el de json_agg de la tabla. Si alguna vez hiciera falta
--  el contenido, está ahí.
--
--  Se queda backup_duplicados_ml_20260930 (la limpieza de duplicados de
--  ML del 30/9), hasta cerrar la caja de septiembre sin diferencias.
--
--  Drop sin CASCADE: si algo dependiera de estas tablas, falla en vez de
--  arrastrarlo. Se probó antes en una transacción abortada y no había
--  dependencias.
-- ============================================================

drop table if exists public.respaldo_carolina_20261002;
drop table if exists public.backup_tienda_borrada_pelustars;
