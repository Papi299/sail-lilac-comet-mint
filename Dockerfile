FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates curl \
  && pip3 install --no-cache-dir --break-system-packages yt-dlp \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV TEMP_DIRECTORY=/tmp/videofetch
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV YTDLP_PATH=python3 -m yt_dlp

EXPOSE 8080

CMD ["npm", "run", "preview"]
