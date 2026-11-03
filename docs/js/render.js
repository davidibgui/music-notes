// ציור התווים עם VexFlow: חמשה, אקורדים, טאבים לגיטרה, חמשה כפולה לפסנתר.
import { TPB } from './score.js';
import { drawChordDiagram } from './chords.js';

const VF = () => window.Vex.Flow;

const KEY_LETTERS = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
const KEY_LETTERS_FLAT = ['c', 'db', 'd', 'eb', 'e', 'f', 'gb', 'g', 'ab', 'a', 'bb', 'b'];

function vfKey(midi, flats) {
  const names = flats ? KEY_LETTERS_FLAT : KEY_LETTERS;
  return `${names[((midi % 12) + 12) % 12]}/${Math.floor(midi / 12) - 1}`;
}

const SYSTEM_TOP = 62;     // מקום לשמות אקורדים מעל החמשה
const STAFF_GAP = 105;     // מרחק בין חמשות באותה שורה
const TAB_GAP = 100;

export function systemHeight(score) {
  if (score.instrument === 'piano') return SYSTEM_TOP + STAFF_GAP + 110;
  return SYSTEM_TOP + (score.staves[0].tab ? STAFF_GAP + TAB_GAP + 10 : 110);
}

function measureMinWidth(score, m) {
  let items = 0;
  for (const s of score.staves) items = Math.max(items, s.measures[m].length);
  const chordsHere = score.chords.filter((c) => Math.floor(c.tick / score.measureTicks) === m).length;
  return Math.max(70 + chordsHere * 30, 28 + items * 30);
}

/** חלוקת התיבות לשורות לפי רוחב זמין. */
export function layoutSystems(score, width) {
  const margin = 12;
  const usable = width - margin * 2;
  const headW = 52 + 11 * Math.abs(score.key.fifths);
  const timeW = 30;
  const systems = [];
  let cur = null;
  for (let m = 0; m < score.numMeasures; m++) {
    const w = measureMinWidth(score, m);
    if (!cur) {
      cur = { measures: [], widths: [], head: headW + (systems.length === 0 ? timeW : 0) };
    }
    const used = cur.head + cur.widths.reduce((a, b) => a + b, 0);
    if (cur.measures.length && used + w > usable) {
      systems.push(cur);
      cur = { measures: [], widths: [], head: headW };
    }
    cur.measures.push(m);
    cur.widths.push(w);
  }
  if (cur) systems.push(cur);
  // מתיחה למילוי השורה (חוץ משורה אחרונה קצרה)
  systems.forEach((s, i) => {
    const sum = s.widths.reduce((a, b) => a + b, 0);
    const free = usable - s.head - sum;
    const last = i === systems.length - 1;
    const factor = last && free > sum * 0.6 ? 1.25 : (usable - s.head) / sum;
    s.widths = s.widths.map((w) => Math.min(w * factor, last ? w * 1.6 : Infinity));
    s.widths[0] += s.head;
    s.x = margin;
  });
  return systems;
}

function makeNotes(score, staff, items, flats) {
  const F = VF();
  const notes = [];
  const tabNotes = [];
  for (const it of items) {
    let note;
    if (it.rest) {
      note = new F.StaveNote({ keys: [staff.clef === 'bass' ? 'd/3' : 'b/4'], duration: it.dur + 'r', clef: staff.clef });
    } else {
      const keys = it.pitches.map((p) => vfKey(p + staff.octaveShift, flats));
      note = new F.StaveNote({ keys, duration: it.dur, clef: staff.clef, auto_stem: true });
    }
    if (it.dur.includes('d')) F.Dot.buildAndAttach([note], { all: true });
    note.__item = it;
    notes.push(note);

    if (staff.tab) {
      let tn;
      const pos = it.ev && it.ev.tab;
      if (!it.rest && it.first && pos && pos.length) {
        tn = new F.TabNote({ positions: pos.map((p) => ({ str: p.str, fret: p.fret })), duration: it.dur.replace('d', '') });
      } else {
        tn = new F.GhostNote({ duration: it.dur.replace('d', '') });
      }
      tabNotes.push(tn);
    }
  }
  return { notes, tabNotes };
}

function makeVoice(score, notes, useDots = true) {
  const F = VF();
  const v = new F.Voice({ num_beats: score.beatsPerMeasure, beat_value: 4 });
  v.setMode(F.Voice.Mode.SOFT);
  v.addTickables(notes);
  return v;
}

/** ציור שורות נתונות על context, החל מ-y. מחזיר את ה-y בסוף. */
export function drawSystems(ctx, score, systems, startY, opts = {}) {
  const F = VF();
  const flats = score.key.fifths < 0;
  const timeSig = `${score.beatsPerMeasure}/4`;
  const sysH = systemHeight(score);
  let y = startY;
  let pendingTies = score.staves.map(() => null); // תו אחרון עם קשת שנמשכת לשורה הבאה

  systems.forEach((sys, si) => {
    const isFirstSystem = sys.measures[0] === 0;
    let x = sys.x;
    const lineNotes = score.staves.map(() => []);
    const staveRows = [];

    sys.measures.forEach((m, mi) => {
      const w = sys.widths[mi];
      const staves = [];
      const voices = [];
      const beamsAll = [];
      score.staves.forEach((staff, sti) => {
        const sy = y + SYSTEM_TOP + sti * STAFF_GAP;
        const st = new F.Stave(x, sy, w);
        if (mi === 0) {
          st.addClef(staff.clef, 'default', staff.octaveShift ? '8vb' : undefined);
          if (score.key.spec !== 'C') st.addKeySignature(score.key.spec);
          if (isFirstSystem) st.addTimeSignature(timeSig);
        }
        if (mi === sys.measures.length - 1 && m === score.numMeasures - 1) st.setEndBarType(F.Barline.type.END);
        staves.push(st);

        const items = staff.measures[m];
        const { notes, tabNotes } = makeNotes(score, staff, items, flats);
        const v = makeVoice(score, notes);
        voices.push({ v, stave: st, notes });
        lineNotes[sti].push(...notes);

        if (staff.tab) {
          const tst = new F.TabStave(x, sy + TAB_GAP, w);
          if (mi === 0) tst.addClef('tab');
          staves.push(tst);
          const tv = makeVoice(score, tabNotes);
          voices.push({ v: tv, stave: tst, notes: tabNotes, tab: true });
        }
      });

      // יישור נקודת התחלת התווים בין כל החמשות של התיבה
      const sx = Math.max(...staves.map((s) => s.getNoteStartX()));
      staves.forEach((s) => s.setNoteStartX(sx));

      // תאונות (accidentals) לפי הסולם
      voices.filter((vv) => !vv.tab).forEach((vv) => {
        try { F.Accidental.applyAccidentals([vv.v], score.key.spec); } catch (e) { /* ignore */ }
      });

      voices.forEach((vv) => vv.notes.forEach((n) => n.setStave(vv.stave)));
      const fmtW = Math.max(20, staves[0].getNoteEndX() - sx - 12);
      new F.Formatter().format(voices.map((vv) => vv.v), fmtW);

      staves.forEach((s) => s.setContext(ctx).draw());
      voices.forEach((vv) => {
        if (!vv.tab) {
          const beamable = vv.notes;
          try {
            const beams = F.Beam.generateBeams(beamable, { groups: F.Beam.getDefaultBeamGroups(timeSig) });
            beamsAll.push(...beams);
          } catch (e) { /* ignore */ }
        }
        vv.v.draw(ctx, vv.stave);
      });
      beamsAll.forEach((b) => b.setContext(ctx).draw());

      // שמות אקורדים
      const top = voices[0];
      const chordsHere = score.chords.filter((c) => Math.floor(c.tick / score.measureTicks) === m);
      ctx.save();
      ctx.setFont('Arial', 15, 'bold');
      ctx.setFillStyle('#1d3d8f');
      for (const c of chordsHere) {
        const n = top.notes.find((nn) => nn.__item.start === c.tick)
          || top.notes.reduce((best, nn) => (nn.__item.start <= c.tick ? nn : best), top.notes[0]);
        const nx = n ? n.getAbsoluteX() : x + 10;
        // מעל התווים הגבוהים שבתיבה (קווי עזר), אבל לא מעבר לראש השורה
        let topY = y + SYSTEM_TOP - 14;
        for (const nn of top.notes) {
          try { topY = Math.min(topY, nn.getBoundingBox().getY() - 6); } catch (e) { /* ignore */ }
        }
        ctx.fillText(c.label, nx - 2, Math.max(y + 16, topY));
      }
      ctx.restore();

      // מספר תיבה בתחילת שורה
      if (mi === 0) {
        ctx.save();
        ctx.setFont('Arial', 10, 'normal');
        ctx.setFillStyle('#777');
        ctx.fillText(String(m + 1), x + 2, y + SYSTEM_TOP - 2);
        ctx.restore();
      }
      staveRows.push(staves);
      x += w;
    });

    // מחברים בתחילת השורה
    const firstStaves = staveRows[0];
    if (firstStaves.length > 1) {
      const top = firstStaves[0], bottom = firstStaves[firstStaves.length - 1];
      new F.StaveConnector(top, bottom).setType(F.StaveConnector.type.SINGLE_LEFT).setContext(ctx).draw();
      new F.StaveConnector(top, bottom)
        .setType(score.instrument === 'piano' ? F.StaveConnector.type.BRACE : F.StaveConnector.type.BRACKET)
        .setContext(ctx).draw();
      if (score.instrument === 'piano') {
        staveRows.forEach((sts) => {
          const isEnd = sts === staveRows[staveRows.length - 1] && sys.measures[sys.measures.length - 1] === score.numMeasures - 1;
          new F.StaveConnector(sts[0], sts[sts.length - 1])
            .setType(isEnd ? F.StaveConnector.type.BOLD_DOUBLE_RIGHT : F.StaveConnector.type.SINGLE_RIGHT)
            .setContext(ctx).draw();
        });
      }
    }

    // קשתות (ties) - כולל המשך משורה קודמת
    score.staves.forEach((staff, sti) => {
      const ns = lineNotes[sti];
      const idx = (n) => n.__item.pitches.map((_, i) => i);
      if (pendingTies[sti] && ns.length && !ns[0].__item.rest) {
        new F.StaveTie({ first_note: null, last_note: ns[0], first_indices: idx(ns[0]), last_indices: idx(ns[0]) }).setContext(ctx).draw();
      }
      pendingTies[sti] = null;
      for (let i = 0; i < ns.length; i++) {
        if (!ns[i].__item.tieNext) continue;
        const next = ns[i + 1];
        if (next) {
          const k = idx(ns[i]);
          new F.StaveTie({ first_note: ns[i], last_note: next, first_indices: k, last_indices: k }).setContext(ctx).draw();
        } else {
          const k = idx(ns[i]);
          new F.StaveTie({ first_note: ns[i], last_note: null, first_indices: k, last_indices: k }).setContext(ctx).draw();
          pendingTies[sti] = true;
        }
      }
    });

    y += sysH;
  });
  return y;
}

/** אזור דיאגרמות האקורדים (לגיטרה). מחזיר גובה. */
export function chordDiagramsHeight(score, width) {
  const uniq = uniqueChords(score);
  if (score.instrument !== 'guitar' || !uniq.length) return 0;
  const perRow = Math.max(1, Math.floor((width - 24) / 88));
  return Math.ceil(uniq.length / perRow) * 112 + 10;
}

export function uniqueChords(score) {
  const seen = new Map();
  for (const c of score.chords) if (!seen.has(c.label)) seen.set(c.label, c);
  return [...seen.values()];
}

export function drawChordDiagrams(ctx, score, width, y) {
  if (score.instrument !== 'guitar') return y;
  const uniq = uniqueChords(score);
  const perRow = Math.max(1, Math.floor((width - 24) / 88));
  uniq.forEach((c, i) => {
    const col = i % perRow, row = Math.floor(i / perRow);
    drawChordDiagram(ctx, 12 + col * 88, y + row * 112, c.label, c.root, c.quality);
  });
  return y + chordDiagramsHeight(score, width);
}

/** ציור מלא לתוך אלמנט HTML (SVG) - לתצוגה במסך. */
export function renderToElement(el, score, { width, zoom = 1 }) {
  const F = VF();
  el.innerHTML = '';
  const logicalW = Math.max(300, width / zoom);
  const systems = layoutSystems(score, logicalW);
  const diagH = chordDiagramsHeight(score, logicalW);
  const height = diagH + systems.length * systemHeight(score) + 30;
  const renderer = new F.Renderer(el, F.Renderer.Backends.SVG);
  renderer.resize(logicalW * zoom, height * zoom);
  const ctx = renderer.getContext();
  ctx.scale(zoom, zoom);
  let y = drawChordDiagrams(ctx, score, logicalW, 6);
  drawSystems(ctx, score, systems, y);
  return { systems };
}

export { TPB };
