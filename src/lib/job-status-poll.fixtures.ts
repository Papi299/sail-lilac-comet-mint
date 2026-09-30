import { ClientApiError, NETWORK_API_ERROR_MESSAGE, type PolledJob } from "./client-api.ts";
import { ERROR_MESSAGES, type ErrorCode } from "./errors.ts";
import type { PollClock } from "./job-status-poller.ts";

/**
 * Test support for BROWSER-JOB-STATUS-POLL-RESILIENCE-001: a deterministic
 * clock, job fixtures, and a scripted status endpoint that records how many
 * requests were ever in flight at once.
 */

export const JOB_ID = "0123456789abcdef0123456789abcdef";
export const OTHER_JOB_ID = "fedcba9876543210fedcba9876543210";

/** Lets every pending promise continuation run. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export class FakeClock implements PollClock {
  private current = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  pendingTimers(): number {
    return this.timers.size;
  }

  /** Advances time, firing due timers in order and settling promises between them. */
  async advance(ms: number): Promise<void> {
    const end = this.current + ms;
    await flush();
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.at <= end && timer.at < nextAt) {
          nextId = id;
          nextAt = timer.at;
        }
      }
      if (nextId === null) break;
      const timer = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.current = timer.at;
      timer.callback();
      await flush();
    }
    this.current = end;
    await flush();
  }
}

export function polledJob(status: PolledJob["status"], overrides: Partial<PolledJob> = {}): PolledJob {
  return {
    jobId: JOB_ID,
    status,
    progress: status === "ready" ? 100 : 42,
    stageLabel: status === "ready" ? "Ready" : "Downloading",
    downloadedBytes: 42_000,
    totalBytes: 100_000,
    speed: 1_000,
    eta: 58,
    error: null,
    errorCode: null,
    filename: status === "ready" ? "clip.mp4" : null,
    fileSize: status === "ready" ? 100_000 : null,
    quality: "1080",
    container: "mp4",
    title: "Regression clip",
    thumbnail: "https://img.example/thumb.jpg",
    source: "youtube.com",
    extractor: "yt-dlp",
    createdAt: 1,
    updatedAt: 2,
    expiresAt: 3,
    downloadUrl: status === "ready" ? `/api/download/${overrides.jobId ?? JOB_ID}/file` : null,
    ...overrides,
  };
}

export function apiError(code: ErrorCode | null, status: number): ClientApiError {
  return new ClientApiError({
    kind: "response",
    code,
    status,
    message: code ? ERROR_MESSAGES[code] : "Something went wrong.",
  });
}

export function networkFailure(): ClientApiError {
  return new ClientApiError({ kind: "network", code: null, status: null, message: NETWORK_API_ERROR_MESSAGE });
}

/** One scripted response: a job, a failure, or a request that never answers. */
export type ScriptStep = { latencyMs?: number } & (
  | { job: PolledJob }
  | { error: unknown }
  | { hang: true }
);

/**
 * A status endpoint answering from a script, on the fake clock. It honors the
 * abort signal the way `fetch` does, and tracks concurrency so a test can prove
 * the loop never had two requests outstanding.
 */
export class ScriptedStatus {
  calls: { jobId: string; at: number; signal: AbortSignal }[] = [];
  inFlight = 0;
  maxInFlight = 0;
  aborted = 0;
  private readonly clock: FakeClock;
  private readonly steps: ScriptStep[];
  private readonly fallback: ScriptStep;

  constructor(clock: FakeClock, steps: ScriptStep[], fallback: ScriptStep = { hang: true }) {
    this.clock = clock;
    this.steps = [...steps];
    this.fallback = fallback;
  }

  push(...steps: ScriptStep[]): void {
    this.steps.push(...steps);
  }

  readonly fetchStatus = (jobId: string, signal: AbortSignal): Promise<PolledJob> => {
    this.calls.push({ jobId, at: this.clock.now(), signal });
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    const step = this.steps.shift() ?? this.fallback;
    return new Promise<PolledJob>((resolve, reject) => {
      let done = false;
      const end = (fn: () => void) => {
        if (done) return;
        done = true;
        this.inFlight -= 1;
        fn();
      };
      signal.addEventListener("abort", () => {
        this.aborted += 1;
        end(() => reject(networkFailure()));
      });
      if ("hang" in step) return;
      const answer = () =>
        end(() => ("job" in step ? resolve(step.job) : reject(step.error)));
      if (step.latencyMs) this.clock.setTimeout(answer, step.latencyMs);
      else queueMicrotask(answer);
    });
  };
}
