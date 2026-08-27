// Estado de cuenta del cliente, para el portal público (cuenta.html).
//
// Por qué existe este endpoint y no se consulta Supabase directo desde el
// navegador: para que el navegador pudiera leer las deudas haría falta una
// política que deje ver filas de `orders` sin estar logueado. Cualquier
// política así es peligrosa — con la clave pública (que está a la vista en
// el HTML) alguien podría pedir las deudas de TODOS los clientes de todas
// las tiendas.
//
// Acá el token viaja al servidor, se resuelve con la service role key, y se
// devuelve únicamente lo del cliente dueño de ese token. La clave nunca sale
// del servidor y el navegador jamás toca la tabla de deudas.

const SUPABASE_URL = 'https://qduguqazpxjjpxjfnkif.supabase.co';

function faltanVariables() {
  return ['SUPABASE_SERVICE_ROLE_KEY'].filter((n) => !process.env[n]);
}

async function consultar(ruta) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + ruta, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY
    }
  });
  if (!r.ok) throw new Error('Supabase respondió ' + r.status);
  return r.json();
}

module.exports = async (req, res) => {
  const faltan = faltanVariables();
  if (faltan.length) {
    return res.status(500).json({ error: 'Falta configurar: ' + faltan.join(', ') });
  }

  const token = String((req.query && req.query.t) || '').trim();
  // Los tokens son 64 caracteres hex. Cortar acá lo que no tenga esa forma
  // evita mandarle cualquier cosa a la base.
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return res.status(400).json({ error: 'Link inválido' });
  }

  try {
    const tokens = await consultar(
      'store_clientes_token?token=eq.' + token +
      '&revocado=is.false&select=store_slug,cliente_nombre&limit=1'
    );

    // Mismo mensaje para "no existe" y "revocado": no le confirmamos a nadie
    // que un token existió alguna vez.
    if (!tokens.length) {
      return res.status(404).json({ error: 'Este link no está activo. Pedile uno nuevo al negocio.' });
    }

    const { store_slug: slug, cliente_nombre: cliente } = tokens[0];
    const clienteFiltro = encodeURIComponent(cliente);

    const [tiendas, pedidos, reparaciones] = await Promise.all([
      // El logo de la tienda vive en image_url (no en logo_url), igual que
      // lo guarda Configuración en el panel.
      consultar('store_profiles?slug=eq.' + encodeURIComponent(slug) +
                '&select=business_name,phone,image_url&limit=1'),
      // Solo lo que tiene saldo: el estado de cuenta es de lo que se debe,
      // no un historial de todo lo que compró alguna vez.
      consultar('orders?store_slug=eq.' + encodeURIComponent(slug) +
                '&customer_name=eq.' + clienteFiltro +
                '&saldo_pendiente=gt.0' +
                '&select=id,created_at,items,total,saldo_pendiente&order=created_at.asc'),
      // 'entregado' queda afuera: si ya se lo llevó, no es "en curso".
      consultar('store_reparaciones?store_slug=eq.' + encodeURIComponent(slug) +
                '&cliente_nombre=eq.' + clienteFiltro +
                '&estado=neq.entregado' +
                '&select=numero,equipo,problema,precio,estado,fecha_recibido&order=fecha_recibido.desc')
    ]);

    // Los pagos se piden después porque dependen de qué pedidos salieron.
    let pagos = [];
    if (pedidos.length) {
      const ids = pedidos.map((p) => p.id).join(',');
      pagos = await consultar(
        'store_pagos?order_id=in.(' + ids + ')&select=order_id,monto,created_at,nota&order=created_at.asc'
      );
    }

    const totalAdeudado = pedidos.reduce((s, p) => s + Number(p.saldo_pendiente || 0), 0);

    // Cache-Control no-store: un estado de cuenta no se cachea en ningún
    // proxy intermedio.
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      negocio: tiendas[0] || {},
      cliente,
      total_adeudado: totalAdeudado,
      pedidos,
      pagos,
      reparaciones,
      generado: new Date().toISOString()
    });
  } catch (e) {
    return res.status(500).json({ error: 'No pudimos traer el estado de cuenta. Probá de nuevo en un momento.' });
  }
};
