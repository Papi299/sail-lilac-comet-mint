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
import { chmod, lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The ACCEPTANCE PRODUCER CONTRACT this harness implements — not merely the set
 * of JSON keys its records carry (§3-§7 of CORRECTION-08).
 *
 * ── What a valid seal does and does not prove ──────────────────────────────
 *
 * A valid HMAC proves only:
 *
 *     this artifact has not changed since somebody holding this run key
 *     produced it
 *
 * It says nothing about WHICH revision of the harness's observation semantics
 * produced the contents it authenticates. That is this constant's job, and it
 * is the only field that can do it.
 *
 * ── Why it had to move, even though the JSON shape did not ─────────────────
 *
 * Stage B case records are rejected structurally when a required field is
 * absent, so an older case artifact cannot pass today's `validateCaseRecord`.
 * STAGE A IS DIFFERENT. Its record's shape has not changed since
 * CORRECTION-03, so an artifact produced by an older harness revision could
 * carry the same runId, the same key, the same source SHA, the same image
 * binding, a `PASS` verdict and this exact identifier — and therefore still
 * satisfy `loadStageA()` and AUTHORIZE CURRENT STAGE B.
 *
 * What that artifact would actually attest is much weaker, because the
 * semantics behind those same fields have changed materially since:
 *
 *   CORRECTION-04  effective deployed MAX_FILE_SIZE; closed deny-class enum;
 *                  fail-closed host process parsing; state-neutral aggregation
 *   CORRECTION-05  narrow secret-safe environment probes (the previous Stage A
 *                  retrieved the COMPLETE environment, values and all);
 *                  image continuity; deterministic restart recovery
 *   CORRECTION-06  positive findings outranking observation gaps; the exact
 *                  `docker top` argv boundary; feature-state continuity
 *   CORRECTION-07  raw evidence validated before normalization; successful exit
 *                  required before stdout is a measurement; container-epoch
 *                  continuity; type-strict run identity; atomic key creation
 *   10D-REM-01     the durable observer can address the deployment AT ALL. The
 *                  producer behind every `durable.*` claim and the sentinel's
 *                  `durable-row` surface previously named a database file that
 *                  does not exist, a table that does not exist, and an
 *                  executable that is not installed on the VM. Any artifact
 *                  from before this could only ever have carried those checks
 *                  as BLOCKED, for a reason describing the instrument rather
 *                  than the deployment.
 *
 *   10D-REM-02     THREE Stage-A observers were measuring the instrument
 *                  rather than the deployment, and the first authenticated
 *                  Stage-A run (`5e6670a858543d93`) proved it by failing a
 *                  healthy deployment:
 *
 *                    `worker.network-mode` compared against
 *                    `container:videofetch-media-netns`, a string Docker never
 *                    emits for a running container — it stores the resolved
 *                    64-hex target id. It now proves the shared namespace from
 *                    Docker's target identity AND both `/proc/<pid>/ns/net`
 *                    identities, so a PASS means materially more than before.
 *
 *                    `runtime.bundled-ejs` imported `yt_dlp_ejs.__version__`,
 *                    which pinned EJS 0.8.0 does not expose, so the probe's own
 *                    ImportError was reported as the runtime being unavailable.
 *
 *                    Both `worker-env.*` checks ran a probe whose Python source
 *                    was a `SyntaxError`, because a JavaScript `\n` had put a
 *                    real newline inside a `"` literal. The environment names
 *                    were never read at all.
 *
 *                  An artifact from before this could only ever have carried
 *                  those four checks as FAIL or BLOCKED for reasons describing
 *                  the harness. Under the corrected observers the same shape
 *                  means something strictly stronger.
 *
 * A Stage A `PASS` from before those is not the Stage A `PASS` this harness
 * means, and nothing in the record itself distinguishes them.
 *
 *   10D-REM-03     The Stage-B success lifecycle previously required every
 *                  durable state to be DIRECTLY SAMPLED. Live run
 *                  `132658924d1c7a1b` disproved that as an observation model:
 *                  a `keep-original` success committed `processing`
 *                  unconditionally and legitimately cleared it between two
 *                  200 ms polls, so a genuinely complete lifecycle recorded
 *                  `queued → analyzing → downloading → uploading → ready`.
 *
 *                  The corrected evaluator allows ONLY `processing` to be
 *                  CAUSALLY PROVEN, and only from a directly observed
 *                  `uploading`, because the exact reviewed Worker store
 *                  enforces `processing → uploading` and offers no
 *                  `downloading → uploading` transition.
 *
 *                  This is the sharpest possible case for the boundary: the
 *                  RAW ARTIFACT IS UNCHANGED, and the acceptance meaning of
 *                  its `job.lifecycle-complete` moves BLOCKED → PASS. Nothing
 *                  in the record's shape, its fields or its seal distinguishes
 *                  the two readings. Only this constant can.
 *
 * ── When to bump it again ──────────────────────────────────────────────────
 *
 * Whenever an observer or evaluator change could make an OLD artifact mean
 * something DIFFERENT under the same shape. A field added or removed is the
 * obvious case; a field whose measurement became stricter is the case that
 * matters, because nothing else catches it — and an evaluator that becomes
 * more PERMISSIVE about the same raw bytes is the same case wearing the
 * opposite sign, and is not exempt.
 *
 * That last direction is the one it is tempting to wave through, so state it
 * plainly. A valid HMAC proves:
 *
 *     this artifact has not changed since it was produced
 *
 * It does NOT prove:
 *
 *     this artifact was produced and evaluated under today's lifecycle
 *     semantics
 *
 * A `10d-remediation-02` success artifact must never silently become
 * ACCEPTABLE under the `10d-remediation-03` evaluator merely because its JSON
 * shape and its seal both remain valid. The seal answers integrity; this
 * constant answers provenance of meaning, and identifying exactly this
 * situation is the entire reason the boundary exists.
 *
 * Two live artifact families are invalidated by these bumps, deliberately.
 *
 *   10D-REM-02  the sealed `10d-remediation-01` record from run
 *               `5e6670a858543d93` — the first authenticated Stage-A attempt,
 *               and the harness defects it exposed.
 *
 *   10D-REM-03  the sealed `10d-remediation-02` records from run
 *               `132658924d1c7a1b` — a Stage-A PASS (23/0/0/0) and a Stage-B
 *               `success` case that genuinely reached `ready` with every byte,
 *               R2 and delivery proof intact. Nothing is wrong with them; they
 *               were simply graded by an evaluator whose lifecycle observation
 *               model has since been corrected.
 *
 * Both remain valid history — cryptographically verifiable accounts of what
 * the harness of their day measured — and `verifyRecord` refuses each on the
 * version boundary alone, independently of its verdict. Neither may be
 * overwritten, resealed, renamed or "upgraded" to the current version: a
 * reseal would forge exactly the provenance of meaning the boundary exists to
 * establish. A corrected Stage A uses a FRESH acceptance run.
 */
export const EVIDENCE_SCHEMA_VERSION = "10d-remediation-03";
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
 * The one message a structurally unusable run-key file produces.
 *
 * Deliberately identical for a bad `runId` and a bad `key`: the operator's
 * action is the same either way, and naming which field was wrong would invite
 * hand-editing the file back into admissibility rather than archiving it.
 */
function malformedRunKeyMessage(path) {
  return (
    `the acceptance run key at ${path} exists but does not carry a usable runId (a STRING of 16 ` +
    "lowercase hex characters) and 256-bit key (a STRING of 64 lowercase hex characters). " +
    "Refusing to overwrite it; archive or delete it deliberately, then re-run Stage A."
  );
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

  // BOTH fields must match the exact grammar the harness itself produces, AND
  // must actually BE strings (§3 of CORRECTION-07).
  //
  // The previous test coerced through `String(...)` first, which is the same
  // laundering mistake as normalizing a `comm` before validating it: the value
  // was transformed into a more admissible shape and the transformed shape was
  // then judged. The concrete escape is a JSON NUMBER —
  //
  //     { "runId": 1234567890123456, "key": "<64 hex>" }
  //
  // — whose string form matches /^[0-9a-f]{16}$/ exactly. It would have been
  // admitted, and then carried into `verifyRecord`, where `record.runId !==
  // expected.runId` compares a string against a number and every artifact of
  // the run becomes unverifiable for a reason nothing reports.
  //
  // `loadOrCreateRun` mints `randomBytes(...).toString("hex")`, so both fields
  // are strings by construction. Requiring the type is requiring what this
  // harness actually produces.
  if (typeof parsed?.runId !== "string" || !RUN_ID_PATTERN.test(parsed.runId)) {
    return { error: malformedRunKeyMessage(path) };
  }
  if (typeof parsed?.key !== "string" || !RUN_KEY_PATTERN.test(parsed.key)) {
    return { error: malformedRunKeyMessage(path) };
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
 * ENOENT is the only condition that mints a new run, and §15 of CORRECTION-07
 * makes the mint itself exclusive, so ENOENT is a reason to ATTEMPT creation
 * rather than a permission to overwrite whatever exists at write time.
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

  // ── §15 of CORRECTION-07: creation is EXCLUSIVE ────────────────────────
  //
  // `stat` -> ENOENT -> `writeFile` is a check followed by an unguarded write,
  // and everything CORRECTION-05 established about never replacing an existing
  // run key lives in the gap between the two. Two Stage A invocations started
  // together — or one started beside a rerun the operator thought had exited —
  // both see ENOENT, both write, and the second silently destroys the key the
  // first has already begun sealing artifacts with.
  //
  // `flag: "wx"` makes the create fail rather than truncate, so the check and
  // the write are one decision. Losing the race is BLOCKED, not "load the
  // winner instead": the winner's `runId` is now the identity of a run this
  // invocation did not begin and whose Stage A binding it has not verified, and
  // adopting it silently would be exactly the resumption CORRECTION-05 requires
  // the operator to make deliberately.
  try {
    await write(path, `${JSON.stringify({ runId, key }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (error?.code === "EEXIST") {
      return {
        error:
          `the acceptance run key at ${path} was created by another process while this run was ` +
          "starting. Refusing to overwrite it, and refusing to adopt it silently: inspect the " +
          "existing run identity and re-run Stage A deliberately if it is the one you want.",
      };
    }
    return {
      error:
        `the acceptance run key at ${path} could not be created ` +
        `(${String(error?.code ?? error?.message ?? error)})`,
    };
  }
  // `mode` on write is masked by the process umask, so it is asserted after.
  // Only ever on the file this call created — a lost race returns above,
  // without touching the winner's permissions.
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

// ── Acceptance artifacts are append-only by path (CORRECTION-08) ───────────
//
// The run key has been fail-closed since CORRECTION-05: a file that EXISTS is
// never replaced, whatever is wrong with it. The evidence artifacts were not.
// Stage A, every Stage B case and the aggregation each sealed their record with
// an ordinary `writeFile`, which truncates, and a dry run handed `--evidence`
// wrote a BLOCKED stub to the same path.
//
// The artifact is the entire durable output of a live acceptance run — the only
// thing a later reviewer, or Stage B itself, can read. Silently replacing one
// destroys evidence that cannot be regenerated without re-running production
// acceptance. These two helpers give evidence the run key's model.

/** The single operator-facing refusal, so all three producers say one thing. */
export const EVIDENCE_PATH_OCCUPIED = "BLOCKED — EVIDENCE PATH ALREADY EXISTS";

/**
 * The EARLY gate (§6): is this evidence path unused?
 *
 * Called before a live command performs product-changing acceptance work, so an
 * occupied path costs nothing rather than costing a real job, a cancellation or
 * a Worker restart whose record can then never be written.
 *
 * `lstat`, never `stat`: a SYMLINK at the path is an entry occupying it, not a
 * window onto whatever it points at. Following it would let a link decide where
 * an acceptance artifact lands — and `writeFile` through a dangling link would
 * create the target rather than refusing.
 *
 * Fails CLOSED. "We could not measure the path" is not "the path is free": an
 * EACCES or EPERM here means the final exclusive create cannot be reasoned
 * about either, and proceeding would risk exactly the destruction this exists
 * to prevent.
 *
 * This check does NOT close the race — a file can still appear between here and
 * the seal — which is why `writeEvidenceExclusive` remains mandatory.
 */
export async function evidencePathAvailable(path, deps = {}) {
  const lstatFile = deps.lstat ?? lstat;
  if (!path) return { ok: true };
  try {
    await lstatFile(path);
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: true };
    return {
      ok: false,
      reason:
        `BLOCKED: the evidence path ${path} could not be measured ` +
        `(${error?.code ?? "unknown error"}); refusing to run acceptance work whose record ` +
        "may not be durably writable",
    };
  }
  return {
    ok: false,
    reason:
      `${EVIDENCE_PATH_OCCUPIED}: ${path} already exists. An acceptance artifact is never ` +
      "replaced, archived or renamed by this harness — choosing a new path is a deliberate " +
      "operator action.",
  };
}

/**
 * The final, RACE-SAFE creation (§5).
 *
 * `flag: "wx"` makes the existence check and the write one decision, so a file
 * that appeared after the early gate loses rather than being truncated. Losing
 * is BLOCKED — never adopt the winner, never unlink and retry, never archive.
 *
 * The bounded consequence is stated plainly to the operator: the acceptance
 * work may already have executed against production, but no evidence claim can
 * be made when the record could not be durably recorded. Deciding what to do
 * about that is the operator's call, not the harness's.
 *
 * The run key deliberately does NOT route through here: it carries secret
 * material and keeps its own specialized 0600 implementation above.
 */
export async function writeEvidenceExclusive(path, contents, deps = {}) {
  const write = deps.writeFile ?? writeFile;
  try {
    await write(path, contents, { encoding: "utf8", flag: "wx" });
    return { ok: true };
  } catch (error) {
    if (error?.code === "EEXIST") {
      return {
        ok: false,
        reason:
          `${EVIDENCE_PATH_OCCUPIED}: ${path} was created after the pre-flight check and before ` +
          "this record could be sealed to it. The existing file has NOT been modified. The " +
          "acceptance work may already have run, but no evidence claim is made for it.",
      };
    }
    return {
      ok: false,
      reason: `the evidence record could not be written to ${path} (${error?.code ?? "unknown error"})`,
    };
  }
}
