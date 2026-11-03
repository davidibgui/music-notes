FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

# Hugging Face Spaces מריץ כמשתמש 1000
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user PATH=/home/user/.local/bin:$PATH NUMBA_CACHE_DIR=/tmp/numba
WORKDIR /home/user/app

COPY --chown=user requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt \
    && pip install --no-cache-dir --user --no-deps basic-pitch==0.4.0

COPY --chown=user . .

# חימום: טעינת המודל פעם אחת בזמן הבנייה כדי לבדוק שהכול תקין
RUN python -c "from basic_pitch.inference import Model; from basic_pitch import ICASSP_2022_MODEL_PATH; Model(ICASSP_2022_MODEL_PATH); print('model ok')"

EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860", "--workers", "1"]
