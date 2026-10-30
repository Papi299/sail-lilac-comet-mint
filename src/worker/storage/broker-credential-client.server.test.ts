import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  BrokerR2CredentialProvider,
  R2CredentialBrokerError,
  R2_BROKER_CLIENT_TIMEOUT_MS,
} from "./broker-credential-client.server.ts";
import type { WorkerObjectKey } from "../../shared/worker/contracts.ts";

/**
 * VIDEOFETCH-LD2B-BOUNDED-CANCELLABLE-UPLOAD-001 — the broker client's abort.
 *
 * A real HTTP server on a real Unix socket in a temporary directory plays a
 * broker that never answers (or answers into an abort). The client's own 5 s
 * timeout still bounds an exchange nobody aborts; an abort ends the exchange
 * at once, and the server sees the connection close. Fake values only.
 */

const BUCKET = "videofetch-objects";
const KEY = `videofetch/jobs/${"a".repeat(32)}/${"b".repeat(32)}` as WorkerObjectKey;
const REQUEST = { action: "PutObject", objectKey: KEY, ttlSeconds: 900 } as const;

type Broker = {
  socketPath: string;
  server: Server;
  requests: number;
  closedByClient: number;
};

function isFailure(failure: string) {
  return (err: unknown) => {
    assert.ok(err instanceof R2CredentialBrokerError, String(err));
    assert.equal(err.failure, failure);
    return true;
  };
}

describe("BrokerR2CredentialProvider: an abort ends the broker exchange (LD-2b)", () => {
  let root: string;
  let broker: Broker;

  async function startBroker(answer: (respond: (status: number, body: string) => void) => void): Promise<Broker> {
    const socketPath = join(root, "b.sock");
    const state: Broker = { socketPath, server: createServer(), requests: 0, closedByClient: 0 };
    state.server.on("request", (req, res) => {
      state.requests += 1;
      req.resume();
      res.on("close", () => {
        if (!res.writableFinished) state.closedByClient += 1;
      });
      answer((status, body) => {
        if (!res.destroyed) res.writeHead(status, { "content-type": "application/json" }).end(body);
      });
    });
    await new Promise<void>((resolve) => state.server.listen(socketPath, resolve));
    return state;
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ld2b-broker-"));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      broker.server.closeAllConnections();
      broker.server.close(() => resolve());
    });
    await rm(root, { recursive: true, force: true });
  });

  it("a broker that never answers: the abort ends the exchange at once, not at the 5 s client timeout", async () => {
    broker = await startBroker(() => {});
    const client = new BrokerR2CredentialProvider({ socketPath: broker.socketPath, bucket: BUCKET });
    const controller = new AbortController();
    const minting = client.mint(REQUEST, { signal: controller.signal });
    for (let i = 0; i < 200 && broker.requests === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.equal(broker.requests, 1, "the exchange was in flight");

    const start = performance.now();
    controller.abort(new Error("cancelled"));
    await assert.rejects(minting, isFailure("aborted"));
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 1_000 && elapsed < R2_BROKER_CLIENT_TIMEOUT_MS, `ended by the abort (${elapsed} ms)`);
    for (let i = 0; i < 200 && broker.closedByClient === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.equal(broker.closedByClient, 1, "the broker saw the client close the exchange");
  });

  it("an already-aborted signal opens no connection", async () => {
    broker = await startBroker((respond) => respond(500, "{}"));
    const client = new BrokerR2CredentialProvider({ socketPath: broker.socketPath, bucket: BUCKET });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await assert.rejects(client.mint(REQUEST, { signal: controller.signal }), isFailure("aborted"));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(broker.requests, 0);
  });

  it("an answer that races an abort is discarded: no credential is ever returned after it", async () => {
    // The broker answers with a VALID credential; the signal reports aborted by
    // the time the answer is used. (A signal whose state flips between the
    // client's two reads stands in for an abort landing in that gap.)
    const valid = JSON.stringify({
      accessKeyId: "fake-delegated-key-id",
      secretAccessKey: "fake-delegated-secret",
      sessionToken: "fake-session-token",
      expiresAt: Date.now() + 60_000,
      action: "PutObject",
      bucket: BUCKET,
      objectKey: KEY,
    });
    broker = await startBroker((respond) => respond(200, valid));
    const client = new BrokerR2CredentialProvider({ socketPath: broker.socketPath, bucket: BUCKET });
    let reads = 0;
    const racing = {
      get aborted() {
        reads += 1;
        return reads > 1;
      },
      reason: new Error("cancelled"),
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal;
    await assert.rejects(client.mint(REQUEST, { signal: racing }), isFailure("aborted"));
    assert.equal(broker.requests, 1);

    // The control: the same answer with no abort is a credential.
    const credential = await client.mint(REQUEST);
    assert.equal(credential.sessionToken, "fake-session-token");
  });

  it("an exchange nobody aborts is still bounded by the client's own timeout", async () => {
    broker = await startBroker(() => {});
    const client = new BrokerR2CredentialProvider({ socketPath: broker.socketPath, bucket: BUCKET, timeoutMs: 100 });
    const start = performance.now();
    await assert.rejects(client.mint(REQUEST, { signal: new AbortController().signal }), isFailure("broker_unavailable"));
    assert.ok(performance.now() - start < 2_000);
  });

  it("a live signal leaves no listener behind after the exchange", async () => {
    const valid = JSON.stringify({
      accessKeyId: "fake-delegated-key-id",
      secretAccessKey: "fake-delegated-secret",
      sessionToken: "fake-session-token",
      expiresAt: Date.now() + 60_000,
      action: "PutObject",
      bucket: BUCKET,
      objectKey: KEY,
    });
    broker = await startBroker((respond) => respond(200, valid));
    const client = new BrokerR2CredentialProvider({ socketPath: broker.socketPath, bucket: BUCKET });
    const listeners = new Set<unknown>();
    const controller = new AbortController();
    const signal = controller.signal;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((type: string, listener: unknown, options?: unknown) => {
      listeners.add(listener);
      add(type, listener as EventListener, options as AddEventListenerOptions);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((type: string, listener: unknown, options?: unknown) => {
      listeners.delete(listener);
      remove(type, listener as EventListener, options as EventListenerOptions);
    }) as typeof signal.removeEventListener;
    await client.mint(REQUEST, { signal });
    assert.equal(listeners.size, 0, "the abort listener was removed when the exchange ended");
  });
});
