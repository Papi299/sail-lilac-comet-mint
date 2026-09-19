import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { inspect } from "node:util";
import { AppError, ERROR_MESSAGES } from "../errors.ts";
import {
  buildPinnedRequestOptions,
  safeGet,
  safeHead,
  safeHttpRequest,
  setPinnedRequestFactoryForTests,
  setSafeHttpTestHooks,
  type DnsAnswer,
  type NodeRequestFactory,
  type PinnedRequestOptions,
} from "./safe-http.server.ts";

const PUBLIC: DnsAnswer = { address: "8.8.8.8", family: 4 };
const PUBLIC_ALT: DnsAnswer = { address: "1.1.1.1", family: 4 };

function answersFor(hostname: string, table: Record<string, DnsAnswer[]>): DnsAnswer[] {
  const found = table[hostname];
  if (!found) throw new Error(`unexpected lookup ${hostname}`);
  return found;
}

function lookupResult(
  lookup: PinnedRequestOptions["lookup"],
): Promise<{ address: string; family: number }> {
  return new Promise((resolve, reject) => {
    lookup("cdn.example", {}, (err, address, family) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ address: String(address), family: Number(family) });
    });
  });
}

function capturingRequestFactory(captured: PinnedRequestOptions[]): NodeRequestFactory {
  return (options, callback) => {
    captured.push(options);
    const req = new EventEmitter() as ReturnType<NodeRequestFactory>;
    req.setTimeout = (() => req) as ReturnType<NodeRequestFactory>["setTimeout"];
    req.destroy = ((err?: Error) => {
      if (err) req.emit("error", err);
      return req;
    }) as ReturnType<NodeRequestFactory>["destroy"];
    req.end = (() => {
      queueMicrotask(() => {
        const res = Readable.from([Buffer.from("ok")]) as IncomingMessage;
        res.statusCode = 200;
        res.headers = { "content-type": "video/mp4" };
        callback(res);
      });
      return req;
    }) as ReturnType<NodeRequestFactory>["end"];
    return req;
  };
}

describe("safe HTTP transport", () => {
  afterEach(() => {
    setSafeHttpTestHooks(null);
    setPinnedRequestFactoryForTests(null);
  });

  it("rejects a resolver answer of 127.0.0.1 before connecting", async () => {
    let connected = false;
    setSafeHttpTestHooks({
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      requestOnce: async () => {
        connected = true;
        throw new Error("should not connect");
      },
    });
    await assert.rejects(() => safeHttpRequest({ url: "https://example.com/a.mp4" }), (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "INVALID_URL");
      return true;
    });
    assert.equal(connected, false);
  });

  it("rejects RFC1918, link-local, and loopback IPv6 answers", async () => {
    for (const address of ["10.1.2.3", "169.254.169.254", "::1"]) {
      let connected = false;
      setSafeHttpTestHooks({
        lookup: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
        requestOnce: async () => {
          connected = true;
          return { status: 200, headers: {}, body: null };
        },
      });
      await assert.rejects(() => safeHttpRequest({ url: "https://example.com/a.mp4" }));
      assert.equal(connected, false);
    }
  });

  it("rejects mixed public+private answers without connecting", async () => {
    let connected = false;
    setSafeHttpTestHooks({
      lookup: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.9", family: 4 },
      ],
      requestOnce: async () => {
        connected = true;
        return { status: 200, headers: {}, body: null };
      },
    });
    await assert.rejects(() => safeHttpRequest({ url: "https://example.com/a.mp4" }));
    assert.equal(connected, false);
  });

  it("pins the connection to the validated address and does not look up twice", async () => {
    let lookups = 0;
    let pinned: DnsAnswer | null = null;
    setSafeHttpTestHooks({
      lookup: async () => {
        lookups += 1;
        return [PUBLIC];
      },
      requestOnce: async (args) => {
        pinned = args.pinned;
        return { status: 200, headers: { "content-type": "video/mp4" }, body: Readable.from([Buffer.from("abc")]) };
      },
    });
    const res = await safeHttpRequest({ url: "https://cdn.example/video.mp4" });
    assert.equal(res.status, 200);
    assert.equal(lookups, 1);
    assert.deepEqual(pinned, PUBLIC);
  });

  it("rejects a redirect to a destination that resolves privately", async () => {
    let hops = 0;
    setSafeHttpTestHooks({
      lookup: async (hostname) =>
        answersFor(hostname, {
          "cdn.example": [PUBLIC],
          "evil.internal": [{ address: "127.0.0.1", family: 4 }],
        }),
      requestOnce: async (args) => {
        hops += 1;
        if (args.url.hostname === "cdn.example") {
          return { status: 302, headers: { location: "https://evil.internal/secret" }, body: null };
        }
        throw new Error("should not connect to redirect target");
      },
    });
    await assert.rejects(() => safeHttpRequest({ url: "https://cdn.example/a.mp4" }), (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "INVALID_URL");
      return true;
    });
    assert.equal(hops, 1);
  });

  it("rejects redirects to RFC1918 and metadata addresses", async () => {
    for (const [host, ip] of [
      ["rfc1918.test", "192.168.1.8"],
      ["metadata.test", "169.254.169.254"],
      ["ula.test", "fd00::1"],
    ] as const) {
      setSafeHttpTestHooks({
        lookup: async (hostname) =>
          hostname === "cdn.example"
            ? [PUBLIC]
            : [{ address: ip, family: ip.includes(":") ? 6 : 4 }],
        requestOnce: async (args) => {
          if (args.url.hostname === "cdn.example") {
            return { status: 302, headers: { location: `https://${host}/x` }, body: null };
          }
          throw new Error("followed unsafe redirect");
        },
      });
      await assert.rejects(() => safeHttpRequest({ url: "https://cdn.example/a.mp4" }));
    }
  });

  it("fails when redirects exceed the configured maximum", async () => {
    let connections = 0;
    setSafeHttpTestHooks({
      lookup: async () => [PUBLIC],
      requestOnce: async (args) => {
        connections += 1;
        return { status: 302, headers: { location: `${args.url.origin}/next-${connections}` }, body: null };
      },
    });
    await assert.rejects(() =>
      safeHttpRequest({ url: "https://cdn.example/start.mp4", maxRedirects: 2 }),
    );
    assert.equal(connections, 3);
  });

  it("streams the body rather than buffering it", async () => {
    const chunks: Buffer[] = [];
    setSafeHttpTestHooks({
      lookup: async () => [PUBLIC],
      requestOnce: async () => ({
        status: 200,
        headers: { "content-length": "3" },
        body: Readable.from([Buffer.from("ab"), Buffer.from("c")]),
      }),
    });
    const res = await safeHttpRequest({ url: "https://cdn.example/a.mp4" });
    assert.ok(res.body);
    assert.ok(typeof (res.body as Readable).pipe === "function");
    for await (const chunk of res.body as Readable) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    assert.equal(Buffer.concat(chunks).toString(), "abc");
  });

  it("builds one-shot request options with agent:false and the request pin", async () => {
    const first = buildPinnedRequestOptions({
      url: new URL("https://cdn.example/a.mp4"),
      method: "GET",
      pinned: PUBLIC,
      headers: { "User-Agent": "VideoFetch/1.0" },
    });
    const second = buildPinnedRequestOptions({
      url: new URL("https://cdn.example/b.mp4"),
      method: "GET",
      pinned: PUBLIC_ALT,
      headers: { "User-Agent": "VideoFetch/1.0" },
    });
    assert.equal(first.agent, false);
    assert.equal(second.agent, false);
    assert.equal(first.hostname, "cdn.example");
    assert.equal(first.servername, "cdn.example");
    assert.equal((first.headers as { host?: string }).host, "cdn.example");
    assert.notEqual(first.lookup, second.lookup);
    assert.deepEqual(await lookupResult(first.lookup), { address: PUBLIC.address, family: 4 });
    assert.deepEqual(await lookupResult(second.lookup), { address: PUBLIC_ALT.address, family: 4 });
  });

  it("does not reuse a shared Agent across two real pinned requests to the same host", async () => {
    const captured: PinnedRequestOptions[] = [];
    const factory = capturingRequestFactory(captured);
    let pin: DnsAnswer = PUBLIC;
    setSafeHttpTestHooks({
      lookup: async () => [pin],
    });
    setPinnedRequestFactoryForTests({ http: factory, https: factory });

    pin = PUBLIC;
    await safeHttpRequest({ url: "https://cdn.example/a.mp4" });
    pin = PUBLIC_ALT;
    await safeHttpRequest({ url: "https://cdn.example/b.mp4" });

    assert.equal(captured.length, 2);
    assert.equal(captured[0]?.agent, false);
    assert.equal(captured[1]?.agent, false);
    assert.equal(captured[0]?.hostname, "cdn.example");
    assert.equal(captured[1]?.hostname, "cdn.example");
    assert.equal(captured[0]?.servername, "cdn.example");
    assert.notEqual(captured[0]?.lookup, captured[1]?.lookup);
    assert.deepEqual(await lookupResult(captured[0]!.lookup), { address: PUBLIC.address, family: 4 });
    assert.deepEqual(await lookupResult(captured[1]!.lookup), { address: PUBLIC_ALT.address, family: 4 });
  });
});

// ── Abort boundary (SAFE-HTTP-ABORT-BETWEEN-DNS-AND-CONNECT-001) ─────────────

/** A promise the test settles by hand, to hold a lookup in flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let pending promise jobs and immediates run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

/** A redirect or response body that records whether it was destroyed. */
function trackedBody(): { stream: Readable; destroyed: () => boolean } {
  let destroyed = false;
  const stream = new Readable({
    read() {
      this.push(null);
    },
    destroy(err, callback) {
      destroyed = true;
      callback(err);
    },
  });
  return { stream, destroyed: () => destroyed };
}

/** Assert the canonical application refusal for an aborted operation. */
async function refusedAsAborted(pending: Promise<unknown>): Promise<AppError> {
  let thrown: unknown;
  try {
    await pending;
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof AppError, "an aborted operation is refused with an AppError");
  assert.equal(thrown.code, "NETWORK_ERROR");
  assert.equal(thrown.message, ERROR_MESSAGES.NETWORK_ERROR);
  return thrown;
}

describe("safe HTTP abort boundary: an already-aborted signal starts nothing", () => {
  afterEach(() => {
    setSafeHttpTestHooks(null);
    setPinnedRequestFactoryForTests(null);
  });

  for (const [label, call] of [
    ["safeGet", (signal: AbortSignal) => safeGet("https://cdn.example/a.m3u8", { signal })],
    ["safeHead", (signal: AbortSignal) => safeHead("https://cdn.example/a.mp4", { signal })],
    ["safeHttpRequest", (signal: AbortSignal) => safeHttpRequest({ url: "https://cdn.example/a.mp4", signal })],
  ] as const) {
    it(`${label}: no lookup and no request (M1)`, async () => {
      const controller = new AbortController();
      controller.abort();
      let lookups = 0;
      let requests = 0;
      setSafeHttpTestHooks({
        lookup: async () => {
          lookups += 1;
          return [PUBLIC];
        },
        requestOnce: async () => {
          requests += 1;
          return { status: 200, headers: {}, body: null };
        },
      });
      await refusedAsAborted(call(controller.signal));
      assert.equal(lookups, 0, "no DNS lookup starts");
      assert.equal(requests, 0, "no request starts");
    });
  }

  it("never reaches the pinned request factory, so no socket and no request byte (M4)", async () => {
    const controller = new AbortController();
    controller.abort();
    const captured: PinnedRequestOptions[] = [];
    let lookups = 0;
    setSafeHttpTestHooks({
      lookup: async () => {
        lookups += 1;
        return [PUBLIC];
      },
    });
    setPinnedRequestFactoryForTests({
      http: capturingRequestFactory(captured),
      https: capturingRequestFactory(captured),
    });
    await refusedAsAborted(safeGet("https://cdn.example/a.mp4", { signal: controller.signal }));
    assert.equal(lookups, 0);
    assert.equal(captured.length, 0, "the request factory is never invoked");
  });
});

describe("safe HTTP abort boundary: an abort during DNS stops before the request", () => {
  afterEach(() => {
    setSafeHttpTestHooks(null);
    setPinnedRequestFactoryForTests(null);
  });

  it("does not request after a lookup that answers only after the abort (M2)", async () => {
    const controller = new AbortController();
    const answer = deferred<DnsAnswer[]>();
    let lookups = 0;
    let requests = 0;
    setSafeHttpTestHooks({
      lookup: () => {
        lookups += 1;
        return answer.promise;
      },
      requestOnce: async () => {
        requests += 1;
        return { status: 200, headers: {}, body: Readable.from([Buffer.from("x")]) };
      },
    });

    const pending = safeGet("https://cdn.example/a.m3u8", { signal: controller.signal });
    await settle();
    assert.equal(lookups, 1, "the lookup is in flight");
    controller.abort();
    // The OS lookup cannot be cancelled: it still completes, with an otherwise
    // perfectly public answer. Nothing may be built on it.
    answer.resolve([PUBLIC]);
    await refusedAsAborted(pending);
    await settle();
    assert.equal(lookups, 1);
    assert.equal(requests, 0, "requestOnce is never called after the abort");
  });

  it("never invokes the pinned request factory after that lookup (M2, M4)", async () => {
    const controller = new AbortController();
    const answer = deferred<DnsAnswer[]>();
    const captured: PinnedRequestOptions[] = [];
    let lookups = 0;
    setSafeHttpTestHooks({
      lookup: () => {
        lookups += 1;
        return answer.promise;
      },
    });
    setPinnedRequestFactoryForTests({
      http: capturingRequestFactory(captured),
      https: capturingRequestFactory(captured),
    });

    const pending = safeGet("https://cdn.example/a.mp4", { signal: controller.signal });
    await settle();
    controller.abort();
    answer.resolve([PUBLIC]);
    await refusedAsAborted(pending);
    await settle();
    assert.equal(lookups, 1);
    assert.equal(captured.length, 0, "no request object, socket or byte is created");
  });

  it("does not request when the abort lands at the lookup's own return (M2)", async () => {
    const controller = new AbortController();
    let requests = 0;
    setSafeHttpTestHooks({
      lookup: async () => {
        // The exact boundary: the answer is valid and is returned, but the
        // signal is already aborted by the time resolution completes.
        controller.abort();
        return [PUBLIC];
      },
      requestOnce: async () => {
        requests += 1;
        return { status: 200, headers: {}, body: null };
      },
    });
    await refusedAsAborted(safeGet("https://cdn.example/a.mp4", { signal: controller.signal }));
    assert.equal(requests, 0);
  });
});

describe("safe HTTP abort boundary: no further redirect hop after an abort", () => {
  afterEach(() => {
    setSafeHttpTestHooks(null);
    setPinnedRequestFactoryForTests(null);
  });

  it("disposes the redirect and starts no lookup or request for the next hop (M3)", async () => {
    const controller = new AbortController();
    const redirectBody = trackedBody();
    const lookedUp: string[] = [];
    const requested: string[] = [];
    setSafeHttpTestHooks({
      lookup: async (hostname) => {
        lookedUp.push(hostname);
        return [PUBLIC];
      },
      requestOnce: async (args) => {
        requested.push(args.url.href);
        // The first hop completes with a redirect, and the operation is
        // cancelled before the loop reaches the next hop.
        controller.abort();
        return { status: 302, headers: { location: "https://next.example/b.m3u8" }, body: redirectBody.stream };
      },
    });
    await refusedAsAborted(safeGet("https://cdn.example/a.m3u8", { signal: controller.signal }));
    await settle();
    assert.deepEqual(requested, ["https://cdn.example/a.m3u8"], "only the first hop was requested");
    assert.deepEqual(lookedUp, ["cdn.example"], "no lookup starts for the next hop");
    assert.equal(redirectBody.destroyed(), true, "the redirect body is disposed");
  });
});

describe("safe HTTP abort boundary: the refusal is application-owned and private", () => {
  afterEach(() => {
    setSafeHttpTestHooks(null);
    setPinnedRequestFactoryForTests(null);
  });

  const SECRETS = ["REASONSECRET", "reason-host.example", "PATHSECRET", "QUERYSECRET", "secret-host.example", "NEXTSECRET"];
  const URL_WITH_SECRETS = "https://secret-host.example/PATHSECRET/a.m3u8?sig=QUERYSECRET";

  function assertPrivate(err: AppError): void {
    assert.equal((err as { cause?: unknown }).cause, undefined);
    const rendered = [err.message, err.stack ?? "", String(err), JSON.stringify(err), inspect(err, { depth: 10, showHidden: true })].join("\n");
    for (const secret of SECRETS) {
      assert.equal(rendered.includes(secret), false, `the refusal must not echo ${secret.slice(0, 6)}…`);
    }
  }

  /** An abort reason a caller could have chosen: arbitrary, and never to be surfaced. */
  function abortWithSecretReason(controller: AbortController): void {
    controller.abort(new Error("REASONSECRET https://reason-host.example/x"));
  }

  it("does not surface the abort reason or the URL before DNS (M5)", async () => {
    const controller = new AbortController();
    abortWithSecretReason(controller);
    setSafeHttpTestHooks({ lookup: async () => [PUBLIC], requestOnce: async () => ({ status: 200, headers: {}, body: null }) });
    assertPrivate(await refusedAsAborted(safeGet(URL_WITH_SECRETS, { signal: controller.signal })));
  });

  it("does not surface the abort reason or the URL after DNS (M5)", async () => {
    const controller = new AbortController();
    setSafeHttpTestHooks({
      lookup: async () => {
        abortWithSecretReason(controller);
        return [PUBLIC];
      },
      requestOnce: async () => ({ status: 200, headers: {}, body: null }),
    });
    assertPrivate(await refusedAsAborted(safeGet(URL_WITH_SECRETS, { signal: controller.signal })));
  });

  it("does not surface the abort reason or the redirect target between hops (M5)", async () => {
    const controller = new AbortController();
    setSafeHttpTestHooks({
      lookup: async () => [PUBLIC],
      requestOnce: async () => {
        abortWithSecretReason(controller);
        return { status: 302, headers: { location: "https://secret-host.example/NEXTSECRET" }, body: null };
      },
    });
    assertPrivate(await refusedAsAborted(safeGet(URL_WITH_SECRETS, { signal: controller.signal })));
  });
});

describe("safe HTTP abort boundary: non-aborted behaviour is unchanged", () => {
  afterEach(() => {
    setSafeHttpTestHooks(null);
    setPinnedRequestFactoryForTests(null);
  });

  const FIXED_PROFILE = { "User-Agent": "VideoFetch/1.0", Accept: "video/*,audio/*,*/*;q=0.8" };

  it("completes one GET under a live signal, with one lookup, the pin and the fixed headers", async () => {
    const controller = new AbortController();
    const seen: { method?: string; headers?: Record<string, string>; pinned?: DnsAnswer; signal?: AbortSignal }[] = [];
    let lookups = 0;
    setSafeHttpTestHooks({
      lookup: async () => {
        lookups += 1;
        return [PUBLIC];
      },
      requestOnce: async (args) => {
        seen.push({ method: args.method, headers: { ...args.headers }, pinned: args.pinned, signal: args.signal });
        return { status: 200, headers: { "content-type": "video/mp4" }, body: Readable.from([Buffer.from("abc")]) };
      },
    });
    const res = await safeGet("https://cdn.example/a.mp4", { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.equal(res.url, "https://cdn.example/a.mp4");
    assert.ok(res.body);
    assert.equal(lookups, 1);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.method, "GET");
    assert.deepEqual(seen[0]?.headers, FIXED_PROFILE);
    assert.deepEqual(seen[0]?.pinned, PUBLIC);
    assert.equal(seen[0]?.signal, controller.signal, "the caller's signal still reaches the request");
  });

  it("completes one HEAD under a live signal", async () => {
    const methods: string[] = [];
    setSafeHttpTestHooks({
      lookup: async () => [PUBLIC],
      requestOnce: async (args) => {
        methods.push(args.method);
        return { status: 200, headers: { "content-length": "3" }, body: null };
      },
    });
    const res = await safeHead("https://cdn.example/a.mp4", { signal: new AbortController().signal });
    assert.equal(res.status, 200);
    assert.deepEqual(methods, ["HEAD"]);
  });

  it("completes GET and HEAD through the real pinned request path", async () => {
    const captured: PinnedRequestOptions[] = [];
    setSafeHttpTestHooks({ lookup: async () => [PUBLIC] });
    setPinnedRequestFactoryForTests({
      http: capturingRequestFactory(captured),
      https: capturingRequestFactory(captured),
    });
    const get = await safeGet("https://cdn.example/a.mp4", { signal: new AbortController().signal });
    assert.equal(get.status, 200);
    assert.ok(get.body);
    const head = await safeHead("https://cdn.example/a.mp4", { signal: new AbortController().signal });
    assert.equal(head.status, 200);
    assert.equal(head.body, null);
    assert.deepEqual(captured.map((o) => o.method), ["GET", "HEAD"]);
    for (const options of captured) assert.equal(options.agent, false);
  });

  it("follows a redirect to a safe public destination under a live signal", async () => {
    const lookedUp: string[] = [];
    const requested: string[] = [];
    setSafeHttpTestHooks({
      lookup: async (hostname) => {
        lookedUp.push(hostname);
        return [PUBLIC];
      },
      requestOnce: async (args) => {
        requested.push(args.url.href);
        if (args.url.hostname === "cdn.example") {
          return { status: 302, headers: { location: "https://next.example/b.mp4" }, body: null };
        }
        return { status: 200, headers: {}, body: Readable.from([Buffer.from("ok")]) };
      },
    });
    const res = await safeGet("https://cdn.example/a.mp4", { signal: new AbortController().signal });
    assert.equal(res.status, 200);
    assert.equal(res.url, "https://next.example/b.mp4");
    assert.deepEqual(lookedUp, ["cdn.example", "next.example"]);
    assert.deepEqual(requested, ["https://cdn.example/a.mp4", "https://next.example/b.mp4"]);
  });

  it("still rejects a private answer and an unsafe redirect when a live signal is present", async () => {
    let connected = false;
    setSafeHttpTestHooks({
      lookup: async () => [{ address: "10.0.0.9", family: 4 }],
      requestOnce: async () => {
        connected = true;
        return { status: 200, headers: {}, body: null };
      },
    });
    await assert.rejects(
      () => safeGet("https://cdn.example/a.mp4", { signal: new AbortController().signal }),
      (err: unknown) => err instanceof AppError && err.code === "INVALID_URL",
    );
    assert.equal(connected, false);

    const requested: string[] = [];
    setSafeHttpTestHooks({
      lookup: async () => [PUBLIC],
      requestOnce: async (args) => {
        requested.push(args.url.href);
        return { status: 302, headers: { location: "http://127.0.0.1/secret" }, body: null };
      },
    });
    await assert.rejects(
      () => safeGet("https://cdn.example/a.mp4", { signal: new AbortController().signal }),
      (err: unknown) => err instanceof AppError && err.code === "INVALID_URL",
    );
    assert.deepEqual(requested, ["https://cdn.example/a.mp4"]);
  });
});
