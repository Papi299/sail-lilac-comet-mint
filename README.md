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
| `YTDLP_ENABLED` | unset (disabled) | Worker-only. Whether generic yt-dlp extraction is enabled. Exactly `true` or `false`; any other spelling is a startup failure. Absent means disabled. Installing the yt-dlp runtime does **not** enable it. The accepted Production Worker sets `YTDLP_ENABLED=true` persistently in `/etc/videofetch/worker.env` (Phase 10E), where it is the operational kill switch. It never controls or attests the network boundary — see `docs/architecture/safe-egress.md`. |
| ~~`YTDLP_NETWORK_ISOLATED`~~ | — | **Retired.** It was an operator attestation, never the boundary. The Worker runtime refuses to start if it is present at any value, `false` included. |
| ~~`YTDLP_PATH`~~ | — | **Retired** for the Worker: it chose the executable and prepended arbitrary leading arguments to every invocation. Also startup-fatal if present. |
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

Production deployments are made only on explicit Product Owner authorization, from a clean worktree at the exact reviewed `main` commit. Vercel Git integration is not connected, so a merge never deploys and Vercel does not attest which commit a deployment was built from: deployment source identity is chain of custody. The current accepted Production deployment is recorded in `docs/architecture/worker-deployment-runbook.md` §11h.

Docker already excludes `.vercel` (see `.dockerignore`) and runs `npm run build` from source inside the image. This repository does not copy generated Vercel output into the image.

`npm run check:artifacts` fails if Git-tracked files appear under `.vercel/`.

## Tests

Unit tests cover URL validation, SSRF helpers, pinned HTTP transport, the pinned yt-dlp runtime policy (closed arguments, closed environment, exact version probe), temp-directory containment, private-access gating, filename sanitization, format normalization, progress parsing, job status, rate limiting, and error mapping. External downloads are not performed in CI.

## Notes

yt-dlp is the generic HTTP/HTTPS extractor. The standalone Worker image ships a **pinned** yt-dlp runtime (exact release, digest-verified at build time, root-owned and read-only, no pip, no self-update), and user-supplied URLs reach it through the Worker's direct-first router: generic extraction was implemented in `PHASE-10C3-YTDLP-GENERIC-EXECUTION-INTEGRATION-001`, accepted live in Phase 10D, and is enabled in Production by `PHASE-10E-PERSISTENT-ON-DEMAND-GENERIC-ENABLEMENT-001`. Generic v1 is deliberately narrow — public, single-item, non-live sources acquired as one progressive HTTP(S) format, with no HLS, DASH or split video+audio merge — so sources outside that scope yield no generic download option. See `docs/architecture/worker-deployment-runbook.md` §4g–§4h.

The reason the boundary matters: yt-dlp performs its own DNS lookups, follows redirects, and issues many subrequests, so application URL validation is **not** yt-dlp egress enforcement. Egress is enforced outside the container by the media network namespace and its host-owned nftables policy — which the Worker cannot read or alter, and therefore cannot attest to. See `docs/architecture/safe-egress.md`.

Some websites (including YouTube and Vimeo) may require a signed-in session or block datacenter IP addresses. Direct media files and public archive sources are the most reliable. Only download media you have the right to save.

## Architecture documents

The standalone-Worker architecture these documents describe is **implemented and deployed**: a Vercel control plane in front of an on-demand Worker reached through Cloudflare Access and a named Tunnel, with durable SQLite job state, externally enforced safe egress, and temporary R2 object storage written through a trusted credential broker. The current deployment state, operating model and phase records are in the Worker Deployment Runbook. The execution-boundary and migration documents also record the pre-migration design and the order the migration was carried out in; those parts are history. An implemented architecture is not a promise that any given site works — see the generic v1 scope under Notes.

- [Worker Deployment Runbook](docs/architecture/worker-deployment-runbook.md) — current state and records
- [Worker Execution Boundary](docs/architecture/worker-execution-boundary.md)
- [Worker API Contract](docs/architecture/worker-api-contract.md)
- [Safe Egress](docs/architecture/safe-egress.md)
- [Migration Plan](docs/architecture/worker-migration-plan.md)
