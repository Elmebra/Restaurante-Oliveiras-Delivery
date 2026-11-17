// Service worker da página do cliente: abre rápido e mantém o visual; o cardápio e os preços SEMPRE vêm da internet.
const VERSION = 'oliveiras-cliente-v1';
const SHELL = [
  './', './index.html', './pedido.js', './pedido.css', './config.js', './manifest.webmanifest',
  '../js/util.js', '../js/pricing.js', '../js/pix.js',
  '../icons/icon-192.png', '../icons/icon-512.png', '../icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k.startsWith('oliveiras-cliente')).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (url.origin !== location.origin && !isFont) return; // Apps Script (cardápio/pedido) nunca passa pelo cache
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      });
      if (hit) { net.catch(() => {}); return hit; }
      return net.catch(() => (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()));
    }),
  );
});
