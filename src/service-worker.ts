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
	const url = new URL(event.request.url);
	// Кросс-доменные запросы (API-режим: wttr.in, Nominatim и т.п.) не перехватываем:
	// браузер выполнит их напрямую с обычным CORS, а кэшировать их всё равно нельзя.
	if (url.origin !== self.location.origin) return;

	// Сборка: имена файлов содержат hash и неизменяемы — отдаём из кэша (cache-first),
	// чтобы при каждой загрузке страницы не ходить в сеть за уже скачанными модулями.
	if (url.pathname.startsWith('/build/')) {
		event.respondWith(
			caches.match(event.request).then((cached) => {
				if (cached) return cached;
				return fetch(event.request).then((response) => {
					if (response.ok) {
						const copy = response.clone();
						caches.open(CACHE).then((cache) => cache.put(event.request, copy));
					}
					return response;
				});
			})
		);
		return;
	}

	// Документ и остальные ресурсы: Network-first (важно в dev, где URL модулей
	// не хешируются), кэшируем успешные ответы и отдаём кэш только при офлайне.
	event.respondWith(
		fetch(event.request)
			.then((response) => {
				if (response.ok) {
					const copy = response.clone();
					caches.open(CACHE).then((cache) => cache.put(event.request, copy));
				}
				return response;
			})
			.catch(() => caches.match(event.request))
	);
});
