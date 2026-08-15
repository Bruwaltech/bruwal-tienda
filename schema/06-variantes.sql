-- Variantes con stock independiente (talle, color, etc)
alter table public.store_products
  add column if not exists tiene_variantes boolean not null default false,
  add column if not exists variante_campos jsonb   not null default '[]'::jsonb,
  add column if not exists variantes       jsonb   not null default '[]'::jsonb;
