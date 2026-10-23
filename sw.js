// Service worker de BRUWAL.
//
// Deliberadamente minimo y SIEMPRE red primero. En este proyecto ya perdimos
// horas persiguiendo un problema que parecia de cache y no lo era, asi que
// este archivo nunca sirve una version vieja mientras haya internet.
// El cache existe solo para que la app abra si el local se queda sin señal:
// la caja tiene que poder seguir vendiendo (ver "SIN INTERNET" en el panel).

const CACHE = 'bruwal-v1';

const LIBRERIAS = [
  'https://cdn.jsdelivr.net/',
  'https://cdnjs.cloudflare.com/',
  'https://unpkg.com/',
  'https://fonts.googleapis.com/',
  'https://fonts.gstatic.com/'
];

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(claves => Promise.all(claves.filter(c => c !== CACHE).map(c => caches.delete(c))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;

  // Solo lecturas, y solo lo nuestro o las librerias que el panel baja de
  // afuera (Supabase, graficos, iconos, fuentes). Sin esas librerias en el
  // aparato, el panel no abre sin internet aunque el HTML este guardado.
  // Las llamadas a Supabase (los datos) no se tocan nunca, para no romper
  // la sesion ni servir datos viejos.
  if (req.method !== 'GET') return;
  const propio = req.url.startsWith(self.location.origin);
  if (!propio && !LIBRERIAS.some(h => req.url.startsWith(h))) return;

  e.respondWith(
    fetch(req)
      .then(res => {
        // Un <script> de otro dominio vuelve "opaco" (status 0): no se puede
        // leer, pero si guardar y servir igual.
        if (res && (res.ok || (!propio && res.type === 'opaque'))) {
          const copia = res.clone();
          caches.open(CACHE).then(c => c.put(req, copia)).catch(() => {});
        }
        return res;
      })
      // Sin internet: lo ultimo que vimos. El panel se abre como
      // /dashboard?app=1 desde el icono y como /dashboard desde el link: si
      // la direccion exacta no esta guardada, sirve la otra.
      .catch(() => caches.match(req).then(r => r ||
        (req.mode === 'navigate' ? caches.match(req, { ignoreSearch: true }) : undefined)))
  );
});

// Avisos de Bruwal Chat (panel del bot de Walter): llegan aunque el panel esté
// cerrado. Los manda walter-bot cuando escribe un cliente. Siempre se muestra
// el aviso: Safari en el iPhone da de baja a quien recibe sin mostrar.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Bruwal Chat', {
    body: d.body || 'Te escribieron',
    tag: d.tag,
    renotify: !!d.tag,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: d.url || '/chat' }
  }).then(numeroEnIcono));
});

// El número sobre el ícono de la app instalada: una por charla con avisos sin abrir.
// Con el panel abierto lo pone el panel (charlas que esperan respuesta).
function numeroEnIcono() {
  if (!self.navigator.setAppBadge) return;
  return self.registration.getNotifications().then((ns) =>
    ns.length ? self.navigator.setAppBadge(ns.length) : self.navigator.clearAppBadge()
  ).catch(() => {});
}

// Tocar el aviso abre la charla: en el panel si ya estaba abierto, si no en una ventana nueva
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  numeroEnIcono();
  const url = new URL((e.notification.data && e.notification.data.url) || '/chat', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ventanas) => {
    const panel = ventanas.find((v) => new URL(v.url).pathname === '/chat');
    if (panel) {
      panel.postMessage({ abrir: url });
      return panel.focus();
    }
    return self.clients.openWindow(url);
  }));
});
