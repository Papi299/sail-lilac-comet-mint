# Worker API Contract

## Internal Worker Control API

The Vercel web runtime orchestrates jobs by communicating with the external worker via a versioned internal REST API.

**Namespace:** `/v1/...`

### Authentication and Replay Prevention

**Mechanism:** HMAC-SHA256 Request Signing.
The browser private-access cookie is NEVER sent to the worker. Vercel and the Worker share a dedicated `WORKER_CONTROL_SECRET`.

**Signature Generation:**
Vercel generates an HMAC signature using the `WORKER_CONTROL_SECRET` over a string combining:
- HTTP Method
- Canonical Path
- Timestamp (Unix epoch seconds)
- Idempotency Key (if present)
- SHA256 Hash of the request body (or empty string if none)

**Headers:**
- `x-videofetch-timestamp`: Timestamp of the request.
- `x-videofetch-signature`: The HMAC-SHA256 signature (hex-encoded).

**Validation & Replay Prevention (Worker-side):**
- **TLS Requirement:** All control plane traffic must occur over HTTPS.
- **Timestamp Tolerance:** Reject requests where the timestamp is older than 5 minutes or in the future to prevent replay attacks.
- **Constant-time Verification:** Signature comparison must use a constant-time string comparison function (e.g., `crypto.timingSafeEqual`).
- **Body-size limits:** Strict JSON body parsing limits (e.g., 100KB) to prevent memory exhaustion before signature validation.

---

## Endpoints

### 1. Allocate Job
**POST /v1/jobs**
Idempotently creates a new job.
- **Request Body:**
  ```json
  {
    "idempotencyKey": "uuid-v4",
    "url": "https://example.com/video",
    "formatId": "best",
    "principalId": "user-hash"
  }
  ```
- **Idempotency:** If the `idempotencyKey` already exists, the worker returns the existing job state (HTTP 200) instead of creating a duplicate. HTTP 201 for new jobs.
- **Timeout Expectation:** Fast (e.g., < 3s). Only writes to SQLite and returns.
- **Response:** Job Record object.

### 2. Analyze URL
**POST /v1/analyze**
Synchronously analyzes a URL to extract metadata.
- **Request Body:**
  ```json
  {
    "url": "https://example.com/video"
  }
  ```
- **Timeout Expectation:** Moderate (e.g., 45s). Worker runs yt-dlp to extract formats.
- **Response:** Video metadata and format list.

### 3. Get Job Status
**GET /v1/jobs/:jobId**
Retrieves the current status and progress of a job.
- **Response:** Job Record object. Includes `outputPath` if ready.

### 4. Cancel Job
**POST /v1/jobs/:jobId/cancel**
Idempotently cancels a queued or running job.
- **Idempotency:** Repeated calls to cancel an already cancelled job return HTTP 200. Cancelling a `ready` job acts as a deletion request.
- **Response:** Updated Job Record object.

### 5. Diagnostics
**GET /v1/healthz** (Unauthenticated)
- **Response:** Minimal HTTP 200 OK. No sensitive information.

**GET /v1/diagnostics** (Authenticated)
- **Response:** Queue depth, active job counts, safe-egress attestations.

---

## Error Contract

Worker failures must map cleanly into existing user-facing `AppError` semantics. The worker API should return standard HTTP status codes and a JSON error payload.

| Worker Scenario | HTTP Status | AppError Code |
| :--- | :--- | :--- |
| Worker unreachable (Network Error) | N/A (Vercel catches) | `WORKER_UNAVAILABLE` |
| Invalid Signature / Auth | 401 Unauthorized | `WORKER_UNAVAILABLE` |
| Job Not Found | 404 Not Found | `JOB_NOT_FOUND` |
| Invalid URL (yt-dlp fails) | 400 Bad Request | `INVALID_URL` |
| Processing Timeout | 408 Request Timeout | `TIMEOUT` |
| Processing Failed | 500 Internal Error | `PROCESSING_FAILED` |
| Job Expired | 410 Gone | `JOB_EXPIRED` |

The worker must never expose arbitrary filesystem paths or command-line strings in its error responses.
