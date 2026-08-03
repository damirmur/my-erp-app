/// <reference types="@sveltejs/kit" />
import { build, files, prerendered, version } from '$service-worker';

const CACHE = `erp-cache-${version}`;
const ASSETS = [...build, ...files, ...prerendered];

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(ASSETS))
			.then(() => self.skipWaiting())
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches.keys().then(async (keys) => {
			for (const key of keys) {
				if (key !== CACHE) await caches.delete(key);
			}
			self.clients.claim();
		})
	);
});

self.addEventListener('fetch', (event) => {
	if (event.request.method !== 'GET') return;
	// Network-first: сначала берём свежий ответ с сервера (важно в dev, где URL модулей
	// не хешируются), кэшируем успешные ответы и отдаём кэш только при офлайне.
	event.respondWith(
		fetch(event.request)
			.then((response) => {
				if (response.ok && event.request.url.startsWith(self.location.origin)) {
					const copy = response.clone();
					caches.open(CACHE).then((cache) => cache.put(event.request, copy));
				}
				return response;
			})
			.catch(() => caches.match(event.request))
	);
});
