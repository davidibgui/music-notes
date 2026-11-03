// דיאגרמות אקורדים לגיטרה. מיתרים 6 (מי נמוך) עד 1. -1 = לא מנגנים.

const OPEN_SHAPES = {
  'C': [-1, 3, 2, 0, 1, 0], 'C7': [-1, 3, 2, 3, 1, 0],
  'D': [-1, -1, 0, 2, 3, 2], 'Dm': [-1, -1, 0, 2, 3, 1], 'D7': [-1, -1, 0, 2, 1, 2],
  'E': [0, 2, 2, 1, 0, 0], 'Em': [0, 2, 2, 0, 0, 0], 'E7': [0, 2, 0, 1, 0, 0],
  'G': [3, 2, 0, 0, 0, 3], 'G7': [3, 2, 0, 0, 0, 1],
  'A': [-1, 0, 2, 2, 2, 0], 'Am': [-1, 0, 2, 2, 1, 0], 'A7': [-1, 0, 2, 0, 2, 0],
  'B7': [-1, 2, 1, 2, 0, 2],
};

// צורות "בארה" יחסיות לסריג השורש
const E_SHAPE = { '': [0, 2, 2, 1, 0, 0], 'm': [0, 2, 2, 0, 0, 0], '7': [0, 2, 0, 1, 0, 0] };
const A_SHAPE = { '': [-1, 0, 2, 2, 2, 0], 'm': [-1, 0, 2, 2, 1, 0], '7': [-1, 0, 2, 0, 2, 0] };

const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** מחזיר {frets:[6 ערכים], barre: fret|null} */
export function guitarShape(root, quality) {
  const q = quality || '';
  const name = SHARP[root] + q;
  if (OPEN_SHAPES[name]) return { frets: OPEN_SHAPES[name], barre: null };
  const eFret = (root - 4 + 12) % 12 || 12;
  const aFret = (root - 9 + 12) % 12 || 12;
  const useE = eFret <= aFret;
  const base = useE ? eFret : aFret;
  const shape = (useE ? E_SHAPE : A_SHAPE)[q] || (useE ? E_SHAPE : A_SHAPE)[''];
  return { frets: shape.map((f) => (f < 0 ? -1 : f + base)), barre: base };
}

/** ציור דיאגרמה עם RenderContext של VexFlow (עובד גם ב-SVG וגם ב-Canvas). */
export function drawChordDiagram(ctx, x, y, label, root, quality) {
  const { frets, barre } = guitarShape(root, quality);
  const played = frets.filter((f) => f > 0);
  const minF = played.length ? Math.min(...played) : 1;
  const maxF = played.length ? Math.max(...played) : 1;
  const start = maxF <= 4 ? 1 : minF;
  const sw = 11, fh = 13, nFrets = 4;
  const w = sw * 5, h = fh * nFrets;
  const gx = x + 12, gy = y + 30;

  ctx.save();
  ctx.setFillStyle('#111');
  ctx.setStrokeStyle('#111');
  ctx.setFont('Arial', 14, 'bold');
  const tw = label.length * 8.5;
  ctx.fillText(label, gx + w / 2 - tw / 2, y + 12);

  ctx.setLineWidth(1);
  for (let s = 0; s < 6; s++) {
    ctx.beginPath(); ctx.moveTo(gx + s * sw, gy); ctx.lineTo(gx + s * sw, gy + h); ctx.stroke();
  }
  for (let f = 0; f <= nFrets; f++) {
    ctx.beginPath(); ctx.moveTo(gx, gy + f * fh); ctx.lineTo(gx + w, gy + f * fh); ctx.stroke();
  }
  if (start === 1) {
    ctx.fillRect(gx - 0.5, gy - 3, w + 1, 3);
  } else {
    ctx.setFont('Arial', 10, 'normal');
    ctx.fillText(String(start), gx - 12, gy + fh * 0.75);
  }
  ctx.setFont('Arial', 9, 'normal');
  frets.forEach((f, i) => {
    const sx = gx + i * sw;
    if (f < 0) {
      ctx.fillText('×', sx - 3, gy - 5);
    } else if (f === 0) {
      ctx.beginPath(); ctx.arc(sx, gy - 8, 3, 0, Math.PI * 2, false); ctx.stroke();
    }
  });
  if (barre && barre >= start) {
    const by = gy + (barre - start + 0.5) * fh;
    const first = frets.findIndex((f) => f === barre);
    if (first >= 0) ctx.fillRect(gx + first * sw - 3, by - 3, (5 - first) * sw + 6, 6);
  }
  frets.forEach((f, i) => {
    if (f <= 0) return;
    const by = gy + (f - start + 0.5) * fh;
    ctx.beginPath(); ctx.arc(gx + i * sw, by, 4, 0, Math.PI * 2, false); ctx.fill();
  });
  ctx.restore();
  return { width: w + 30, height: h + 40 };
}
