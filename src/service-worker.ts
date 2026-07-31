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
	event.respondWith(
		caches.match(event.request).then((cached) => {
			return (
				cached ||
				fetch(event.request).then((response) => {
					return caches.open(CACHE).then((cache) => {
						if (response.ok && event.request.url.startsWith(self.location.origin)) {
							cache.put(event.request, response.clone());
						}
						return response;
					});
				})
			);
		})
	);
});
