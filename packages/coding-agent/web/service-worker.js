const CACHE_NAME = "pi-web-v2";
const APP_SHELL = [
	"/",
	"/favicon.svg",
	"/manifest.webmanifest",
	"/web/app.tsx",
	"/web/components.tsx",
	"/web/shared.ts"
];

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(CACHE_NAME)
			.then((cache) => cache.addAll(APP_SHELL))
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (event) => {
	const request = event.request;
	const url = new URL(request.url);
	if (request.method !== "GET" || url.pathname.startsWith("/api/") || url.pathname === "/events") return;

	if (request.mode === "navigate") {
		event.respondWith(fetch(request).catch(() => caches.match("/") ?? Response.error()));
		return;
	}

	if (url.pathname.startsWith("/web/") || url.pathname === "/service-worker.js") {
		event.respondWith(
			fetch(request)
				.then((response) => {
					if (response && response.status === 200) {
						const copy = response.clone();
						caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
					}
					return response;
				})
				.catch(() => caches.match(request) ?? Response.error()),
		);
		return;
	}

	event.respondWith(
		caches.match(request).then(
			(cached) =>
				cached ??
				fetch(request).then((response) => {
					if (!response || (response.status !== 200 && response.type !== "opaque")) return response;
					const copy = response.clone();
					caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
					return response;
				}),
		),
	);
});
