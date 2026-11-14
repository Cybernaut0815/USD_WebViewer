// Cross-origin isolation for hosts that cannot send headers (GitHub Pages). The core needs it for its threads, and
// only two kinds of response carry it: the page and worker scripts. This worker adds COOP/COEP to those and leaves
// every other request alone, so scripts and the wasm keep the HTTP cache and the browser's code cache.
// Register it from the page (scope: the page's folder, with core/ inside) and reload once; see docs/embedding.md.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(Promise.all([self.clients.claim(), self.registration.navigationPreload?.enable()])));
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.mode !== 'navigate' && request.destination !== 'worker') return;
  event.respondWith(
    (async () => {
      const response = (await event.preloadResponse) ?? (await fetch(request));
      if (response.status === 0 || response.headers.has('Cross-Origin-Embedder-Policy')) return response; // opaque, or headers sent
      const headers = new Headers(response.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    })(),
  );
});
