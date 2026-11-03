// ממשק המשתמש הראשי.
import { Recorder, extFor } from './audio.js';
import { analyze, loadEngine } from './analyzer.js';
import { buildScore, DEFAULT_SETTINGS, keyInfo } from './score.js';
import { renderToElement } from './render.js';
import { exportPdf } from './pdf.js';
import { Editor } from './edit.js';
import * as store from './store.js';
import * as cloud from './cloud.js';
import { t, errText, noteName, keyLabel, lang, setLang, applyDom } from './i18n.js';

const $ = (id) => document.getElementById(id);
const LS_SETTINGS = 'tavim:settings';
const LS_LAST = 'tavim:last'; // גרסה ישנה ("השיר האחרון") - מועבר לספרייה

const state = {
  defaults: { ...DEFAULT_SETTINGS, ...load(LS_SETTINGS, {}), transpose: 0, tempo: 0 },
  settings: null,
  zoom: 1,
  audio: null,       // { blob, name }
  audioDirty: false, // צריך לשמור את קובץ השמע
  analysis: null,
  songId: null,
  createdAt: 0,
  title: '',
  lyrics: '',
  score: null,
  anchors: [],
  editMode: false,
  selTick: null,
};
state.settings = { ...state.defaults };

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* מקום מלא/פרטי */ }
}
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  }));

// ---------- ניווט בין מסכים ----------
const SCREENS = ['home', 'youtube', 'account', 'recording', 'preview', 'processing', 'result'];
function show(id) {
  if (id !== 'result') { try { $('resultAudio').pause(); } catch (e) { /* ignore */ } }
  if (id !== 'youtube') $('ytFrame').src = 'about:blank';
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

// ---------- טעינת מנוע הזיהוי ----------
async function prepareEngine() {
  const pill = $('serverStatus');
  pill.textContent = t('status.engine');
  pill.className = 'pill wait';
  try {
    await loadEngine();
    pill.textContent = t('status.ready');
    pill.className = 'pill ok';
  } catch (e) {
    console.error(e);
    pill.textContent = t('status.error');
    pill.className = 'pill bad';
  }
}

// ---------- שמירה אוטומטית ----------
let saveTimer = null;
function currentSong() {
  return {
    id: state.songId,
    title: state.title || t('lib.untitled'),
    analysis: state.analysis,
    settings: state.settings,
    lyrics: state.lyrics,
    createdAt: state.createdAt,
    updatedAt: Date.now(),
  };
}
function scheduleSave(delay = 800) {
  if (!state.songId || !state.analysis) return;
  clearTimeout(saveTimer);
  $('saveStatus').textContent = t('save.saving');
  saveTimer = setTimeout(saveNow, delay);
}
async function saveNow() {
  clearTimeout(saveTimer);
  if (!state.songId || !state.analysis) return;
  try {
    await store.saveSong(currentSong(), state.audioDirty && state.audio ? state.audio.blob : null);
    state.audioDirty = false;
    $('saveStatus').textContent = store.useCloud() ? t('save.cloud') : t('save.local');
  } catch (e) {
    console.error(e);
    $('saveStatus').textContent = t('save.failed');
    toast(t('save.failedMsg') + errText(e), true);
  }
}

// ---------- ספריית שירים ----------
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString(lang === 'fr' ? 'fr-FR' : 'he-IL', { day: 'numeric', month: 'numeric', year: '2-digit' }) : '');

async function refreshLibrary() {
  $('libWhere').textContent = store.useCloud() ? t('lib.cloud') : t('lib.local');
  const list = $('songList');
  list.innerHTML = '';
  let songs = [];
  try { songs = await store.listSongs(); } catch (e) { toast(t('lib.loadFail') + errText(e), true); }
  $('emptyLib').hidden = songs.length > 0;
  for (const s of songs) {
    const row = document.createElement('div');
    row.className = 'song-item';
    const open = document.createElement('button');
    open.className = 'open';
    open.type = 'button';
    open.textContent = s.title || t('lib.untitled');
    const small = document.createElement('small');
    small.textContent = fmtDate(s.updatedAt);
    open.appendChild(small);
    open.addEventListener('click', () => openSong(s.id));
    const del = document.createElement('button');
    del.className = 'del';
    del.type = 'button';
    del.title = t('lib.delete');
    del.textContent = '🗑';
    del.addEventListener('click', async () => {
      if (!confirm(t('lib.confirmDelete', { t: s.title || t('lib.untitled') }))) return;
      try { await store.deleteSong(s.id); } catch (e) { toast(errText(e), true); }
      refreshLibrary();
    });
    row.append(open, del);
    list.appendChild(row);
  }
}

async function openSong(id) {
  try {
    const song = await store.getSong(id);
    if (!song) throw new Error(t('open.notFound'));
    state.songId = song.id;
    state.createdAt = song.createdAt || Date.now();
    state.title = song.title || '';
    state.analysis = song.analysis;
    state.settings = { ...state.defaults, ...(song.settings || {}) };
    state.lyrics = song.lyrics || '';
    state.audio = song.audio ? { blob: song.audio, name: 'song' } : null;
    state.audioDirty = false;
    openResult();
    $('saveStatus').textContent = '';
  } catch (e) {
    toast(t('open.failed') + errText(e), true);
  }
}

/** העברת "השיר האחרון" מהגרסה הקודמת לספרייה (פעם אחת). */
async function migrateLegacyLast() {
  const last = load(LS_LAST, null);
  if (!last || !last.analysis) return;
  try {
    const audio = await store.local.getFile('last-audio').catch(() => null);
    await store.local.put({
      id: uuid(), title: last.title || t('lib.untitled'), analysis: last.analysis,
      settings: { ...state.defaults }, lyrics: last.lyrics || '', createdAt: last.savedAt || Date.now(),
    }, audio || null);
    localStorage.removeItem(LS_LAST);
    store.local.removeFile('last-audio').catch(() => {});
  } catch (e) { console.warn(e); }
}

// ---------- כפתורי בחירה (segmented) ----------
function syncControls() {
  document.querySelectorAll('.seg[data-setting]').forEach((seg) => {
    const key = seg.dataset.setting;
    const src = seg.closest('#home') ? state.defaults : state.settings;
    seg.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('on', String(src[key]) === b.dataset.value);
    });
  });
  $('showTab').checked = !!state.settings.showTab;
  $('tabToggle').hidden = state.settings.instrument !== 'guitar';
  const tr = state.settings.transpose || 0;
  $('trVal').textContent = tr > 0 ? `+${tr}` : String(tr);
}

document.querySelectorAll('.seg[data-setting]').forEach((seg) => {
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const key = seg.dataset.setting;
    const v = /^\d+$/.test(b.dataset.value) ? Number(b.dataset.value) : b.dataset.value;
    if (seg.closest('#home')) {
      state.defaults[key] = v;
      state.settings[key] = v;
    } else {
      state.settings[key] = v;
      if (key !== 'transpose') state.defaults[key] = v;
    }
    save(LS_SETTINGS, { ...state.defaults, transpose: 0, tempo: 0 });
    syncControls();
    if (state.analysis && !$('result').hidden) { renderScore(); scheduleSave(); }
  });
});

$('showTab').addEventListener('change', (e) => {
  state.settings.showTab = e.target.checked;
  state.defaults.showTab = e.target.checked;
  save(LS_SETTINGS, { ...state.defaults, transpose: 0, tempo: 0 });
  renderScore();
  scheduleSave();
});

// ---------- טרנספוזיציה, טמפו, מהירות ----------
function setTranspose(v) {
  state.settings.transpose = Math.max(-11, Math.min(11, v));
  syncControls();
  renderScore();
  scheduleSave();
}
$('trUp').addEventListener('click', () => setTranspose((state.settings.transpose || 0) + 1));
$('trDown').addEventListener('click', () => setTranspose((state.settings.transpose || 0) - 1));

$('tempoInput').addEventListener('change', (e) => {
  const v = Math.round(Number(e.target.value));
  state.settings.tempo = v >= 30 && v <= 260 ? v : 0;
  renderScore();
  scheduleSave();
});

function applySpeed() {
  const a = $('resultAudio');
  const r = Number($('speed').value) || 1;
  a.playbackRate = r;
  a.defaultPlaybackRate = r;
  // שמירה על גובה הצליל כשמאטים
  a.preservesPitch = true;
  a.webkitPreservesPitch = true;
  a.mozPreservesPitch = true;
}
$('speed').addEventListener('change', applySpeed);

// ---------- הקלטה ----------
let recorder = null;
let recTarget = 'main'; // 'main' | 'youtube'
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

async function startRecording(target) {
  recTarget = target;
  const ui = target === 'youtube'
    ? { time: $('ytRecTime'), level: $('ytRecLevel') }
    : { time: $('recTime'), level: $('recLevel') };
  recorder = new Recorder({
    onLevel: (p) => { ui.level.style.width = Math.min(100, p * 140) + '%'; },
    onTick: (s) => { ui.time.textContent = fmtTime(s); },
    onAutoStop: () => stopRecording(),
  });
  try {
    ui.time.textContent = '0:00';
    await recorder.start();
    if (target === 'youtube') {
      $('ytRecBox').hidden = false;
      $('btnYtRec').textContent = t('yt.stop');
    } else {
      show('recording');
    }
  } catch (e) {
    recorder = null;
    const msg = e.name === 'NotAllowedError'
      ? t('rec.noPermission')
      : (errText(e) || t('rec.cantStart'));
    toast(msg, true);
  }
}

async function stopRecording() {
  if (!recorder) return;
  const r = recorder;
  recorder = null;
  const blob = await r.stop();
  $('ytRecBox').hidden = true;
  $('btnYtRec').textContent = t('yt.record');
  if (!blob || blob.size < 1000) {
    toast(t('rec.tooShort'), true);
    show(recTarget === 'youtube' ? 'youtube' : 'home');
    return;
  }
  const stamp = new Date().toLocaleString(lang === 'fr' ? 'fr-FR' : 'he-IL', { dateStyle: 'short', timeStyle: 'short' });
  const title = recTarget === 'youtube' ? (state.ytTitle || `YouTube ${stamp}`) : t('rec.name', { d: stamp });
  setAudio(blob, `recording.${extFor(blob.type)}`, title);
}

$('btnRecord').addEventListener('click', () => startRecording('main'));
$('btnStop').addEventListener('click', stopRecording);
$('btnCancelRec').addEventListener('click', async () => {
  if (recorder) { await recorder.stop(); recorder = null; }
  show('home');
});

// ---------- YouTube ----------
function youtubeId(url) {
  const m = String(url).trim().match(/(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/|v\/))([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}
$('btnYt').addEventListener('click', () => {
  const id = youtubeId($('ytUrl').value);
  if (!id) { toast(t('yt.bad'), true); return; }
  state.ytTitle = '';
  show('youtube');
  $('ytFrame').src = `https://www.youtube-nocookie.com/embed/${id}?playsinline=1&rel=0`;
});
$('btnYtRec').addEventListener('click', () => (recorder ? stopRecording() : startRecording('youtube')));
$('btnYtBack').addEventListener('click', async () => {
  if (recorder) { await recorder.stop(); recorder = null; }
  $('ytRecBox').hidden = true;
  $('btnYtRec').textContent = t('yt.record');
  show('home');
});

// ---------- העלאת קובץ ----------
$('fileInput').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (f.size > 60 * 1024 * 1024) { toast(t('up.tooBig'), true); return; }
  const title = f.name.replace(/\.[^.]+$/, '');
  setAudio(f, f.name, title);
});

function setAudio(blob, name, title) {
  state.audio = { blob, name };
  state.title = title;
  state.lyrics = '';
  const url = URL.createObjectURL(blob);
  $('previewAudio').src = url;
  $('previewName').textContent = name;
  show('preview');
}

$('btnBackHome').addEventListener('click', () => { refreshLibrary(); show('home'); });

// ---------- עיבוד ----------
$('btnAnalyze').addEventListener('click', async () => {
  if (!state.audio) return;
  show('processing');
  const onProgress = (stage, f) => {
    $('procMsg').textContent = t('proc.' + stage) + (stage === 'notes' ? ` ${Math.round(f * 100)}%` : '');
    $('procBar').style.width = Math.round((stage === 'notes' ? 0.1 + 0.8 * f : { load: 0, decode: 0.05, harmony: 0.92, done: 1 }[stage]) * 100) + '%';
  };
  onProgress('load', 0);
  try {
    const analysis = await analyze(state.audio.blob, {
      sensitivity: Number($('sensitivity').value),
      onProgress,
    });
    if (!analysis.notes?.length && !analysis.chords?.some((c) => c.label !== 'N')) {
      throw new Error(t('proc.nothing'));
    }
    state.analysis = analysis;
    state.songId = uuid();
    state.createdAt = Date.now();
    state.settings = { ...state.defaults, transpose: 0, tempo: 0 };
    state.audioDirty = true;
    openResult();
    saveNow();
  } catch (e) {
    toast(errText(e) || t('proc.failed'), true, 8000);
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
  $('saveStatus').textContent = '';
  if (state.audio) $('resultAudio').src = URL.createObjectURL(state.audio.blob);
  applySpeed();
  editor.reset();
  setEditMode(false);
  syncControls();
  show('result');
  renderScore();
}

function renderScore() {
  if (!state.analysis) return;
  try {
    state.score = buildScore(state.analysis, state.settings, state.lyrics);
    const s = state.score;
    const tr = state.settings.transpose || 0;
    $('songInfo').textContent = t('res.info', {
      k: keyLabel(s.key),
      tr: tr ? t('res.trInfo', { v: (tr > 0 ? '+' : '') + tr }) : '',
      m: s.numMeasures,
    });
    $('tempoInput').value = s.tempo;
    const wrap = $('scoreWrap');
    const r = renderToElement($('score'), s, { width: wrap.clientWidth - 2, zoom: state.zoom });
    state.anchors = r.anchors;
    lastAnchor = null;
    updateCursor(true);
    if (state.editMode) applySelection();
  } catch (e) {
    console.error(e);
    toast(t('res.drawError') + e.message, true);
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

  const noteA = a.end ? null : a;
  if (noteA !== lastAnchor) {
    if (lastAnchor && lastAnchor.el) lastAnchor.el.classList.remove('playing');
    if (noteA && noteA.el && !noteA.rest) noteA.el.classList.add('playing');
    lastAnchor = noteA;
    if (!audio.paused) {
      const r = cur.getBoundingClientRect();
      const barH = document.querySelector('.bottom-bar').offsetHeight || 70;
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

function anchorFromClick(e) {
  if (!state.anchors.length) return null;
  const rect = $('score').getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  const row = state.anchors.filter((a) => y >= a.top && y <= a.bottom && !a.end);
  if (!row.length) return null;
  let best = row[0];
  for (const a of row) if (Math.abs(a.x - x) < Math.abs(best.x - x)) best = a;
  return best;
}

// נגיעה בתו: במצב עריכה - בחירה; אחרת - קפיצה לאותו מקום בשיר
$('score').addEventListener('click', (e) => {
  const a = anchorFromClick(e);
  if (!a) return;
  if (state.editMode) {
    state.selTick = a.tick;
    applySelection();
    return;
  }
  if (!state.audio) return;
  const audio = $('resultAudio');
  audio.currentTime = Math.max(0, state.score.tickToTime(a.tick));
  if (audio.paused) audio.play().catch(() => {});
});

// ---------- עריכה ----------
const editor = new Editor(() => { renderScore(); scheduleSave(); $('btnUndo').disabled = !editor.canUndo; });

function selectedAnchor() {
  if (state.selTick == null) return null;
  return state.anchors.find((a) => !a.end && a.tick === state.selTick)
    || state.anchors.filter((a) => !a.end && a.tick <= state.selTick).pop() || null;
}

function noteLabel(p) {
  const names = state.score.key.names;
  const n = names[((p % 12) + 12) % 12];
  return `${noteName(n)} (${n}${Math.floor(p / 12) - 1})`;
}

function applySelection() {
  document.querySelectorAll('#score .selected').forEach((el) => el.classList.remove('selected'));
  const a = selectedAnchor();
  if (!a) {
    $('selInfo').textContent = t('ed.pick');
    setToolsEnabled(null);
    return;
  }
  state.selTick = a.tick;
  if (a.el) a.el.classList.add('selected');
  const it = a.item;
  const dur = t('dur.' + it.dur);
  const chord = state.score.chords.find((c) => c.tick <= it.start && it.start < c.end);
  let txt = it.rest ? `${t('ed.rest')} · ${dur}` : `${it.pitches.slice().reverse().map(noteLabel).join(' + ')} · ${dur}`;
  if (it.tieNext || !it.first) txt += t('ed.tied');
  if (chord) txt += t('ed.chord', { c: chord.label });
  $('selInfo').textContent = txt;
  // ברירת מחדל באקורד: האקורד הנוכחי
  if (chord && chord.root != null) {
    $('chRoot').value = String(chord.root);
    $('chQual').value = chord.quality || '';
  }
  setToolsEnabled(it);
}

function setToolsEnabled(it) {
  const hasNotes = !!(it && !it.rest && it.ev && it.ev.srcs && it.ev.srcs.length);
  document.querySelectorAll('#noteTools button').forEach((b) => {
    const act = b.dataset.act;
    if (act === 'prev' || act === 'next') b.disabled = !state.anchors.length;
    else if (act === 'add') b.disabled = !it;
    else b.disabled = !hasNotes;
  });
  $('btnSetChord').disabled = !it;
  $('btnUndo').disabled = !editor.canUndo;
}

function setEditMode(on) {
  state.editMode = on;
  $('editPanel').hidden = !on;
  $('btnEdit').classList.toggle('primary', on);
  $('btnEdit').classList.toggle('secondary', !on);
  if (on) {
    $('resultAudio').pause();
    if (state.selTick == null && state.anchors.length) state.selTick = state.anchors.find((a) => !a.end && !a.rest)?.tick ?? null;
    applySelection();
  } else {
    document.querySelectorAll('#score .selected').forEach((el) => el.classList.remove('selected'));
  }
}

$('btnEdit').addEventListener('click', () => setEditMode(!state.editMode));
$('btnEditDone').addEventListener('click', () => setEditMode(false));
$('btnUndo').addEventListener('click', () => editor.undo(state.analysis));

// אקורדים לבחירה (שמות לפי הסולם המוצג)
function fillChordRoots() {
  const names = keyInfo(state.analysis?.key, state.settings.transpose || 0).names;
  const cur = $('chRoot').value;
  $('chRoot').innerHTML = `<option value="none">${t('ed.noChord')}</option>`
    + names.map((n, i) => `<option value="${i}">${n}</option>`).join('');
  $('chRoot').value = cur || '0';
}
$('btnEdit').addEventListener('click', fillChordRoots);

document.querySelectorAll('#noteTools button').forEach((b) => b.addEventListener('click', () => {
  const a = selectedAnchor();
  const act = b.dataset.act;
  const notesA = state.anchors.filter((x) => !x.end);
  if (act === 'prev' || act === 'next') {
    const i = a ? notesA.indexOf(a) : -1;
    const j = Math.max(0, Math.min(notesA.length - 1, i + (act === 'next' ? 1 : -1)));
    state.selTick = notesA[j]?.tick ?? null;
    applySelection();
    a?.el?.scrollIntoView?.({ block: 'nearest' });
    return;
  }
  if (!a) return;
  const it = a.item;
  const an = state.analysis;
  switch (act) {
    case 'up': editor.shiftPitch(an, it, 1); break;
    case 'down': editor.shiftPitch(an, it, -1); break;
    case 'octUp': editor.shiftPitch(an, it, 12); break;
    case 'octDown': editor.shiftPitch(an, it, -12); break;
    case 'shorter': editor.changeLength(an, state.score, it, -1); break;
    case 'longer': editor.changeLength(an, state.score, it, 1); break;
    case 'delete': editor.deleteNotes(an, it); break;
    case 'add': {
      // גובה: התו האחרון לפני, או מעל התו הנוכחי בטרצה
      const tr = state.settings.transpose || 0;
      let pitch;
      if (!it.rest && it.pitches.length) pitch = Math.max(...it.pitches) + 4;
      else {
        const prev = notesA.filter((x) => x.tick < it.start && !x.rest).pop();
        pitch = prev ? Math.max(...prev.item.pitches) : 67;
      }
      editor.addNote(an, state.score, it, pitch - tr);
      break;
    }
    default: break;
  }
}));

$('btnSetChord').addEventListener('click', () => {
  const a = selectedAnchor();
  if (!a) return;
  const v = $('chRoot').value;
  const tr = state.settings.transpose || 0;
  const root = v === 'none' ? null : ((Number(v) - tr) % 12 + 12) % 12;
  editor.setChord(state.analysis, state.score, a.item.start, root, $('chQual').value);
});

// ---------- מילים ----------
$('btnLyrics').addEventListener('click', () => {
  $('lyricsPanel').hidden = !$('lyricsPanel').hidden;
  if (!$('lyricsPanel').hidden) $('lyricsText').focus();
});
$('btnLyricsClose').addEventListener('click', () => { $('lyricsPanel').hidden = true; });
$('btnLyricsApply').addEventListener('click', () => {
  state.lyrics = $('lyricsText').value;
  $('lyricsPanel').hidden = true;
  renderScore();
  scheduleSave(0);
});

$('songTitle').addEventListener('input', (e) => {
  state.title = e.target.value;
  scheduleSave(1200);
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
    const inst = t(s.instrument === 'guitar' ? 'inst.guitar.plain' : 'inst.piano.plain');
    const info = t('pdf.info', { i: inst, k: keyLabel(s.key), t: s.tempo });
    const { blob, name } = await exportPdf(s, { title: state.title || t('pdf.untitled'), info, rtl: lang === 'he' });
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
    toast(t('pdf.failed') + e.message, true);
  } finally {
    btn.disabled = false;
  }
});

$('btnNew').addEventListener('click', async () => {
  if (saveTimer) await saveNow();
  setEditMode(false);
  refreshLibrary();
  show('home');
});

// ---------- חשבון ----------
function syncAccountUI() {
  const configured = cloud.isConfigured();
  $('accNotConfigured').hidden = configured;
  $('accLoggedOut').hidden = !configured || !!cloud.user;
  $('accLoggedIn').hidden = !configured || !cloud.user;
  $('btnAccount').classList.toggle('in', !!cloud.user);
  if (cloud.user) $('accUser').textContent = cloud.user.email || '';
}

async function checkMigration() {
  if (!cloud.user) { $('migrateBox').hidden = true; return; }
  const localSongs = await store.local.list().catch(() => []);
  $('migrateBox').hidden = !localSongs.length;
  $('migrateText').textContent = t('acc.localCount', { n: localSongs.length });
}

$('btnAccount').addEventListener('click', () => { syncAccountUI(); checkMigration(); show('account'); });
$('btnAccBack').addEventListener('click', () => { refreshLibrary(); show('home'); });

async function doAuth(kind) {
  const email = $('accEmail').value.trim();
  const pass = $('accPass').value;
  if (!email || pass.length < 6) { toast(t('acc.needFields'), true); return; }
  try {
    if (kind === 'in') {
      await cloud.signIn(email, pass);
      toast(t('acc.signedIn'));
    } else {
      const r = await cloud.signUp(email, pass);
      toast(r.needsConfirm ? t('acc.confirm') : t('acc.signedUp'), false, 8000);
    }
    $('accPass').value = '';
  } catch (e) {
    toast(errText(e), true);
  }
  syncAccountUI();
  checkMigration();
}
$('btnSignIn').addEventListener('click', () => doAuth('in'));
$('btnSignUp').addEventListener('click', () => doAuth('up'));
$('btnSignOut').addEventListener('click', async () => {
  await cloud.signOut();
  syncAccountUI();
  toast(t('acc.signedOut'));
});
$('btnMigrate').addEventListener('click', async () => {
  const btn = $('btnMigrate');
  btn.disabled = true;
  try {
    const n = await store.migrateLocalToCloud((d, total) => { $('migrateText').textContent = t('acc.migrating', { d, t: total }); });
    toast(t('acc.migrated', { n }));
  } catch (e) {
    toast(t('acc.migrateFail') + errText(e), true);
  } finally {
    btn.disabled = false;
    checkMigration();
  }
});

// ---------- שפה ----------
function refreshTexts() {
  applyDom();
  if (!$('result').hidden && state.analysis) { renderScore(); if (state.editMode) { fillChordRoots(); applySelection(); } }
  if (!$('home').hidden) refreshLibrary();
  if (!$('account').hidden) checkMigration();
  const pill = $('serverStatus');
  if (pill.classList.contains('ok')) pill.textContent = t('status.ready');
  $('btnYtRec').textContent = recorder && recTarget === 'youtube' ? t('yt.stop') : t('yt.record');
  $('saveStatus').textContent = '';
}
$('btnLang').addEventListener('click', () => {
  setLang(lang === 'he' ? 'fr' : 'he');
  refreshTexts();
});

// ---------- התחלה ----------
applyDom();
syncControls();
prepareEngine();
(async () => {
  await migrateLegacyLast();
  try {
    await cloud.init(() => { syncAccountUI(); if (!$('home').hidden) refreshLibrary(); });
  } catch (e) { console.warn(e); }
  syncAccountUI();
  refreshLibrary();
})();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// לבדיקות
window.__tavim = { state, renderScore, openResult };
