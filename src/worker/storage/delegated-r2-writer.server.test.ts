import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  DelegatedR2Error,
  DelegatedR2ObjectStoreWriter,
} from "./delegated-r2-writer.server.ts";
import type { CloudflareR2Config } from "./cloudflare-r2-writer.server.ts";
import type { R2CredentialProvider, R2CredentialRequestInput } from "./credential-provider.ts";
import { deriveCredentialTtlSeconds } from "./credential-provider.ts";
import type { ObjectStoreHead, ObjectStorePutInput, ObjectStoreWriter } from "./writer.ts";
import type { WorkerObjectKey } from "../../shared/worker/contracts.ts";
import {
  R2_CREDENTIAL_TTL_CEILING_SECONDS,
  R2_CREDENTIAL_TTL_FLOOR_SECONDS,
} from "../../shared/worker/r2-broker.ts";

/**
 * Per-operation credential delegation behind the UNCHANGED `ObjectStoreWriter`
 * contract. Fake deterministic credentials only; nothing here reaches R2.
 */

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const BUCKET = "videofetch-objects";
const JOB_ID = "a".repeat(32);
const KEY = `videofetch/jobs/${JOB_ID}/${"b".repeat(32)}` as WorkerObjectKey;
const NOW = 1_700_000_000_000;

type Mint = R2CredentialRequestInput;

function recordingProvider(
  mints: Mint[],
  overrides: { expiresAt?: number; sessionToken?: string; fail?: boolean } = {},
): R2CredentialProvider {
  return {
    async mint(request) {
      mints.push(request);
      if (overrides.fail) throw new Error("broker down");
      return {
        accessKeyId: "fake-delegated-key-id",
        secretAccessKey: "fake-delegated-secret",
        sessionToken: overrides.sessionToken ?? `fake-session-token-${request.action}`,
        expiresAt: overrides.expiresAt ?? NOW + request.ttlSeconds * 1000,
      };
    },
  };
}

type Call = { op: string; key: string };

function recordingWriterFactory(
  configs: CloudflareR2Config[],
  calls: Call[],
  headResult: ObjectStoreHead | null = null,
): (config: CloudflareR2Config) => ObjectStoreWriter {
  return (config) => {
    configs.push(config);
    return {
      async put(input: ObjectStorePutInput) {
        calls.push({ op: "put", key: input.objectKey });
      },
      async head(objectKey: WorkerObjectKey) {
        calls.push({ op: "head", key: objectKey });
        return headResult;
      },
      async delete(objectKey: WorkerObjectKey) {
        calls.push({ op: "delete", key: objectKey });
      },
    };
  };
}

function makeWriter(
  provider: R2CredentialProvider,
  factory: (config: CloudflareR2Config) => ObjectStoreWriter,
  jobDeadlineAt?: (jobId: string) => number | null,
) {
  return new DelegatedR2ObjectStoreWriter({
    location: { accountId: ACCOUNT_ID, bucket: BUCKET, jurisdiction: "default" },
    credentials: provider,
    clock: () => NOW,
    createWriter: factory,
    ...(jobDeadlineAt ? { jobDeadlineAt } : {}),
  });
}

function putInput(objectKey: string = KEY): ObjectStorePutInput {
  return {
    objectKey: objectKey as WorkerObjectKey,
    body: Readable.from([Buffer.from("payload")]) as unknown as AsyncIterable<Uint8Array>,
    contentLength: 7,
    contentType: "video/mp4",
    contentDisposition: 'attachment; filename="v.mp4"',
  };
}

describe("DelegatedR2ObjectStoreWriter", () => {
  it("maps each operation onto exactly its own S3 action", async () => {
    const mints: Mint[] = [];
    const configs: CloudflareR2Config[] = [];
    const calls: Call[] = [];
    const writer = makeWriter(
      recordingProvider(mints),
      recordingWriterFactory(configs, calls, {
        objectKey: KEY,
        contentLength: 7,
        contentType: "video/mp4",
        contentDisposition: 'attachment; filename="v.mp4"',
      }),
    );

    await writer.put(putInput());
    await writer.head(KEY);
    await writer.delete(KEY);

    assert.deepEqual(
      mints.map((m) => m.action),
      ["PutObject", "HeadObject", "DeleteObject"],
      "put -> PutObject, head -> HeadObject, delete -> DeleteObject",
    );
    // Every mint names the one exact key the operation touches.
    assert.deepEqual(new Set(mints.map((m) => m.objectKey)), new Set([KEY]));
    assert.deepEqual(
      calls,
      [
        { op: "put", key: KEY },
        { op: "head", key: KEY },
        { op: "delete", key: KEY },
      ],
    );
  });

  it("mints a FRESH credential for every operation", async () => {
    const mints: Mint[] = [];
    const configs: CloudflareR2Config[] = [];
    const writer = makeWriter(
      recordingProvider(mints),
      recordingWriterFactory(configs, []),
    );

    await writer.delete(KEY);
    await writer.delete(KEY);
    await writer.delete(KEY);

    assert.equal(mints.length, 3, "no credential is cached across operations");
    assert.equal(configs.length, 3, "a writer is built per operation");
  });

  it("supplies the session token to the S3 client configuration", async () => {
    const configs: CloudflareR2Config[] = [];
    const writer = makeWriter(recordingProvider([]), recordingWriterFactory(configs, []));

    await writer.put(putInput());

    assert.equal(configs.length, 1);
    assert.equal(configs[0].sessionToken, "fake-session-token-PutObject");
    assert.equal(configs[0].accessKeyId, "fake-delegated-key-id");
    assert.equal(configs[0].secretAccessKey, "fake-delegated-secret");
    assert.equal(configs[0].bucket, BUCKET);
    assert.equal(configs[0].accountId, ACCOUNT_ID);
  });

  it("rejects a malformed object key BEFORE asking the broker", async () => {
    const mints: Mint[] = [];
    const configs: CloudflareR2Config[] = [];
    const writer = makeWriter(recordingProvider(mints), recordingWriterFactory(configs, []));

    const malformed = [
      "",
      "not-a-key",
      `videofetch/jobs/${JOB_ID}`,
      `videofetch/jobs/${JOB_ID}/${"b".repeat(31)}`,
      `../videofetch/jobs/${JOB_ID}/${"b".repeat(32)}`,
      `videofetch/jobs/${JOB_ID}/${"b".repeat(32)}/x`,
    ];

    for (const key of malformed) {
      await assert.rejects(() => writer.head(key as WorkerObjectKey), DelegatedR2Error);
      await assert.rejects(() => writer.delete(key as WorkerObjectKey), DelegatedR2Error);
      await assert.rejects(() => writer.put(putInput(key)), DelegatedR2Error);
    }

    assert.deepEqual(mints, [], "a malformed key never reaches the broker");
    assert.deepEqual(configs, [], "and never builds an S3 client");
  });

  it("fails the operation CLOSED when the broker is unavailable", async () => {
    const configs: CloudflareR2Config[] = [];
    const calls: Call[] = [];
    const writer = makeWriter(
      recordingProvider([], { fail: true }),
      recordingWriterFactory(configs, calls),
    );

    for (const op of [
      () => writer.put(putInput()),
      () => writer.head(KEY),
      () => writer.delete(KEY),
    ]) {
      await assert.rejects(op, (err: unknown) => {
        assert.ok(err instanceof DelegatedR2Error);
        assert.equal(err.failure, "credential_unavailable");
        return true;
      });
    }

    // No fallback: nothing was attempted against R2 without a credential.
    assert.deepEqual(configs, [], "no S3 client is built without a credential");
    assert.deepEqual(calls, [], "no R2 operation is attempted");
  });

  it("refuses an already-expired credential before touching R2", async () => {
    const configs: CloudflareR2Config[] = [];
    const calls: Call[] = [];

    for (const expiresAt of [NOW, NOW - 1, NOW - 60_000]) {
      const writer = makeWriter(
        recordingProvider([], { expiresAt }),
        recordingWriterFactory(configs, calls),
      );
      await assert.rejects(() => writer.delete(KEY), (err: unknown) => {
        assert.ok(err instanceof DelegatedR2Error);
        assert.equal(err.failure, "credential_unavailable");
        return true;
      });
    }

    assert.deepEqual(configs, [], "an expired credential never reaches an S3 client");
    assert.deepEqual(calls, []);
  });

  it("preserves head()'s missing-object contract", async () => {
    const writer = makeWriter(
      recordingProvider([]),
      recordingWriterFactory([], [], null),
    );
    assert.equal(await writer.head(KEY), null, "a missing object is still null, not an error");
  });

  it("shortens the TTL to the remaining job lifetime", async () => {
    const mints: Mint[] = [];
    // 200 seconds of job life left, well under the PutObject ceiling.
    const writer = makeWriter(
      recordingProvider(mints),
      recordingWriterFactory([], []),
      () => NOW + 200_000,
    );

    await writer.put(putInput());
    assert.equal(mints[0].ttlSeconds, 200, "TTL follows the remaining job lifetime");
  });

  it("caps the TTL at the per-action ceiling however long the job lives", async () => {
    const mints: Mint[] = [];
    const writer = makeWriter(
      recordingProvider(mints),
      recordingWriterFactory([], []),
      () => NOW + 30 * 24 * 60 * 60 * 1000, // a month
    );

    await writer.put(putInput());
    await writer.head(KEY);
    await writer.delete(KEY);

    assert.equal(mints[0].ttlSeconds, R2_CREDENTIAL_TTL_CEILING_SECONDS.PutObject);
    assert.equal(mints[1].ttlSeconds, R2_CREDENTIAL_TTL_CEILING_SECONDS.HeadObject);
    assert.equal(mints[2].ttlSeconds, R2_CREDENTIAL_TTL_CEILING_SECONDS.DeleteObject);
  });

  it("still mints a short DeleteObject credential for an ALREADY EXPIRED job", async () => {
    // This is the maintenance path: the job expired long ago, so the remaining
    // lifetime is negative. Cleanup must still be possible, with a fresh
    // delete-only credential rather than a stale upload one.
    const mints: Mint[] = [];
    const writer = makeWriter(
      recordingProvider(mints),
      recordingWriterFactory([], []),
      () => NOW - 24 * 60 * 60 * 1000,
    );

    await writer.delete(KEY);

    assert.equal(mints.length, 1);
    assert.equal(mints[0].action, "DeleteObject");
    assert.equal(mints[0].ttlSeconds, R2_CREDENTIAL_TTL_FLOOR_SECONDS);
  });

  it("falls back to the action ceiling when the job row is gone", async () => {
    const mints: Mint[] = [];
    const writer = makeWriter(recordingProvider(mints), recordingWriterFactory([], []), () => null);

    await writer.delete(KEY);
    assert.equal(mints[0].ttlSeconds, R2_CREDENTIAL_TTL_CEILING_SECONDS.DeleteObject);
  });

  it("survives a throwing deadline lookup without failing the operation", async () => {
    const mints: Mint[] = [];
    const writer = makeWriter(recordingProvider(mints), recordingWriterFactory([], []), () => {
      throw new Error("store unavailable");
    });

    await writer.delete(KEY);
    assert.equal(mints[0].ttlSeconds, R2_CREDENTIAL_TTL_CEILING_SECONDS.DeleteObject);
  });
});

describe("credential TTL derivation", () => {
  it("always lands inside the policy window", () => {
    const cases = [
      -Number.MAX_SAFE_INTEGER,
      -1,
      0,
      NOW - 10_000,
      NOW + 1,
      NOW + 1_000,
      NOW + 500_000,
      NOW + 10_000_000,
      Number.MAX_SAFE_INTEGER,
    ];
    for (const action of ["PutObject", "HeadObject", "DeleteObject"] as const) {
      for (const jobDeadlineMs of [...cases, null]) {
        const ttl = deriveCredentialTtlSeconds({ action, nowMs: NOW, jobDeadlineMs });
        assert.ok(
          ttl >= R2_CREDENTIAL_TTL_FLOOR_SECONDS &&
            ttl <= R2_CREDENTIAL_TTL_CEILING_SECONDS[action],
          `${action} ttl ${ttl} escaped the window for deadline ${jobDeadlineMs}`,
        );
        assert.ok(Number.isSafeInteger(ttl));
      }
    }
  });
});
