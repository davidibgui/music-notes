// יצוא PDF בדפדפן: כל עמוד מצויר על Canvas ברזולוציה גבוהה ומוכנס ל-jsPDF.
import { layoutSystems, drawSystems, systemHeight, chordDiagramsHeight, drawChordDiagrams } from './render.js';

const PAGE_W = 794;   // A4 ב-96DPI
const PAGE_H = 1123;
const SCALE = 2.5;
const MARGIN_TOP = 40;

function newPage() {
  const F = window.Vex.Flow;
  // גודל קבוע (בלי devicePixelRatio) כדי לא לחרוג ממגבלת ה-Canvas באייפון
  const canvas = document.createElement('canvas');
  canvas.width = PAGE_W * SCALE;
  canvas.height = PAGE_H * SCALE;
  const renderer = new F.Renderer(canvas, F.Renderer.Backends.CANVAS);
  const ctx = renderer.getContext();
  const raw = canvas.getContext('2d');
  raw.setTransform(1, 0, 0, 1, 0, 0);
  raw.fillStyle = '#fff';
  raw.fillRect(0, 0, canvas.width, canvas.height);
  // חשוב: להחזיר צבע שחור, אחרת VexFlow מצייר את הסמלים בלבן
  raw.fillStyle = '#000';
  raw.strokeStyle = '#000';
  raw.setTransform(SCALE, 0, 0, SCALE, 0, 0);
  return { canvas, ctx, raw };
}

// VexFlow מנקה (clearRect) רקע מאחורי מספרי הטאבים => שקוף => שחור ב-JPEG. מדביקים על לבן.
function flatten(canvas) {
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const c = out.getContext('2d');
  c.fillStyle = '#fff';
  c.fillRect(0, 0, out.width, out.height);
  c.drawImage(canvas, 0, 0);
  return out;
}

function header(raw, title, info) {
  raw.save();
  raw.fillStyle = '#111';
  raw.textAlign = 'center';
  raw.direction = 'rtl';
  raw.font = 'bold 26px Arial, sans-serif';
  raw.fillText(title || 'שיר ללא שם', PAGE_W / 2, 52);
  raw.font = '14px Arial, sans-serif';
  raw.fillStyle = '#444';
  raw.fillText(info, PAGE_W / 2, 78);
  raw.restore();
  return 96;
}

function footer(raw, pageNo, total) {
  raw.save();
  raw.fillStyle = '#888';
  raw.textAlign = 'center';
  raw.font = '11px Arial, sans-serif';
  raw.fillText(`${pageNo} / ${total}`, PAGE_W / 2, PAGE_H - 20);
  raw.restore();
}

export async function exportPdf(score, { title, info, fileName }) {
  const width = PAGE_W - 40;
  const systems = layoutSystems(score, width);
  const sysH = systemHeight(score);
  const diagH = chordDiagramsHeight(score, width);

  // חלוקה לעמודים
  const pages = [];
  let page = { systems: [], diagrams: true };
  let used = 96 + diagH;
  for (const s of systems) {
    if (used + sysH > PAGE_H - 50 && page.systems.length) {
      pages.push(page);
      page = { systems: [], diagrams: false };
      used = MARGIN_TOP;
    }
    page.systems.push(s);
    used += sysH;
  }
  pages.push(page);

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4', compress: true });
  const pw = doc.internal.pageSize.getWidth();
  const ph = doc.internal.pageSize.getHeight();

  pages.forEach((pg, i) => {
    const { canvas, ctx, raw } = newPage();
    let y = MARGIN_TOP;
    if (i === 0) {
      y = header(raw, title, info);
      y = drawChordDiagrams(ctx, score, width, y);
    }
    // הזזה אופקית קטנה לשוליים
    ctx.save();
    raw.translate(20, 0);
    drawSystems(ctx, score, pg.systems, y);
    raw.translate(-20, 0);
    ctx.restore();
    footer(raw, i + 1, pages.length);
    if (i > 0) doc.addPage();
    doc.addImage(flatten(canvas).toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pw, ph, undefined, 'FAST');
  });

  const name = (fileName || title || 'notes').replace(/[\\/:*?"<>|]+/g, '_') + '.pdf';
  const blob = doc.output('blob');
  return { blob, name };
}
