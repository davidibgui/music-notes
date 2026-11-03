"""שרת העיבוד של "תווים לדוד" - רץ ב-Hugging Face Spaces (Docker, מעבד חינמי)."""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import threading

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from analysis import analyze

MAX_UPLOAD_MB = 25
MAX_SECONDS = 360  # 6 דקות

# כתובות שמורשות לפנות לשרת (מופרדות בפסיק). ברירת מחדל: GitHub Pages + פיתוח מקומי
ALLOWED_ORIGINS = os.environ.get(
    "ALLOWED_ORIGINS",
    "https://davidibgui.github.io,http://localhost:8000,http://127.0.0.1:8000",
).split(",")

app = FastAPI(title="Tavim server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in ALLOWED_ORIGINS if o.strip()],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# מעבד חינמי חלש - מעבדים בקשה אחת בכל פעם
_lock = threading.Semaphore(1)


@app.get("/")
@app.get("/health")
def health():
    return {"ok": True}


def _to_wav(src: str, dst: str) -> None:
    """המרה ל-WAV מונו 22050 עם ffmpeg (תומך MP3/M4A/AAC/WEBM/OGG...)."""
    cmd = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-i", src, "-t", str(MAX_SECONDS), "-ac", "1", "-ar", "22050", dst,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if r.returncode != 0 or not os.path.exists(dst):
        raise HTTPException(400, "לא הצלחתי לקרוא את קובץ האודיו. נסו MP3, WAV או M4A.")


@app.post("/analyze")
def analyze_endpoint(file: UploadFile = File(...), sensitivity: float = Form(0.5)):
    tmp = tempfile.mkdtemp(prefix="tavim_")
    try:
        src = os.path.join(tmp, "input")
        size = 0
        with open(src, "wb") as f:
            while chunk := file.file.read(1 << 20):
                size += len(chunk)
                if size > MAX_UPLOAD_MB * 1024 * 1024:
                    raise HTTPException(413, f"הקובץ גדול מדי (מקסימום {MAX_UPLOAD_MB}MB)")
                f.write(chunk)
        if size == 0:
            raise HTTPException(400, "הקובץ ריק")
        wav = os.path.join(tmp, "audio.wav")
        _to_wav(src, wav)
        if not _lock.acquire(timeout=240):
            raise HTTPException(503, "השרת עסוק כרגע, נסו שוב בעוד דקה")
        try:
            return analyze(wav, sensitivity)
        finally:
            _lock.release()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
