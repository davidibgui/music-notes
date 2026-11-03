// Service worker: שמירת קבצי האפליקציה כדי שתיפתח מהר (גם בלי רשת).
// בכל שינוי בקבצים - להעלות את מספר הגרסה.
const CACHE = 'music-notes-v6';
const ASSETS = [
  './', 'index.html', 'css/style.css', 'manifest.webmanifest',
  'js/app.js', 'js/i18n.js', 'js/audio.js', 'js/analyzer.js', 'js/edit.js', 'js/store.js', 'js/cloud.js', 'js/cloud-config.js', 'js/score.js', 'js/render.js', 'js/chords.js', 'js/pdf.js',
  'lib/vexflow.js', 'lib/jspdf.umd.min.js', 'lib/basic-pitch.bundle.js', 'lib/supabase.js',
  'model/model.json', 'model/group1-shard1of1.bin',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// רשת קודם (כדי לקבל עדכונים), ואם אין רשת - מהמטמון
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('index.html'))),
  );
});
