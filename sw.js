// v2.1: o app do restaurante mudou para a pasta própria (gestao-…). Este arquivo só limpa o service worker
// antigo (v2.0) que ficou instalado nos aparelhos que abriam o app na raiz do site, e se desliga.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const ks = await caches.keys();
    await Promise.all(ks.filter((k) => k === 'oliveiras-delivery-v1').map((k) => caches.delete(k)));
    await self.registration.unregister();
    const cs = await self.clients.matchAll({ type: 'window' });
    cs.forEach((c) => { try { c.navigate(c.url); } catch { /* ignora */ } });
  })());
});
