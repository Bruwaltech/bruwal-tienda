-- ============================================================
--  BRUWAL — PIN para proteger Costos (Gastos y Costo/Margen de
--  reparaciones), para que solo el dueño o personas autorizadas
--  los vean.
--  Correr en Supabase → SQL Editor. Sin $$, para que no se corte
--  al pegarlo. Es aditivo e idempotente.
-- ============================================================

-- Se guarda el HASH (SHA-256) del PIN, nunca el PIN en texto plano. null =
-- todavía no lo configuraron, y en ese caso no se pide nada (compatibilidad
-- con las tiendas que ya existen: nadie queda bloqueado por sorpresa).
--
-- Nota de seguridad honesta: un PIN de 4 dígitos tiene solo 10.000
-- combinaciones — el hash frena a alguien mirando la base de datos por
-- arriba, pero no es una traba real contra un ataque de fuerza bruta. Es
-- pensado como un freno casero para que un empleado no vea los costos sin
-- querer, no como seguridad bancaria.
alter table public.store_profiles
  add column if not exists pin_costos text;

-- Datos del proveedor de un producto (a quién se le compró, para
-- reponer) — igual que el costo, es información que el dueño puede no
-- querer que vea cualquiera con acceso al panel. Se protege con el mismo
-- PIN de arriba.
alter table public.store_products
  add column if not exists proveedor_nombre    text,
  add column if not exists proveedor_telefono  text,
  add column if not exists proveedor_email     text;

-- Verificación
select 'pin_costos y proveedor agregados' as estado,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_profiles'
          and column_name='pin_costos') as columna_pin,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='store_products'
          and column_name in ('proveedor_nombre','proveedor_telefono','proveedor_email')) as columnas_proveedor;
