# Worker Migration Plan

Moving media processing from the Vercel web runtime to a long-lived external worker is a significant architectural shift. To avoid a "flag day", the migration must be broken into incremental, independently testable phases.

## Phase Strategy

### 1. Shared Worker Protocol & Contracts
- Define the public/control DTOs (`WorkerJobView`, `WorkerJobInternal`).
- Define the JSON schemas for the new `/v1/...` worker API.
- Define the exact HMAC canonical input and `Idempotency-Key` header requirement.
- Establish the worker `ErrorCode` allowlist mapping.

### 2. Worker HTTP Skeleton & Authentication
- Initialize the standalone worker runtime (`src/worker/`).
- Create an Express/Fastify/Hono skeleton.
- Implement the exact sequence for HMAC-SHA256 signature verification (enforce size limits, validate timestamps, verify HMAC, then parse JSON).
- Implement the secret rotation logic handling `WORKER_CONTROL_SECRET`.

### 3. Durable Worker Job Store (SQLite)
- Implement the SQLite database within the worker.
- Create tables for Jobs, Idempotency Records, and Replay-Request Records.
- Implement idempotent job creation (with strict retention periods) and replay protection using the SQLite store.
- Implement atomic terminal-state Check-And-Set (CAS) for robust cancellation race handling.

### 4. Object Storage Abstraction & Upload
- Implement the provider-neutral object storage client in the worker.
- The worker interface is `upload`, `head`, and `delete` ONLY. (Worker does NOT sign download URLs).
- Setup the temporary storage lifecycle/TTL rules in the chosen provider to act as a safety backstop.
- Establish worker expiration cleanup using the exact `objectKey`.

### 5. Control-Plane Client & Storage Signing
- Implement the HMAC-signing HTTP client in the Vercel web runtime (`src/web/`).
- Implement the object-storage signing logic in Vercel (`signGet`) ensuring Content-Disposition guarantees.
- Enforce strict signed URL expiry bounding (`signedUrlExpiresAt <= job.expiresAt`).
- Add error mapping (translating worker HTTP errors to `AppError`).

### 6. Worker Direct-Media Execution (Fail-closed yt-dlp)
- Migrate the actual processing logic (`processJob`, `ffmpeg`, `yt-dlp`) into the worker.
- Connect the SQLite job queue to the execution loop.
- Implement conditional writes so cancelled states cannot transition to ready, and handle cancel/upload race cleanup.
- `yt-dlp` remains strictly disabled (fail-closed).

### 7. Shift Traffic (Analyze, Download, Status)
- Modify the existing Vercel `/api/...` routes to proxy orchestration to the worker.
- Vercel `/api/download/:jobId/file` strips the `objectKey`, generates the short-lived signed URL, and redirects.

### 8. Deploy Worker with Safe Egress (yt-dlp disabled)
- Deploy the new worker infrastructure (container, persistent volume).
- Apply the externally owned egress policy (e.g., host-level `nftables`).
- `YTDLP_NETWORK_ISOLATED` remains `false`.

### 9. Safe-Egress Acceptance Suite
- Run the full egress integration tests (direct-address, redirect, DNS, rebinding, descendant, firewall-mutation, public-success) *from inside* the deployed production worker container.

### 10. Enable yt-dlp Network Execution
- ONLY AFTER Phase 9 passes, configure `YTDLP_NETWORK_ISOLATED=true` in the worker deployment.
- `yt-dlp` is now permitted to execute against user-supplied URLs.

---

## Local Development Mode

During transition, local development should remain seamless.
- A local start script (`npm run dev`) should spin up both the Vercel dev server and a local worker process concurrently.
- The local worker uses a local SQLite file (e.g., `dev.sqlite`).
- The local worker runs with `YTDLP_NETWORK_ISOLATED=false` (fail-closed).
- Do NOT instruct developers to casually override `YTDLP_NETWORK_ISOLATED=true` on a normal home/workstation network. If local network testing is eventually needed, it must use a deliberately isolated local container boundary equivalent in intent to production.
