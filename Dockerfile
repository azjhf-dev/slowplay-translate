FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN pip3 install --break-system-packages --no-cache-dir faster-whisper yt-dlp
RUN python3 -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8')"
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js transcribe_job.py ./
COPY public ./public
ENV PORT=7860 PYTHONUNBUFFERED=1
EXPOSE 7860
CMD ["node", "server.js"]
