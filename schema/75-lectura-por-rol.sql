-- 75 · Cada rol lee lo suyo en store_profiles y store_products.
--
-- Hasta aca sp_lectura_publica y prod_lectura_publica eran `to public using
-- (true)`: cualquier usuario LOGUEADO (un duenio cualquiera, un empleado)
-- leia la fila completa de TODAS las tiendas, con costos, proveedores, IMEI y
-- el hash del PIN. La 73 solo habia cerrado columnas para anon.
--
--   anon          -> todas las tiendas, solo columnas publicas (73); productos
--                    sin los solo_interno; variantes solo sin IMEI (74).
--   authenticated -> su negocio (duenio) o donde es miembro activo del equipo,
--                    todas las columnas.
--
-- ORDEN: va DESPUES de deployar el cliente `sbPublico` en tienda.html,
-- index.html y el panel. Con `sb`, un duenio logueado que abre otra tienda (o
-- la portada) leeria con su sesion y no veria nada.

-- Miembro activo del equipo de esa tienda, con cualquier permiso. Mismas
-- condiciones que equipo_puede (plan pro o cortesia). SECURITY DEFINER para
-- poder leer store_miembros/store_profiles sin recursion de politicas.
create or replace function public.equipo_es_miembro(p_slug text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from store_miembros m
      join store_profiles sp on sp.slug = m.store_slug
     where m.user_id = auth.uid()
       and m.store_slug = p_slug
       and m.activo
       and sp.plan in ('pro', 'cortesia')
  );
$$;
revoke execute on function public.equipo_es_miembro(text) from public, anon;
grant execute on function public.equipo_es_miembro(text) to authenticated;

drop policy if exists sp_lectura_publica on public.store_profiles;
create policy sp_lectura_publica on public.store_profiles
  for select to anon
  using (true);

drop policy if exists sp_lectura_propia on public.store_profiles;
create policy sp_lectura_propia on public.store_profiles
  for select to authenticated
  using (user_id = auth.uid() or public.equipo_es_miembro(slug));

drop policy if exists prod_lectura_publica on public.store_products;
create policy prod_lectura_publica on public.store_products
  for select to anon
  using (coalesce(solo_interno, false) = false);

drop policy if exists prod_lectura_propia on public.store_products;
create policy prod_lectura_propia on public.store_products
  for select to authenticated
  using (
    exists (select 1 from public.store_profiles sp
             where sp.slug = store_products.store_slug and sp.user_id = auth.uid())
    or public.equipo_es_miembro(store_slug)
  );

-- La tienda ya lee variantes_publicas (74): el JSON con IMEI deja de ser publico.
revoke select (variantes) on public.store_products from anon;

notify pgrst, 'reload schema';
