# VideoFetch

A polished video downloader. Paste a link, pick a quality, and download the file.

VideoFetch analyzes public video pages and direct media URLs, normalizes available formats, then processes the download in a background job. Separate video and audio streams are merged automatically when FFmpeg is available.

## Features

- URL analysis with title, duration, thumbnail, and source
- Simple quality picker plus an advanced format list
- Background jobs with real progress (bytes, speed, ETA)
- MP4 / WebM / audio-only / MP3 conversion
- Temporary files with automatic expiry
- SSRF protections, rate limits, sanitized filenames, and a private-access gate

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
| `YTDLP_NETWORK_ISOLATED` | unset / `false` | Operator attestation that yt-dlp has an independent safe-egress boundary. Default is fail-closed. The flag is **not** itself isolation. |
| `VIDEOFETCH_ACCESS_SECRET` | unset | Server-only private-access secret. Minimum 32 UTF-8 bytes. Required in production; missing/short values fail closed (HTTP 503) instead of exposing the downloader. Rotating it invalidates active sessions. Generate with `openssl rand -base64 32`. Never expose via `VITE_*`. |
| `DIAGNOSTICS_TOKEN` | empty | Required for `/diagnostics` in production |

## API

Downloader endpoints require a private-access session cookie except as noted.

- `GET /api/access/session`
- `POST /api/access/login` `{ "secret": "..." }`
- `POST /api/access/logout`
- `POST /api/analyze` `{ "url": "https://..." }`
- `POST /api/download` `{ "url": "...", "formatId": "preset:1080" }`
- `GET /api/download/:jobId/status`
- `GET /api/download/:jobId/file`
- `GET /api/health` (public; for platform health checks)
- `GET /api/sites`

Local development may omit `VIDEOFETCH_ACCESS_SECRET`. Production never becomes public merely because the secret was forgotten.

## Docker

The image installs FFmpeg and yt-dlp:

```sh
docker compose up --build
```

Temporary media is written to a tmpfs volume.

## Tests

Unit tests cover URL validation, SSRF helpers, pinned HTTP transport, yt-dlp network policy, temp-directory containment, private-access gating, filename sanitization, format normalization, progress parsing, job status, rate limiting, and error mapping. External downloads are not performed in CI.

## Notes

yt-dlp remains the generic HTTP/HTTPS extractor. It performs its own DNS lookups, redirects, and media requests, so application URL validation is **not** yt-dlp egress enforcement. Generic extraction is therefore refused unless `YTDLP_NETWORK_ISOLATED=true` is set by an operator who has independently isolated yt-dlp's network. Do not enable that flag in this repository's defaults.

Some websites (including YouTube and Vimeo) may require a signed-in session or block datacenter IP addresses. Direct media files and public archive sources are the most reliable. Only download media you have the right to save.
