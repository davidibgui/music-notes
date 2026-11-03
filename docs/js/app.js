// ממשק המשתמש הראשי.
import { Recorder, extFor } from './audio.js';
import { analyze, loadEngine } from './analyzer.js';
import { buildScore, DEFAULT_SETTINGS } from './score.js';
import { renderToElement } from './render.js';
import { exportPdf } from './pdf.js';

const $ = (id) => document.getElementById(id);
const LS_SETTINGS = 'tavim:settings';
const LS_LAST = 'tavim:last';

const state = {
  settings: { ...DEFAULT_SETTINGS, ...load(LS_SETTINGS, {}) },
  zoom: 1,
  audio: null,      // { blob, name }
  analysis: null,
  title: '',
  lyrics: '',
  score: null,
  anchors: [],
};
state.settings.transpose = 0;

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* מקום מלא/פרטי */ }
}

// ---------- שמירת קובץ השמע של השיר האחרון (IndexedDB) ----------
function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('music-notes', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbPut(key, value) {
  try {
    const db = await idb();
    await new Promise((res, rej) => {
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put(value, key);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch (e) { /* פרטי/מלא - לא קריטי */ }
}
async function idbGet(key) {
  try {
    const db = await idb();
    return await new Promise((res, rej) => {
      const r = db.transaction('files').objectStore('files').get(key);
      r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error);
    });
  } catch (e) { return null; }
}

// ---------- ניווט בין מסכים ----------
const SCREENS = ['home', 'recording', 'preview', 'processing', 'result'];
function show(id) {
  if (id !== 'result') { try { $('resultAudio').pause(); } catch (e) { /* ignore */ } }
  SCREENS.forEach((s) => { $(s).hidden = s !== id; });
  window.scrollTo(0, 0);
}

let toastTimer;
function toast(msg, isError = false, ms = 5000) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------- טעינת מנוע הזיהוי (פעם אחת, אחר כך נשמר במטמון) ----------
async function prepareEngine() {
  const pill = $('serverStatus');
  pill.textContent = 'טוען מנוע…';
  pill.className = 'pill wait';
  try {
    await loadEngine();
    pill.textContent = 'מוכן';
    pill.className = 'pill ok';
  } catch (e) {
    console.error(e);
    pill.textContent = 'שגיאה בטעינה';
    pill.className = 'pill bad';
  }
}

// ---------- כפתורי בחירה (segmented) ----------
function syncSegs() {
  document.querySelectorAll('.seg[data-setting]').forEach((seg) => {
    const key = seg.dataset.setting;
    seg.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('on', String(state.settings[key]) === b.dataset.value);
    });
  });
  $('showTab').checked = !!state.settings.showTab;
  $('tabToggle').hidden = state.settings.instrument !== 'guitar';
}

document.querySelectorAll('.seg[data-setting]').forEach((seg) => {
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const key = seg.dataset.setting;
    const v = b.dataset.value;
    state.settings[key] = /^\d+$/.test(v) ? Number(v) : v;
    save(LS_SETTINGS, { ...state.settings, transpose: 0 });
    syncSegs();
    if (state.analysis && !$('result').hidden) renderScore();
  });
});

$('showTab').addEventListener('change', (e) => {
  state.settings.showTab = e.target.checked;
  save(LS_SETTINGS, { ...state.settings, transpose: 0 });
  renderScore();
});

// ---------- הקלטה ----------
let recorder = null;
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

$('btnRecord').addEventListener('click', async () => {
  recorder = new Recorder({
    onLevel: (p) => { $('recLevel').style.width = Math.min(100, p * 140) + '%'; },
    onTick: (s) => { $('recTime').textContent = fmtTime(s); },
    onAutoStop: () => stopRecording(),
  });
  try {
    $('recTime').textContent = '0:00';
    await recorder.start();
    show('recording');
  } catch (e) {
    recorder = null;
    const msg = e.name === 'NotAllowedError'
      ? 'אין הרשאה למיקרופון. אפשרו גישה בהגדרות הדפדפן ונסו שוב.'
      : (e.message || 'לא ניתן להתחיל הקלטה');
    toast(msg, true);
  }
});

async function stopRecording() {
  if (!recorder) return;
  const r = recorder;
  recorder = null;
  const blob = await r.stop();
  if (!blob || blob.size < 1000) {
    toast('ההקלטה קצרה מדי', true);
    show('home');
    return;
  }
  const stamp = new Date().toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
  setAudio(blob, `הקלטה.${extFor(blob.type)}`, `הקלטה ${stamp}`);
}

$('btnStop').addEventListener('click', stopRecording);
$('btnCancelRec').addEventListener('click', async () => {
  if (recorder) { await recorder.stop(); recorder = null; }
  show('home');
});

// ---------- העלאת קובץ ----------
$('fileInput').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (f.size > 25 * 1024 * 1024) { toast('הקובץ גדול מדי (מקסימום 25MB)', true); return; }
  const title = f.name.replace(/\.[^.]+$/, '');
  setAudio(f, f.name, title);
});

function setAudio(blob, name, title) {
  state.audio = { blob, name };
  state.title = title;
  state.lyrics = '';
  const url = URL.createObjectURL(blob);
  $('previewAudio').src = url;
  $('resultAudio').src = url;
  $('previewName').textContent = name;
  show('preview');
}

$('btnBackHome').addEventListener('click', () => show('home'));

// ---------- עיבוד ----------
$('btnAnalyze').addEventListener('click', async () => {
  if (!state.audio) return;
  show('processing');
  const labels = { load: 'טוען מנוע זיהוי…', decode: 'קורא את ההקלטה…', notes: 'מזהה תווים', harmony: 'מזהה אקורדים וקצב…', done: 'מסיים…' };
  const onProgress = (stage, f) => {
    $('procMsg').textContent = labels[stage] + (stage === 'notes' ? ` ${Math.round(f * 100)}%` : '');
    $('procBar').style.width = Math.round((stage === 'notes' ? 0.1 + 0.8 * f : { load: 0, decode: 0.05, harmony: 0.92, done: 1 }[stage]) * 100) + '%';
  };
  onProgress('load', 0);
  try {
    const analysis = await analyze(state.audio.blob, {
      sensitivity: Number($('sensitivity').value),
      onProgress,
    });
    if (!analysis.notes?.length && !analysis.chords?.some((c) => c.label !== 'N')) {
      throw new Error('לא זוהו צלילים בהקלטה. נסו להקליט קרוב יותר לכלי.');
    }
    state.analysis = analysis;
    save(LS_LAST, { analysis, title: state.title, lyrics: '', savedAt: Date.now() });
    idbPut('last-audio', state.audio.blob);
    openResult();
  } catch (e) {
    toast(e.message || 'משהו השתבש', true, 8000);
    show('preview');
  }
});

// ---------- תוצאה ----------
function openResult() {
  $('songTitle').value = state.title || '';
  $('lyricsText').value = state.lyrics || '';
  $('lyricsPanel').hidden = true;
  $('playerBar').hidden = !state.audio;
  $('playHint').hidden = !state.audio;
  if (state.audio) $('resultAudio').src = URL.createObjectURL(state.audio.blob);
  syncSegs();
  show('result');
  renderScore();
}

function renderScore() {
  if (!state.analysis) return;
  try {
    state.score = buildScore(state.analysis, state.settings, state.lyrics);
    const s = state.score;
    $('songInfo').textContent = `סולם: ${s.key.hebrew} · טמפו: ${s.tempo} · ${s.numMeasures} תיבות`;
    const wrap = $('scoreWrap');
    const r = renderToElement($('score'), s, { width: wrap.clientWidth - 2, zoom: state.zoom });
    state.anchors = r.anchors;
    lastAnchor = null;
    updateCursor(true);
  } catch (e) {
    console.error(e);
    toast('שגיאה בציור התווים: ' + e.message, true);
  }
}

// ---------- ניגון: סמן שרץ על התווים ----------
let lastAnchor = null;
let rafId = 0;

function anchorAt(tick) {
  // העוגן האחרון שהתחיל עד הרגע הזה (בסדר הציור: סוף תיבה ואז התו הראשון של הבאה)
  const A = state.anchors;
  if (!A.length) return null;
  let i = 0;
  for (let k = 0; k < A.length; k++) if (A[k].tick <= tick + 1e-6) i = k;
  return i;
}

function updateCursor(force = false) {
  const audio = $('resultAudio');
  const cur = $('cursor');
  if (!state.score || !state.audio || !state.anchors.length || (audio.paused && audio.currentTime === 0 && !force)) {
    cur.hidden = true;
    return;
  }
  const tick = state.score.timeToTick(audio.currentTime);
  const A = state.anchors;
  const i = anchorAt(tick);
  if (i == null) return;
  const a = A[i];
  let x = a.x;
  const b = A[i + 1];
  if (b && b.top === a.top && b.tick > a.tick) {
    x = a.x + (b.x - a.x) * Math.min(1, Math.max(0, (tick - a.tick) / (b.tick - a.tick)));
  }
  const off = $('score').offsetTop;
  cur.hidden = false;
  cur.style.left = x + 'px';
  cur.style.top = (off + a.top) + 'px';
  cur.style.height = (a.bottom - a.top) + 'px';

  // הדגשת התו שמתנגן
  const noteA = a.end ? null : a;
  if (noteA !== lastAnchor) {
    if (lastAnchor && lastAnchor.el) lastAnchor.el.classList.remove('playing');
    if (noteA && noteA.el && !noteA.rest) noteA.el.classList.add('playing');
    lastAnchor = noteA;
    // גלילה אוטומטית כשהשורה יוצאת מהמסך
    if (!audio.paused) {
      const r = cur.getBoundingClientRect();
      const barH = $('playerBar').offsetHeight || 70;
      if (r.top < 70 || r.bottom > window.innerHeight - barH - 10) {
        window.scrollBy({ top: r.top - window.innerHeight * 0.25, behavior: 'smooth' });
      }
    }
  }
}

function loop() {
  updateCursor();
  if (!$('resultAudio').paused) rafId = requestAnimationFrame(loop);
}
$('resultAudio').addEventListener('play', () => { cancelAnimationFrame(rafId); loop(); });
$('resultAudio').addEventListener('pause', () => { cancelAnimationFrame(rafId); updateCursor(true); });
$('resultAudio').addEventListener('seeked', () => updateCursor(true));

// נגיעה בתו => קפיצה לאותו מקום בשיר
$('score').addEventListener('click', (e) => {
  if (!state.audio || !state.anchors.length) return;
  const rect = $('score').getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  const row = state.anchors.filter((a) => y >= a.top && y <= a.bottom && !a.end);
  if (!row.length) return;
  let best = row[0];
  for (const a of row) if (Math.abs(a.x - x) < Math.abs(best.x - x)) best = a;
  const audio = $('resultAudio');
  audio.currentTime = Math.max(0, state.score.tickToTime(best.tick));
  if (audio.paused) audio.play().catch(() => {});
});

// ---------- מילים ----------
$('btnLyrics').addEventListener('click', () => {
  $('lyricsPanel').hidden = !$('lyricsPanel').hidden;
  if (!$('lyricsPanel').hidden) $('lyricsText').focus();
});
$('btnLyricsClose').addEventListener('click', () => { $('lyricsPanel').hidden = true; });
$('btnLyricsApply').addEventListener('click', () => {
  state.lyrics = $('lyricsText').value;
  const last = load(LS_LAST, null);
  if (last) save(LS_LAST, { ...last, lyrics: state.lyrics });
  $('lyricsPanel').hidden = true;
  renderScore();
});

$('songTitle').addEventListener('input', (e) => {
  state.title = e.target.value;
  const last = load(LS_LAST, null);
  if (last) save(LS_LAST, { ...last, title: state.title });
});

$('zoomIn').addEventListener('click', () => { state.zoom = Math.min(2, state.zoom + 0.15); renderScore(); });
$('zoomOut').addEventListener('click', () => { state.zoom = Math.max(0.5, state.zoom - 0.15); renderScore(); });

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (!$('result').hidden) renderScore(); }, 250);
});

$('btnPdf').addEventListener('click', async () => {
  if (!state.score) return;
  const btn = $('btnPdf');
  btn.disabled = true;
  try {
    const s = state.score;
    const inst = s.instrument === 'guitar' ? 'גיטרה' : 'פסנתר';
    const info = `${inst} · סולם ${s.key.hebrew} · טמפו ${s.tempo}`;
    const { blob, name } = await exportPdf(s, { title: state.title, info });
    const file = new File([blob], name, { type: 'application/pdf' });
    // באייפון: חלונית שיתוף (שמירה לקבצים / וואטסאפ / הדפסה). אחרת - הורדה רגילה
    if (navigator.canShare && navigator.canShare({ files: [file] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
      try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (e) {
    console.error(e);
    toast('יצירת ה-PDF נכשלה: ' + e.message, true);
  } finally {
    btn.disabled = false;
  }
});

$('btnNew').addEventListener('click', () => { refreshLast(); show('home'); });

// ---------- שיר אחרון ----------
function refreshLast() {
  const last = load(LS_LAST, null);
  $('lastSong').hidden = !last;
  if (last) $('lastTitle').textContent = last.title || 'ללא שם';
}
$('btnOpenLast').addEventListener('click', async () => {
  const last = load(LS_LAST, null);
  if (!last) return;
  state.analysis = last.analysis;
  state.title = last.title;
  state.lyrics = last.lyrics || '';
  const blob = await idbGet('last-audio');
  state.audio = blob ? { blob, name: 'last' } : null;
  openResult();
});

// ---------- התחלה ----------
syncSegs();
refreshLast();
prepareEngine();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// לבדיקות
window.__tavim = { state, renderScore, openResult };
