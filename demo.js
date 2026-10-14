// La cuenta demo: una tienda que Walter (o quien venda BRUWAL) abre en una
// reunión y, en un toque, convierte en el negocio del cliente que tiene
// enfrente — una casa de celulares, una peluquería, una hamburguesería —
// con productos, ventas del último mes, turnos o reparaciones de ejemplo.
//
// POR QUÉ EXISTE:
// antes, para mostrar el sistema había que crear un usuario nuevo en cada
// reunión y cargarle productos a mano delante del cliente. Una tienda vacía
// no vende nada: el dashboard sin ventas es un gráfico chato.
//
// CÓMO SE ACTIVA:
// la tienda tiene que tener store_profiles.es_demo = true (lo pone el
// administrador con schema/62-cuenta-demo.sql). El panel solo carga este
// archivo para esas tiendas; para el resto no existe.
//
// QUÉ HACE "Cargar ejemplo":
// BORRA todo lo de esa tienda (productos, ventas, turnos, reparaciones,
// gastos, caja) y lo vuelve a armar con el rubro elegido. Por eso solo
// corre en una tienda marcada como demo: se chequea acá y no solo en el
// botón.
//
// Mismo criterio que planes.js: un archivo propio, sin saber nada del panel
// más allá de lo que recibe.

(function (global) {
  'use strict';

  var FOTOS = '/demo/fotos/';

  // Turnos apagados: el horario queda guardado por si el rubro los prende.
  var TURNOS_APAGADOS = { activo: false, porDia: false, dias: [1, 2, 3, 4, 5, 6],
                          desde: '09:00', hasta: '19:00', intervalo: 30 };

  // ---- Ayudas para escribir los productos cortos ----

  // Todas las combinaciones de los atributos, cada una con su stock.
  function conVariantes(campos, stockDe) {
    var combos = [{}];
    campos.forEach(function (c) {
      var nuevas = [];
      combos.forEach(function (base) {
        c.valores.forEach(function (v) {
          var a = {}; for (var k in base) a[k] = base[k];
          a[c.nombre] = v;
          nuevas.push(a);
        });
      });
      combos = nuevas;
    });
    var variantes = combos.map(function (atributos, i) {
      return { stock: stockDe(i, atributos), atributos: atributos };
    });
    return {
      tiene_variantes: true,
      variante_campos: campos,
      variantes: variantes,
      stock: variantes.reduce(function (s, v) { return s + v.stock; }, 0)
    };
  }

  var TALLES = { nombre: 'Talle', valores: ['S', 'M', 'L', 'XL'] };
  var stockTalles = function (i) { return [2, 5, 4, 1, 0, 3, 6, 2][i % 8]; };

  // ---- Los rubros ----
  //
  // `rubro_manual` tiene que ser uno de los valores de configRubroManual:
  // es lo que prende talles, agregados, IMEI, turnos, sabores.
  // En los productos: n nombre, c categoría, p precio, s stock, k costo,
  // f foto (archivo de /demo/fotos), d descripción. El resto va tal cual
  // a store_products.
  var RUBROS = {
    electronica: {
      etiqueta: 'Celulares', icono: '📱',
      nombre: 'Celulares Demo',
      descripcion: 'Venta de celulares, accesorios y servicio técnico.',
      eslogan: 'Tu celular, en buenas manos',
      hace_reparaciones: true,
      tema: { texto: '#15294d', banner: '#2f8fe0', tarjetas: '#eaf4fd' },
      categorias: ['Celulares', 'Accesorios', 'Audio', 'Cargadores', 'Servicio técnico'],
      productos: [
        { n: 'iPhone 13 128 GB', c: 'Celulares', p: 890000, s: 3, k: 760000, f: 'celular', d: 'Con caja y cargador. Garantía 6 meses.' },
        { n: 'iPhone 15 128 GB', c: 'Celulares', p: 1450000, s: 2, k: 1260000, f: 'celular' },
        { n: 'Samsung Galaxy A35 256 GB', c: 'Celulares', p: 620000, s: 4, k: 520000, f: 'celular' },
        { n: 'Motorola Moto G54', c: 'Celulares', p: 330000, s: 6, k: 270000, f: 'celular' },
        { n: 'Xiaomi Redmi Note 13', c: 'Celulares', p: 380000, s: 5, k: 310000, f: 'celular' },
        { n: 'Funda silicona iPhone', c: 'Accesorios', p: 15000, s: 30, k: 5000, f: 'funda' },
        { n: 'Vidrio templado 9D', c: 'Accesorios', p: 8000, s: 60, k: 1500, f: 'vidrio' },
        { n: 'Auriculares Bluetooth', c: 'Audio', p: 35000, s: 12, k: 18000, f: 'auriculares', precio_oferta: 29900 },
        { n: 'Parlante portátil', c: 'Audio', p: 48000, s: 7, k: 26000, f: 'parlante' },
        { n: 'Cargador 20W USB-C', c: 'Cargadores', p: 25000, s: 20, k: 11000, f: 'cargador' },
        { n: 'Cable USB-C 1 m', c: 'Cargadores', p: 9000, s: 40, k: 2500, f: 'cable' },
        { n: 'Cambio de pantalla', c: 'Servicio técnico', p: 120000, tipo: 'servicio', f: 'herramienta', d: 'Precio orientativo, depende del modelo.' },
        { n: 'Cambio de batería', c: 'Servicio técnico', p: 55000, tipo: 'servicio', f: 'bateria' }
      ]
    },

    indumentaria: {
      etiqueta: 'Ropa', icono: '👕',
      nombre: 'Ropa Demo',
      descripcion: 'Indumentaria y calzado para todos los días.',
      eslogan: 'Vestite como te gusta',
      tema: { texto: '#1a1a1a', banner: '#e8dcc4', tarjetas: '#f5ede0' },
      categorias: ['Remeras', 'Buzos', 'Pantalones', 'Calzado', 'Accesorios'],
      productos: [
        merge({ n: 'Remera básica algodón', c: 'Remeras', p: 18000, k: 7000, f: 'remera' },
              conVariantes([TALLES, { nombre: 'Color', valores: ['Negro', 'Blanco'] }], stockTalles)),
        merge({ n: 'Remera oversize estampada', c: 'Remeras', p: 24000, k: 9500, f: 'remera' },
              conVariantes([TALLES], stockTalles)),
        merge({ n: 'Buzo canguro frisa', c: 'Buzos', p: 42000, k: 19000, f: 'buzo', precio_oferta: 36000 },
              conVariantes([TALLES, { nombre: 'Color', valores: ['Gris', 'Negro'] }], stockTalles)),
        merge({ n: 'Jean mom', c: 'Pantalones', p: 48000, k: 22000, f: 'jean' },
              conVariantes([{ nombre: 'Talle', valores: ['36', '38', '40', '42'] }], stockTalles)),
        merge({ n: 'Jogger rústico', c: 'Pantalones', p: 32000, k: 14000, f: 'jean' },
              conVariantes([TALLES], stockTalles)),
        merge({ n: 'Zapatillas urbanas', c: 'Calzado', p: 75000, k: 38000, f: 'zapatilla' },
              conVariantes([{ nombre: 'Talle', valores: ['37', '38', '39', '40', '41', '42'] }], stockTalles)),
        { n: 'Gorra bordada', c: 'Accesorios', p: 15000, s: 14, k: 5500, f: 'gorra' },
        { n: 'Medias pack x3', c: 'Accesorios', p: 7500, s: 40, k: 2500, f: 'medias' }
      ]
    },

    servicios: {
      etiqueta: 'Peluquería', icono: '✂️',
      nombre: 'Peluquería Demo',
      descripcion: 'Peluquería y barbería. Sacá tu turno online.',
      eslogan: 'Tu estilo, tu turno',
      turnos: { activo: true, porDia: false, dias: [1, 2, 3, 4, 5, 6], desde: '09:00', hasta: '20:00', intervalo: 30 },
      tema: { texto: '#2b1d14', banner: '#b07d56', tarjetas: '#f6ede6' },
      categorias: ['Cortes', 'Color', 'Barbería', 'Productos'],
      productos: [
        { n: 'Corte de pelo', c: 'Cortes', p: 12000, tipo: 'servicio', duracion_minutos: 30, f: 'tijera',
          opciones: [{ nombre: 'Lavado', precio: 3000 }, { nombre: 'Peinado', precio: 4000 }] },
        { n: 'Corte niño', c: 'Cortes', p: 9000, tipo: 'servicio', duracion_minutos: 30, f: 'tijera' },
        { n: 'Color completo', c: 'Color', p: 35000, tipo: 'servicio', duracion_minutos: 90, f: 'color' },
        { n: 'Mechas / reflejos', c: 'Color', p: 45000, tipo: 'servicio', duracion_minutos: 120, f: 'color' },
        { n: 'Corte + barba', c: 'Barbería', p: 16000, tipo: 'servicio', duracion_minutos: 45, f: 'barba' },
        { n: 'Perfilado de barba', c: 'Barbería', p: 7000, tipo: 'servicio', duracion_minutos: 20, f: 'barba' },
        { n: 'Shampoo profesional 500 ml', c: 'Productos', p: 18000, s: 10, k: 8000, f: 'shampoo' },
        { n: 'Cera para peinar', c: 'Productos', p: 9500, s: 15, k: 3800, f: 'shampoo' }
      ]
    },

    comida: {
      etiqueta: 'Comida', icono: '🍔',
      nombre: 'Hamburguesería Demo',
      descripcion: 'Hamburguesas, papas y pizzas. Retiro y delivery.',
      eslogan: 'Pedí y en un rato lo tenés',
      demora_minutos: 30,
      tema: { texto: '#2a1206', banner: '#e4572e', tarjetas: '#fdeee6' },
      categorias: ['Hamburguesas', 'Pizzas', 'Papas', 'Bebidas', 'Postres'],
      productos: [
        { n: 'Hamburguesa clásica', c: 'Hamburguesas', p: 11000, s: 999, f: 'hamburguesa', d: 'Medallón 120 g, lechuga, tomate y queso.',
          opciones: [{ nombre: 'Cheddar extra', precio: 1500 }, { nombre: 'Panceta', precio: 2000 }, { nombre: 'Huevo', precio: 1000 }] },
        { n: 'Hamburguesa doble cheddar', c: 'Hamburguesas', p: 15000, s: 999, f: 'hamburguesa',
          opciones: [{ nombre: 'Panceta', precio: 2000 }, { nombre: 'Cebolla caramelizada', precio: 1200 }] },
        { n: 'Hamburguesa veggie', c: 'Hamburguesas', p: 12000, s: 999, f: 'hamburguesa' },
        { n: 'Pizza muzzarella', c: 'Pizzas', p: 13000, s: 999, f: 'pizza' },
        { n: 'Pizza especial', c: 'Pizzas', p: 16500, s: 999, f: 'pizza' },
        { n: 'Papas fritas', c: 'Papas', p: 6000, s: 999, f: 'papas',
          opciones: [{ nombre: 'Cheddar y panceta', precio: 2500 }] },
        { n: 'Gaseosa 500 ml', c: 'Bebidas', p: 2500, s: 48, k: 1100, f: 'gaseosa' },
        { n: 'Agua 500 ml', c: 'Bebidas', p: 1800, s: 36, k: 700, f: 'agua' },
        { n: 'Brownie con helado', c: 'Postres', p: 5500, s: 999, f: 'postre' }
      ]
    },

    bebidas: {
      etiqueta: 'Cafetería', icono: '☕',
      nombre: 'Café Demo',
      descripcion: 'Cafetería de especialidad, desayunos y meriendas.',
      eslogan: 'Un buen café cambia el día',
      demora_minutos: 10,
      tema: { texto: '#2b1b12', banner: '#6f4e37', tarjetas: '#f4ece4' },
      categorias: ['Cafés', 'Sin alcohol', 'Para picar', 'Promos'],
      productos: [
        { n: 'Café espresso', c: 'Cafés', p: 3200, s: 999, f: 'cafe' },
        { n: 'Café con leche', c: 'Cafés', p: 4200, s: 999, f: 'cafe',
          opciones: [{ nombre: 'Leche de almendras', precio: 800 }, { nombre: 'Shot extra', precio: 900 }] },
        { n: 'Capuchino', c: 'Cafés', p: 4800, s: 999, f: 'cafe' },
        { n: 'Limonada con menta', c: 'Sin alcohol', p: 4500, s: 999, f: 'limonada',
          opciones: [{ nombre: 'Con jengibre', precio: 500 }] },
        { n: 'Licuado de frutilla', c: 'Sin alcohol', p: 5200, s: 999, f: 'limonada' },
        { n: 'Medialunas x3', c: 'Para picar', p: 3600, s: 999, f: 'medialuna' },
        { n: 'Tostado jamón y queso', c: 'Para picar', p: 6500, s: 999, f: 'tostado' },
        { n: 'Desayuno completo', c: 'Promos', p: 9500, s: 999, f: 'desayuno', d: 'Café con leche, 2 medialunas y jugo de naranja.' }
      ]
    },

    vape: {
      etiqueta: 'Vape', icono: '💨',
      nombre: 'Vape Demo',
      descripcion: 'Vapes descartables, pods y líquidos.',
      eslogan: 'Todos los sabores, siempre',
      tema: { texto: '#14112b', banner: '#7c3aed', tarjetas: '#f1ebfd' },
      categorias: ['Descartables', 'Pods', 'Líquidos', 'Accesorios'],
      productos: [
        merge({ n: 'Descartable 5000 pitadas', c: 'Descartables', p: 22000, k: 11000, f: 'vape' },
              conVariantes([{ nombre: 'Sabor', valores: ['Menta', 'Frutilla', 'Sandía', 'Mango', 'Uva'] }],
                           function (i) { return [8, 3, 6, 0, 5][i]; })),
        merge({ n: 'Descartable 10000 pitadas', c: 'Descartables', p: 32000, k: 17000, f: 'vape' },
              conVariantes([{ nombre: 'Sabor', valores: ['Menta fría', 'Frutos rojos', 'Banana', 'Maracuyá'] }],
                           function (i) { return [4, 7, 2, 5][i]; })),
        { n: 'Pod recargable', c: 'Pods', p: 45000, s: 6, k: 24000, f: 'vape' },
        merge({ n: 'Líquido 30 ml', c: 'Líquidos', p: 14000, k: 6000, f: 'liquido' },
              conVariantes([{ nombre: 'Sabor', valores: ['Tabaco', 'Vainilla', 'Menta'] },
                            { nombre: 'Nicotina', valores: ['20 mg (2%)', '50 mg (5%)'] }],
                           function (i) { return [3, 5, 2, 4, 6, 1][i]; })),
        { n: 'Resistencias x5', c: 'Accesorios', p: 12000, s: 15, k: 5000, f: 'cable' },
        { n: 'Cargador USB-C', c: 'Accesorios', p: 7000, s: 20, k: 2500, f: 'cargador' }
      ]
    },

    otro: {
      etiqueta: 'Kiosco', icono: '🏪',
      nombre: 'Almacén Demo',
      descripcion: 'Kiosco y almacén de barrio. Pedidos por WhatsApp.',
      eslogan: 'Lo que necesitás, a la vuelta',
      tema: { texto: '#10302a', banner: '#1f9d74', tarjetas: '#e8f6f1' },
      categorias: ['Almacén', 'Bebidas', 'Golosinas', 'Limpieza', 'Fiambrería'],
      productos: [
        { n: 'Yerba 1 kg', c: 'Almacén', p: 4800, s: 24, k: 3400, f: 'yerba' },
        { n: 'Fideos 500 g', c: 'Almacén', p: 1600, s: 40, k: 1000, f: 'fideos' },
        { n: 'Aceite girasol 1,5 L', c: 'Almacén', p: 3900, s: 18, k: 2800, f: 'aceite' },
        { n: 'Gaseosa 2,25 L', c: 'Bebidas', p: 3200, s: 30, k: 2100, f: 'gaseosa' },
        { n: 'Agua mineral 2 L', c: 'Bebidas', p: 1500, s: 36, k: 850, f: 'agua' },
        { n: 'Alfajor triple', c: 'Golosinas', p: 1400, s: 60, k: 800, f: 'alfajor' },
        { n: 'Chocolate 100 g', c: 'Golosinas', p: 2600, s: 25, k: 1600, f: 'chocolate', precio_oferta: 2200 },
        { n: 'Lavandina 1 L', c: 'Limpieza', p: 1300, s: 20, k: 700, f: 'limpieza' },
        { n: 'Detergente 750 ml', c: 'Limpieza', p: 2400, s: 18, k: 1400, f: 'limpieza' },
        { n: 'Queso cremoso', c: 'Fiambrería', p: 9800, s: 8, k: 6500, f: 'queso', unidad_medida: 'kg',
          d: 'Precio por kilo.' },
        { n: 'Jamón cocido', c: 'Fiambrería', p: 14000, s: 6, k: 9500, f: 'fiambre', unidad_medida: 'kg',
          d: 'Precio por kilo.' }
      ]
    }
  };

  function merge(a, b) { for (var k in b) a[k] = b[k]; return a; }

  // El orden en que aparecen en la barra.
  var ORDEN = ['electronica', 'indumentaria', 'servicios', 'comida', 'bebidas', 'vape', 'otro'];

  // ---- Azar repetible ----
  // Con la misma semilla sale la misma demo: si Walter resetea, ve los
  // mismos números que la vez anterior y no lo agarra un gráfico distinto
  // en medio de la reunión.
  function azar(semilla) {
    var a = semilla >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var CLIENTES = ['Lucía Fernández', 'Martín Gómez', 'Sofía Díaz', 'Juan Pérez', 'Camila Romero',
                  'Diego Sosa', 'Valentina Torres', 'Nicolás Ruiz', 'Agustina Álvarez', 'Federico Acosta'];
  var MEDIOS = ['Efectivo', 'Efectivo', 'Transferencia', 'Transferencia', 'Débito', 'Mercado Pago'];

  // Fecha AR (UTC-3) a ISO. Argentina no tiene horario de verano.
  function enHoraAR(diasAtras, hora, minuto) {
    var hoyAR = new Date(Date.now() - 3 * 3600000);
    var d = Date.UTC(hoyAR.getUTCFullYear(), hoyAR.getUTCMonth(), hoyAR.getUTCDate() - diasAtras, hora + 3, minuto);
    return new Date(d).toISOString();
  }
  function fechaAR(diasAtras) { return enHoraAR(diasAtras, 12, 0).slice(0, 10); }
  function horaActualAR() { return new Date(Date.now() - 3 * 3600000).getUTCHours(); }

  // Ventas de los últimos 30 días, más tirando a los fines de semana y con
  // una leve subida hacia hoy: un gráfico plano no le dice nada a nadie.
  function armarVentas(slug, productos, rubro, r) {
    var vendibles = productos.filter(function (p) { return Number(p.price) > 0; });
    // Lo barato sale más seguido que lo caro: una casa de celulares vende
    // muchas fundas por cada iPhone. Peso = 1 / precio^0,6.
    var pesos = vendibles.map(function (p) { return 1 / Math.pow(Number(p.price), 0.6); });
    var sumaPesos = pesos.reduce(function (s, x) { return s + x; }, 0);
    var elegir = function () {
      var x = r() * sumaPesos;
      for (var i = 0; i < vendibles.length; i++) { x -= pesos[i]; if (x <= 0) return vendibles[i]; }
      return vendibles[vendibles.length - 1];
    };
    var mostrador = rubro === 'comida' || rubro === 'bebidas' || rubro === 'otro';
    var ventas = [];
    var ahora = horaActualAR();
    for (var dias = 29; dias >= 0; dias--) {
      var cuantas = 2 + Math.floor(r() * 4) + (dias < 10 ? 1 : 0) + (mostrador ? 4 : 0);
      for (var i = 0; i < cuantas; i++) {
        var hora = 10 + Math.floor(r() * 11);
        if (dias === 0 && hora >= ahora) continue;   // nada en el futuro
        var lineas = 1 + Math.floor(r() * (mostrador ? 3 : 2));
        var items = [];
        for (var j = 0; j < lineas; j++) {
          var p = elegir();
          // Lo caro se vende de a uno; lo barato, a veces de a varios.
          var qty = Number(p.price) < 10000 && r() < 0.4 ? 2 + Math.floor(r() * 2) : 1;
          var precio = Number(p.precio_oferta) > 0 ? Number(p.precio_oferta) : Number(p.price);
          var it = { product_id: p.id, qty: qty, name: p.name, price: precio };
          if (p.tiene_variantes && Array.isArray(p.variantes) && p.variantes.length) {
            it.variante = p.variantes[Math.floor(r() * p.variantes.length)].atributos;
          }
          items.push(it);
        }
        var total = items.reduce(function (s, x) { return s + x.qty * x.price; }, 0);
        var conNombre = r() < 0.45;
        ventas.push({
          store_slug: slug,
          customer_name: conNombre ? CLIENTES[Math.floor(r() * CLIENTES.length)]
                                   : 'Venta mostrador ' + String(hora).padStart(2, '0') + ':' + String(Math.floor(r() * 60)).padStart(2, '0'),
          customer_phone: 'scanner',
          items: items,
          total: total,
          estado: 'confirmado',
          saldo_pendiente: 0,
          medio_pago: MEDIOS[Math.floor(r() * MEDIOS.length)],
          created_at: enHoraAR(dias, hora, Math.floor(r() * 60))
        });
      }
    }

    // Uno o dos fiados abiertos: la pantalla de Fiado vacía no muestra nada.
    if (rubro === 'otro' || rubro === 'electronica' || rubro === 'indumentaria') {
      var p0 = vendibles[2 % vendibles.length];
      ventas.push({
        store_slug: slug, customer_name: 'Roberto Medina', customer_phone: '3415550101',
        items: [{ product_id: p0.id, qty: 1, name: p0.name, price: Number(p0.price) }],
        total: Number(p0.price), estado: 'confirmado',
        saldo_pendiente: Math.round(Number(p0.price) / 2),
        created_at: enHoraAR(6, 17, 20)
      });
    }

    // Comida y cafetería: pedidos de hoy en la cocina, para mostrar las
    // comandas andando.
    if (rubro === 'comida' || rubro === 'bebidas') {
      [['nuevo', 'delivery', 'Av. Pellegrini 1450'], ['nuevo', 'retiro', null], ['en_preparacion', 'retiro', null]].forEach(function (c, i) {
        var p = vendibles[i % vendibles.length];
        var q = vendibles[(i + 3) % vendibles.length];
        var items = [{ product_id: p.id, qty: 2, name: p.name, price: Number(p.price) },
                     { product_id: q.id, qty: 1, name: q.name, price: Number(q.price) }];
        ventas.push({
          store_slug: slug, customer_name: CLIENTES[i + 4], customer_phone: '341555020' + i,
          items: items, total: items.reduce(function (s, x) { return s + x.qty * x.price; }, 0),
          estado: 'confirmado', etapa: c[0], tipo_entrega: c[1], direccion: c[2],
          medio_pago: i === 0 ? 'Mercado Pago' : 'Efectivo',
          aclaraciones: i === 1 ? 'Sin cebolla' : null,
          created_at: new Date(Date.now() - (i + 1) * 6 * 60000).toISOString()
        });
      });
    }
    return ventas;
  }

  function armarTurnos(slug, productos, r) {
    var servicios = productos.filter(function (p) { return p.tipo === 'servicio'; });
    var turnos = [];
    var ocupado = {};
    // Hoy, mañana y pasado: lo que el cliente quiere ver es la agenda llena.
    [0, -1, -2].forEach(function (dias) {
      var fecha = fechaAR(dias);
      for (var i = 0; i < 6; i++) {
        var hora = 9 + Math.floor(r() * 10);
        var media = r() < 0.5 ? '00' : '30';
        var clave = fecha + hora + media;
        if (ocupado[clave]) continue;
        ocupado[clave] = true;
        var s = servicios[Math.floor(r() * servicios.length)];
        turnos.push({
          store_slug: slug, fecha: fecha, hora: String(hora).padStart(2, '0') + ':' + media,
          cliente: CLIENTES[Math.floor(r() * CLIENTES.length)], telefono: '34155501' + (10 + i),
          servicio: s ? s.name : null, duracion_minutos: s ? (s.duracion_minutos || 30) : 30,
          estado: 'confirmado', bloqueado: false
        });
      }
    });
    return turnos;
  }

  function armarReparaciones(slug) {
    var base = [
      ['Lucía Fernández', 'Apple', 'iPhone 11', 'Pantalla rota', 'recibido', 120000, 70000, 0],
      ['Diego Sosa', 'Samsung', 'Galaxy A52', 'No carga', 'en_reparacion', 45000, 15000, 1],
      ['Camila Romero', 'Motorola', 'Moto G60', 'Batería se descarga rápido', 'listo', 55000, 25000, 2],
      ['Martín Gómez', 'Xiaomi', 'Redmi Note 10', 'Cambio de módulo', 'en_reparacion', 98000, 52000, 1]
    ];
    return base.map(function (b, i) {
      return {
        store_slug: slug, cliente_nombre: b[0], cliente_telefono: '34155503' + (10 + i),
        marca: b[1], equipo: b[2], problema: b[3], estado: b[4],
        precio: b[5], costo: b[6], fecha_recibido: enHoraAR(b[7], 11, 15)
      };
    });
  }

  // Los gastos van en proporción a lo vendido: un alquiler fijo de
  // $450.000 se come la ganancia del kiosco y en la de celulares no se ve.
  function armarGastos(slug, rubro, vendido) {
    var redondo = function (x) { return Math.max(1000, Math.round(x / 1000) * 1000); };
    var gastos = [
      ['Alquiler del local', 'Otro', 0.12, 25],
      ['Luz', 'Impuestos', 0.03, 18],
      ['Publicidad en Instagram', 'Publicidad', 0.02, 10],
      ['Compra a proveedor', rubro === 'electronica' ? 'Repuestos' : 'Mercadería', 0.35, 4]
    ];
    return gastos.map(function (g) {
      var monto = redondo(vendido * g[2]);
      return { store_slug: slug, concepto: g[0], categoria: g[1], monto: monto, moneda: 'ARS',
               monto_original: monto, cotizacion: 1, fecha: fechaAR(g[3]), medio_pago: 'Transferencia' };
    });
  }

  // Tablas que se vacían al resetear, en este orden: primero lo que apunta
  // a otra cosa (los pagos apuntan a pedidos, los pedidos a reparaciones y
  // productos). Las `opcional` pueden no existir en una base atrasada.
  var TABLAS = [
    { t: 'store_pagos', opcional: true },
    { t: 'store_movimientos_caja', opcional: true },
    { t: 'store_imei_eventos', opcional: true },
    { t: 'orders' },
    { t: 'store_reparaciones', opcional: true },
    { t: 'store_turnos', opcional: true },
    { t: 'store_gastos', opcional: true },
    { t: 'store_products' }
  ];

  async function cargar(opts) {
    var sb = opts.sb;
    var store = opts.store;
    var clave = opts.rubro;
    var rubro = RUBROS[clave];
    var aviso = opts.progreso || function () {};

    if (!store || !store.slug) throw new Error('No hay tienda cargada.');
    if (store.es_demo !== true) throw new Error('Esta tienda no es de demo: no se borra nada.');
    if (!rubro) throw new Error('Rubro desconocido: ' + clave);

    var slug = store.slug;

    aviso('Borrando lo anterior…');
    for (var i = 0; i < TABLAS.length; i++) {
      var res = await sb.from(TABLAS[i].t).delete().eq('store_slug', slug);
      if (res.error && !TABLAS[i].opcional) throw res.error;
    }

    aviso('Armando el negocio…');
    var perfil = {
      business_name: (opts.nombre || '').trim() || rubro.nombre,
      description: rubro.descripcion,
      eslogan: rubro.eslogan,
      rubro_manual: clave,
      hace_reparaciones: !!rubro.hace_reparaciones,
      categorias: rubro.categorias,
      tema: rubro.tema,
      turnos: rubro.turnos || TURNOS_APAGADOS,
      demora_minutos: rubro.demora_minutos || 0
    };
    var rp = await sb.from('store_profiles').update(perfil).eq('slug', slug);
    if (rp.error) throw rp.error;

    aviso('Cargando productos…');
    var filas = rubro.productos.map(function (p, orden) {
      var fila = {
        store_slug: slug, name: p.n, category: p.c, price: p.p,
        description: p.d || null, costo: p.k == null ? null : p.k,
        stock: p.stock != null ? p.stock : (p.s || 0),
        in_stock: true, tipo: p.tipo || 'producto', orden: orden,
        image_url: p.f ? FOTOS + p.f + '.svg' : null
      };
      for (var k in p) {
        if (['n', 'c', 'p', 'd', 'k', 's', 'f', 'stock', 'tipo'].indexOf(k) === -1) fila[k] = p[k];
      }
      return fila;
    });
    var rprod = await sb.from('store_products').insert(filas)
      .select('id,name,price,precio_oferta,tipo,tiene_variantes,variantes,duracion_minutos');
    if (rprod.error) throw rprod.error;
    var productos = rprod.data || [];

    var r = azar(ORDEN.indexOf(clave) * 7919 + 17);

    aviso('Cargando ventas del último mes…');
    var ventas = armarVentas(slug, productos, clave, r);
    var rv = await sb.from('orders').insert(ventas);
    if (rv.error) throw rv.error;
    var vendido = ventas.reduce(function (s, v) { return s + v.total; }, 0);

    // Lo que sigue suma, pero si falla la demo igual sirve.
    var extras = [sb.from('store_gastos').insert(armarGastos(slug, clave, vendido))];
    if (clave === 'servicios') extras.push(sb.from('store_turnos').insert(armarTurnos(slug, productos, r)));
    if (clave === 'electronica') extras.push(sb.from('store_reparaciones').insert(armarReparaciones(slug)));
    await Promise.all(extras);
  }

  // ---- La barra del panel ----
  function escapar(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function montarBarra(opts) {
    var cont = opts.contenedor;
    var store = opts.store;
    if (!cont || !store || store.es_demo !== true) return;

    var actual = RUBROS[store.rubro_manual] ? store.rubro_manual : 'electronica';

    cont.innerHTML =
      '<span style="font-weight:700;">🎬 Cuenta demo</span>' +
      '<select id="demoRubro" aria-label="Rubro de la demo">' +
        ORDEN.map(function (k) {
          return '<option value="' + k + '"' + (k === actual ? ' selected' : '') + '>' +
                 RUBROS[k].icono + ' ' + escapar(RUBROS[k].etiqueta) + '</option>';
        }).join('') +
      '</select>' +
      '<input id="demoNombre" type="text" maxlength="60" placeholder="Nombre del negocio del cliente" ' +
        'value="' + escapar(store.business_name || '') + '" aria-label="Nombre del negocio">' +
      '<button type="button" id="demoCargarBtn">Cargar ejemplo</button>';

    var sel = cont.querySelector('#demoRubro');
    var nombre = cont.querySelector('#demoNombre');
    var boton = cont.querySelector('#demoCargarBtn');

    // Cambiar de rubro propone su nombre de ejemplo, salvo que ya hayan
    // escrito el del cliente: eso no se pisa.
    var nombresDeEjemplo = ORDEN.map(function (k) { return RUBROS[k].nombre; });
    sel.addEventListener('change', function () {
      if (!nombre.value.trim() || nombresDeEjemplo.indexOf(nombre.value.trim()) !== -1) {
        nombre.value = RUBROS[sel.value].nombre;
      }
    });

    boton.addEventListener('click', async function () {
      var rubro = RUBROS[sel.value];
      var ok = await opts.confirmar(
        'Vamos a dejar la demo como ' + rubro.icono + ' ' + rubro.etiqueta +
        (nombre.value.trim() ? ' ("' + nombre.value.trim() + '")' : '') + '.\n\n' +
        'Se borra todo lo que haya cargado en esta cuenta demo (productos, ventas, turnos) y se carga el ejemplo de nuevo.');
      if (!ok) return;
      boton.disabled = true;
      try {
        await cargar({
          sb: opts.sb, store: store, rubro: sel.value, nombre: nombre.value,
          progreso: function (t) { boton.textContent = t; }
        });
        boton.textContent = '¡Listo!';
        if (opts.listo) opts.listo();
      } catch (err) {
        boton.disabled = false;
        boton.textContent = 'Cargar ejemplo';
        opts.aviso('No se pudo cargar la demo:\n\n' + ((err && err.message) || err));
      }
    });
  }

  global.bruwalDemo = { RUBROS: RUBROS, ORDEN: ORDEN, cargar: cargar, montarBarra: montarBarra };
})(window);
