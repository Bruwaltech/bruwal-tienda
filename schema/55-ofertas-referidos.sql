-- ============================================================
--  BRUWAL — Ofertas de Mercado Libre con links de referido.
--
--  PARA QUÉ: una página pública (/ofertas) donde la gente entra, elige un
--  rubro y encuentra ofertas de Mercado Libre elegidas a mano. Cada botón
--  lleva al link de afiliado de BRUWAL: si compra, la comisión es nuestra.
--
--  QUIÉN ESCRIBE: solo la cuenta de BRUWAL, desde /ofertas/panel.html, a
--  través de /api/ofertas con el service role. La lista de admins vive en
--  ADMIN_EMAILS (Vercel), igual que el resto de lo que es "solo soporte".
--  Por eso acá NO hay políticas de insert/update/delete: el navegador no
--  puede escribir nada, ni siquiera estando logueado.
--
--  QUIÉN LEE: cualquiera, pero solo las ofertas vigentes (activas y sin
--  vencer) y solo las columnas que se muestran. Los clics son nuestros: un
--  competidor no tiene por qué ver qué oferta funciona.
--
--  Es aditivo e idempotente.
-- ============================================================

create table if not exists public.ofertas (
  id             uuid primary key default gen_random_uuid(),

  -- El link de referido TAL CUAL lo da Mercado Libre (meli.la/...,
  -- mercadolibre.com/sec/...). Es el que cobra la comisión: no se
  -- reemplaza por el link "limpio" de la publicación.
  link           text not null check (link ~* '^https://'),

  titulo         text not null check (char_length(titulo) between 1 and 200),
  imagen_url     text check (imagen_url is null or imagen_url ~* '^https://'),
  precio         numeric check (precio is null or precio >= 0),
  -- El precio tachado. Solo se muestra si es MAYOR que precio.
  precio_antes   numeric check (precio_antes is null or precio_antes >= 0),

  rubro          text not null default 'Varios' check (char_length(rubro) between 1 and 40),
  -- Una línea de por qué la recomendamos. Es lo que la diferencia de
  -- buscar en Mercado Libre directamente.
  nota           text check (nota is null or char_length(nota) <= 280),
  ml_item_id     text,

  destacada      boolean not null default false,
  activa         boolean not null default true,
  -- Las ofertas de ML duran poco. Con fecha, se esconde sola al otro día;
  -- sin fecha, queda hasta que se la apague a mano.
  vence          date,

  clicks         integer not null default 0,
  ultimo_click   timestamptz,

  creada_en      timestamptz not null default now(),
  actualizada_en timestamptz not null default now()
);

create index if not exists ofertas_vigentes
  on public.ofertas (activa, destacada desc, creada_en desc);

alter table public.ofertas enable row level security;

drop policy if exists "cualquiera ve las ofertas vigentes" on public.ofertas;
create policy "cualquiera ve las ofertas vigentes" on public.ofertas
  for select to anon, authenticated
  using (activa and (vence is null or
         vence >= (now() at time zone 'America/Argentina/Buenos_Aires')::date));

-- Solo las columnas que muestra la página. Supabase da SELECT sobre la
-- tabla entera por defecto; sin esto, clicks y ultimo_click se leerían
-- con la clave pública.
revoke select on public.ofertas from anon, authenticated;
grant select (id, link, titulo, imagen_url, precio, precio_antes, rubro, nota,
              destacada, vence, creada_en)
  on public.ofertas to anon, authenticated;


-- ------------------------------------------------------------
--  Clics por día. El total de siempre no dice qué está funcionando HOY:
--  una oferta vieja con 300 clics puede no tener ninguno esta semana.
-- ------------------------------------------------------------
create table if not exists public.ofertas_clicks_dia (
  oferta_id uuid not null references public.ofertas(id) on delete cascade,
  dia       date not null,
  clicks    integer not null default 0,
  primary key (oferta_id, dia)
);

-- Sin políticas: la lee solo el panel, con el service role.
alter table public.ofertas_clicks_dia enable row level security;


-- El botón de la página pública cuenta el clic contra esto. Es security
-- definer porque el navegador no puede escribir en las tablas; a cambio,
-- lo único que puede hacer es sumar 1 a una oferta vigente.
create or replace function public.contar_click_oferta(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  hoy date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
begin
  update public.ofertas
     set clicks = clicks + 1, ultimo_click = now()
   where id = p_id and activa;

  if found then
    insert into public.ofertas_clicks_dia (oferta_id, dia, clicks)
    values (p_id, hoy, 1)
    on conflict (oferta_id, dia)
    do update set clicks = public.ofertas_clicks_dia.clicks + 1;
  end if;
end;
$$;

revoke all on function public.contar_click_oferta(uuid) from public;
grant execute on function public.contar_click_oferta(uuid) to anon, authenticated;

notify pgrst, 'reload schema';

-- Verificación
select 'ofertas' as estado,
       (select count(*) from information_schema.tables
         where table_schema='public' and table_name in ('ofertas','ofertas_clicks_dia')) as tablas,
       (select count(*) from pg_policies
         where schemaname='public' and tablename='ofertas') as politicas,
       (select rowsecurity from pg_tables
         where schemaname='public' and tablename='ofertas') as rls;
