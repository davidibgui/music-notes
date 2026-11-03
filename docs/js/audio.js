// הקלטה מהמיקרופון (כולל אייפון/ספארי).
import { MAX_SECONDS as MAX_RECORD_SECONDS } from './analyzer.js';

function pickMime() {
  const types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'];
  if (!window.MediaRecorder) return null;
  for (const t of types) if (MediaRecorder.isTypeSupported?.(t)) return t;
  return '';
}

export class Recorder {
  constructor({ onLevel, onTick, onAutoStop }) {
    Object.assign(this, { onLevel, onTick, onAutoStop });
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      throw new Error('הדפדפן לא תומך בהקלטה. נסו ספארי מעודכן או העלו קובץ.');
    }
    // כיבוי עיבודי "שיחה" שפוגעים בצליל של כלי נגינה
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const mime = pickMime();
    this.mime = mime || 'audio/webm';
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => e.data && e.data.size && this.chunks.push(e.data);
    this.rec.start(1000);
    this.t0 = Date.now();

    const AC = window.AudioContext || window.webkitAudioContext;
    this.ac = new AC();
    const src = this.ac.createMediaStreamSource(this.stream);
    this.an = this.ac.createAnalyser();
    this.an.fftSize = 1024;
    src.connect(this.an);
    const buf = new Float32Array(this.an.fftSize);
    const loop = () => {
      if (!this.rec || this.rec.state !== 'recording') return;
      this.an.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
      const sec = (Date.now() - this.t0) / 1000;
      this.onLevel?.(peak);
      this.onTick?.(sec);
      if (sec >= MAX_RECORD_SECONDS) { this.onAutoStop?.(); return; }
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.rec) return resolve(null);
      cancelAnimationFrame(this.raf);
      this.rec.onstop = () => {
        const type = (this.rec.mimeType || this.mime).split(';')[0];
        const blob = new Blob(this.chunks, { type });
        this.cleanup();
        resolve(blob);
      };
      this.rec.state !== 'inactive' ? this.rec.stop() : this.rec.onstop();
    });
  }

  cleanup() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ac?.close().catch(() => {});
    this.rec = null;
  }
}

export function extFor(type) {
  if (type.includes('mp4') || type.includes('m4a') || type.includes('aac')) return 'm4a';
  if (type.includes('webm')) return 'webm';
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('wav')) return 'wav';
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
  return 'audio';
}
