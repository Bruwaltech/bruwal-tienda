// La imagen de un producto para una historia de Instagram o un estado.
//
// POR QUÉ EXISTE, si el link ya tiene vista previa:
// Instagram NO muestra vista previa de links — ni en el feed ni en las
// historias: el sticker de link es texto y nada más. Y en un estado de
// WhatsApp la previa sale chica. En esos dos lugares lo único que ocupa
// pantalla es una imagen, así que hay que fabricarla.
//
// POR QUÉ ESTÁ EN SU PROPIO ARCHIVO:
// la usan la tienda (el botón Compartir de la ficha) y el panel (el 📷 de
// cada producto). Copiada en los dos, el día que cambie el diseño habría
// que acordarse de cambiarla dos veces — y la segunda no se hace nunca.
// Mismo criterio que planes.js.
//
// No sabe nada de tiendas ni de paneles: recibe los textos ya armados. Cada
// página formatea el precio con sus propias funciones, que no son iguales.

(function (global) {
  'use strict';

  // 1080x1350 es el formato vertical de Instagram y el que mejor entra en
  // un estado: ocupa la pantalla del teléfono casi entera.
  var ANCHO = 1080;
  var ALTO = 1350;

  // La foto ocupa 880 y no 1080 porque abajo tienen que entrar el nombre
  // (hasta dos líneas), las estrellas, el precio y el pie. Con 270px el
  // precio terminaba dibujado encima del nombre del negocio.
  var ALTO_FOTO = 880;

  var FUENTE = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';

  // La foto viene de otro dominio (el storage). Sin crossOrigin el canvas
  // queda "manchado" y exportarlo tira error: el navegador no deja sacar
  // píxeles de una imagen de otro lado sin permiso. El storage lo da
  // (Access-Control-Allow-Origin: *), pero hay que pedirlo explícitamente.
  function cargarImagen(url) {
    return new Promise(function (resolve) {
      if (!url) return resolve(null);
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () { resolve(img); };
      img.onerror = function () { resolve(null); };   // sin foto se arma igual
      img.src = url;
    });
  }

  // Texto que no entra en el ancho: se parte en líneas y, si se pasa del
  // máximo, la última termina en puntos suspensivos. Un nombre largo
  // cortado a lo bruto se lee como un error.
  function partirTexto(ctx, texto, ancho, maxLineas) {
    var palabras = String(texto || '').split(/\s+/).filter(Boolean);
    var lineas = [];
    var actual = '';

    palabras.forEach(function (palabra) {
      var prueba = actual ? actual + ' ' + palabra : palabra;
      if (ctx.measureText(prueba).width <= ancho || !actual) {
        actual = prueba;
      } else {
        lineas.push(actual);
        actual = palabra;
      }
    });
    if (actual) lineas.push(actual);

    if (lineas.length > maxLineas) {
      var recortada = lineas[maxLineas - 1];
      while (recortada && ctx.measureText(recortada + '…').width > ancho) {
        recortada = recortada.slice(0, -1);
      }
      lineas.length = maxLineas;
      lineas[maxLineas - 1] = recortada + '…';
    }
    return lineas;
  }

  // La foto entra recortada, no deformada: una pava estirada para llenar el
  // cuadrado se ve mal y no la comparte nadie.
  function dibujarCubriendo(ctx, img, x, y, ancho, alto) {
    var escala = Math.max(ancho / img.width, alto / img.height);
    var w = img.width * escala;
    var h = img.height * escala;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, ancho, alto);
    ctx.clip();
    ctx.drawImage(img, x + (ancho - w) / 2, y + (alto - h) / 2, w, h);
    ctx.restore();
  }

  // datos = {
  //   nombre,           el del producto
  //   precio,           texto ya formateado ("$28.900" o "Consultar precio")
  //   precioAnterior,   texto o null — se dibuja tachado al lado
  //   off,              número, para el cartel de OFERTA (0 = sin cartel)
  //   foto,             url o null
  //   nota, opiniones,  las estrellas (0 o null = no se dibujan)
  //   negocio           de quién es, para que la imagen no viaje sola
  // }
  function armar(datos) {
    var d = datos || {};
    var lienzo = document.createElement('canvas');
    lienzo.width = ANCHO;
    lienzo.height = ALTO;
    var ctx = lienzo.getContext('2d');

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, ANCHO, ALTO);

    return cargarImagen(d.foto).then(function (img) {
      // --- la foto, arriba
      if (img) {
        dibujarCubriendo(ctx, img, 0, 0, ANCHO, ALTO_FOTO);
      } else {
        ctx.fillStyle = '#E8EEF4';
        ctx.fillRect(0, 0, ANCHO, ALTO_FOTO);
        ctx.fillStyle = '#8FA3B5';
        ctx.font = '600 56px ' + FUENTE;
        ctx.textAlign = 'center';
        ctx.fillText('Sin foto', ANCHO / 2, ALTO_FOTO / 2);
        ctx.textAlign = 'left';
      }

      // --- el cartel de oferta, arriba a la izquierda
      if (Number(d.off) > 0) {
        ctx.fillStyle = '#DC2626';
        ctx.fillRect(40, 40, 230, 92);
        ctx.fillStyle = '#FFFFFF';
        ctx.font = '800 52px ' + FUENTE;
        ctx.textAlign = 'center';
        ctx.fillText(Math.round(d.off) + '% OFF', 155, 104);
        ctx.textAlign = 'left';
      }

      // --- abajo: nombre, estrellas, precio y de quién es
      var margen = 56;
      var y = ALTO_FOTO + 86;

      ctx.fillStyle = '#0F2740';
      ctx.font = '700 54px ' + FUENTE;
      partirTexto(ctx, d.nombre, ANCHO - margen * 2, 2).forEach(function (linea) {
        ctx.fillText(linea, margen, y);
        y += 62;
      });

      // Las estrellas van entre el nombre y el precio: es lo que más empuja
      // a entrar, no algo para dejar perdido en un rincón.
      if (Number(d.nota) > 0 && Number(d.opiniones) > 0) {
        ctx.font = '600 38px ' + FUENTE;
        ctx.fillStyle = '#B8860B';
        ctx.fillText('★ ' + Number(d.nota).toFixed(1).replace('.', ',') +
                     '  (' + Number(d.opiniones) + ' opiniones)', margen, y + 8);
        y += 46;
      }

      y += 26;
      ctx.fillStyle = '#2F8FE0';
      ctx.font = '800 72px ' + FUENTE;
      var texto = String(d.precio || '');
      ctx.fillText(texto, margen, y);

      // El precio de antes, tachado al lado: la oferta se entiende sola.
      if (d.precioAnterior) {
        var anchoPrecio = ctx.measureText(texto).width;
        ctx.font = '600 42px ' + FUENTE;
        ctx.fillStyle = '#8FA3B5';
        var x = margen + anchoPrecio + 24;
        ctx.fillText(d.precioAnterior, x, y);
        ctx.fillRect(x, y - 14, ctx.measureText(d.precioAnterior).width, 3);
      }

      // El pie. Sin esto la imagen viaja sola y nadie sabe a quién pedírsela.
      ctx.fillStyle = '#5A6B7B';
      ctx.font = '600 36px ' + FUENTE;
      ctx.fillText(d.negocio ? String(d.negocio).slice(0, 42) : 'Pedímelo por WhatsApp',
                   margen, ALTO - 60);

      return new Promise(function (resolve) {
        lienzo.toBlob(resolve, 'image/jpeg', 0.92);
      });
    });
  }

  function nombreDeArchivo(nombre) {
    var limpio = String(nombre || 'producto')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase()
      .slice(0, 40);
    return (limpio || 'producto') + '.jpg';
  }

  // Compartir de verdad (el menú del teléfono) cuando se puede, y si no,
  // descargar. En la computadora casi nunca se puede compartir un archivo, y
  // descargarlo es justamente lo que sirve: de ahí se sube a Instagram.
  //
  // Devuelve 'compartido' | 'descargado' | 'cancelado', para que quien
  // llame pueda decir algo distinto en cada caso.
  function compartir(datos, texto) {
    return armar(datos).then(function (blob) {
      if (!blob) throw new Error('No se pudo armar la imagen');

      var archivo = new File([blob], nombreDeArchivo(datos && datos.nombre), { type: 'image/jpeg' });

      if (navigator.canShare && navigator.canShare({ files: [archivo] })) {
        // El texto lleva el link: una imagen sola no lleva a ningún lado, y
        // el que la ve tiene que poder entrar a comprar.
        return navigator.share({ files: [archivo], text: texto || '' })
          .then(function () { return 'compartido'; })
          .catch(function () { return 'cancelado'; });
      }

      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = archivo.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      return 'descargado';
    });
  }

  global.BruwalImagen = { armar: armar, compartir: compartir };
})(window);
