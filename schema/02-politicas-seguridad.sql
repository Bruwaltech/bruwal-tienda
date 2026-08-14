-- ============================================================
--  BRUWAL — Políticas de seguridad (RLS)
--
--  Hace dos cosas:
--   1) Aísla las tiendas entre sí: nadie puede tocar los productos
--      ni ver los pedidos de otro negocio.
--   2) Aplica el bloqueo del trial vencido en la base de datos,
--      no solo en la pantalla.
--
--  Se puede correr varias veces (borra y recrea las políticas).
--  No usa $$ para que no se corte al pegarlo en el editor.
--
--  Lo que sigue siendo público a propósito:
--   - el listado de tiendas (lo necesita el mapa de la home)
--   - el catálogo de productos (lo necesitan los compradores)
--   - crear un pedido (el cliente que compra no está logueado)
-- ============================================================

alter table public.store_profiles enable row level security;
alter table public.store_products enable row level security;
alter table public.orders         enable row level security;


-- ---------- store_profiles ----------------------------------

drop policy if exists sp_lectura_publica on public.store_profiles;
create policy sp_lectura_publica
  on public.store_profiles for select
  using (true);

drop policy if exists sp_crear_propia on public.store_profiles;
create policy sp_crear_propia
  on public.store_profiles for insert
  with check (auth.uid() = user_id);

drop policy if exists sp_editar_propia on public.store_profiles;
create policy sp_editar_propia
  on public.store_profiles for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);


-- ---------- store_products ----------------------------------
-- Leer: cualquiera (es el catálogo de la tienda pública).
-- Escribir: solo el dueño, y solo si su plan está vigente.

drop policy if exists prod_lectura_publica on public.store_products;
create policy prod_lectura_publica
  on public.store_products for select
  using (true);

drop policy if exists prod_crear on public.store_products;
create policy prod_crear
  on public.store_products for insert
  with check (
    exists (
      select 1 from public.store_profiles sp
      where sp.slug = store_products.store_slug
        and sp.user_id = auth.uid()
        and ( sp.plan in ('basic', 'pro', 'cortesia')
              or (sp.plan = 'trial' and coalesce(sp.trial_ends_at, now()) > now()) )
    )
  );

drop policy if exists prod_editar on public.store_products;
create policy prod_editar
  on public.store_products for update
  using (
    exists (
      select 1 from public.store_profiles sp
      where sp.slug = store_products.store_slug
        and sp.user_id = auth.uid()
        and ( sp.plan in ('basic', 'pro', 'cortesia')
              or (sp.plan = 'trial' and coalesce(sp.trial_ends_at, now()) > now()) )
    )
  );

drop policy if exists prod_borrar on public.store_products;
create policy prod_borrar
  on public.store_products for delete
  using (
    exists (
      select 1 from public.store_profiles sp
      where sp.slug = store_products.store_slug
        and sp.user_id = auth.uid()
        and ( sp.plan in ('basic', 'pro', 'cortesia')
              or (sp.plan = 'trial' and coalesce(sp.trial_ends_at, now()) > now()) )
    )
  );


-- ---------- orders ------------------------------------------
-- Crear: cualquiera, porque el comprador no está logueado.
--        NO se exige plan vigente: si la prueba venció, la tienda
--        pública sigue online y tiene que poder seguir recibiendo.
-- Ver:   solo el dueño de esa tienda.
--
-- OJO: acá había un "exists (...)" que exigía que la tienda existiera.
-- Se probó en producción y rompía TODAS las compras:
--   "new row violates row-level security policy for table orders".
-- La subconsulta contra store_profiles no resuelve dentro de la
-- política. No hace falta: lo que protege los datos es la política
-- de lectura de abajo, no ésta. Si algún día queremos garantizar que
-- el slug exista, va como FOREIGN KEY, no como política.

drop policy if exists ord_crear_publico on public.orders;
create policy ord_crear_publico
  on public.orders for insert
  with check (true);

drop policy if exists ord_ver_propios on public.orders;
create policy ord_ver_propios
  on public.orders for select
  using (
    exists (
      select 1 from public.store_profiles sp
      where sp.slug = orders.store_slug
        and sp.user_id = auth.uid()
    )
  );

drop policy if exists ord_borrar_propios on public.orders;
create policy ord_borrar_propios
  on public.orders for delete
  using (
    exists (
      select 1 from public.store_profiles sp
      where sp.slug = orders.store_slug
        and sp.user_id = auth.uid()
    )
  );


-- ---------- Verificación ------------------------------------
select tablename,
       rowsecurity as rls_activo,
       (select count(*) from pg_policies p
        where p.schemaname = 'public' and p.tablename = t.tablename) as politicas
from pg_tables t
where schemaname = 'public'
  and tablename in ('store_profiles', 'store_products', 'orders')
order by tablename;


-- ============================================================
--  SI ALGO SE ROMPE, volver atrás con esto:
--
--   alter table public.store_profiles disable row level security;
--   alter table public.store_products disable row level security;
--   alter table public.orders         disable row level security;
--
--  Deja todo como estaba antes. Las políticas quedan guardadas
--  pero sin efecto, así se puede reactivar después.
-- ============================================================

-- ---- AGREGADO: permiso de modificación en pedidos ----
-- Faltaba. Sin esto el dueño no podía confirmar ni cancelar un pedido, ni
-- corregir el nombre de un cliente: la base rechazaba el cambio en silencio,
-- sin devolver error, así que el botón parecía andar y no hacía nada.
drop policy if exists ord_editar_propios on public.orders;
create policy ord_editar_propios on public.orders for update
  using (exists (select 1 from public.store_profiles sp
                 where sp.slug = orders.store_slug and sp.user_id = auth.uid()))
  with check (exists (select 1 from public.store_profiles sp
                 where sp.slug = orders.store_slug and sp.user_id = auth.uid()));
