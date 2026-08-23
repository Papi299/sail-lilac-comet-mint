# VideoFetch

A polished video downloader. Paste a link, pick a quality, and download the file.

VideoFetch analyzes public video pages and direct media URLs, normalizes available formats, then processes the download in a background job. Separate video and audio streams are merged automatically when FFmpeg is available.

## Features

- URL analysis with title, duration, thumbnail, and source
- Simple quality picker plus an advanced format list
- Background jobs with real progress (bytes, speed, ETA)
- MP4 / WebM / audio-only / MP3 conversion
- Temporary files with automatic expiry
- SSRF protections, rate limits, and sanitized filenames

## Architecture

```text
Frontend (TanStack Start)
  → REST API
    → Extractor registry (sample, direct media, yt-dlp)
      → Job queue / workers
        → FFmpeg processing
          → Temporary storage
            → Secure download URL
```

Extractors implement a shared `MediaExtractor` interface (`canHandle`, `getMetadata`, `getFormats`, `download`) so additional websites can be added without changing the rest of the app.

## Requirements

- Node.js 22
- FFmpeg
- Python 3 with `yt-dlp` (`pip install yt-dlp`)

## Development

```sh
npm install
pip install yt-dlp
cp .env.example .env   # optional; defaults work for local development
npm run dev
```

The app listens on port 8080.

## Scripts

- `npm run dev` — development server
- `npm run build` — production build
- `npm run typecheck` — TypeScript
- `npm test` — unit tests (no live downloads)
- `npm run lint` — ESLint

## Environment

See `.env.example`. Important knobs:

| Variable | Default | Meaning |
| --- | --- | --- |
| `MAX_FILE_SIZE` | 500MB | Reject larger outputs |
| `MAX_VIDEO_DURATION` | 2 hours | Reject longer videos |
| `FILE_EXPIRATION_MINUTES` | 45 | Temporary file lifetime |
| `MAX_CONCURRENT_DOWNLOADS` | 3 | Global worker cap |
| `RATE_LIMIT` | 20/min | Analyze requests per IP |
| `TEMP_DIRECTORY` | OS temp `/videofetch` | Isolated job folders |
| `DIAGNOSTICS_TOKEN` | empty | Required for `/diagnostics` in production |

## API

- `POST /api/analyze` `{ "url": "https://..." }`
- `POST /api/download` `{ "url": "...", "formatId": "preset:1080" }`
- `GET /api/download/:jobId/status`
- `GET /api/download/:jobId/file`
- `GET /api/health`
- `GET /api/sites`

## Docker

The image installs FFmpeg and yt-dlp:

```sh
docker compose up --build
```

Temporary media is written to a tmpfs volume.

## Tests

Unit tests cover URL validation, SSRF helpers, filename sanitization, format normalization, progress parsing, job status, rate limiting, and error mapping. External downloads are not performed in CI.

## Notes

Some websites (including YouTube and Vimeo) may require a signed-in session or block datacenter IP addresses. Direct media files and public archive sources are the most reliable. Only download media you have the right to save.
