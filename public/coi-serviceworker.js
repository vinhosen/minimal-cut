/*! coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, licensed under MIT */
/* Enables Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy (credentialless) on static hosts like GitHub Pages. */
if (typeof window === 'undefined') {
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

  self.addEventListener('fetch', (event) => {
    const r = event.request;
    if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') {
      return;
    }

    event.respondWith(
      fetch(r)
        .then((response) => {
          if (response.status === 0) {
            return response;
          }
          const newHeaders = new Headers(response.headers);
          newHeaders.set('Cross-Origin-Embedder-Policy', 'credentialless');
          newHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');

          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          });
        })
        .catch((e) => console.error(e))
    );
  });
} else {
  (() => {
    if (window.crossOriginIsolated !== false) return;
    if (!window.isSecureContext || !('serviceWorker' in navigator)) return;

    navigator.serviceWorker
      .register(new URL('./coi-serviceworker.js', window.document.baseURI).href)
      .then((registration) => {
        registration.addEventListener('updatefound', () => {
          const worker = registration.installing;
          if (!worker) return;
          worker.addEventListener('statechange', () => {
            if (worker.state === 'activated' && !sessionStorage.getItem('coiReloaded')) {
              sessionStorage.setItem('coiReloaded', '1');
              window.location.reload();
            }
          });
        });
        if (registration.active && !navigator.serviceWorker.controller && !sessionStorage.getItem('coiReloaded')) {
          sessionStorage.setItem('coiReloaded', '1');
          window.location.reload();
        }
      })
      .catch(() => {
        // Service worker registration failed (e.g. private mode); app still runs in non-isolated fallback mode.
      });
  })();
}
