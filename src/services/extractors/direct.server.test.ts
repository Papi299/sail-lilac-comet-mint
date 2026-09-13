import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { config } from "../../lib/config.ts";
import { AppError } from "../../lib/errors.ts";
import { setPinnedRequestFactoryForTests, setSafeHttpTestHooks } from "../../lib/security/safe-http.server.ts";
import {
  directExtractor,
  downloadDirectOriginalWorker,
  setDirectDownloadDeadlineTimerForTests,
  type DirectDownloadDeadlineTimer,
} from "./direct.server.ts";

describe("direct extractor response disposal", () => {
  afterEach(() => {
    setSafeHttpTestHooks(null);
    setPinnedRequestFactoryForTests(null);
  });

  async function downloadWithStatus(status: number, body: Readable) {
    setSafeHttpTestHooks({
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      requestOnce: async () => ({
        status,
        headers: { "content-type": "video/mp4" },
        body,
      }),
    });
    return directExtractor.download(
      "https://cdn.example/video.mp4",
      { formatId: "direct-original" },
      { workDir: "/unused-direct-download-workdir" },
    );
  }

  it("disposes a 404 response body before failing", async () => {
    const body = Readable.from([Buffer.from("missing")]);
    await assert.rejects(
      () => downloadWithStatus(404, body),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "VIDEO_UNAVAILABLE");
        return true;
      },
    );
    assert.equal(body.destroyed, true);
  });

  it("disposes a 500 response body before failing", async () => {
    const body = Readable.from([Buffer.from("error")]);
    await assert.rejects(
      () => downloadWithStatus(500, body),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "NETWORK_ERROR");
        return true;
      },
    );
    assert.equal(body.destroyed, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MAX-FILE-SIZE-4GIB-IMPLEMENTATION-001: the absolute direct acquisition deadline
// ─────────────────────────────────────────────────────────────────────────────

describe("direct acquisition absolute deadline", () => {
  const MEDIA_URL = "https://cdn.example/video.mp4";
  let workDir = "";

  /** A recorded, manually fired deadline timer: no wall clock is involved. */
  function fakeDeadline() {
    const armed: Array<{ fire: () => void; ms: number; handle: object }> = [];
    const cleared: unknown[] = [];
    const timer: DirectDownloadDeadlineTimer = {
      set: (onDeadline, ms) => {
        const handle = { armedIndex: armed.length };
        armed.push({ fire: onDeadline, ms, handle });
        return handle;
      },
      clear: (handle) => {
        cleared.push(handle);
      },
    };
    setDirectDownloadDeadlineTimerForTests(timer);
    return { armed, cleared };
  }

  /**
   * A body that never ends and never stalls: one byte per turn of the event
   * loop, far more often than any socket-idle timeout could ever notice.
   */
  function tricklingBody(): Readable {
    return new Readable({
      read() {
        setImmediate(() => {
          this.push(Buffer.from("x"));
        });
      },
    });
  }

  function serve(body: Readable, headers: Record<string, string> = {}) {
    setSafeHttpTestHooks({
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      requestOnce: async () => ({
        status: 200,
        headers: { "content-type": "video/mp4", ...headers },
        body,
      }),
    });
  }

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "direct-deadline-"));
  });

  afterEach(async () => {
    setSafeHttpTestHooks(null);
    setPinnedRequestFactoryForTests(null);
    setDirectDownloadDeadlineTimerForTests(null);
    await rm(workDir, { recursive: true, force: true });
  });

  it("arms exactly one deadline of DOWNLOAD_TIMEOUT (600 s) for the whole transfer", async () => {
    const deadline = fakeDeadline();
    serve(Readable.from([Buffer.from("0123456789")]), { "content-length": "10" });

    const result = await downloadDirectOriginalWorker(MEDIA_URL, { workDir });

    assert.equal(result.fileSize, 10);
    assert.equal(config.downloadTimeoutMs, 600_000, "the default policy value is unchanged");
    assert.equal(deadline.armed.length, 1);
    assert.equal(deadline.armed[0]!.ms, config.downloadTimeoutMs);
  });

  it("an ordinary acquisition still succeeds and disarms its deadline exactly once", async () => {
    const deadline = fakeDeadline();
    for (let run = 0; run < 2; run += 1) {
      serve(Readable.from([Buffer.from("abc"), Buffer.from("def")]));
      const result = await downloadDirectOriginalWorker(MEDIA_URL, { workDir });
      assert.equal(result.fileSize, 6);
      assert.equal(result.container, "mp4");
    }
    // One deadline per acquisition, each cleared on its own settlement: no
    // second deadline remains armed.
    assert.equal(deadline.armed.length, 2);
    assert.deepEqual(deadline.cleared, deadline.armed.map((entry) => entry.handle));

    // A deadline firing after settlement is inert.
    for (const entry of deadline.armed) entry.fire();
  });

  it("aborts with TIMEOUT even while bytes keep arriving, and never re-arms on progress", async () => {
    const deadline = fakeDeadline();
    const body = tricklingBody();
    serve(body);

    let progressEvents = 0;
    const pending = downloadDirectOriginalWorker(MEDIA_URL, {
      workDir,
      onProgress: () => {
        progressEvents += 1;
        // Bytes are flowing continuously; only the ABSOLUTE deadline ends it.
        if (progressEvents === 64) deadline.armed[0]!.fire();
      },
    });

    await assert.rejects(pending, (err: unknown) => {
      assert.ok(err instanceof AppError, String(err));
      assert.equal(err.code, "TIMEOUT");
      return true;
    });
    assert.ok(progressEvents >= 64, `${progressEvents} progress events`);
    assert.equal(deadline.armed.length, 1, "progress must never extend or reset the deadline");
    assert.deepEqual(deadline.cleared, [deadline.armed[0]!.handle]);
    assert.equal(body.destroyed, true, "the response body is destroyed on expiry");
  });

  it("covers the request itself, not only the body", async () => {
    const deadline = fakeDeadline();
    let sawSignal = false;
    setSafeHttpTestHooks({
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      requestOnce: ({ signal }) =>
        new Promise((_resolve, reject) => {
          assert.ok(signal, "the operation signal reaches the request");
          sawSignal = true;
          signal.addEventListener("abort", () => reject(new AppError("NETWORK_ERROR")), { once: true });
          // The server never answers; the deadline fires while waiting.
          setImmediate(() => deadline.armed[0]!.fire());
        }),
    });

    await assert.rejects(downloadDirectOriginalWorker(MEDIA_URL, { workDir }), (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "TIMEOUT");
      return true;
    });
    assert.equal(sawSignal, true);
    assert.deepEqual(deadline.cleared, [deadline.armed[0]!.handle]);
  });

  it("caller cancellation still aborts, is not reported as TIMEOUT, and removes its listener", async () => {
    const deadline = fakeDeadline();
    const body = tricklingBody();
    serve(body);

    const caller = new AbortController();
    const signal = caller.signal;
    let added = 0;
    let removed = 0;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
      if (type === "abort") added += 1;
      add(type, listener, options);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((type: string, listener: EventListener, options?: EventListenerOptions) => {
      if (type === "abort") removed += 1;
      remove(type, listener, options);
    }) as typeof signal.removeEventListener;

    let progressEvents = 0;
    const pending = downloadDirectOriginalWorker(MEDIA_URL, {
      workDir,
      signal,
      onProgress: () => {
        progressEvents += 1;
        if (progressEvents === 16) caller.abort(new AppError("PROCESSING_FAILED", "Job cancelled"));
      },
    });

    await assert.rejects(pending, (err: unknown) => {
      assert.ok(!(err instanceof AppError && err.code === "TIMEOUT"), "a cancellation is not a timeout");
      return true;
    });
    assert.equal(body.destroyed, true);
    assert.equal(added, 1);
    assert.equal(removed, 1, "the caller listener is removed on settlement");
    assert.deepEqual(deadline.cleared, [deadline.armed[0]!.handle]);

    // The deadline firing after a cancellation changes nothing.
    deadline.armed[0]!.fire();
  });

  it("an already-cancelled caller never transfers a body", async () => {
    const deadline = fakeDeadline();
    const body = tricklingBody();
    serve(body);
    const caller = new AbortController();
    caller.abort(new AppError("PROCESSING_FAILED", "Job cancelled"));

    await assert.rejects(downloadDirectOriginalWorker(MEDIA_URL, { workDir, signal: caller.signal }));
    assert.equal(body.destroyed, true);
    assert.deepEqual(deadline.cleared, [deadline.armed[0]!.handle]);
  });
});
