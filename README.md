# VideoFetch

A polished video downloader. Paste a link, pick a quality, and download the file.

VideoFetch analyzes direct media URLs and eligible public video pages, offers application-owned quality presets, and runs each download as a durable background job on a standalone Worker; the finished file is kept briefly in private object storage and delivered through a short-lived signed link. Generic pages are handled by a deliberately narrow path: yt-dlp analyzes them and downloads only progressive HTTP(S) media, and it never merges, remuxes or post-processes anything (see *Generic v1 scope* below).

## Features

- URL analysis with title, duration, thumbnail, and source
- Simple quality picker plus an advanced format list
- Background jobs with real progress (bytes, speed, ETA)
- MP4 / WebM / audio-only / MP3 conversion
- Temporary files with automatic expiry
- SSRF protections, process-local rate limits, sanitized filenames, and a private-access gate

## Architecture

```text
Private browser
  → Vercel control plane      private-access gate, request validation,
                              HMAC-signed Worker calls, signed R2 GETs
  → Cloudflare Access + named Tunnel
  → standalone Worker         on-demand Lima VM
      → SQLite durable job state
      → direct-first analysis and acquisition
      → generic yt-dlp fallback, when the URL is eligible
      → Worker processing     its own FFmpeg, where a preset needs it
      → temporary R2 object   per-operation credentials from a host broker
  → Vercel signed download    short-lived GET; the object then expires
```

The control plane never runs media work: when the Worker is unreachable it fails closed with `WORKER_UNAVAILABLE`, and it never falls back to local processing. The Worker runs on demand — while its VM is stopped the downloader is offline by design. Media egress is confined by an external safe-egress boundary (a media network namespace, a host-owned nftables policy and a watchdog) that the Worker cannot read or alter. The current deployment state and operating model are in [`docs/architecture/worker-deployment-runbook.md`](docs/architecture/worker-deployment-runbook.md).

**Generic v1 scope.** Generic extraction covers public, single-item, non-live sources. It offers only application-owned presets (`preset:best`, `preset:1080`, `preset:720`, …) — never raw upstream format ids, and there is no HLS-specific public format vocabulary. Current source can back a generic video preset in three ways:

- **progressive HTTP(S)** — one format, downloaded by yt-dlp;
- an approved **split pair** — a video-only + an audio-only stream, each over progressive HTTP(S), downloaded by yt-dlp and merged locally by the Worker's own FFmpeg;
- **clear-HLS v1** — a deliberately narrow HLS path: exactly yt-dlp's `m3u8_native` protocol, a clear (unencrypted), finite VOD media playlist of MPEG-TS segments, and video with proven audio in one rendition. yt-dlp only *discovers* such a rendition during analysis. **VideoFetch itself** preflights the playlist and fetches the segments, and the Worker remuxes TS → MP4 (stream copy) only after the job has entered `processing`.

yt-dlp's own download allowlist is still exactly `http`/`https`; clear HLS was added without widening it. Everything else is unsupported and fails closed. Segmented DASH yields no generic video option. HLS outside the clear-HLS v1 subset — live, encrypted or DRM-protected, fMP4, byte-range, with discontinuities, or relying on a separate audio rendition — is either never offered or, when only the media playlist reveals it, refused at download time before any segment is fetched. Renditions that are not offered can still be reported as withheld (`unsupported_protocol`) in the informational `sourceQuality`.

**Deployment state.** Progressive and split-pair acquisition are live in Production (split pairs since 2026-09-13, runbook §11h). **Clear-HLS v1 is live in the Production Worker** since 2026-09-26: HLS-10 promoted the qualified release candidate and accepted it on a real public HLS source (runbook §4j). It remains deliberately narrow: `m3u8_native` discovery only, a clear VOD MPEG-TS media playlist, one rendition with proven video and audio, VideoFetch-owned HLS acquisition, and a Worker stream-copy remux only after the job has entered `processing`. Segmented DASH and every HLS shape outside that subset remain unavailable.

The `src/services/` extractor registry (`MediaExtractor`) and in-process download manager are the pre-migration design. They remain in the repository, and the Worker reuses some of their lower-level helpers, but they are not the Production execution path: `src/web/boundary/control-plane-boundary.test.ts` bars the browser-facing API from reaching them.

## Requirements

- **Web control plane and tests:** Node.js 22 and npm. No local FFmpeg, Python or yt-dlp is needed to run the web control plane, and `npm test` does not require FFmpeg or yt-dlp.
- **Worker:** built from `Dockerfile.worker`, which ships its own FFmpeg, Python 3 and a digest-pinned yt-dlp runtime — nothing is installed with `pip`. It runs on the Lima VM behind its R2 credential broker and safe-egress boundary; see `deploy/README.md` and the runbook.

## Development

```sh
npm install
npm run dev
```

`npm run dev` starts **only the web control plane** — the Vite dev server on port 8080. The UI loads, but every downloader request fails closed with `WORKER_UNAVAILABLE` until the control plane can reach a Worker: `WORKER_BASE_URL`, `WORKER_CONTROL_KEY_ID` and `WORKER_CONTROL_SECRET` must be present in its environment, plus `CLOUDFLARE_ACCESS_CLIENT_ID` / `CLOUDFLARE_ACCESS_CLIENT_SECRET` when the Worker sits behind Cloudflare Access, and the `R2_*` location and signer variables for the final download. `.env.example` documents every variable.

The repository does **not** provide a local end-to-end Worker workflow. No script starts a Worker; the Worker image is deployed together with its R2 credential broker and its external safe-egress boundary (`deploy/README.md`), and generic yt-dlp execution must never be enabled on a Worker that lacks that boundary. End-to-end behaviour is exercised against the deployed stack; locally, `npm test` exercises both runtimes without any external download.

## Scripts

- `npm run dev` — development server for the web control plane only (no Worker)
- `npm run build` — production build
- `npm run typecheck` — TypeScript
- `npm test` — unit tests (no live downloads)
- `npm run lint` — ESLint
- `npm run check:artifacts` — fail if Git-tracked files exist under `.vercel/`

## Environment

See `.env.example`. Important knobs:

| Variable | Default | Meaning |
| --- | --- | --- |
| `MAX_FILE_SIZE` | 4 GiB (4,294,967,296 bytes) | Reject delivered outputs larger than this. A capacity contract as well as a limit — see *Large files* below. |
| `MAX_VIDEO_DURATION` | 2 hours | Reject longer videos |
| `FILE_EXPIRATION_MINUTES` | 45 | Temporary file lifetime |
| `MAX_CONCURRENT_DOWNLOADS` | 3 | Cap of the legacy in-process download manager. The standalone Worker executes one job at a time regardless. |
| `MAX_CONCURRENT_PER_PRINCIPAL` | 2 | Active downloads per authenticated operator. Process-local. |
| `RATE_LIMIT` | 20/min | Analyze requests per authenticated operator. Process-local. Forwarded-IP headers are not used as identity. |
| `TEMP_DIRECTORY` | OS temp `/videofetch` | Isolated job folders |
| `YTDLP_ENABLED` | unset (disabled) | Worker-only. Whether generic yt-dlp extraction is enabled. Exactly `true` or `false`; any other spelling is a startup failure. Absent means disabled. Installing the yt-dlp runtime does **not** enable it. The accepted Production Worker sets `YTDLP_ENABLED=true` persistently in `/etc/videofetch/worker.env` (Phase 10E), where it is the operational kill switch. It never controls or attests the network boundary — see `docs/architecture/safe-egress.md`. |
| ~~`YTDLP_NETWORK_ISOLATED`~~ | — | **Retired.** It was an operator attestation, never the boundary. The Worker runtime refuses to start if it is present at any value, `false` included. |
| ~~`YTDLP_PATH`~~ | — | **Retired** for the Worker: it chose the executable and prepended arbitrary leading arguments to every invocation. Also startup-fatal if present. |
| `VIDEOFETCH_ACCESS_SECRET` | unset | Server-only private-access secret. Minimum 32 UTF-8 bytes. Required in production for downloader APIs; missing/short values fail closed (HTTP 503) instead of exposing the downloader. **`GET /api/diagnostics` requires a configured secret and a valid session in every environment**, including local development — the ordinary development bypass does not apply there. Rotating it invalidates active sessions. Generate with `openssl rand -base64 32`. Never expose via `VITE_*`. |

Analyze/download rate limits and per-operator concurrency are keyed on the private-access principal after a successful gate, not on `X-Forwarded-For` or other client-address headers. Limits are process-local and are not shared across horizontally scaled instances.

**Large files.** The delivered-file ceiling is 4 GiB, and it is a capacity contract as well as a limit:

- The Worker executes one job at a time. A job keeps its original and its produced file side by side (or both split halves and the merge), so it can need up to **8 GiB** of local media space. The Worker refuses to start unless its media workspace can hold that. In Production the workspace is a bounded **10 GiB disk-backed ext4 filesystem**, not a memory-backed tmpfs (`deploy/README.md`, runbook §2a).
- Size is not the only bound. Every acquisition — direct or generic — must finish within `DOWNLOAD_TIMEOUT` (600 s, absolute), so a 4 GiB file needs roughly 57 Mbit/s of sustained download. Local processing and the job's `FILE_EXPIRATION_MINUTES` lifetime are separate bounds too. Completion at arbitrary bandwidth is not guaranteed; a transfer that is too slow fails as `TIMEOUT`.
- The finished file is stored with **one single-part upload**, which 4 GiB fits under the object store's single-part limit. There is no multipart upload and no upload resume; a failed upload fails the job. The browser downloads the file directly from object storage through a short-lived signed link — the control plane never proxies it.

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

`docker compose up --build` builds the root `Dockerfile`, which is the **legacy single-runtime image**. It serves the web app with `npm run preview` on port 8080; the FFmpeg and system yt-dlp it installs belong to the pre-migration in-process stack, which the browser-facing API no longer reaches. As configured it provides no `VIDEOFETCH_ACCESS_SECRET` and no Worker variables, so its downloader APIs fail closed. It is **not** the Worker image — that is `Dockerfile.worker`, deployed as described in `deploy/README.md`.

## Deployment provenance

`.vercel/` is generated Vercel local/build output and is intentionally not version-controlled.

Production artifacts must be generated from the exact reviewed source commit. Do not treat historical repository-resident `.vercel/output` as deployable source.

A future Vercel deployment must build from source. If a prebuilt deployment workflow is introduced later, that prebuilt output must be freshly generated from the exact approved commit in that workflow.

Production deployments are made only on explicit Product Owner authorization, from a clean worktree at the exact reviewed `main` commit. Vercel Git integration is not connected, so a merge never deploys and Vercel does not attest which commit a deployment was built from: deployment source identity is chain of custody. The current accepted Production deployment is recorded in `docs/architecture/worker-deployment-runbook.md` §11h.

Docker already excludes `.vercel` (see `.dockerignore`) and runs `npm run build` from source inside the image. This repository does not copy generated Vercel output into the image.

`npm run check:artifacts` fails if Git-tracked files appear under `.vercel/`.

## Tests

Unit tests cover URL validation, SSRF helpers, pinned HTTP transport, the pinned yt-dlp runtime policy (closed arguments, closed environment, exact version probe), temp-directory containment, private-access gating, filename sanitization, format normalization, progress parsing, job status, rate limiting, and error mapping. The tests never perform external downloads. The repository has no CI; run the suites locally.

## Notes

yt-dlp is the generic HTTP/HTTPS extractor. The standalone Worker image ships a **pinned** yt-dlp runtime (exact release, digest-verified at build time, root-owned and read-only, no pip, no self-update), and user-supplied URLs reach it through the Worker's direct-first router: generic extraction was implemented in `PHASE-10C3-YTDLP-GENERIC-EXECUTION-INTEGRATION-001`, accepted live in Phase 10D, and is enabled in Production by `PHASE-10E-PERSISTENT-ON-DEMAND-GENERIC-ENABLEMENT-001`. Generic v1 is deliberately narrow — public, single-item, non-live sources acquired as one progressive HTTP(S) format, as a video-only + audio-only pair merged locally (deployed 2026-09-13, §11h), or through the clear-HLS v1 path, which VideoFetch acquires itself rather than yt-dlp (deployed 2026-09-26 by HLS-10, §4j). There is no DASH acquisition and no HLS acquisition outside clear-HLS v1, so sources outside that scope yield no generic download option. See `docs/architecture/worker-deployment-runbook.md` §4g–§4h and §4j.

The reason the boundary matters: yt-dlp performs its own DNS lookups, follows redirects, and issues many subrequests, so application URL validation is **not** yt-dlp egress enforcement. Egress is enforced outside the container by the media network namespace and its host-owned nftables policy — which the Worker cannot read or alter, and therefore cannot attest to. See `docs/architecture/safe-egress.md`.

Some websites (including YouTube and Vimeo) may require a signed-in session or block datacenter IP addresses. Direct media files and public archive sources are the most reliable. Only download media you have the right to save.

## Architecture documents

The standalone-Worker architecture these documents describe is **implemented and deployed**: a Vercel control plane in front of an on-demand Worker reached through Cloudflare Access and a named Tunnel, with durable SQLite job state, externally enforced safe egress, and temporary R2 object storage written through a trusted credential broker. The current deployment state, operating model and phase records are in the Worker Deployment Runbook. The execution-boundary and migration documents also record the pre-migration design and the order the migration was carried out in; those parts are history. An implemented architecture is not a promise that any given site works — see the generic v1 scope under Notes.

- [Worker Deployment Runbook](docs/architecture/worker-deployment-runbook.md) — current state and records
- [Worker Execution Boundary](docs/architecture/worker-execution-boundary.md)
- [Worker API Contract](docs/architecture/worker-api-contract.md)
- [Safe Egress](docs/architecture/safe-egress.md)
- [Migration Plan](docs/architecture/worker-migration-plan.md)
