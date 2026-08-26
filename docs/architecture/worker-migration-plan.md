# Worker Migration Plan

Moving media processing from the Vercel web runtime to a long-lived external worker is a significant architectural shift. To avoid a "flag day" (a massive, risky single pull request), the migration must be broken into incremental, independently testable phases.

## Phase Strategy

The migration relies on building the worker in parallel with the existing system, then shifting traffic route-by-route. Production must never silently fall back from isolated worker yt-dlp to unisolated web-runtime yt-dlp.

### 1. Shared Worker Protocol & Contracts
Extract data types, config schemas, and job definitions into a `src/shared/` or equivalent directory.
- Define `JobRecord` enhancements (e.g., adding cancellation tracking).
- Define the JSON schemas for the new `/v1/...` worker API.

### 2. Worker HTTP Skeleton & Authentication
Initialize the standalone worker runtime (`src/worker/`).
- Create an Express/Fastify/Hono skeleton.
- Implement the HMAC-SHA256 signature verification middleware using `WORKER_CONTROL_SECRET`.
- Create a dummy `/v1/healthz` endpoint.
- Add `Dockerfile.worker`.

### 3. Durable Worker Job Store (SQLite)
Implement the SQLite database within the worker.
- Replace the in-memory `Map` inside the worker boundary with SQLite tables (Jobs).
- Implement idempotent job creation, status updates, and retrieval.
- Build the `/v1/jobs` and `/v1/jobs/:jobId` endpoints.

### 4. Object Storage Abstraction & Upload
Implement the provider-neutral object storage client in the worker.
- Define the interface (upload, delete, generate signed URL).
- Implement the upload logic inside the worker for completed media.
- Setup the temporary storage lifecycle/TTL rules in the chosen provider.

### 5. Worker Direct-Media Execution (Fail-closed yt-dlp)
Migrate the actual processing logic (`processJob`, `ffmpeg`, `yt-dlp`) into the worker.
- Connect the SQLite job queue to the execution loop.
- `yt-dlp` remains strictly disabled (fail-closed) because the egress boundary is not yet proven.
- Test with direct media URLs and local dummy files.

### 6. Control-Plane Worker Client
Implement the HMAC-signing HTTP client in the Vercel web runtime (`src/web/`).
- The client constructs signed requests to communicate with the worker's `/v1/...` API.
- Add error mapping (translating worker HTTP errors to `AppError`).

### 7. Shift Traffic (Analyze, Download, Status)
Modify the existing Vercel `/api/...` routes to proxy orchestration to the worker.
- `/api/analyze` → calls Worker `/v1/analyze`.
- `/api/downloads` → calls Worker `/v1/jobs`.
- Modify Vercel to generate short-lived signed download URLs via the object storage SDK, redirecting the browser for file delivery.

### 8. Deploy Worker with Safe Egress (yt-dlp disabled)
Deploy the new worker infrastructure (container, persistent volume, egress firewall).
- `YTDLP_NETWORK_ISOLATED` remains `false`.
- Ensure Vercel can reach the worker over HTTPS using `WORKER_CONTROL_SECRET`.

### 9. Safe-Egress Acceptance Suite
Run the egress integration tests *from inside* the deployed production worker container.
- Prove that local, private, metadata, and link-local addresses are unreachable.
- Prove that public HTTPS is reachable.

### 10. Enable yt-dlp Network Execution
Once the egress boundary is proven, configure the environment variable:
- Set `YTDLP_NETWORK_ISOLATED=true` in the worker deployment.
- `yt-dlp` is now permitted to execute against user-supplied URLs.

---

## Local Development Mode

During transition, local development should remain seamless.
- A local start script (`npm run dev`) should spin up both the Vercel dev server and a local worker process concurrently.
- The local worker uses a local SQLite file (e.g., `dev.sqlite`).
- Local object storage can be mocked via the local filesystem or a lightweight S3 clone (like MinIO) if necessary, or simply bypass signed URLs locally.
- The local worker runs with `YTDLP_NETWORK_ISOLATED=false` (fail-closed) unless the developer explicitly overrides it, ensuring they don't accidentally execute untrusted URLs on their home network without isolation.
