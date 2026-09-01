// ============================================================
//  BRUWAL — Los planes, en un solo lugar.
//
//  Lo cargan el panel (dashboard/index.html) y la home (index.html). Antes
//  vivian solo adentro del panel; cuando hubo que mostrarlos tambien en la
//  home, copiarlos habria dejado los precios en dos archivos, que es
//  exactamente el problema que ya existe entre el precio de aca y el monto
//  cargado en el link de Mercado Pago. Con dos lugares alcanza para que un
//  dia no coincidan y alguien vea un precio y se le cobre otro.
//
//  Es un script clasico, no un modulo: define constantes globales que las
//  dos paginas leen directo. Por eso va ANTES del <script> de cada pagina.
// ============================================================

// Lo que en la competencia es la letra chica del techo, acá se muestra al
// derecho. Son los mismos en Basic y en Pro porque son límites de la
// plataforma, no del escalón: no hay ninguno.
const LIMITES_DE_LA_PLATAFORMA = [
  'Productos ilimitados',
  'Ventas y pedidos ilimitados',
  'El precio que ves es el que pagás'
];

// ---- Plan anual --------------------------------------------------------
// Se paga un año de una y sale menos. El descuento es UN solo número: el
// precio anual sale de multiplicar el mensual por 12 y aplicarlo, así que
// el precio mensual sigue siendo la única fuente de verdad y no hay dos
// numeros para mantener sincronizados (que es justo lo que ya nos pasó
// con el monto del link de Mercado Pago).
const ANUAL_DESCUENTO = 0.20;

// IMPORTANTE: el precio que se muestra aca tiene que coincidir con el monto
// configurado en el link de Mercado Pago. Si no coinciden, el cliente ve un
// precio y se le cobra otro.
// Mientras el link de un plan 'pago' no empiece con https, el modal muestra
// "planes en preparacion" en vez de un boton de pago roto.

const PLANES = {
  basic: {
    nombre: 'Stock y Pedidos',
    tipo: 'pago',               // se activa solo, con Mercado Pago
    precioAnterior: '$35.000',
    precio: '$25.900',
    periodo: 'por mes',
    paraQuien: 'Para el negocio que quiere dejar de anotar en un cuaderno y empezar a vender online.',
    limites: LIMITES_DE_LA_PLATAFORMA,
    resumen: 'Todo el negocio ordenado en un solo lugar: stock, ventas, clientes y tu tienda online.',
    // Plan "Bruwalstock Basic" en Mercado Pago. Usamos la URL larga a
    // proposito: el link corto (mpago.la/28KDgwc) descarta los parametros
    // al redirigir y perderiamos el external_reference, que es lo que le
    // dice al webhook QUE tienda pago.
    link: 'https://www.mercadopago.com.ar/subscriptions/checkout?preapproval_plan_id=558bf71f6d62460797b95829fc767e0d',
    grupos: [
      { t: 'Productos y stock', items: [
        'Productos ilimitados, con foto y categorías',
        'Variantes por talle, color y modelo',
        'Alertas automáticas de stock bajo',
        'Importación y exportación masiva por Excel',
        'Etiquetas con código de barras para imprimir',
        'Carga de equipos por IMEI, uno por uno',
        'Valoración de tu stock a costo, en vivo'
      ]},
      { t: 'Ventas y clientes', items: [
        'Ventas con lector de código de barras',
        'Historial completo de ventas y pedidos',
        'Ficha de cliente con todo lo que compró',
        'Cuentas corrientes: fiado con saldo por cliente',
        'Gastos del negocio, mes a mes',
        'Toma de equipo usado en parte de pago'
      ]},
      { t: 'Tu tienda pública', items: [
        'Tienda online propia con carrito',
        'Los pedidos te llegan por WhatsApp',
        'Link propio para compartir donde quieras',
        'Aparecés en el mapa de tiendas de BRUWAL'
      ]},
      { t: 'Servicio técnico y agenda', items: [
        'Reparaciones de punta a punta, con estados',
        'Agenda de turnos por día',
        'Panel con tendencia de ventas de 12 meses'
      ]},
      { t: 'Y además', items: [
        'App instalable en el celular',
        'PIN para que un empleado no vea los costos',
        'Actualizaciones incluidas, sin instalar nada',
        'Soporte por WhatsApp'
      ]}
    ],
    nota: 'Cancelás cuando quieras, desde tu panel.'
  },
  pro: {
    nombre: 'Pro',
    tipo: 'pago',                // se activa solo, con Mercado Pago
    destacado: true,
    precioAnterior: '$87.500',
    precio: '$70.000',
    periodo: 'por mes',
    paraQuien: 'Para el que ya vende todos los días y necesita ver la plata y los números, no solo el stock.',
    limites: LIMITES_DE_LA_PLATAFORMA,
    resumen: 'Todo lo del plan Stock y Pedidos, más el control de la plata y los números del negocio:',
    // Plan de Mercado Pago -- cobra $70.000 de verdad, coincide con lo que
    // se muestra. URL larga a proposito, igual que Basic: el acortador
    // (mpago.la) descarta el external_reference del slug de la tienda al
    // redirigir, y sin eso no hay forma de saber que tienda pago.
    link: 'https://www.mercadopago.com.ar/subscriptions/checkout?preapproval_plan_id=7f3874b7347b43698e4b9daf92a5405b',
    grupos: [
      { t: 'Caja diaria', items: [
        'Ingresos y egresos del día en una sola pantalla',
        'Todo separado por medio de pago',
        'Suma sola las ventas, los cobros de fiado y los gastos',
        'Movimientos manuales para lo que no pasa por el sistema'
      ]},
      { t: 'Estadísticas del negocio', items: [
        'Ranking de productos por facturación y margen real',
        'Productos con stock que no se están vendiendo',
        'Clientes segmentados: VIP, frecuente, en riesgo, inactivo',
        'Comparación por período, con un clic'
      ]},
      { t: 'Equipos e IMEI', items: [
        'Historial completo por IMEI en una línea de tiempo',
        'Ingreso, venta y reparación de cada equipo, juntos',
        'Buscador de IMEI desde Productos'
      ]},
      { t: 'Carga inteligente', items: [
        'Cargá el stock sacándole una foto a la factura (IA)',
        'Reconoce productos, cantidades y costos'
      ]},
      { t: 'Soporte', items: [
        'Atención prioritaria por WhatsApp'
      ]}
    ],
    nota: 'Cancelás cuando quieras, desde tu panel.'
  }
};

// El Bot de pedidos con IA no es un escalón de plan: es un adicional a
// medida que se suma sobre Basic o Pro, se cotiza por WhatsApp y se
// factura aparte. Vive fuera de PLANES a propósito, para no mezclarlo
// con el gating de currentStore.plan (que ya no tiene nada que ver con
// el bot desde que Pro se separó en $70.000 fijos).
const BOT_PEDIDOS = {
  nombre: 'Bot de pedidos con IA',
  precio: 'A medida',
  periodo: 'lo armamos con vos',
  paraQuien: 'Para el que no da abasto contestando el WhatsApp y pierde pedidos por no llegar.',
  resumen: 'Un adicional que se suma sobre cualquier plan: atiende el WhatsApp por vos.',
  grupos: [
    { t: 'Qué hace', items: [
      'Toma los pedidos solo, sin que nadie esté atendiendo',
      'Responde precios, stock y horarios las 24 horas',
      'Consulta tu stock real antes de confirmar',
      'Descuenta el stock cuando el pedido se cierra'
    ]},
    { t: 'Cómo se arma', items: [
      'Configurado según tu rubro y tu carta',
      'Con tus respuestas y tu forma de hablar',
      'Se suma sobre el plan que ya tengas',
      'Lo cotizamos según tu volumen de consultas'
    ]}
  ],
  nota: 'Se factura aparte del plan de stock.'
};
