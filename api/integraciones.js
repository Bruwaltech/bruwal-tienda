// Una sola función de Vercel para las integraciones de cada tienda:
// facturación con ARCA y la cuenta de cobro de Mercado Pago.
//
// Por qué juntas: el plan de Vercel admite hasta 12 funciones por deploy y
// /api ya estaba en el límite. Con una función más el deploy falla entero.
// Los archivos con "_" adelante no cuentan como función, así que la lógica
// sigue en _arca.js y _mercadopago.js y acá solo se reparte.
//
// Las URLs no cambian: vercel.json reescribe /api/arca, /api/mercadopago y
// /api/mp-callback hacia acá con ?servicio=...

const arca = require('./_arca');
const mercadopago = require('./_mercadopago');

module.exports = (req, res) => {
  const servicio = (req.query || {}).servicio;
  if (servicio === 'arca') return arca(req, res);
  if (servicio === 'mercadopago') return mercadopago(req, res);
  return res.status(404).json({ error: 'Servicio desconocido' });
};
