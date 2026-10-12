-- ============================================================
--  BRUWAL — Panel del afiliado: un link privado para que cada
--  afiliado vea su link para compartir, cuántas ventas trajo y
--  cuánto lleva ganado, sin registrarse ni tener contraseña.
--
--  Mismo criterio que el portal del cliente (33-portal-clientes):
--  token de 64 caracteres hex generado en la base, imposible de
--  adivinar. La página afiliado.html NO lee tablas desde el
--  navegador: se lo pide a api/afiliado.js, que con la service
--  role key devuelve solo lo de ese afiliado y sin datos de los
--  clientes (ni nombre ni teléfono).
--
--  Va como columna de store_afiliados y no en una tabla aparte:
--  es un link por afiliado, y el dueño ya ve esa fila en el panel.
--  Para cortarle el acceso alcanza con pausarlo.
--
--  Correr en Supabase -> SQL Editor. Aditivo e idempotente.
-- ============================================================

-- El default es volátil, así que cada afiliado que ya existe recibe
-- su propio token al agregar la columna, no uno compartido.
alter table public.store_afiliados
  add column if not exists token text not null
    default replace(gen_random_uuid()::text, '-', '') ||
            replace(gen_random_uuid()::text, '-', '');

create unique index if not exists store_afiliados_token_unico
  on public.store_afiliados (token);

NOTIFY pgrst, 'reload schema';

-- Verificación: tiene que dar 1
select count(*) as col_token
  from information_schema.columns
 where table_schema='public' and table_name='store_afiliados' and column_name='token';
