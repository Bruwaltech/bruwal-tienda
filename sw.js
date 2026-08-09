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
