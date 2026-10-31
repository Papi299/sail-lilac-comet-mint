import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import diagnosticsChannel from "node:diagnostics_channel";
import type { Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { S3Client } from "@aws-sdk/client-s3";
import {
  CloudflareR2Error,
  CloudflareR2ObjectStoreWriter,
  R2_TRANSPORT_POLICY,
  buildR2S3ClientConfig,
  type R2TransportBounds,
} from "./cloudflare-r2-writer.server.ts";
import { startStubS3Server, type StubMode, type StubS3Server } from "./r2-stub-server.fixtures.ts";
import type { WorkerObjectKey } from "../../shared/worker/contracts.ts";

/**
 * VIDEOFETCH-LD2B-BOUNDED-CANCELLABLE-UPLOAD-001 — the R2 transport, for real.
 *
 * Every test here drives the PRODUCTION writer through the REAL AWS SDK and its
 * REAL Node request handler, configured by the production
 * `buildR2S3ClientConfig`, over a REAL socket to a synthetic S3 endpoint on the
 * loopback interface (`r2-stub-server.fixtures.ts`). The only differences from
 * Production are the endpoint (loopback, path-style) and two narrowed timing
 * bounds, so a stall is proved in milliseconds instead of minutes. A rejected
 * promise is never accepted as proof on its own: each test also checks, from
 * the server's side, that the request really ended, and from the body's side,
 * that no further byte was read.
 *
 * Fake credentials only. Nothing leaves the test process.
 */

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const BUCKET = "videofetch-objects";
const KEY = `videofetch/jobs/${"a".repeat(32)}/${"b".repeat(32)}` as WorkerObjectKey;
const CREDENTIALS = {
  accessKeyId: "fake-delegated-key-id",
  secretAccessKey: "fake-delegated-secret",
  sessionToken: "fake-session-token",
};
/** Narrowed bounds: a stall is proved in well under a second. */
const NARROW: R2TransportBounds = { connectionTimeoutMs: 300, socketIdleTimeoutMs: 400 };
const MIB = 1024 * 1024;

type Harness = { stub: StubS3Server; writer: CloudflareR2ObjectStoreWriter };

/** The production writer over the production client configuration, pointed at the stub. */
function writerFor(endpoint: string, transport: R2TransportBounds = NARROW, agentOptions: object = {}) {
  // A fresh copy each time: the SDK tags the credentials object it is handed
  // (`$source`), which the strict R2 configuration would then refuse.
  const base = buildR2S3ClientConfig({ endpoint, credentials: { ...CREDENTIALS }, transport });
  const handler = base.requestHandler as Record<string, unknown>;
  const client = new S3Client({
    ...base,
    forcePathStyle: true,
    requestHandler: {
      ...handler,
      httpAgent: { ...(handler.httpAgent as object), ...agentOptions },
    },
  });
  return new CloudflareR2ObjectStoreWriter(
    { accountId: ACCOUNT_ID, bucket: BUCKET, ...CREDENTIALS },
    client,
  );
}

async function harness(mode?: (ordinal: number, method: string) => StubMode): Promise<Harness> {
  const stub = await startStubS3Server({
    bucket: BUCKET,
    ...(mode ? { mode: (exchange) => mode(exchange.ordinal, exchange.method) } : {}),
  });
  try {
    return { stub, writer: writerFor(stub.endpoint) };
  } catch (error) {
    await stub.close();
    throw error;
  }
}

/** A body that counts every byte it hands out and records when it is closed. */
function countingBody(total: number, chunk = 64 * 1024) {
  const state = { produced: 0, closed: false };
  async function* generate() {
    try {
      while (state.produced < total) {
        const n = Math.min(chunk, total - state.produced);
        state.produced += n;
        yield new Uint8Array(n);
      }
    } finally {
      state.closed = true;
    }
  }
  return { state, body: generate() };
}

function putInput(body: AsyncIterable<Uint8Array>, contentLength: number) {
  return {
    objectKey: KEY,
    body,
    contentLength,
    contentType: "video/mp4",
    contentDisposition: 'attachment; filename="clip.mp4"',
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await sleep(5);
  }
}

/**
 * Awaits `promise` and returns how it settled and how long that took — or
 * fails the test, rather than hanging the runner, if it never settles.
 */
async function settle<T>(promise: Promise<T>, label: string, timeoutMs = 5_000) {
  const start = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      promise.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`never settled: ${label}`)), timeoutMs);
      }),
    ]);
    return { ...outcome, elapsedMs: performance.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

/** The SDK error the writer wrapped, by name. */
function causeName(error: unknown): string {
  assert.ok(error instanceof CloudflareR2Error, `expected a CloudflareR2Error, got ${String(error)}`);
  return String((error.cause as { name?: unknown } | undefined)?.name);
}

const refTimers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

/**
 * Every client socket this process creates, captured on Node's own
 * `net.client.socket` diagnostics channel — the client's side of the proof
 * that a request really ended: its socket destroyed and closed. (A server that
 * has stopped reading cannot see the client go away.)
 */
const clientSockets: Socket[] = [];
const onClientSocket = (message: unknown) => clientSockets.push((message as { socket: Socket }).socket);
before(() => {
  process.on("unhandledRejection", onUnhandled);
  diagnosticsChannel.subscribe("net.client.socket", onClientSocket);
});
after(() => {
  process.off("unhandledRejection", onUnhandled);
  diagnosticsChannel.unsubscribe("net.client.socket", onClientSocket);
});

/** Waits until every client socket created so far is destroyed and closed. */
async function clientSocketsClosed(label: string): Promise<void> {
  assert.ok(clientSockets.length > 0, `${label}: a client socket was captured`);
  await waitFor(() => clientSockets.every((socket) => socket.destroyed && socket.closed), `${label}: every client socket closed`);
}

// ─────────────────────────────────────────────────────────────────────────────

describe("LD-2b R2 transport: the production client configuration", () => {
  it("pins the reviewed bounds as frozen constants", () => {
    assert.deepEqual({ ...R2_TRANSPORT_POLICY }, { connectionTimeoutMs: 30_000, socketIdleTimeoutMs: 120_000, maxAttempts: 3 });
    assert.ok(Object.isFrozen(R2_TRANSPORT_POLICY));
  });

  it("builds exactly the production configuration when nothing is narrowed", () => {
    const config = buildR2S3ClientConfig({ endpoint: "https://example.invalid", credentials: CREDENTIALS });
    assert.equal(config.region, "auto");
    assert.equal(config.maxAttempts, 3);
    assert.equal(config.retryMode, "standard");
    assert.equal(config.requestChecksumCalculation, "WHEN_REQUIRED");
    assert.deepEqual(config.requestHandler, {
      connectionTimeout: 30_000,
      socketTimeout: 120_000,
      httpAgent: { keepAlive: false },
      httpsAgent: { keepAlive: false },
    });
  });

  it("lets a test narrow a bound, and refuses any attempt to widen or corrupt one", () => {
    assert.doesNotThrow(() =>
      buildR2S3ClientConfig({ endpoint: "https://example.invalid", credentials: CREDENTIALS, transport: { socketIdleTimeoutMs: 1 } }),
    );
    for (const transport of [
      { connectionTimeoutMs: 30_001 },
      { socketIdleTimeoutMs: 120_001 },
      { socketIdleTimeoutMs: 0 },
      { connectionTimeoutMs: -1 },
      { connectionTimeoutMs: 1.5 },
      { socketIdleTimeoutMs: Number.POSITIVE_INFINITY },
    ]) {
      assert.throws(
        () => buildR2S3ClientConfig({ endpoint: "https://example.invalid", credentials: CREDENTIALS, transport }),
        CloudflareR2Error,
        JSON.stringify(transport),
      );
    }
  });

  it("the production writer's REAL client resolves those values, whatever the SDK's environment variables say", async () => {
    const saved = {
      AWS_MAX_ATTEMPTS: process.env.AWS_MAX_ATTEMPTS,
      AWS_RETRY_MODE: process.env.AWS_RETRY_MODE,
      AWS_REQUEST_CHECKSUM_CALCULATION: process.env.AWS_REQUEST_CHECKSUM_CALCULATION,
    };
    process.env.AWS_MAX_ATTEMPTS = "10";
    process.env.AWS_RETRY_MODE = "adaptive";
    process.env.AWS_REQUEST_CHECKSUM_CALCULATION = "WHEN_SUPPORTED";
    try {
      const writer = new CloudflareR2ObjectStoreWriter({ accountId: ACCOUNT_ID, bucket: BUCKET, ...CREDENTIALS });
      assert.equal(Object.hasOwn(CREDENTIALS, "$source"), false, "the shared constant is never handed to the SDK");
      const config = (writer as unknown as { client: S3Client }).client.config;
      assert.equal(await config.maxAttempts(), 3);
      const strategy = (await config.retryStrategy()) as unknown as {
        mode: string;
        maxAttemptsProvider: () => Promise<number>;
      };
      assert.equal(strategy.mode, "standard", "never the environment's adaptive mode");
      assert.equal(await strategy.maxAttemptsProvider(), 3);
      assert.equal(await config.requestChecksumCalculation(), "WHEN_REQUIRED");
      const handler = config.requestHandler as unknown as { configProvider: Promise<Record<string, unknown>> };
      const resolved = await handler.configProvider;
      assert.equal(resolved.connectionTimeout, 30_000);
      assert.equal(resolved.socketTimeout, 120_000);
      const agent = resolved.httpsAgent as { keepAlive?: boolean };
      assert.equal(agent.keepAlive, false, "no pooled socket outlives the operation");
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("LD-2b R2 transport: a healthy exchange", () => {
  let h: Harness;
  afterEach(async () => {
    clientSockets.length = 0;
    // Closed and forgotten, so a test that failed to build its own harness can
    // never close (or blame) the previous test's.
    await h?.stub.close();
    h = undefined as unknown as Harness;
    const seen = unhandled;
    unhandled = [];
    assert.deepEqual(seen, [], "no unhandled rejection");
  });

  it("streams the exact body with its declared length, plainly framed, and closes the socket", async () => {
    h = await harness();
    const size = 3 * MIB + 17; // over the SDK's 2 MiB `Expect: 100-continue` threshold
    const { state, body } = countingBody(size);
    const outcome = await settle(h.writer.put(putInput(body, size)), "a healthy put");
    assert.equal(outcome.ok, true);
    assert.deepEqual(h.stub.objects.get(KEY), {
      size,
      contentType: "video/mp4",
      contentDisposition: 'attachment; filename="clip.mp4"',
    });
    const [exchange] = h.stub.exchanges;
    assert.equal(exchange!.headers["content-length"], String(size), "the declared Content-Length");
    assert.equal(exchange!.headers["expect"], "100-continue");
    assert.equal(exchange!.headers["content-encoding"], undefined, "no aws-chunked re-framing");
    assert.equal(exchange!.headers["x-amz-trailer"], undefined, "no trailing checksum");
    assert.equal(exchange!.headers["x-amz-security-token"], CREDENTIALS.sessionToken, "the delegated session token");
    assert.equal(state.produced, size);
    assert.equal(state.closed, true);
    await waitFor(() => h.stub.sockets.closed === h.stub.sockets.opened, "every socket closed after the exchange", 2_000);
  });

  it("verifies and deletes through the same bounded client, one exchange each", async () => {
    h = await harness();
    const { body } = countingBody(1024);
    await h.writer.put(putInput(body, 1024));
    assert.deepEqual(await h.writer.head(KEY), {
      objectKey: KEY,
      contentLength: 1024,
      contentType: "video/mp4",
      contentDisposition: 'attachment; filename="clip.mp4"',
    });
    await h.writer.delete(KEY);
    // Only successful exchanges so far: an error response would make the SDK
    // destroy the connection itself and hide a pooled socket.
    await waitFor(() => h.stub.sockets.closed === h.stub.sockets.opened, "no pooled socket remains", 2_000);
    assert.equal(h.stub.sockets.opened, 3, "one connection per operation: nothing was reused from a pool");
    assert.equal(await h.writer.head(KEY), null);
    assert.deepEqual(h.stub.exchanges.map((e) => e.method), ["PUT", "HEAD", "DELETE", "HEAD"]);
  });

  it("a slow answer inside the inactivity bound still succeeds: the bound is a stall detector, not a total", async () => {
    h = await harness(() => ({ kind: "slow-response", delayMs: 250 }));
    const { body } = countingBody(4096);
    const outcome = await settle(h.writer.put(putInput(body, 4096)), "a slow but live answer");
    assert.equal(outcome.ok, true);
    assert.equal(h.stub.objects.get(KEY)?.size, 4096);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("LD-2b R2 transport: stalls end on the transport's own bounds", () => {
  let h: Harness;
  afterEach(async () => {
    clientSockets.length = 0;
    // Closed and forgotten, so a test that failed to build its own harness can
    // never close (or blame) the previous test's.
    await h?.stub.close();
    h = undefined as unknown as Harness;
    const seen = unhandled;
    unhandled = [];
    assert.deepEqual(seen, [], "no unhandled rejection");
  });

  it("a connection that never establishes ends at the connection bound, before any byte is read", async () => {
    // A resolver that never answers keeps the socket connecting forever, with
    // no packet sent anywhere. HEAD carries no body, so the configured agent
    // (and its lookup) is used.
    const stub = await startStubS3Server({ bucket: BUCKET });
    h = { stub, writer: writerFor("http://stuck.invalid:9", NARROW, { lookup: () => {} }) };
    const head = await settle(h.writer.head(KEY), "a stuck connect");
    assert.equal(head.ok, false);
    assert.equal(causeName(head.ok ? null : head.error), "TimeoutError");
    assert.ok(head.elapsedMs >= 250 && head.elapsedMs < 2_000, `ended at the bound (${head.elapsedMs} ms)`);

    // A put below the 100-continue threshold takes the same agent: bounded too.
    // Its body is piped at once, so the request buffers what fits locally
    // while it waits to connect — and nothing beyond that is ever read.
    const size = 1536 * 1024;
    const { state, body } = countingBody(size);
    const put = await settle(h.writer.put(putInput(body, size)), "a stuck put connect");
    assert.equal(put.ok, false);
    assert.equal(causeName(put.ok ? null : put.error), "TimeoutError");
    assert.ok(state.produced <= 4 * 64 * 1024, `only a local buffer's worth was read (${state.produced})`);
    assert.equal(state.closed, true, "the body was closed");
    assert.equal(stub.exchanges.length, 0, "no request ever reached a server");
    await clientSocketsClosed("stuck connect");
  });

  it("a peer that never answers 100-continue: the inactivity bound ends it and the body is never read", async () => {
    h = await harness(() => ({ kind: "never-continue" }));
    const size = 4 * MIB;
    const { state, body } = countingBody(size);
    const outcome = await settle(h.writer.put(putInput(body, size)), "never continued");
    assert.equal(outcome.ok, false);
    assert.equal(causeName(outcome.ok ? null : outcome.error), "TimeoutError");
    assert.ok(outcome.elapsedMs < 3_000, `ended by the idle bound, not the 6 s continue wait (${outcome.elapsedMs} ms)`);
    assert.equal(state.produced, 0);
    await waitFor(() => h.stub.exchanges[0]!.clientClosed, "the server saw the client go away");
    await sleep(150);
    assert.equal(state.produced, 0, "and nothing was read afterwards");
  });

  it("a peer that stops reading part-way: the request is destroyed and the body stops at once", async () => {
    h = await harness(() => ({ kind: "stall-body", afterBytes: 1 * MIB }));
    const size = 64 * MIB;
    const { state, body } = countingBody(size);
    const outcome = await settle(h.writer.put(putInput(body, size)), "a partial body then a stall");
    assert.equal(outcome.ok, false);
    assert.equal(causeName(outcome.ok ? null : outcome.error), "TimeoutError");
    const producedAtEnd = state.produced;
    assert.ok(producedAtEnd < 16 * MIB, `back-pressured: ${producedAtEnd} bytes read of ${size}`);
    assert.equal(state.closed, true, "the body was closed");
    await clientSocketsClosed("a stalled body");
    await sleep(200);
    assert.equal(state.produced, producedAtEnd, "no byte read after the request ended");
    assert.equal(h.stub.objects.size, 0, "no object was committed");
  });

  it("a peer that reads everything and never answers: the inactivity bound ends it", async () => {
    h = await harness(() => ({ kind: "never-respond" }));
    const size = 512 * 1024;
    const { state, body } = countingBody(size);
    const outcome = await settle(h.writer.put(putInput(body, size)), "never answered");
    assert.equal(outcome.ok, false);
    assert.equal(causeName(outcome.ok ? null : outcome.error), "TimeoutError");
    assert.equal(state.produced, size);
    assert.equal(h.stub.exchanges[0]!.bodyComplete, true, "the server had the whole body");
    await waitFor(() => h.stub.exchanges[0]!.clientClosed, "the server saw the client go away");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("LD-2b R2 transport: no hidden retry", () => {
  let h: Harness;
  afterEach(async () => {
    clientSockets.length = 0;
    // Closed and forgotten, so a test that failed to build its own harness can
    // never close (or blame) the previous test's.
    await h?.stub.close();
    h = undefined as unknown as Harness;
    const seen = unhandled;
    unhandled = [];
    assert.deepEqual(seen, [], "no unhandled rejection");
  });

  for (const [label, mode] of [
    ["a transient 503", { kind: "status", status: 503, code: "SlowDown" }],
    ["a 500", { kind: "status", status: 500, code: "InternalError" }],
    ["a connection reset mid-body", { kind: "reset", afterBytes: 256 * 1024 }],
  ] as const) {
    it(`a streaming PutObject is attempted exactly once after ${label}`, async () => {
      h = await harness(() => mode);
      const size = 1 * MIB;
      const { body } = countingBody(size);
      const outcome = await settle(h.writer.put(putInput(body, size)), label);
      assert.equal(outcome.ok, false);
      await sleep(300); // long enough for any retry backoff to have fired
      assert.deepEqual(h.stub.exchanges.map((e) => e.method), ["PUT"], "one request, never re-sent from a consumed stream");
    });
  }

  it("a HeadObject retries a transient error at most maxAttempts times, then fails", async () => {
    h = await harness(() => ({ kind: "status", status: 503, code: "SlowDown" }));
    const outcome = await settle(h.writer.head(KEY), "a head that keeps failing", 10_000);
    assert.equal(outcome.ok, false);
    assert.deepEqual(h.stub.exchanges.map((e) => e.method), ["HEAD", "HEAD", "HEAD"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("LD-2b R2 transport: the caller's abort ends the request itself", () => {
  let h: Harness;
  afterEach(async () => {
    clientSockets.length = 0;
    // Closed and forgotten, so a test that failed to build its own harness can
    // never close (or blame) the previous test's.
    await h?.stub.close();
    h = undefined as unknown as Harness;
    const seen = unhandled;
    unhandled = [];
    assert.deepEqual(seen, [], "no unhandled rejection");
  });

  it("an abort half-way through the body destroys the request, stops the body and settles at once", async () => {
    h = await harness(() => ({ kind: "trickle", tickMs: 5 }));
    // Production's own, un-narrowed bounds: nothing but the abort can end it.
    h.writer = writerFor(h.stub.endpoint, {
      connectionTimeoutMs: R2_TRANSPORT_POLICY.connectionTimeoutMs,
      socketIdleTimeoutMs: R2_TRANSPORT_POLICY.socketIdleTimeoutMs,
    });
    const size = 64 * MIB;
    const { state, body } = countingBody(size);
    const controller = new AbortController();
    const timersBefore = refTimers();
    const put = h.writer.put(putInput(body, size), { signal: controller.signal });
    await waitFor(() => (h.stub.exchanges[0]?.bytesReceived ?? 0) >= 1 * MIB, "the body to be half-way");

    controller.abort(new Error("cancelled by the test"));
    const outcome = await settle(put, "the aborted put");
    assert.equal(outcome.ok, false);
    assert.equal(causeName(outcome.ok ? null : outcome.error), "AbortError");
    assert.ok(outcome.elapsedMs < 1_000, `settled promptly after the abort (${outcome.elapsedMs} ms)`);
    const producedAtAbort = state.produced;
    assert.equal(state.closed, true, "the body was closed");
    await clientSocketsClosed("the aborted put");
    await waitFor(() => h.stub.exchanges[0]!.clientClosed, "the server saw the request end");
    await waitFor(() => h.stub.sockets.closed === h.stub.sockets.opened, "the server's socket closed");
    const receivedAtClose = h.stub.exchanges[0]!.bytesReceived;
    await sleep(200);
    assert.equal(state.produced, producedAtAbort, "no byte read after the abort");
    assert.equal(h.stub.exchanges[0]!.bytesReceived, receivedAtClose, "no byte transferred after the abort");
    assert.ok(state.produced < size, "the body was never drained into memory");
    assert.equal(h.stub.objects.size, 0);
    assert.equal(refTimers(), timersBefore, "no transport timer outlives the request");
  });

  it("a signal aborted before the call builds no request and reads nothing", async () => {
    h = await harness();
    const { state, body } = countingBody(1 * MIB);
    const controller = new AbortController();
    controller.abort(new Error("already over"));
    const outcome = await settle(h.writer.put(putInput(body, 1 * MIB), { signal: controller.signal }), "pre-aborted");
    assert.equal(outcome.ok, false);
    assert.equal(state.produced, 0);
    const operations: Array<() => Promise<unknown>> = [
      () => h.writer.head(KEY, { signal: controller.signal }),
      () => h.writer.delete(KEY, { signal: controller.signal }),
    ];
    for (const op of operations) {
      const settled = await settle(op(), "pre-aborted head/delete");
      assert.equal(settled.ok, false);
    }
    await sleep(50);
    assert.equal(h.stub.exchanges.length, 0, "no request reached the server");
    assert.equal(h.stub.sockets.opened, 0, "no connection was even opened");
  });

  it("an abort while the connection is still being made ends it at once", async () => {
    const stub = await startStubS3Server({ bucket: BUCKET });
    h = { stub, writer: writerFor("http://stuck.invalid:9", { connectionTimeoutMs: 30_000, socketIdleTimeoutMs: 120_000 }, { lookup: () => {} }) };
    const controller = new AbortController();
    const head = h.writer.head(KEY, { signal: controller.signal });
    await sleep(50);
    controller.abort(new Error("cancelled while connecting"));
    const outcome = await settle(head, "abort during connect");
    assert.equal(outcome.ok, false);
    assert.equal(causeName(outcome.ok ? null : outcome.error), "AbortError");
    assert.ok(outcome.elapsedMs < 1_000, `${outcome.elapsedMs} ms`);
  });

  it("an aborted HeadObject is attempted once: an abort is never retried", async () => {
    h = await harness(() => ({ kind: "never-respond" }));
    h.writer = writerFor(h.stub.endpoint, {
      connectionTimeoutMs: R2_TRANSPORT_POLICY.connectionTimeoutMs,
      socketIdleTimeoutMs: R2_TRANSPORT_POLICY.socketIdleTimeoutMs,
    });
    const controller = new AbortController();
    const head = h.writer.head(KEY, { signal: controller.signal });
    await waitFor(() => h.stub.exchanges.length === 1, "the head to be in flight");
    controller.abort(new Error("deadline"));
    const outcome = await settle(head, "the aborted head");
    assert.equal(outcome.ok, false);
    assert.equal(causeName(outcome.ok ? null : outcome.error), "AbortError");
    await waitFor(() => h.stub.exchanges[0]!.clientClosed, "the server saw the head end");
    await sleep(300);
    assert.equal(h.stub.exchanges.length, 1, "no second attempt after the abort");
  });

  it("an abort after the provider answered cannot undo a completed put — the caller must clean up", async () => {
    // The response is already in: the SDK settles with success, and an abort
    // arriving afterwards changes nothing. This is why the upload lifecycle
    // re-checks its stage after every operation instead of trusting it.
    h = await harness();
    const { body } = countingBody(2048);
    const controller = new AbortController();
    await h.writer.put(putInput(body, 2048), { signal: controller.signal });
    controller.abort(new Error("too late"));
    assert.equal(h.stub.objects.get(KEY)?.size, 2048, "the object exists: only an exact-key delete removes it");
  });
});
