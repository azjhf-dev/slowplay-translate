FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js transcribe_job.py ./
COPY public ./public
ENV PORT=7860 PYTHONUNBUFFERED=1
EXPOSE 7860
CMD ["node", "server.js"]
