-- ============================================================
--  BRUWAL — Facturación electrónica con ARCA (ex AFIP).
--
--  Cómo funciona: BRUWAL tiene UN certificado de ARCA, a nombre de
--  la CUIT de Bruwaltech. Cada negocio, una sola vez, entra a ARCA y
--  le delega a esa CUIT el web service de factura electrónica (wsfe)
--  y crea un punto de venta "Web Services". Desde ahí BRUWAL pide el
--  CAE en nombre del negocio, sin que el negocio maneje certificados.
--
--  Correr en Supabase → SQL Editor. Sin $$, para que no se corte al
--  pegarlo. Es aditivo e idempotente.
-- ============================================================


-- ------------------------------------------------------------
--  1) Datos fiscales de cada negocio.
--
--  No son secretos, así que el dueño la puede LEER (el panel la usa
--  para saber si mostrar el botón Facturar). Escribirla, solo desde
--  api/_arca.js: así no se cambia la CUIT con la que se factura por un
--  camino que no valide nada.
-- ------------------------------------------------------------
create table if not exists public.store_arca (
  store_slug          text primary key references public.store_profiles(slug) on delete cascade,
  cuit                text not null,                    -- 11 dígitos, sin guiones
  razon_social        text not null,
  punto_venta         integer not null,                 -- el que se creó como "Web Services"
  condicion_iva       text not null default 'monotributo'
                      check (condicion_iva in ('monotributo')),
  domicilio           text,
  inicio_actividades  date,
  ingresos_brutos     text,                             -- nro o "Convenio multilateral"
  auto_facturar       boolean not null default false,   -- facturar cada venta sola
  actualizado_en      timestamptz not null default now()
);

alter table public.store_arca enable row level security;

drop policy if exists arca_ver_propia on public.store_arca;
create policy arca_ver_propia on public.store_arca for select
  using (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_arca.store_slug and sp.user_id = auth.uid()));


-- ------------------------------------------------------------
--  2) Los comprobantes emitidos.
--
--  El dueño los LEE desde el panel (para reimprimir o listar), pero
--  no los escribe: un comprobante con CAE es un documento fiscal y
--  solo lo crea el servidor después de que ARCA lo autorizó.
--
--  order_id único: una venta se factura una sola vez. Es lo que evita
--  que un doble toque en "Facturar" saque dos facturas por la misma
--  venta.
-- ------------------------------------------------------------
create table if not exists public.store_comprobantes (
  id                 uuid primary key default gen_random_uuid(),
  store_slug         text not null references public.store_profiles(slug) on delete cascade,
  order_id           uuid references public.orders(id) on delete set null,
  estado             text not null default 'pendiente'
                     check (estado in ('pendiente', 'autorizado')),
  tipo               integer not null,                  -- 11 = Factura C
  punto_venta        integer not null,
  numero             bigint,
  fecha              date not null,
  total              numeric(14,2) not null,
  doc_tipo           integer not null default 99,       -- 99 = sin identificar, 96 = DNI, 80 = CUIT
  doc_nro            bigint not null default 0,
  receptor_nombre    text,
  receptor_condicion integer not null default 5,        -- 5 = Consumidor final
  cae                text,
  cae_vto            date,
  emisor             jsonb,                             -- copia de los datos fiscales al momento de emitir
  items              jsonb,
  creado_en          timestamptz not null default now()
);

create unique index if not exists store_comprobantes_una_por_venta
  on public.store_comprobantes(order_id) where order_id is not null;
create unique index if not exists store_comprobantes_numero_unico
  on public.store_comprobantes(store_slug, tipo, punto_venta, numero) where numero is not null;
create index if not exists store_comprobantes_por_tienda
  on public.store_comprobantes(store_slug, fecha desc);

alter table public.store_comprobantes enable row level security;

drop policy if exists comprobantes_ver_propios on public.store_comprobantes;
create policy comprobantes_ver_propios on public.store_comprobantes for select
  using (exists (
    select 1 from public.store_profiles sp
    where sp.slug = store_comprobantes.store_slug and sp.user_id = auth.uid()));


-- ------------------------------------------------------------
--  3) El ticket de acceso de ARCA (WSAA).
--
--  Dura 12 horas y ARCA no da otro mientras el anterior siga vivo, así
--  que hay que guardarlo: cada función de Vercel arranca de cero. Es
--  uno solo para todos los negocios, porque es del certificado de
--  BRUWAL; el negocio se indica en cada pedido con su CUIT.
--  Sin políticas: es una credencial.
-- ------------------------------------------------------------
create table if not exists public.arca_acceso (
  servicio     text primary key,          -- 'wsfe' + entorno
  token        text not null,
  sign         text not null,
  expira_en    timestamptz not null
);

alter table public.arca_acceso enable row level security;


-- Verificación
select 'facturación ARCA lista' as estado,
       (select count(*) from pg_policies
        where schemaname='public' and tablename='store_comprobantes') as politicas;
