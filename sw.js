// Service worker de BRUWAL.
//
// Deliberadamente minimo y SIEMPRE red primero. En este proyecto ya perdimos
// horas persiguiendo un problema que parecia de cache y no lo era, asi que
// este archivo nunca sirve una version vieja mientras haya internet.
// El cache existe solo para que la app abra algo si el local se queda sin señal.

const CACHE = 'bruwal-v1';

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

  // Solo lecturas y solo lo nuestro. Las llamadas a Supabase son de otro
  // origen: no las tocamos nunca, para no romper la sesion ni los datos.
  if (req.method !== 'GET') return;
  if (!req.url.startsWith(self.location.origin)) return;

  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const copia = res.clone();
          caches.open(CACHE).then(c => c.put(req, copia)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req))   // sin internet: lo ultimo que vimos
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
  }));
});

// Tocar el aviso abre la charla: en el panel si ya estaba abierto, si no en una ventana nueva
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
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
