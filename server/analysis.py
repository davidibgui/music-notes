"""ניתוח אודיו: זיהוי תווים (Basic Pitch), פעמות/טמפו, סולם ואקורדים.

השרת מחזיר נתונים "גולמיים" בשניות ובפעמות. הכימות לתווים, החלוקה לתיבות
והציור נעשים בדפדפן, כך שאפשר לשנות תצוגה/כלי/טרנספוזיציה בלי לפנות שוב לשרת.
"""
from __future__ import annotations

import numpy as np
import librosa

SR = 22050
PITCH_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]

# פרופילי Krumhansl-Kessler לזיהוי סולם
_MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

# תבניות אקורדים (מרווחים מהשורש) ומשקל קדימות (מעדיפים משולשים פשוטים)
_CHORD_QUALITIES = {
    "": ([0, 4, 7], 1.0),       # מז'ור
    "m": ([0, 3, 7], 1.0),      # מינור
    "7": ([0, 4, 7, 10], 0.93),  # דומיננט 7
}


def load_audio(path: str) -> tuple[np.ndarray, int]:
    y, sr = librosa.load(path, sr=SR, mono=True)
    if y.size == 0:
        raise ValueError("קובץ האודיו ריק")
    peak = float(np.max(np.abs(y)))
    if peak > 0:
        y = y / peak * 0.9
    return y, sr


def detect_notes(path: str, sensitivity: float = 0.5) -> list[dict]:
    """Basic Pitch -> רשימת תווים בשניות. sensitivity בין 0 ל-1 (גבוה = יותר תווים)."""
    from basic_pitch.inference import predict
    from basic_pitch import ICASSP_2022_MODEL_PATH

    s = float(np.clip(sensitivity, 0.0, 1.0))
    onset = 0.65 - 0.35 * s      # 0.65..0.30
    frame = 0.40 - 0.20 * s      # 0.40..0.20
    _, _, events = predict(
        path,
        ICASSP_2022_MODEL_PATH,
        onset_threshold=onset,
        frame_threshold=frame,
        minimum_note_length=90,   # מילישניות
        minimum_frequency=librosa.midi_to_hz(28),
        maximum_frequency=librosa.midi_to_hz(100),
        multiple_pitch_bends=False,
        melodia_trick=True,
    )
    notes = [
        {
            "start": round(float(st), 4),
            "end": round(float(en), 4),
            "pitch": int(p),
            "velocity": round(float(a), 3),
        }
        for st, en, p, a, *_ in events
    ]
    notes.sort(key=lambda n: (n["start"], n["pitch"]))
    return remove_overtones(notes)


def remove_overtones(notes: list[dict]) -> list[dict]:
    """הסרת "רפאים": תו חלש שמתחיל יחד עם תו נמוך ממנו באוקטבה/דואודצימה/2 אוקטבות."""
    keep = []
    for n in notes:
        ghost = False
        for m in notes:
            if m is n or abs(m["start"] - n["start"]) > 0.06:
                continue
            if n["pitch"] - m["pitch"] in (12, 19, 24) and n["velocity"] < 0.85 * m["velocity"]:
                ghost = True
                break
        if not ghost:
            keep.append(n)
    return keep


def detect_beats(y: np.ndarray, sr: int) -> tuple[float, list[float]]:
    duration = len(y) / sr
    tempo, frames = librosa.beat.beat_track(y=y, sr=sr, units="frames", trim=False)
    tempo = float(np.atleast_1d(tempo)[0])
    times = librosa.frames_to_time(frames, sr=sr).tolist()
    if len(times) < 4 or tempo <= 0:
        # לא נמצאו פעמות אמינות (למשל נגינה חופשית) - רשת קבועה של 90 BPM
        tempo = 90.0
        times = np.arange(0.0, duration + 60 / tempo, 60 / tempo).tolist()
    # טמפו מעשי: הממוצע של המרווחים בפועל
    tempo = float(60.0 / np.median(np.diff(times)))
    return round(tempo, 1), [round(t, 4) for t in times]


def detect_key(chroma: np.ndarray, notes: list[dict]) -> dict:
    """סולם לפי Krumhansl: שילוב היסטוגרמת התווים (משקל עיקרי) עם הכרומה."""
    hist = np.zeros(12)
    for n in notes:
        hist[n["pitch"] % 12] += (n["end"] - n["start"]) * n["velocity"]
    c = chroma.sum(axis=1)
    profile = np.zeros(12)
    if hist.sum() > 0:
        profile += 0.7 * hist / hist.sum()
    if c.sum() > 0:
        profile += 0.3 * c / c.sum()
    if profile.sum() <= 0:
        return {"tonic": 0, "mode": "major", "name": "C"}
    best = (-2.0, 0, "major")
    for tonic in range(12):
        for mode, ref in (("major", _MAJOR_PROFILE), ("minor", _MINOR_PROFILE)):
            r = float(np.corrcoef(profile, np.roll(ref, tonic))[0, 1])
            if r > best[0]:
                best = (r, tonic, mode)
    _, tonic, mode = best
    return {"tonic": tonic, "mode": mode, "name": PITCH_NAMES[tonic] + ("m" if mode == "minor" else "")}


def _chord_templates() -> tuple[list[str], list[int], list[str], np.ndarray, np.ndarray]:
    labels, roots, quals, mats, weights = [], [], [], [], []
    for root in range(12):
        for q, (ints, w) in _CHORD_QUALITIES.items():
            v = np.zeros(12)
            for i in ints:
                v[(root + i) % 12] = 1.0
            v[root] += 0.5  # השורש חשוב יותר
            labels.append(PITCH_NAMES[root] + q)
            roots.append(root)
            quals.append(q)
            mats.append(v / np.linalg.norm(v))
            weights.append(w)
    return labels, roots, quals, np.array(mats), np.array(weights)


def detect_chords(y: np.ndarray, sr: int, beat_times: list[float]) -> tuple[list[dict], np.ndarray]:
    """אקורד לכל פעמה (כולל N = ללא אקורד), עם החלקה ויטרבי."""
    hop = 512
    y_harm = librosa.effects.harmonic(y, margin=4)
    chroma = librosa.feature.chroma_cqt(y=y_harm, sr=sr, hop_length=hop, bins_per_octave=36)
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]

    n_frames = chroma.shape[1]
    beat_frames = librosa.time_to_frames(beat_times, sr=sr, hop_length=hop)
    beat_frames = np.clip(beat_frames, 0, n_frames)
    bounds = list(beat_frames) + [n_frames]

    labels, roots, quals, T, w = _chord_templates()
    n_states = len(labels) + 1  # + N
    n_beats = len(beat_times)
    probs = np.zeros((n_states, n_beats))
    energy_thr = float(np.percentile(rms, 90)) * 0.08 if rms.size else 0.0

    for b in range(n_beats):
        a, z = bounds[b], max(bounds[b + 1], bounds[b] + 1)
        seg = chroma[:, a:z]
        if seg.size == 0:
            probs[-1, b] = 1.0
            continue
        c = np.median(seg, axis=1)
        e = float(np.mean(rms[a:z])) if z <= rms.size else 0.0
        norm = np.linalg.norm(c)
        if norm <= 1e-6 or e < energy_thr:
            probs[:, b] = 0.02
            probs[-1, b] = 1.0
            probs[:, b] /= probs[:, b].sum()
            continue
        sims = (T @ (c / norm)) * w
        # המרה להסתברויות (softmax חד)
        logits = np.concatenate([sims, [0.55]]) * 18.0
        logits -= logits.max()
        p = np.exp(logits)
        probs[:, b] = p / p.sum()

    probs /= probs.sum(axis=0, keepdims=True)
    trans = librosa.sequence.transition_loop(n_states, 0.75)
    path = librosa.sequence.viterbi_discriminative(probs, trans)

    out = []
    for b, s in enumerate(path):
        if s == n_states - 1:
            out.append({"beat": b, "label": "N", "root": None, "quality": None})
        else:
            out.append({"beat": b, "label": labels[s], "root": roots[s], "quality": quals[s]})
    return out, chroma


def analyze(path: str, sensitivity: float = 0.5) -> dict:
    y, sr = load_audio(path)
    duration = len(y) / sr
    tempo, beats = detect_beats(y, sr)
    chords, chroma = detect_chords(y, sr, beats)
    notes = detect_notes(path, sensitivity)
    key = detect_key(chroma, notes)
    return {
        "version": 1,
        "duration": round(duration, 3),
        "tempo": tempo,
        "beats": beats,
        "key": key,
        "chords": chords,
        "notes": notes,
    }
