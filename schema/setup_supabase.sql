-- ============================================================
-- TABLAS PARA TIENDA ONLINE
-- ============================================================

-- 1. PERFIL DE TIENDA (store_profiles)
CREATE TABLE IF NOT EXISTS store_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  business_name TEXT NOT NULL,
  phone TEXT,
  description TEXT,
  image_url TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- 2. PRODUCTOS DE TIENDA (store_products)
CREATE TABLE IF NOT EXISTS store_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_slug TEXT REFERENCES store_profiles(slug) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  price NUMERIC NOT NULL,
  image_url TEXT,
  category TEXT,
  stock INTEGER DEFAULT 999,
  min_stock INTEGER DEFAULT 0,
  ean TEXT,
  provider TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- 3. PEDIDOS (orders)
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_slug TEXT REFERENCES store_profiles(slug) ON DELETE CASCADE NOT NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  items JSONB NOT NULL,
  total NUMERIC NOT NULL,
  status TEXT DEFAULT 'nuevo',
  notes TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- Índices para mejorar rendimiento
CREATE INDEX IF NOT EXISTS idx_store_profiles_user_id ON store_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_store_profiles_slug ON store_profiles(slug);
CREATE INDEX IF NOT EXISTS idx_store_products_store_slug ON store_products(store_slug);
CREATE INDEX IF NOT EXISTS idx_orders_store_slug ON orders(store_slug);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);

-- ============================================================
-- DATOS DE EJEMPLO PARA BRUWALTECH
-- ============================================================

-- Primero, obtén tu USER_ID ejecutando esto:
-- SELECT auth.uid();
-- Luego reemplaza 'TU_USER_ID_AQUI' con el resultado

-- Insertar tienda de ejemplo
INSERT INTO store_profiles (user_id, slug, business_name, phone, description, image_url)
VALUES (
  'TU_USER_ID_AQUI',
  'bruwaltech',
  'Bruwaltech - Sistemas para Comercios',
  '3413005232',
  'Soluciones tecnológicas para tu negocio',
  NULL
)
ON CONFLICT (slug) DO NOTHING;

-- Insertar productos de ejemplo
INSERT INTO store_products (store_slug, name, description, price, category, stock, image_url)
VALUES
  ('bruwaltech', 'Papel Térmico 80x40mm - x10 rollos', 'Papel de calidad para impresoras POS', 3500, 'Consumibles', 45, NULL),
  ('bruwaltech', 'Impresora Térmica POS 58mm', 'Impresora térmica profesional para puntos de venta', 125000, 'Hardware', 6, NULL),
  ('bruwaltech', 'Lector Código de Barras USB', 'Lector USB profesional para escaneo de códigos', 45000, 'Periféricos', 22, NULL),
  ('bruwaltech', 'Laptop HP 15" G10', 'Laptop de 15 pulgadas, procesador i5, 8GB RAM', 899999, 'Electrónica', 45, NULL),
  ('bruwaltech', 'Mochila Trekking 40L Impermeable', 'Mochila resistente al agua, 40 litros', 28000, 'Accesorios', 15, NULL),
  ('bruwaltech', 'Botella Térmica Acero 1L', 'Botella térmica de acero inoxidable', 12500, 'Accesorios', 15, NULL),
  ('bruwaltech', 'Cable USB C Premium 2m', 'Cable USB tipo C de alta calidad', 4500, 'Periféricos', 50, NULL),
  ('bruwaltech', 'Batería Externa 20000mAh', 'Batería portátil para cargar dispositivos', 8900, 'Electrónica', 30, NULL)
ON CONFLICT DO NOTHING;
