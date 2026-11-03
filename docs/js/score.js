// המרת תוצאת הניתוח מהשרת (שניות + פעמות) לתווים "מוזיקליים":
// כימות לרשת, חלוקה לתיבות, קשתות (ties), מנגינה/מלא, אקורדים וטאבים.
// כל זה רץ בדפדפן, כך ששינוי הגדרות לא דורש פנייה נוספת לשרת.

export const TPB = 4; // טיקים לפעמה (רבע) = שש-עשריות

// [אורך בטיקים, משך VexFlow]
const DURATIONS = [
  [16, 'w'], [12, 'hd'], [8, 'h'], [6, 'qd'], [4, 'q'], [3, '8d'], [2, '8'], [1, '16'],
];

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
// מספר דיאזים(+)/במולים(-) לסולם מז'ור לפי הטוניקה
const MAJOR_FIFTHS = [0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5];
const FIFTHS_TO_KEY = { 0: 'C', 1: 'G', 2: 'D', 3: 'A', 4: 'E', 5: 'B', 6: 'F#', '-1': 'F', '-2': 'Bb', '-3': 'Eb', '-4': 'Ab', '-5': 'Db', '-6': 'Gb' };

// כיוון גיטרה סטנדרטי (מיתר 1 = מי גבוה)
export const GUITAR_TUNING = [64, 59, 55, 50, 45, 40];
const GUITAR_MIN = 40, GUITAR_MAX = 79, MAX_FRET = 15;

export const DEFAULT_SETTINGS = {
  instrument: 'guitar', // 'guitar' | 'piano'
  content: 'melody',    // 'melody' | 'full'
  grid: 2,              // יחידות לפעמה: 2 = שמיניות, 4 = שש-עשריות
  beatsPerMeasure: 4,
  showTab: true,
  transpose: 0,         // בחצאי טונים
  tempo: 0,             // 0 = הטמפו שזוהה
};

const mod12 = (n) => ((n % 12) + 12) % 12;

export function keyInfo(key, transpose = 0) {
  const tonic = mod12((key?.tonic ?? 0) + transpose);
  const minor = key?.mode === 'minor';
  const majorTonic = minor ? mod12(tonic + 3) : tonic;
  const fifths = MAJOR_FIFTHS[majorTonic];
  const names = fifths < 0 ? FLAT_NAMES : SHARP_NAMES;
  return {
    fifths,
    spec: FIFTHS_TO_KEY[fifths],
    name: names[tonic] + (minor ? 'm' : ''),
    hebrew: `${names[tonic]} ${minor ? 'מינור' : 'מז׳ור'}`,
    names,
  };
}

export function pitchName(midi, names) {
  return names[mod12(midi)];
}

export function chordName(root, quality, names) {
  return names[mod12(root)] + (quality || '');
}

/** המרת זמן בשניות למיקום בפעמות (אינטרפולציה בין הפעמות שזוהו - עמיד לשינויי קצב). */
export function makeBeatMapper(beats) {
  const b = beats && beats.length >= 2 ? beats : [0, 0.6];
  const n = b.length;
  return (t) => {
    if (t <= b[0]) return (t - b[0]) / (b[1] - b[0]);
    if (t >= b[n - 1]) return n - 1 + (t - b[n - 1]) / (b[n - 1] - b[n - 2]);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (b[mid] <= t) lo = mid; else hi = mid;
    }
    return lo + (t - b[lo]) / (b[lo + 1] - b[lo]);
  };
}

/** פעמה (מספר עשרוני) -> שניות. ההפך של makeBeatMapper. */
export function makeTimeMapper(beats) {
  const b = beats && beats.length >= 2 ? beats : [0, 0.6];
  const n = b.length;
  return (beat) => {
    if (beat <= 0) return b[0] + beat * (b[1] - b[0]);
    if (beat >= n - 1) return b[n - 1] + (beat - (n - 1)) * (b[n - 1] - b[n - 2]);
    const i = Math.floor(beat);
    return b[i] + (beat - i) * (b[i + 1] - b[i]);
  };
}

/** פירוק טקסט מילים לאסימונים: רווח בין מילים, מקף בין הברות (שָׁ-לוֹם). */
export function lyricTokens(text) {
  const out = [];
  for (const word of (text || '').split(/\s+/)) {
    if (!word) continue;
    const parts = word.split('-').filter(Boolean);
    parts.forEach((p, i) => out.push(i < parts.length - 1 ? p + '-' : p));
  }
  return out;
}

/** אקורד לכל "משבצת" (חצי תיבה ב-4/4, תיבה ב-3/4) לפי רוב קולות. */
function chordSlots(perBeat, startBeat, bpm) {
  const step = bpm % 2 === 0 ? bpm / 2 : bpm;
  const slots = [];
  const total = perBeat.length;
  for (let s = startBeat; s < total; s += step) {
    const votes = new Map();
    for (let b = Math.max(0, s); b < Math.min(total, s + step); b++) {
      const c = perBeat[b];
      const k = c.label;
      votes.set(k, (votes.get(k) || 0) + 1 + (b === s ? 0.1 : 0));
    }
    let best = null, bestV = -1;
    for (const [k, v] of votes) if (v > bestV) { best = k; bestV = v; }
    const sample = perBeat.find((c, i) => i >= Math.max(0, s) && c.label === best);
    slots.push({ beat: s, beats: step, chord: sample || { label: 'N' } });
  }
  return slots;
}

/** בחירת מיקום הפעמה הראשונה בתיבה: היכן שהכי הרבה החלפות אקורדים ובס חזק. */
function chooseDownbeatPhase(perBeat, bassOnsets, bpm) {
  let bestPhase = 0, bestScore = -1;
  for (let ph = 0; ph < bpm; ph++) {
    let score = 0;
    for (let b = 1; b < perBeat.length; b++) {
      if ((b - ph) % bpm !== 0) continue;
      if (perBeat[b].label !== perBeat[b - 1].label) score += 1;
      score += 0.5 * (bassOnsets.get(b) || 0);
    }
    if (score > bestScore + 1e-9) { bestScore = score; bestPhase = ph; }
  }
  return bestPhase;
}

function skyline(notes) {
  // בכל נקודת התחלה משאירים רק את התו הגבוה ביותר
  const byTick = new Map();
  for (const n of notes) {
    const cur = byTick.get(n.st);
    if (!cur || n.pitch > cur.pitch) byTick.set(n.st, n);
  }
  return [...byTick.values()].sort((a, b) => a.st - b.st);
}

function foldInto(pitch, lo, hi) {
  while (pitch < lo) pitch += 12;
  while (pitch > hi) pitch -= 12;
  return pitch;
}

/** פירוק משך לערכי תווים חוקיים, תוך שמירה על גבולות פעמה. */
function decompose(offset, length) {
  const out = [];
  let o = offset, len = length;
  while (len > 0) {
    let pick = [1, '16'];
    for (const [d, name] of DURATIONS) {
      if (d > len) continue;
      const fits = d > TPB ? o % TPB === 0 : (o % TPB) + d <= TPB;
      if (fits) { pick = [d, name]; break; }
    }
    out.push({ ticks: pick[0], dur: pick[1] });
    o += pick[0];
    len -= pick[0];
  }
  return out;
}

/**
 * בניית קול יחיד לחמשה: אירועים (אקורד/תו) ללא חפיפה + הפסקות.
 * מחזיר מערך תיבות, בכל תיבה פריטים {rest, pitches, ticks, dur, start, tieNext, first, tab}
 */
function buildVoice(notes, numMeasures, measureTicks, splitTicks, maxPolyphony, legatoGap = 0) {
  const total = numMeasures * measureTicks;
  const groups = new Map();
  for (const n of notes) {
    if (n.st >= total) continue;
    const g = groups.get(n.st) || { st: n.st, en: n.st, pitches: new Set(), tab: null, srcByPitch: new Map() };
    g.pitches.add(n.pitch);
    if (n.src != null) {
      if (!g.srcByPitch.has(n.pitch)) g.srcByPitch.set(n.pitch, []);
      g.srcByPitch.get(n.pitch).push(n.src);
    }
    g.en = Math.max(g.en, Math.min(n.en, total));
    groups.set(n.st, g);
  }
  const events = [...groups.values()].sort((a, b) => a.st - b.st);
  for (let i = 0; i < events.length; i++) {
    let p = [...events[i].pitches].sort((a, b) => a - b);
    if (p.length > maxPolyphony) p = p.slice(p.length - maxPolyphony);
    events[i].pitches = p;
    // מקור התווים בניתוח (לעריכה)
    events[i].srcs = p.flatMap((x) => events[i].srcByPitch.get(x) || []);
    events[i].en0 = events[i].en;
    if (i + 1 < events.length) {
      const next = events[i + 1].st;
      // לגאטו: רווח קטן עד התו הבא נבלע (קריאות טובה יותר, פחות הפסקות קטנות)
      events[i].en = next - events[i].en <= legatoGap ? next : Math.min(events[i].en, next);
    }
  }

  // רצף: תווים והפסקות
  const spans = [];
  let cursor = 0;
  for (const ev of events) {
    if (ev.st > cursor) spans.push({ rest: true, st: cursor, en: ev.st });
    spans.push({ rest: false, st: ev.st, en: ev.en, pitches: ev.pitches, ev });
    cursor = ev.en;
  }
  if (cursor < total) spans.push({ rest: true, st: cursor, en: total });

  const boundaries = new Set(splitTicks);
  for (let m = 0; m <= numMeasures; m++) boundaries.add(m * measureTicks);
  const sortedB = [...boundaries].sort((a, b) => a - b);

  const measures = Array.from({ length: numMeasures }, () => []);
  for (const sp of spans) {
    // נקודות חיתוך בתוך הקטע
    const cuts = [sp.st, ...sortedB.filter((b) => b > sp.st && b < sp.en), sp.en];
    const pieces = [];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const a = cuts[i], z = cuts[i + 1];
      const m = Math.floor(a / measureTicks);
      for (const d of decompose(a - m * measureTicks, z - a)) {
        pieces.push({ m, d });
      }
    }
    let t = sp.st;
    pieces.forEach((pc, i) => {
      const item = {
        rest: sp.rest,
        pitches: sp.rest ? [] : sp.pitches,
        ticks: pc.d.ticks,
        dur: pc.d.dur,
        start: t,
        tieNext: !sp.rest && i < pieces.length - 1,
        first: i === 0,
        ev: sp.ev || null,
      };
      t += pc.d.ticks;
      measures[pc.m].push(item);
    });
  }
  return measures;
}

/** הצבת תווים על מיתרים/סריגים בגיטרה (חמדני, מעדיף מיקום יד קרוב ומיתרים פתוחים). */
function assignTab(events) {
  let hand = 3;
  for (const ev of events) {
    const desc = [...ev.pitches].sort((a, b) => b - a);
    const positions = [];
    let lastString = 0; // מיתרים 1..6, תו נמוך יותר => מספר מיתר גבוה יותר
    for (const p of desc) {
      let best = null, bestCost = Infinity;
      for (let s = lastString + 1; s <= 6; s++) {
        const fret = p - GUITAR_TUNING[s - 1];
        if (fret < 0 || fret > MAX_FRET) continue;
        // משאירים מספיק מיתרים לתווים הנמוכים שנותרו
        const remaining = desc.length - positions.length - 1;
        if (6 - s < remaining) continue;
        const cost = fret === 0 ? 0.5 : Math.abs(fret - hand) + (fret > 12 ? 2 : 0);
        if (cost < bestCost) { bestCost = cost; best = { str: s, fret }; }
      }
      if (best) { positions.push(best); lastString = best.str; }
    }
    ev.tab = positions;
    const fretted = positions.filter((x) => x.fret > 0).map((x) => x.fret);
    if (fretted.length) hand = 0.6 * hand + 0.4 * (fretted.reduce((a, b) => a + b, 0) / fretted.length);
  }
}

/**
 * הפונקציה הראשית: analysis (מהשרת) + settings => מבנה תווים מוכן לציור.
 */
export function buildScore(analysis, userSettings = {}, lyrics = '') {
  const st = { ...DEFAULT_SETTINGS, ...userSettings };
  const bpm = st.beatsPerMeasure;
  const measureTicks = bpm * TPB;
  const q = TPB / st.grid;
  const toBeat = makeBeatMapper(analysis.beats);
  const key = keyInfo(analysis.key, st.transpose);
  const perBeat = analysis.chords || [];

  // אונסטים של בס לכל פעמה (לזיהוי תחילת תיבה)
  const bassOnsets = new Map();
  for (const n of analysis.notes) {
    if (n.pitch >= 55) continue;
    const b = Math.round(toBeat(n.start));
    bassOnsets.set(b, (bassOnsets.get(b) || 0) + n.velocity);
  }
  const phase = chooseDownbeatPhase(perBeat, bassOnsets, bpm);

  // הפעמה הראשונה בה יש צליל או אקורד
  let firstBeat = Infinity;
  for (const n of analysis.notes) firstBeat = Math.min(firstBeat, toBeat(n.start));
  const firstChord = perBeat.findIndex((c) => c.label !== 'N');
  if (firstChord >= 0) firstBeat = Math.min(firstBeat, firstChord);
  if (!isFinite(firstBeat)) firstBeat = 0;
  const startBeat = phase + bpm * Math.floor((firstBeat + 0.25 - phase) / bpm);

  // כימות
  const seen = new Set();
  let notes = [];
  analysis.notes.forEach((n, src) => {
    const s = toBeat(n.start) - startBeat;
    const e = toBeat(n.end) - startBeat;
    const sTick = Math.max(0, Math.round(s * st.grid) * q);
    const eTick = Math.max(sTick + q, Math.round(e * st.grid) * q);
    const pitch = n.pitch + st.transpose;
    const k = sTick + ':' + pitch;
    if (seen.has(k)) return;
    seen.add(k);
    notes.push({ st: sTick, en: eTick, pitch, vel: n.velocity, src });
  });
  notes.sort((a, b) => a.st - b.st || a.pitch - b.pitch);

  // אקורדים: משבצות -> מקטעים בטיקים
  const slots = chordSlots(perBeat, startBeat, bpm);
  const chordMarks = [];
  let prev = null;
  for (const s of slots) {
    const tick = Math.round((s.beat - startBeat) * TPB);
    if (tick < 0) continue;
    const c = s.chord;
    const label = c.label === 'N' || c.root == null ? 'N' : chordName(c.root + st.transpose, c.quality, key.names);
    if (label === prev) continue;
    prev = label;
    chordMarks.push({ tick, label, root: c.root == null ? null : mod12(c.root + st.transpose), quality: c.quality });
  }
  // סיום כל מקטע אקורד
  for (let i = 0; i < chordMarks.length; i++) {
    chordMarks[i].end = i + 1 < chordMarks.length ? chordMarks[i + 1].tick : Infinity;
  }

  const lastNote = notes.reduce((m, n) => Math.max(m, n.en), 0);
  const lastChord = chordMarks.filter((c) => c.label !== 'N').reduce((m, c) => Math.max(m, c.tick + TPB), 0);
  const numMeasures = Math.max(1, Math.ceil(Math.max(lastNote, lastChord) / measureTicks));
  const total = numMeasures * measureTicks;
  for (const c of chordMarks) c.end = Math.min(c.end, total);
  const visibleChords = chordMarks.filter((c) => c.label !== 'N' && c.tick < total);
  const chordTicks = visibleChords.map((c) => c.tick);

  // חלוקה לחמשות
  const staves = [];
  if (st.instrument === 'guitar') {
    let gNotes = notes.map((n) => ({ ...n, pitch: foldInto(n.pitch, GUITAR_MIN, GUITAR_MAX) }));
    if (st.content === 'melody') gNotes = skyline(gNotes);
    const measures = buildVoice(gNotes, numMeasures, measureTicks, chordTicks, 6, q);
    const events = [];
    for (const m of measures) for (const it of m) if (!it.rest && it.first && it.ev && !events.includes(it.ev)) events.push(it.ev);
    assignTab(events);
    staves.push({ clef: 'treble', octaveShift: 12, measures, tab: st.showTab });
  } else {
    let treble, bass;
    if (st.content === 'melody') {
      treble = skyline(notes).map((n) => ({ ...n, pitch: foldInto(n.pitch, 55, 88) }));
      // יד שמאל: שורש האקורד
      bass = visibleChords.map((c) => ({ st: c.tick, en: c.end, pitch: 48 + c.root }));
    } else {
      treble = notes.filter((n) => n.pitch >= 60);
      bass = notes.filter((n) => n.pitch < 60);
    }
    staves.push({ clef: 'treble', octaveShift: 0, measures: buildVoice(treble, numMeasures, measureTicks, chordTicks, 5, q) });
    staves.push({ clef: 'bass', octaveShift: 0, measures: buildVoice(bass, numMeasures, measureTicks, chordTicks, 5, q) });
  }

  // מילים: מילה/הברה לכל תו חדש בחמשה העליונה
  const tokens = lyricTokens(lyrics);
  if (tokens.length) {
    let i = 0;
    for (const m of staves[0].measures) {
      for (const it of m) {
        if (i >= tokens.length) break;
        if (!it.rest && it.first) it.lyric = tokens[i++];
      }
    }
  }

  const toTime = makeTimeMapper(analysis.beats);
  return {
    hasLyrics: tokens.length > 0,
    timeToTick: (t) => (toBeat(t) - startBeat) * TPB,
    tickToTime: (tick) => toTime(startBeat + tick / TPB),
    settings: st,
    key,
    tempo: Math.round(st.tempo || analysis.tempo || 90),
    startBeat,
    beatsPerMeasure: bpm,
    measureTicks,
    numMeasures,
    staves,
    chords: visibleChords,
    instrument: st.instrument,
  };
}
