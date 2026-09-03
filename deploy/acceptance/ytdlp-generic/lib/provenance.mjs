// Tamper-evident acceptance artifacts (§22-§29 of CORRECTION-02).
//
// Strict schema validation is not provenance. A hand-written record with the
// right field names and types passed the previous aggregator, which violates the
// governing rule that no arbitrary operator JSON assertion may create a PASS.
//
// Every Stage A record and every Stage B case record is sealed with an
// HMAC-SHA256 over a canonical encoding of the COMPLETE record, excluding only
// the authenticator field itself.
//
// Editing anything — a check outcome, a runtime version, a digest, a PID, a
// transition, the case name, the nested binding, a timestamp — invalidates the
// seal, and an unverifiable record is rejected outright rather than partially
// consumed. Excluding one field rather than enumerating many also means a field
// added to the record later is authenticated automatically.
//
// ── The key ────────────────────────────────────────────────────────────────
//
// A per-run, acceptance-only random key. It is deliberately NOT any application
// credential: reusing `WORKER_CONTROL_SECRET`, `VIDEOFETCH_ACCESS_SECRET` or an
// R2/Cloudflare/Vercel credential would give the acceptance harness a reason to
// hold production secrets it otherwise has no need for, and would make a leak of
// the harness's own state file a production incident.
//
// It exists only to make the operator's own multi-run artifacts self-consistent
// across the separate CLI invocations Stage B requires. It is not a defence
// against an operator who wants to forge their own acceptance — nothing local
// can be — it is a defence against an artifact being edited, mixed between runs,
// or carried over from a different image without anyone noticing.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Bumped by CORRECTION-03: the authenticated material changed from a named
 * subset to the whole record, so artifacts from the previous schema are not
 * interchangeable with these and must not be silently accepted.
 */
export const EVIDENCE_SCHEMA_VERSION = "10c4-correction-03";
export const HARNESS_ID = "deploy/acceptance/ytdlp-generic/acceptance.mjs";
export const AUTHENTICATOR_ALG = "HMAC-SHA256";

/** `sha256:<64 hex>` — the only image identity shape the binding accepts. */
export const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
/** An abbreviated-or-full git object name. */
export const SHA_PATTERN = /^[0-9a-f]{7,40}$/;

/**
 * The EXACT run-id grammar this harness produces (§16 of CORRECTION-06).
 *
 * `loadOrCreateRun` mints `randomBytes(8).toString("hex")` — sixteen lowercase
 * hex characters — so that is what an existing run identity must be. The
 * previous admission test was `typeof runId === "string"`, which accepted `""`,
 * `"abc"`, and anything else a damaged or hand-edited file happened to carry.
 *
 * That mattered beyond tidiness: `runId` is inside the authenticated material
 * and is compared across artifacts to prove they belong to one acceptance run.
 * An identity the harness could never have generated is not a run identity, and
 * accepting one lets a malformed file continue as though it were intact.
 */
export const RUN_ID_PATTERN = /^[0-9a-f]{16}$/;

/** The acceptance-only HMAC key: 256 bits, lowercase hex. */
export const RUN_KEY_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Deterministic JSON encoding.
 *
 * Object keys are sorted at every depth, so a record that round-trips through a
 * different serializer still authenticates. Without this the seal would depend
 * on key insertion order, and an operator opening a record in an editor could
 * invalidate it by accident — which would train people to ignore the check.
 */
export function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
}

/**
 * The material the authenticator covers: the COMPLETE record, minus only the
 * authenticator itself (§22 of CORRECTION-03).
 *
 * The previous version enumerated a subset — harness, schema, run, stage, case,
 * identity, verdict, payload — which left `checks[]`, `runtime`, `services`,
 * `delivery`, `process`, the nested `binding` and every timestamp OUTSIDE the
 * seal. All of those are acceptance-relevant, and an editable `checks[0].outcome`
 * is exactly the kind of field the seal exists to protect.
 *
 * Enumerating is also the wrong shape: a field added to the record later would
 * silently fall outside the authenticator. Excluding one field instead means
 * every future field is authenticated by default.
 */
export function authenticatedMaterial(record) {
  const material = {};
  for (const [key, value] of Object.entries(record ?? {})) {
    if (key === "authenticator") continue;
    material[key] = value;
  }
  return canonicalize(material);
}

/** Seals a record. Returns a NEW object; the input is not mutated. */
export function sealRecord(record, key) {
  if (typeof key !== "string" || key.length < 32) {
    throw new Error("refusing to seal an acceptance record without a run key");
  }
  const mac = createHmac("sha256", Buffer.from(key, "hex"))
    .update(authenticatedMaterial(record), "utf8")
    .digest("hex");
  return { ...record, authenticator: { alg: AUTHENTICATOR_ALG, mac } };
}

/**
 * Verifies a record's seal.
 *
 * Constant-time comparison, and a length check first because `timingSafeEqual`
 * throws on a length mismatch — which an attacker-controlled `mac` field could
 * otherwise use to turn a verification failure into a crash.
 */
export function verifySeal(record, key) {
  const provided = record?.authenticator;
  if (!provided || provided.alg !== AUTHENTICATOR_ALG || typeof provided.mac !== "string") {
    return { ok: false, reason: "the record carries no usable authenticator" };
  }
  if (!/^[0-9a-f]{64}$/.test(provided.mac)) {
    return { ok: false, reason: "the record's authenticator is malformed" };
  }
  let expected;
  try {
    expected = createHmac("sha256", Buffer.from(key, "hex"))
      .update(authenticatedMaterial(record), "utf8")
      .digest("hex");
  } catch {
    return { ok: false, reason: "the acceptance run key is unusable" };
  }
  const a = Buffer.from(provided.mac, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return {
      ok: false,
      reason: "the record's authenticator does not match its contents (edited, or from another run)",
    };
  }
  return { ok: true };
}

/**
 * Verifies a record's seal AND that it belongs to this acceptance run and this
 * deployment (§26).
 *
 * Order matters: authenticity first. Reading binding fields out of an
 * unverified record and comparing them would be trusting the very thing under
 * test.
 */
export function verifyRecord(record, key, expected) {
  const sealed = verifySeal(record, key);
  if (!sealed.ok) return sealed;

  if (record.harness !== HARNESS_ID) {
    return { ok: false, reason: "the record was not produced by this harness" };
  }
  if (record.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `record schema ${String(record.schemaVersion)} is not ${EVIDENCE_SCHEMA_VERSION}`,
    };
  }
  if (record.runId !== expected.runId) {
    return { ok: false, reason: "the record belongs to a different acceptance run" };
  }
  if (record.expectedSha !== expected.expectedSha) {
    return {
      ok: false,
      reason: `the record binds to source ${String(record.expectedSha)}, not to ${expected.expectedSha}`,
    };
  }
  if (!IMAGE_ID_PATTERN.test(String(record.runningImageId))) {
    return { ok: false, reason: "the record carries no valid running image identity" };
  }
  if (expected.runningImageId && record.runningImageId !== expected.runningImageId) {
    return { ok: false, reason: "the record was produced against a different image object" };
  }
  return { ok: true };
}

/**
 * §23 of CORRECTION-03 — the top-level identity and the nested binding must
 * AGREE.
 *
 * Both are inside the authenticated material, so neither can be edited without
 * invalidating the seal. This check catches the remaining case: a record sealed
 * with two internally inconsistent copies of the same identity, where a reader
 * looking at one and a verifier looking at the other would disagree.
 */
export function bindingAgreesWithRecord(record) {
  const binding = record?.binding;
  if (!binding || typeof binding !== "object") {
    return { ok: false, reason: "the record carries no deployment binding" };
  }
  for (const field of ["expectedSha", "runningImageId", "taggedImageId"]) {
    if (record[field] !== binding[field]) {
      return {
        ok: false,
        reason: `record.${field} disagrees with binding.${field}`,
      };
    }
  }
  return { ok: true };
}

// ── The run key ────────────────────────────────────────────────────────────

/**
 * The permission property both run-key entry points must enforce (§26 of
 * CORRECTION-04).
 *
 * A run key readable by any other local account defeats the seal entirely: that
 * account could re-seal edited artifacts and the aggregator would accept them.
 * CORRECTION-03 checked this in `loadRun` only, which left two holes — Stage A
 * silently RESUMED an already-insecure key, and a `stat` that failed for any
 * reason was treated as "probably fine".
 *
 * Now: three distinct answers, and only one of them is permissive.
 *
 *   absent   — nothing to judge; the caller may mint a fresh key
 *   ok       — the mode was measured and is private
 *   error    — insecure, OR unmeasurable
 *
 * Unmeasurable fails closed because "we could not read the permissions" is not
 * "the permissions are fine" — that is the same SKIPPED->PASS edge the whole
 * harness refuses elsewhere.
 */
async function inspectRunKeyPermissions(path, statFile) {
  let stats;
  try {
    stats = await statFile(path);
  } catch (error) {
    // ENOENT is a genuine answer, not a measurement failure: there is no file,
    // so there are no permissions to be wrong.
    if (error?.code === "ENOENT") return { absent: true };
    return {
      error:
        `the permissions of the acceptance run key at ${path} could not be measured ` +
        `(${String(error?.code ?? error?.message ?? error)}); refusing to use a key whose ` +
        "privacy is unknown",
    };
  }

  const mode = stats?.mode;
  if (typeof mode !== "number") {
    return {
      error:
        `the acceptance run key at ${path} reported no file mode, so its privacy could not be ` +
        "established; refusing to use it",
    };
  }
  const permissions = mode & 0o777;
  if ((permissions & 0o077) !== 0) {
    return {
      error:
        `the acceptance run key at ${path} is mode ${permissions.toString(8).padStart(3, "0")}; ` +
        "it must not be group- or world-accessible",
    };
  }
  return { ok: true };
}

/**
 * Reads and structurally validates an EXISTING run-key file (§23 of
 * CORRECTION-05).
 *
 * Every failure is an error, never a reason to mint. The previous version fell
 * through to "mint a fresh run" on unreadable content or malformed JSON, which
 * OVERWROTE the file — destroying the only key that could verify the artifacts
 * already sealed under it, and doing so silently at the exact moment something
 * was already wrong. A damaged acceptance identity is the operator's to
 * archive or delete; the harness stops and says so.
 */
async function readExistingRun(path, read) {
  let contents;
  try {
    contents = await read(path, "utf8");
  } catch (error) {
    return {
      error:
        `the acceptance run key at ${path} exists but could not be read ` +
        `(${String(error?.code ?? error?.message ?? error)}); refusing to replace it`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return {
      error:
        `the acceptance run key at ${path} exists but is not valid JSON. Refusing to overwrite ` +
        "it: the artifacts already sealed under this run could only ever be verified with the " +
        "key it holds. Archive or delete it deliberately, then re-run Stage A.",
    };
  }

  // BOTH fields must match the exact grammar the harness itself produces.
  if (!RUN_ID_PATTERN.test(String(parsed?.runId ?? "")) || !RUN_KEY_PATTERN.test(String(parsed?.key ?? ""))) {
    return {
      error:
        `the acceptance run key at ${path} exists but does not carry a usable runId (16 lowercase ` +
        "hex characters) and 256-bit key (64 lowercase hex characters). Refusing to overwrite it; " +
        "archive or delete it deliberately, then re-run Stage A.",
    };
  }

  return { runId: parsed.runId, key: parsed.key };
}

/**
 * Creates or loads the acceptance run identity.
 *
 * The file holds a random `runId` and a 256-bit key, is written `0600`, and is
 * never printed, never committed, and never placed in any evidence record. Only
 * the `runId` — which is not secret — travels with the artifacts.
 *
 * §26 of CORRECTION-04: an EXISTING key is subject to the same permission
 * property as `loadRun` enforces. §23 of CORRECTION-05: a file that EXISTS is
 * never replaced, whatever is wrong with it.
 *
 * ENOENT is the only condition that mints a new run.
 *
 * The operator deletes it when acceptance is complete; the README says so.
 */
export async function loadOrCreateRun(path, deps = {}) {
  const read = deps.readFile ?? readFile;
  const write = deps.writeFile ?? writeFile;
  const makeDir = deps.mkdir ?? mkdir;
  const setMode = deps.chmod ?? chmod;
  const statFile = deps.stat ?? stat;

  const permissions = await inspectRunKeyPermissions(path, statFile);
  if (permissions.error) return { error: permissions.error };

  if (!permissions.absent) {
    const existing = await readExistingRun(path, read);
    if (existing.error) return { error: existing.error };
    return { runId: existing.runId, key: existing.key, created: false };
  }

  const runId = randomBytes(8).toString("hex");
  const key = randomBytes(32).toString("hex");
  try {
    await makeDir(dirname(path), { recursive: true });
  } catch {
    /* the directory already exists */
  }
  await write(path, `${JSON.stringify({ runId, key }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  // `mode` on write is masked by the process umask, so it is asserted after.
  await setMode(path, 0o600);
  return { runId, key, created: true };
}

/**
 * Loads an EXISTING run without creating one.
 *
 * Stage B cases and the aggregation must join the run Stage A began; silently
 * minting a new key here would make every prior artifact unverifiable and, worse,
 * would let a re-keyed run re-seal edited records.
 *
 * A file that exists but is damaged is an ERROR here too, not a `null`: `null`
 * means "no run has been started", which would send the operator to re-run
 * Stage A and quietly overwrite the very file that needed attention.
 */
export async function loadRun(path, deps = {}) {
  const read = deps.readFile ?? readFile;
  const statFile = deps.stat ?? stat;

  const permissions = await inspectRunKeyPermissions(path, statFile);
  if (permissions.error) return { error: permissions.error };
  // No key file at all is not an error here — the caller reports the missing
  // run, which is a different and more actionable message.
  if (permissions.absent) return null;

  const existing = await readExistingRun(path, read);
  if (existing.error) return { error: existing.error };
  return { runId: existing.runId, key: existing.key };
}

/** A non-secret fingerprint safe to place in evidence, for correlating artifacts. */
export function runFingerprint(runId) {
  return typeof runId === "string" ? runId.slice(0, 12) : null;
}

/**
 * The Stage A deployment binding (§27).
 *
 * Every field is required and shape-checked. A record whose `runningImageId` is
 * `null` — which the previous implementation happily produced when the container
 * was not inspectable — must never authorize Stage B, because it proves nothing
 * about which image Stage A actually graded.
 */
export function validateDeploymentBinding(binding, expectedSha) {
  if (!binding || typeof binding !== "object") {
    return { ok: false, reason: "the record carries no deployment binding" };
  }
  if (!SHA_PATTERN.test(String(binding.expectedSha))) {
    return { ok: false, reason: "the binding carries no valid expected source SHA" };
  }
  if (expectedSha && binding.expectedSha !== expectedSha) {
    return {
      ok: false,
      reason: `the binding is for source ${binding.expectedSha}, not ${expectedSha}`,
    };
  }
  if (!IMAGE_ID_PATTERN.test(String(binding.runningImageId))) {
    return { ok: false, reason: "the binding carries no valid running image id" };
  }
  if (!IMAGE_ID_PATTERN.test(String(binding.taggedImageId))) {
    return { ok: false, reason: "the binding carries no valid SHA-tagged image id" };
  }
  if (binding.runningImageId !== binding.taggedImageId) {
    return {
      ok: false,
      reason: "the running image is not the image tagged with the authorized source SHA",
    };
  }
  return { ok: true };
}
