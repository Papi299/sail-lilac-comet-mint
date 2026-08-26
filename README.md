# VideoFetch

A polished video downloader. Paste a link, pick a quality, and download the file.

VideoFetch analyzes public video pages and direct media URLs, normalizes available formats, then processes the download in a background job. Separate video and audio streams are merged automatically when FFmpeg is available.

## Features

- URL analysis with title, duration, thumbnail, and source
- Simple quality picker plus an advanced format list
- Background jobs with real progress (bytes, speed, ETA)
- MP4 / WebM / audio-only / MP3 conversion
- Temporary files with automatic expiry
- SSRF protections, process-local rate limits, sanitized filenames, and a private-access gate

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
- `npm run check:artifacts` — fail if Git-tracked files exist under `.vercel/`

## Environment

See `.env.example`. Important knobs:

| Variable | Default | Meaning |
| --- | --- | --- |
| `MAX_FILE_SIZE` | 500MB | Reject larger outputs |
| `MAX_VIDEO_DURATION` | 2 hours | Reject longer videos |
| `FILE_EXPIRATION_MINUTES` | 45 | Temporary file lifetime |
| `MAX_CONCURRENT_DOWNLOADS` | 3 | Global worker cap |
| `MAX_CONCURRENT_PER_PRINCIPAL` | 2 | Active downloads per authenticated operator. Process-local. |
| `RATE_LIMIT` | 20/min | Analyze requests per authenticated operator. Process-local. Forwarded-IP headers are not used as identity. |
| `TEMP_DIRECTORY` | OS temp `/videofetch` | Isolated job folders |
| `YTDLP_NETWORK_ISOLATED` | unset / `false` | Operator attestation that yt-dlp has an independent safe-egress boundary. Default is fail-closed. The flag is **not** itself isolation. |
| `VIDEOFETCH_ACCESS_SECRET` | unset | Server-only private-access secret. Minimum 32 UTF-8 bytes. Required in production for downloader APIs; missing/short values fail closed (HTTP 503) instead of exposing the downloader. **`GET /api/diagnostics` requires a configured secret and a valid session in every environment**, including local development — the ordinary development bypass does not apply there. Rotating it invalidates active sessions. Generate with `openssl rand -base64 32`. Never expose via `VITE_*`. |

Analyze/download rate limits and per-operator concurrency are keyed on the private-access principal after a successful gate, not on `X-Forwarded-For` or other client-address headers. Limits are process-local and are not shared across horizontally scaled instances.

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
- `GET /api/diagnostics` (sensitive operator endpoint; requires a configured `VIDEOFETCH_ACCESS_SECRET` and a valid private-access session even in local development)

Local development may omit `VIDEOFETCH_ACCESS_SECRET` for ordinary downloader operations (analyze/download/status/file/sites). Diagnostics never uses that bypass. Production never becomes public merely because the secret was forgotten.

## Docker

The image installs FFmpeg and yt-dlp:

```sh
docker compose up --build
```

Temporary media is written to a tmpfs volume.

## Deployment provenance

`.vercel/` is generated Vercel local/build output and is intentionally not version-controlled.

Production artifacts must be generated from the exact reviewed source commit. Do not treat historical repository-resident `.vercel/output` as deployable source.

A future Vercel deployment must build from source. If a prebuilt deployment workflow is introduced later, that prebuilt output must be freshly generated from the exact approved commit in that workflow.

Production deployment is not currently authorized.

Docker already excludes `.vercel` (see `.dockerignore`) and runs `npm run build` from source inside the image. This repository does not copy generated Vercel output into the image.

`npm run check:artifacts` fails if Git-tracked files appear under `.vercel/`.

## Tests

Unit tests cover URL validation, SSRF helpers, pinned HTTP transport, yt-dlp network policy, temp-directory containment, private-access gating, filename sanitization, format normalization, progress parsing, job status, rate limiting, and error mapping. External downloads are not performed in CI.

## Notes

yt-dlp remains the generic HTTP/HTTPS extractor. It performs its own DNS lookups, redirects, and media requests, so application URL validation is **not** yt-dlp egress enforcement. Generic extraction is therefore refused unless `YTDLP_NETWORK_ISOLATED=true` is set by an operator who has independently isolated yt-dlp's network. Do not enable that flag in this repository's defaults.

Some websites (including YouTube and Vimeo) may require a signed-in session or block datacenter IP addresses. Direct media files and public archive sources are the most reliable. Only download media you have the right to save.
