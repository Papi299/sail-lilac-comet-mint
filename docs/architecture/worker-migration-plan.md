# Worker Migration Plan

> **Status: COMPLETED — this is a historical plan, not a live runbook.** Every
> phase below has since been carried out. The current deployment state,
> operating model and phase records are in
> [`worker-deployment-runbook.md`](worker-deployment-runbook.md) (its header and
> §11h). The steps are kept to show how the migration was sequenced, and are
> **not** instructions to repeat.
>
> **Current yt-dlp configuration rules — these supersede the variable named in
> the original plan text:**
>
> - `YTDLP_NETWORK_ISOLATED` must be **absent**. It is retired; its presence at
>   any value, `false` included, is startup-fatal.
> - `YTDLP_PATH` must be **absent**. It is retired and equally startup-fatal.
> - `YTDLP_ENABLED` is the explicit feature switch: absent means disabled,
>   exactly `true` enables generic execution, exactly `false` disables it, and
>   any other spelling is a startup failure.
> - Installing the pinned yt-dlp runtime does not itself authorize generic
>   execution.
> - Safe-egress enforcement is external — the media network namespace, its
>   host-owned nftables policy, the policy verifier and the watchdog — and is
>   never attested by an application environment variable.
> - Production generic execution was enabled, after Phase-9 safe-egress
>   acceptance and the Phase-10D live acceptance, by
>   `PHASE-10E-PERSISTENT-ON-DEMAND-GENERIC-ENABLEMENT-001`.

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
- Generic yt-dlp execution remains disabled. *(The original plan expressed this through the now-retired `YTDLP_NETWORK_ISOLATED` variable, held false; see the current rules above.)*

### 9. Safe-Egress Acceptance Suite
- Run the full egress integration tests (direct-address, redirect, DNS, rebinding, descendant, firewall-mutation, public-success) *from inside* the deployed production worker container.

### 10. Enable yt-dlp Network Execution
- ONLY AFTER Phase 9 passes — and after live acceptance of generic execution — enable it with `YTDLP_ENABLED=true` in the Worker's environment file. *(The original plan named the now-retired `YTDLP_NETWORK_ISOLATED` variable at this step; setting that variable is now startup-fatal.)* **Done:** Phase 10D accepted generic execution live and Phase 10E enabled it persistently.
- `yt-dlp` is now permitted to execute against user-supplied URLs.

---

## Local Development Mode

During transition, local development should remain seamless. *(The first two bullets record transition-era intent; the yt-dlp rules after them are current.)*
- A local start script (`npm run dev`) should spin up both the Vercel dev server and a local worker process concurrently.
- The local worker uses a local SQLite file (e.g., `dev.sqlite`).
- A local Worker leaves `YTDLP_ENABLED` unset, so generic execution stays disabled (fail-closed), and never sets `YTDLP_NETWORK_ISOLATED` or `YTDLP_PATH` — the presence of either, at any value, is startup-fatal.
- Do NOT instruct developers to casually set `YTDLP_ENABLED=true` on a normal home/workstation network: a local Worker has no external safe-egress boundary, and yt-dlp performs its own DNS lookups, redirects and subrequests. If local network testing is eventually needed, it must use a deliberately isolated local container boundary equivalent in intent to production.
