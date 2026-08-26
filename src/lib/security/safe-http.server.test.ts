import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { AppError } from "../errors.ts";
import {
  buildPinnedRequestOptions,
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
