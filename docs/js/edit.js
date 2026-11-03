// עריכת תווים ואקורדים. כל השינויים נעשים על נתוני הניתוח (analysis),
// כך שהם נשמרים גם כשמחליפים כלי/תצוגה/טרנספוזיציה.
import { TPB } from './score.js';

const MAX_UNDO = 40;

export class Editor {
  constructor(onChange) {
    this.onChange = onChange;
    this.undoStack = [];
  }

  reset() { this.undoStack = []; }

  get canUndo() { return this.undoStack.length > 0; }

  snapshot(analysis) {
    this.undoStack.push(JSON.stringify({ notes: analysis.notes, chords: analysis.chords }));
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
  }

  undo(analysis) {
    const snap = this.undoStack.pop();
    if (!snap) return false;
    const { notes, chords } = JSON.parse(snap);
    analysis.notes = notes;
    analysis.chords = chords;
    this.onChange();
    return true;
  }

  /** הזזת גובה התווים של האירוע הנבחר (בחצאי טונים). */
  shiftPitch(analysis, item, delta) {
    const srcs = item?.ev?.srcs || [];
    if (!srcs.length) return false;
    this.snapshot(analysis);
    for (const i of srcs) {
      const n = analysis.notes[i];
      if (n) n.pitch = Math.min(108, Math.max(21, n.pitch + delta));
    }
    this.onChange();
    return true;
  }

  /** מחיקת התווים של האירוע הנבחר. */
  deleteNotes(analysis, item) {
    const srcs = new Set(item?.ev?.srcs || []);
    if (!srcs.size) return false;
    this.snapshot(analysis);
    analysis.notes = analysis.notes.filter((_, i) => !srcs.has(i));
    this.onChange();
    return true;
  }

  /** שינוי משך: delta ביחידות רשת (שמינית/שש-עשרית), משנה את זמן הסיום. */
  changeLength(analysis, score, item, delta) {
    const srcs = item?.ev?.srcs || [];
    if (!srcs.length) return false;
    const q = TPB / score.settings.grid;
    const ev = item.ev;
    const newEnd = Math.max(ev.st + q, ev.en + delta * q);
    this.snapshot(analysis);
    const endTime = score.tickToTime(newEnd) - 0.01;
    for (const i of srcs) {
      const n = analysis.notes[i];
      if (n) n.end = Math.max(n.start + 0.05, endTime);
    }
    // כשמאריכים - מקצרים את מה שהתחיל באמצע (כדי שהתו הארוך יופיע)
    if (delta > 0) {
      const t0 = score.tickToTime(ev.st) + 0.02, t1 = endTime;
      analysis.notes = analysis.notes.filter((n, i) => srcs.includes(i) || !(n.start > t0 && n.start < t1 && n.pitch >= Math.min(...srcs.map((k) => analysis.notes[k]?.pitch ?? 0)) - 12));
    }
    this.onChange();
    return true;
  }

  /** הוספת תו במקום הפסקה (או מעל תו קיים). */
  addNote(analysis, score, item, pitch) {
    this.snapshot(analysis);
    const start = score.tickToTime(item.start) + 0.005;
    const end = score.tickToTime(item.start + item.ticks) - 0.01;
    analysis.notes.push({ start, end: Math.max(start + 0.08, end), pitch, velocity: 0.9 });
    analysis.notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    this.onChange();
    return true;
  }

  /** קביעת אקורד מהמקום הנבחר עד האקורד הבא. root בלי טרנספוזיציה (0-11) או null = בלי אקורד. */
  setChord(analysis, score, tick, root, quality) {
    const names = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
    const mark = score.chords.find((c) => c.tick <= tick && tick < c.end);
    const endTick = mark ? mark.end : (score.chords.find((c) => c.tick > tick)?.tick ?? score.numMeasures * score.measureTicks);
    const b0 = Math.max(0, Math.floor(score.startBeat + tick / TPB + 1e-6));
    const b1 = Math.max(b0 + 1, Math.ceil(score.startBeat + endTick / TPB - 1e-6));
    this.snapshot(analysis);
    for (let b = b0; b < b1; b++) {
      while (analysis.chords.length <= b) analysis.chords.push({ beat: analysis.chords.length, label: 'N', root: null, quality: null });
      analysis.chords[b] = root == null
        ? { beat: b, label: 'N', root: null, quality: null }
        : { beat: b, label: names[root] + quality, root, quality };
    }
    this.onChange();
    return true;
  }
}
