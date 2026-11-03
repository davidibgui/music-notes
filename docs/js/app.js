// ממשק המשתמש הראשי.
import { Recorder, analyzeAudio, pingServer, extFor } from './audio.js';
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
  score: null,
};
state.settings.transpose = 0;

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* מקום מלא/פרטי */ }
}

// ---------- ניווט בין מסכים ----------
const SCREENS = ['home', 'recording', 'preview', 'processing', 'result'];
function show(id) {
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

// ---------- מצב השרת ----------
async function checkServer() {
  const pill = $('serverStatus');
  pill.textContent = 'השרת מתעורר…';
  pill.className = 'pill wait';
  const ok = await pingServer();
  pill.textContent = ok ? 'השרת מוכן' : 'השרת לא זמין';
  pill.className = 'pill ' + (ok ? 'ok' : 'bad');
  return ok;
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
    checkServer(); // מעירים את השרת כבר עכשיו
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
  checkServer();
});

function setAudio(blob, name, title) {
  state.audio = { blob, name };
  state.title = title;
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
  const msgs = ['מעלה את הקובץ…', 'מזהה תווים…', 'מזהה אקורדים וקצב…', 'עוד רגע…'];
  let i = 0;
  $('procMsg').textContent = msgs[0];
  const timer = setInterval(() => { i = Math.min(i + 1, msgs.length - 1); $('procMsg').textContent = msgs[i]; }, 8000);
  try {
    const analysis = await analyzeAudio(state.audio.blob, state.audio.name, {
      sensitivity: Number($('sensitivity').value),
    });
    if (!analysis.notes?.length && !analysis.chords?.some((c) => c.label !== 'N')) {
      throw new Error('לא זוהו צלילים בהקלטה. נסו להקליט קרוב יותר לכלי.');
    }
    state.analysis = analysis;
    save(LS_LAST, { analysis, title: state.title, savedAt: Date.now() });
    openResult();
  } catch (e) {
    toast(e.message || 'משהו השתבש', true, 8000);
    show('preview');
  } finally {
    clearInterval(timer);
  }
});

// ---------- תוצאה ----------
function openResult() {
  $('songTitle').value = state.title || '';
  $('resultAudio').hidden = !state.audio;
  syncSegs();
  show('result');
  renderScore();
}

function renderScore() {
  if (!state.analysis) return;
  try {
    state.score = buildScore(state.analysis, state.settings);
    const s = state.score;
    $('songInfo').textContent = `סולם: ${s.key.hebrew} · טמפו: ${s.tempo} · ${s.numMeasures} תיבות`;
    const wrap = $('scoreWrap');
    renderToElement($('score'), s, { width: wrap.clientWidth - 2, zoom: state.zoom });
  } catch (e) {
    console.error(e);
    toast('שגיאה בציור התווים: ' + e.message, true);
  }
}

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
$('btnOpenLast').addEventListener('click', () => {
  const last = load(LS_LAST, null);
  if (!last) return;
  state.analysis = last.analysis;
  state.title = last.title;
  state.audio = null;
  openResult();
});

// ---------- התחלה ----------
syncSegs();
refreshLast();
checkServer();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// לבדיקות
window.__tavim = { state, renderScore, openResult };
