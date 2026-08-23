import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { AppError } from "../errors.ts";
import {
  safeHttpRequest,
  setSafeHttpTestHooks,
  type DnsAnswer,
} from "./safe-http.server.ts";

const PUBLIC: DnsAnswer = { address: "8.8.8.8", family: 4 };

function answersFor(hostname: string, table: Record<string, DnsAnswer[]>): DnsAnswer[] {
  const found = table[hostname];
  if (!found) throw new Error(`unexpected lookup ${hostname}`);
  return found;
}

describe("safe HTTP transport", () => {
  afterEach(() => {
    setSafeHttpTestHooks(null);
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
});
