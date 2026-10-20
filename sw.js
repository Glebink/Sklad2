// Общий service worker сервиса «Склад» (Учёт потребления + Заявки на закупку).
// Версия держится одинаковой с APP_VERSION в uchet/app.js и zayavki/app.js.
const CACHE_NAME = "sklad2-cache-v2.0";
const SHELL = [
  "./", "index.html", "manifest.json", "auth.js", "auth.css", "icon-192.png", "icon-512.png",
  "uchet/", "uchet/index.html", "uchet/style.css", "uchet/app.js", "uchet/qrcode.js",
  "zayavki/", "zayavki/index.html", "zayavki/style.css", "zayavki/app.js"
];
const LIB = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all([
        // cache: "reload" — мимо HTTP-кэша браузера (GitHub Pages отдаёт файлы с max-age=600)
        ...SHELL.map((u) => cache.add(new Request(u, { cache: "reload" })).catch(() => {})),
        cache.add(LIB).catch(() => {})
      ])
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Supabase (данные, фото, вход) не кэшируем
  if (url.hostname.endsWith("supabase.co")) return;
  // Библиотека с CDN и шрифты: из кэша, если есть
  if (url.origin !== self.location.origin) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok && url.hostname === "cdn.jsdelivr.net") {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        }
        return res;
      }))
    );
    return;
  }
  // Файлы приложения: сначала сеть (чтобы обновления доходили), без сети — из кэша
  event.respondWith(
    // cache: "no-cache" — всегда сверяться с сервером (ETag), а не брать файл из HTTP-кэша браузера:
    // GitHub Pages разрешает кэш на 10 минут, и исправления иначе доезжали бы с задержкой
    fetch(req, { cache: "no-cache" }).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE_NAME).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match(url.pathname.includes("/zayavki/") ? "zayavki/index.html" : "uchet/index.html")))
  );
});
