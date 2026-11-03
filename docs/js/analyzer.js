// ניתוח אודיו בתוך הדפדפן - בלי שרת.
// Basic Pitch (Spotify, TF.js) מזהה תווים, ומאותו פלט מחושבים גם פעמות/טמפו, אקורדים וסולם.
// מחזיר את אותו מבנה נתונים שהשרת היה מחזיר: {duration, tempo, beats, key, chords, notes}
import { tf, BasicPitch, outputToNotesPoly, noteFramesToTime } from '../lib/basic-pitch.bundle.js';

const SR = 22050;
const HOP = 256;
const FPS = SR / HOP; // ~86 פריימים לשנייה
export const MAX_SECONDS = 360;

const PITCH_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const CHORD_QUALITIES = [['', [0, 4, 7], 1.0], ['m', [0, 3, 7], 1.0], ['7', [0, 4, 7, 10], 0.93]];

const midiToHz = (m) => 440 * 2 ** ((m - 69) / 12);

// ---------- טעינת המנוע והמודל ----------
let enginePromise = null;

async function pickBackend(order = ['webgl', 'cpu']) {
  // WebGL = המעבד הגרפי (מהיר). CPU = גיבוי איטי יותר אבל תמיד עובד.
  for (const b of order) {
    try {
      if (await tf.setBackend(b)) { await tf.ready(); return b; }
    } catch (e) { /* ננסה את הבא */ }
  }
  return tf.getBackend();
}

/** טעינה מוקדמת (נקרא בפתיחת האפליקציה). */
export function loadEngine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const backend = await pickBackend();
      const model = tf.loadGraphModel(new URL('../model/model.json', import.meta.url).href);
      await model;
      return { backend, model };
    })();
    enginePromise.catch(() => { enginePromise = null; });
  }
  return enginePromise;
}

// ---------- פענוח אודיו ----------
async function decodeToMono(blob) {
  const buf = await blob.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  let audio;
  try {
    audio = await new Promise((resolve, reject) => {
      const p = ac.decodeAudioData(buf, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  } catch (e) {
    throw new Error('err.decode');
  } finally {
    try { ac.close(); } catch (e) { /* ignore */ }
  }
  const duration = Math.min(audio.duration, MAX_SECONDS);
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const off = new OAC(1, Math.max(1, Math.ceil(duration * SR)), SR);
  const src = off.createBufferSource();
  src.buffer = audio;
  src.connect(off.destination);
  src.start(0);
  const rendered = await new Promise((resolve, reject) => {
    off.oncomplete = (e) => resolve(e.renderedBuffer);
    const p = off.startRendering();
    if (p && p.then) p.then(resolve, reject);
  });
  const data = new Float32Array(rendered.getChannelData(0));
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  if (peak < 1e-4) throw new Error('err.silent');
  const g = 0.9 / peak;
  for (let i = 0; i < data.length; i++) data[i] *= g;
  return { data, duration };
}

// ---------- עזרי מתמטיקה ----------
function normalize(arr) {
  let max = 0;
  for (const v of arr) max = Math.max(max, v);
  return max > 0 ? arr.map((v) => v / max) : arr;
}

function percentile(arr, q) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
}

function corr(a, b) {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

// ---------- מעטפת אונסטים (לקצב) ----------
function onsetEnvelope(frames, onsets, audio) {
  const n = frames.length;
  const onsetSum = new Array(n).fill(0);
  const flux = new Array(n).fill(0);
  const rmsFlux = new Array(n).fill(0);
  let prevSum = 0, prevLog = 0;
  for (let t = 0; t < n; t++) {
    let os = 0, fs = 0;
    for (let p = 0; p < 88; p++) { os += onsets[t][p]; fs += frames[t][p]; }
    onsetSum[t] = os;
    flux[t] = Math.max(0, fs - prevSum);
    prevSum = fs;
    // אנרגיה מהאודיו עצמו (תופים/כלי הקשה)
    const a = t * HOP, z = Math.min(audio.length, a + 1024);
    let e = 0;
    for (let i = a; i < z; i++) e += audio[i] * audio[i];
    const lg = Math.log(1e-6 + e / Math.max(1, z - a));
    rmsFlux[t] = Math.max(0, lg - prevLog);
    prevLog = lg;
  }
  const A = normalize(onsetSum), B = normalize(flux), C = normalize(rmsFlux);
  const env = A.map((v, i) => v + 0.7 * B[i] + 0.5 * C[i]);
  // הסרת ממוצע מקומי
  const w = Math.round(FPS * 0.5);
  const out = new Array(n);
  let acc = 0;
  const pre = [0];
  for (let i = 0; i < n; i++) { acc += env[i]; pre.push(acc); }
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w), z = Math.min(n, i + w + 1);
    out[i] = Math.max(0, env[i] - (pre[z] - pre[a]) / (z - a));
  }
  return out;
}

function estimatePeriod(env) {
  const minLag = Math.round((FPS * 60) / 200), maxLag = Math.round((FPS * 60) / 50);
  let best = Math.round((FPS * 60) / 100), bestScore = -Infinity;
  for (let L = minLag; L <= maxLag; L++) {
    let s = 0;
    for (let i = L; i < env.length; i++) s += env[i] * env[i - L];
    s /= env.length - L;
    const bpm = (FPS * 60) / L;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 110) / 0.9) ** 2);
    if (s * prior > bestScore) { bestScore = s * prior; best = L; }
  }
  return best;
}

/** מעקב פעמות בתכנון דינמי (Ellis 2007). */
function trackBeats(env, period) {
  const n = env.length;
  // החלקה גאוסית
  const half = Math.max(1, Math.round(period / 2));
  const sigma = period / 32 || 1;
  const kernel = [];
  for (let k = -half; k <= half; k++) kernel.push(Math.exp(-0.5 * (k / sigma) ** 2));
  const local = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j >= 0 && j < n) s += env[j] * kernel[k + half];
    }
    local[i] = s;
  }
  const tight = 100;
  const cum = new Array(n).fill(0);
  const back = new Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    let best = -Infinity, arg = -1;
    const lo = Math.max(0, t - Math.round(2 * period)), hi = t - Math.round(period / 2);
    for (let p = lo; p <= hi; p++) {
      const sc = cum[p] - tight * Math.log((t - p) / period) ** 2;
      if (sc > best) { best = sc; arg = p; }
    }
    cum[t] = local[t] + (arg >= 0 ? best : 0);
    back[t] = arg;
  }
  let end = n - 1, bestEnd = -Infinity;
  for (let t = Math.max(0, n - Math.round(period)); t < n; t++) {
    if (cum[t] > bestEnd) { bestEnd = cum[t]; end = t; }
  }
  const beats = [];
  for (let t = end; t >= 0; t = back[t]) beats.push(t);
  beats.reverse();
  return beats.map((f) => f / FPS);
}

// ---------- אקורדים ----------
function chordTemplates() {
  const out = [];
  for (let root = 0; root < 12; root++) {
    for (const [q, ints, w] of CHORD_QUALITIES) {
      const v = new Array(12).fill(0);
      for (const i of ints) v[(root + i) % 12] = 1;
      v[root] += 0.5;
      const nrm = Math.hypot(...v);
      out.push({ label: PITCH_NAMES[root] + q, root, quality: q, v: v.map((x) => x / nrm), w });
    }
  }
  return out;
}

function detectChords(chroma, beatTimes) {
  const n = chroma.length;
  const T = chordTemplates();
  const S = T.length + 1; // + N
  const bounds = beatTimes.map((t) => Math.min(n, Math.max(0, Math.round(t * FPS))));
  bounds.push(n);
  const segs = [];
  const energies = [];
  for (let b = 0; b < beatTimes.length; b++) {
    const a = bounds[b], z = Math.max(bounds[b + 1], a + 1);
    const c = new Array(12).fill(0);
    for (let t = a; t < Math.min(z, n); t++) for (let k = 0; k < 12; k++) c[k] += chroma[t][k];
    const e = c.reduce((x, y) => x + y, 0) / (z - a);
    segs.push(c);
    energies.push(e);
  }
  const thr = percentile(energies, 0.9) * 0.08;
  const logE = segs.map((c, b) => {
    const p = new Array(S).fill(0);
    const nrm = Math.hypot(...c);
    if (nrm <= 1e-6 || energies[b] < thr) {
      p.fill(Math.log(0.02)); p[S - 1] = 0;
      return p;
    }
    const logits = T.map((t) => t.w * t.v.reduce((s, x, k) => s + x * (c[k] / nrm), 0) * 18);
    logits.push(0.55 * 18);
    const mx = Math.max(...logits);
    const ex = logits.map((l) => Math.exp(l - mx));
    const sum = ex.reduce((x, y) => x + y, 0);
    return ex.map((v) => Math.log(v / sum + 1e-12));
  });
  // ויטרבי עם העדפה להישאר באותו אקורד
  const stay = Math.log(0.75), move = Math.log(0.25 / (S - 1));
  const B = logE.length;
  if (!B) return [];
  let prev = logE[0].slice();
  const ptr = [];
  for (let b = 1; b < B; b++) {
    let bestPrev = 0;
    for (let s = 1; s < S; s++) if (prev[s] > prev[bestPrev]) bestPrev = s;
    const cur = new Array(S), bp = new Array(S);
    for (let s = 0; s < S; s++) {
      const viaStay = prev[s] + stay, viaMove = prev[bestPrev] + move;
      if (viaStay >= viaMove) { cur[s] = viaStay + logE[b][s]; bp[s] = s; } else { cur[s] = viaMove + logE[b][s]; bp[s] = bestPrev; }
    }
    ptr.push(bp);
    prev = cur;
  }
  let s = 0;
  for (let k = 1; k < S; k++) if (prev[k] > prev[s]) s = k;
  const path = [s];
  for (let b = B - 2; b >= 0; b--) { s = ptr[b][s]; path.push(s); }
  path.reverse();
  return path.map((st, b) => (st === S - 1
    ? { beat: b, label: 'N', root: null, quality: null }
    : { beat: b, label: T[st].label, root: T[st].root, quality: T[st].quality }));
}

function detectKey(chroma, notes) {
  const hist = new Array(12).fill(0);
  for (const n of notes) hist[n.pitch % 12] += (n.end - n.start) * n.velocity;
  const c = new Array(12).fill(0);
  for (const row of chroma) for (let k = 0; k < 12; k++) c[k] += row[k];
  const hs = hist.reduce((a, b) => a + b, 0), cs = c.reduce((a, b) => a + b, 0);
  const profile = hist.map((h, k) => (hs ? (0.7 * h) / hs : 0) + (cs ? (0.3 * c[k]) / cs : 0));
  let best = [-2, 0, 'major'];
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const [mode, ref] of [['major', MAJOR_PROFILE], ['minor', MINOR_PROFILE]]) {
      const rolled = ref.map((_, i) => ref[(i - tonic + 12) % 12]);
      const r = corr(profile, rolled);
      if (r > best[0]) best = [r, tonic, mode];
    }
  }
  const [, tonic, mode] = best;
  return { tonic, mode, name: PITCH_NAMES[tonic] + (mode === 'minor' ? 'm' : '') };
}

function removeOvertones(notes) {
  return notes.filter((n) => !notes.some((m) => m !== n
    && Math.abs(m.start - n.start) <= 0.06
    && [12, 19, 24].includes(n.pitch - m.pitch)
    && n.velocity < 0.85 * m.velocity));
}

async function runModel(model, data, onProgress) {
  const frames = [], onsets = [];
  const bp = new BasicPitch(model);
  await bp.evaluateModel(
    data,
    (f, o) => { for (const r of f) frames.push(r); for (const r of o) onsets.push(r); },
    (p) => onProgress('notes', p),
  );
  return { frames, onsets };
}

function hasBadValues(frames) {
  for (let t = 0; t < frames.length; t += 7) {
    for (const v of frames[t]) if (!Number.isFinite(v) || v < -0.01 || v > 1.01) return true;
  }
  return false;
}

// ---------- הפונקציה הראשית ----------
/**
 * @param {Blob} blob קובץ אודיו
 * @param {{sensitivity?:number, onProgress?:(stage:string, fraction:number)=>void}} opts
 */
export async function analyze(blob, { sensitivity = 0.5, onProgress = () => {} } = {}) {
  onProgress('load', 0);
  const { model } = await loadEngine();
  onProgress('decode', 0);
  const { data, duration } = await decodeToMono(blob);

  onProgress('notes', 0);
  let { frames, onsets } = await runModel(model, data, onProgress);
  if (hasBadValues(frames) && tf.getBackend() !== 'cpu') {
    // יש מכשירים שבהם WebGL מחזיר ערכים שגויים - עוברים ל-CPU ומריצים שוב
    console.warn('WebGL returned invalid values, retrying on CPU');
    await pickBackend(['cpu']);
    ({ frames, onsets } = await runModel(model, data, onProgress));
  }
  onProgress('harmony', 0);
  await new Promise((r) => setTimeout(r, 0));

  // כרומה (12 צלילים) מתוך פלט המודל - לפני שהפונקציה של התווים משנה את המערכים
  const chroma = frames.map((row) => {
    const c = new Array(12).fill(0);
    for (let p = 0; p < 88; p++) c[(p + 21) % 12] += row[p];
    return c;
  });
  const env = onsetEnvelope(frames, onsets, data);

  let beats = trackBeats(env, estimatePeriod(env));
  if (beats.length < 4) {
    beats = [];
    for (let t = 0; t <= duration + 0.67; t += 60 / 90) beats.push(t);
  }
  const diffs = beats.slice(1).map((t, i) => t - beats[i]).sort((a, b) => a - b);
  const tempo = 60 / diffs[Math.floor(diffs.length / 2)];
  const chords = detectChords(chroma, beats);

  // תווים
  const s = Math.min(1, Math.max(0, sensitivity));
  const onsetThresh = 0.65 - 0.35 * s;
  const frameThresh = 0.40 - 0.20 * s;
  const fCopy = frames.map((r) => r.slice());
  const oCopy = onsets.map((r) => r.slice());
  const events = noteFramesToTime(outputToNotesPoly(
    fCopy, oCopy, onsetThresh, frameThresh, Math.round(0.09 * FPS), true, midiToHz(100), midiToHz(28), true,
  ));
  let notes = events.map((e) => ({
    start: +e.startTimeSeconds.toFixed(4),
    end: +(e.startTimeSeconds + e.durationSeconds).toFixed(4),
    pitch: e.pitchMidi,
    velocity: +e.amplitude.toFixed(3),
  })).sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  notes = removeOvertones(notes);
  const key = detectKey(chroma, notes);
  onProgress('done', 1);

  return {
    version: 1,
    duration: +duration.toFixed(3),
    tempo: +tempo.toFixed(1),
    beats: beats.map((t) => +t.toFixed(4)),
    key,
    chords,
    notes,
  };
}
