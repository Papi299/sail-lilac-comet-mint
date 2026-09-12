// The SPLIT-06 deterministic local `ObjectStoreWriter`.
//
// ── What it substitutes, and what it does not ──────────────────────────────
//
// EXACTLY ONE thing: the external object-storage PROVIDER. Cloudflare R2 is
// replaced by a task-owned local sink so the acceptance run needs no network,
// no credential and no broker.
//
// Everything on the Worker's side of that boundary stays real and is exercised
// by this writer rather than bypassed by it:
//
//   `beginUploading()`              the durable transition
//   the upload body stream          `createReadStream` over the merged file
//   `contentLength`                 the validated local output size
//   the object key                  `generateWorkerObjectKey`
//   `contentType` / disposition     `mimeForContainer` / `buildAttachment…`
//   `finalizeJobUpload`             put -> head -> compare -> commit ready
//
// So a SPLIT-06 pass is NOT R2 acceptance, and the report says so. It is proof
// that the Worker's upload lifecycle drove a conforming writer end to end with
// exact byte fidelity.
//
// ── HEAD reports what is STORED, never what was declared ───────────────────
//
// `finalizeJobUpload` puts, then HEADs, then compares the head's
// `contentLength` with the `fileSize` it expected. That comparison is the
// lifecycle's proof that the provider holds what the Worker produced, and it
// proves something only if the head is a second, INDEPENDENT observation of
// the stored object. That is what R2 gives the real writer: `HeadObject`'s
// `ContentLength` is R2's own measurement, not an echo of the PUT.
//
// So this writer keeps three numbers apart:
//
//   declaredLength        what the caller's put said it would send
//   observedBytes         what this writer counted while consuming the body
//   head().contentLength  `lstat()` of the persisted sink file, taken at HEAD
//                         time — neither the declaration nor the counter
//
// A HEAD that echoed the declaration would let the lifecycle compare its
// expectation with itself, and a truncated upload would reach `ready`.
// Measuring the stored object is what lets the REAL lifecycle refuse it.
//
// `contentType` and `contentDisposition` are replayed from what the put stored,
// as a real provider replays the metadata it persisted with the object.
//
// ── Why it validates its own input ─────────────────────────────────────────
//
// `finalizeJobUpload` already parses the put candidate through
// `ObjectStorePutInputSchema` before calling the writer. This writer parses it
// AGAIN, because it is a provider boundary: a provider that trusted its caller
// would make "the lifecycle validated it" the only guarantee, and the mutation
// battery has to be able to break the lifecycle and see the writer notice.
//
// ── What it deliberately does not have ─────────────────────────────────────
//
// No list operation, no prefix delete, no presigned URL, no public read — the
// same absences the real `ObjectStoreWriter` interface requires. `delete` takes
// one exact key and removes that key alone.

import { createHash } from "node:crypto";
import { lstat, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ObjectStorePutInputSchema } from "../../../../src/worker/storage/writer.ts";
import { WorkerObjectKeySchema } from "../../../../src/shared/worker/contracts.ts";

/**
 * A local sink directory holding at most the objects this run uploaded.
 *
 * @param {object} opts
 * @param {string} opts.sinkDir     task-owned directory; created if absent
 * @param {(input: object) => void} [opts.onPut]
 *        Invoked at the START of `put`, BEFORE the body is consumed, with the
 *        validated input. SPLIT-06 uses it to query the ACTUAL durable store
 *        at the exact moment the provider is asked to accept bytes.
 */
export function createLocalObjectStoreWriter({ sinkDir, onPut }) {
  if (typeof sinkDir !== "string" || sinkDir.length === 0) {
    throw new Error("the local object writer needs a task-owned sink directory");
  }

  /** @type {Map<string, {objectKey:string, declaredLength:number, observedBytes:number, contentType:string, contentDisposition:string, sha256:string, path:string}>} */
  const objects = new Map();
  const puts = [];
  const heads = [];
  const deletes = [];

  /** One object key becomes one flat filename; the key never becomes a path. */
  const sinkPathFor = (objectKey) =>
    join(sinkDir, `${createHash("sha256").update(objectKey).digest("hex")}.object`);

  /** The stored object's size, measured now; null when it no longer exists. */
  async function persistedSize(record) {
    let info;
    try {
      info = await lstat(record.path);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    // Anything but a plain file is an operational failure, not "missing".
    if (!info.isFile()) throw new Error("the persisted object is not a regular file");
    return info.size;
  }

  return {
    async put(input) {
      // Re-parsed at the provider boundary, never trusted. A malformed
      // candidate is refused here even if the lifecycle let it through.
      const parsed = ObjectStorePutInputSchema.parse(input);

      // The observation hook runs BEFORE a single byte is consumed, so a
      // durable status read here describes the state the Worker was in when it
      // asked for the upload, not one it reached during the transfer.
      if (onPut) onPut(parsed);

      const hash = createHash("sha256");
      const chunks = [];
      let observedBytes = 0;
      for await (const chunk of parsed.body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(buf);
        chunks.push(buf);
        observedBytes += buf.byteLength;
      }
      const body = Buffer.concat(chunks, observedBytes);

      await mkdir(sinkDir, { recursive: true });
      const path = sinkPathFor(parsed.objectKey);
      await writeFile(path, body);

      const record = {
        objectKey: parsed.objectKey,
        // The caller's declaration, kept apart from every measurement. `head`
        // never reads it.
        declaredLength: parsed.contentLength,
        observedBytes,
        contentType: parsed.contentType,
        contentDisposition: parsed.contentDisposition,
        sha256: hash.digest("hex"),
        path,
      };
      objects.set(parsed.objectKey, record);
      puts.push({
        objectKey: parsed.objectKey,
        declaredLength: parsed.contentLength,
        declaredContentType: parsed.contentType,
        declaredContentDisposition: parsed.contentDisposition,
        observedBytes,
      });
    },

    async head(objectKey) {
      const key = WorkerObjectKeySchema.parse(objectKey);
      const record = objects.get(key);
      // A second, independent observation of the STORED object: its length
      // comes from the persisted file, measured at HEAD time.
      const contentLength = record ? await persistedSize(record) : null;
      if (!record || contentLength === null) {
        heads.push({ objectKey: key, contentLength: null, contentType: null, contentDisposition: null });
        return null;
      }
      const head = {
        objectKey: record.objectKey,
        contentLength,
        contentType: record.contentType,
        contentDisposition: record.contentDisposition,
      };
      heads.push({ ...head });
      return head;
    },

    async delete(objectKey) {
      // EXACTLY one key. There is no prefix form and no wildcard, so there is
      // nothing to get wrong about which objects a delete reaches.
      const key = WorkerObjectKeySchema.parse(objectKey);
      const record = objects.get(key);
      deletes.push(key);
      if (!record) return;
      objects.delete(key);
      await rm(record.path, { force: true });
    },

    // ── harness-only observation, never part of the interface ─────────────

    /** Every object still held, as sanitized records. */
    inventory() {
      return [...objects.values()].map((r) => ({ ...r }));
    },
    /** The one object this run uploaded, or null when the count is not one. */
    soleObject() {
      return objects.size === 1 ? { ...[...objects.values()][0] } : null;
    },
    putCount() {
      return puts.length;
    },
    putLog() {
      return puts.map((p) => ({ ...p }));
    },
    /** Every head answered, including the misses, in order. */
    headLog() {
      return heads.map((h) => ({ ...h }));
    },
    deleteLog() {
      return [...deletes];
    },
  };
}
