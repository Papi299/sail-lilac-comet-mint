import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { config } from "../../lib/config.ts";
import { AppError } from "../../lib/errors.ts";
import {
  setPinnedRequestFactoryForTests,
  setSafeHttpTestHooks,
  type NodeRequestFactory,
} from "../../lib/security/safe-http.server.ts";
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
    let lookups = 0;
    let requests = 0;
    setSafeHttpTestHooks({
      lookup: async () => {
        lookups += 1;
        return [{ address: "8.8.8.8", family: 4 }];
      },
      requestOnce: async () => {
        requests += 1;
        return { status: 200, headers: { "content-type": "video/mp4" }, body };
      },
    });
    const caller = new AbortController();
    caller.abort(new AppError("PROCESSING_FAILED", "Job cancelled"));

    await assert.rejects(downloadDirectOriginalWorker(MEDIA_URL, { workDir, signal: caller.signal }));
    // Safe-HTTP refuses an aborted operation before resolving or requesting
    // anything, so no body is ever produced — there is nothing to dispose.
    assert.equal(lookups, 0);
    assert.equal(requests, 0);
    assert.deepEqual(deadline.cleared, [deadline.armed[0]!.handle]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MEDIA-EXECUTION-FAILURE-CLASSIFICATION-001: a transport failure after the
// response began is the SOURCE failing — NETWORK_ERROR — not an internal one.
// ─────────────────────────────────────────────────────────────────────────────

describe("direct acquisition transport-failure classification", () => {
  const MEDIA_URL = "https://cdn.example/video.mp4";
  let workDir = "";

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "direct-transport-"));
  });

  afterEach(async () => {
    setSafeHttpTestHooks(null);
    setPinnedRequestFactoryForTests(null);
    await rm(workDir, { recursive: true, force: true });
  });

  /** A body that delivers one chunk, then fails with `err` on the next read. */
  function failingBody(err: Error): Readable {
    let sent = false;
    return new Readable({
      read() {
        if (sent) {
          this.destroy(err);
          return;
        }
        sent = true;
        this.push(Buffer.from("partial-media"));
      },
    });
  }

  function serve(body: Readable) {
    setSafeHttpTestHooks({
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      requestOnce: async () => ({
        status: 200,
        headers: { "content-type": "video/mp4", "content-length": "1000" },
        body,
      }),
    });
  }

  it("a raw mid-body reset is NETWORK_ERROR, with none of the raw text", async () => {
    serve(failingBody(Object.assign(new Error("aborted SECRET_UPSTREAM_TEXT"), { code: "ECONNRESET" })));
    let received = 0;
    await assert.rejects(
      downloadDirectOriginalWorker(MEDIA_URL, {
        workDir,
        onProgress: (p) => {
          received = p.downloadedBytes ?? received;
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "NETWORK_ERROR");
        assert.equal(err.message.includes("SECRET_UPSTREAM_TEXT"), false);
        assert.equal(err.message.includes("ECONNRESET"), false);
        return true;
      },
    );
    assert.ok(received > 0, "the failure happened after the body had started");
  });

  it("an AppError raised on the body keeps its own code", async () => {
    serve(failingBody(new AppError("TOO_LARGE")));
    await assert.rejects(downloadDirectOriginalWorker(MEDIA_URL, { workDir }), (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "TOO_LARGE");
      return true;
    });
  });

  it("a local file-stream failure is NOT reclassified as a network failure", async () => {
    serve(Readable.from([Buffer.from("0123456789")]));
    await assert.rejects(
      downloadDirectOriginalWorker(MEDIA_URL, { workDir: join(workDir, "does-not-exist") }),
      (err: unknown) => {
        assert.equal(err instanceof AppError, false, "a local failure stays internal");
        return true;
      },
    );
  });

  it("a caller cancellation mid-body is not reclassified as a network failure", async () => {
    const caller = new AbortController();
    const body = new Readable({
      read() {
        setImmediate(() => this.push(Buffer.from("x")));
      },
    });
    serve(body);
    let events = 0;
    await assert.rejects(
      downloadDirectOriginalWorker(MEDIA_URL, {
        workDir,
        signal: caller.signal,
        onProgress: () => {
          events += 1;
          if (events === 4) caller.abort(new AppError("PROCESSING_FAILED", "Job cancelled"));
        },
      }),
      (err: unknown) => {
        assert.ok(!(err instanceof AppError && err.code === "NETWORK_ERROR"));
        return true;
      },
    );
  });

  it("a real source that closes its connection mid-body is NETWORK_ERROR", async () => {
    // A real Node HTTP exchange over loopback: the server declares 1000 bytes,
    // sends 10, then ends the connection. TCP delivers the FIN after the data,
    // so the client always sees headers and body bytes before the failure.
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "video/mp4", "content-length": "1000" });
      res.write(Buffer.alloc(10), () => res.socket?.end());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      setSafeHttpTestHooks({ lookup: async () => [{ address: "8.8.8.8", family: 4 }] });
      // Only the destination is redirected to the loopback server; the request
      // otherwise runs through the production pinned-request path.
      const loopback: NodeRequestFactory = (options, callback) => {
        const { agent, lookup, servername, family, ...rest } = options;
        void agent;
        void lookup;
        void servername;
        void family;
        return http.request({ ...rest, protocol: "http:", host: "127.0.0.1", hostname: "127.0.0.1", port }, callback);
      };
      setPinnedRequestFactoryForTests({ https: loopback });

      let received = 0;
      await assert.rejects(
        downloadDirectOriginalWorker(MEDIA_URL, {
          workDir,
          onProgress: (p) => {
            received = p.downloadedBytes ?? received;
          },
        }),
        (err: unknown) => {
          assert.ok(err instanceof AppError, "the raw Node error was classified");
          assert.equal(err.code, "NETWORK_ERROR");
          return true;
        },
      );
      assert.equal(received, 10, "the connection closed mid-body, after the first bytes");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
