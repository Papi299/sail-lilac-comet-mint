// Process-tree observation and classification (§29-§32; §22-§26 of CORRECTION-01).
//
// Pure over a SAMPLE. Taking the sample is `process-sampler.mjs`'s job; deciding
// what a sample means is this module's, so every rule below is testable without
// a Production container.
//
// The sample schema is a CLOSED ALLOWLIST, not a blacklist of known-bad names:
//
//   pid, ppid, pgid, comm (executable BASENAME only), netns (namespace inode)
//
// A blacklist only rejects the leaks somebody already thought of. An allowlist
// rejects `environment`, `headers`, `query`, `fullCommand` and every other field
// a future observer might add to an object that was designed specifically not to
// hold them. The acquisition argv ends in the operator-supplied media URL, so a
// command line in evidence would defeat both the URL redaction and the sentinel
// test at once.

/** The ONLY keys a sample row may carry. Anything else is a defect. */
export const ALLOWED_SAMPLE_FIELDS = Object.freeze(["pid", "ppid", "pgid", "comm", "netns"]);

/**
 * Executables that must NOT appear anywhere under the Worker during
 * `downloading` (§30).
 *
 * ffmpeg/ffprobe are the load-bearing pair: Phase-10 v1 acquires a single
 * progressive source verbatim, so any transcode or remux tool running while the
 * durable state says `downloading` means the five independent no-FFmpeg
 * mechanisms have all failed at once. The external downloaders are here because
 * yt-dlp can be steered into one by a site's own hints, and the shells because
 * a shell executing media work is a command-construction path this design does
 * not have.
 */
export const FORBIDDEN_DOWNLOADING_DESCENDANTS = Object.freeze([
  "ffmpeg",
  "ffprobe",
  "ffplay",
  "avconv",
  "curl",
  "wget",
  "aria2c",
  "aria2",
  "axel",
  "httpie",
  "http",
  "rtmpdump",
  "sh",
  "bash",
  "dash",
  "zsh",
  "busybox",
]);

/**
 * The exact executable shapes the pinned yt-dlp runtime may present as.
 *
 * The runtime is the zipimport artifact executed BY the interpreter
 * (`/usr/bin/python3 /usr/local/lib/videofetch/yt-dlp`), so `comm` is the
 * interpreter's basename. `yt-dlp` is admitted because a kernel that reports the
 * script name rather than the interpreter is a plausible variation, not a
 * different runtime.
 */
export const YTDLP_RUNTIME_BASENAMES = Object.freeze([
  "python3",
  "python3.11",
  "yt-dlp",
]);

/**
 * Executables the acquisition hierarchy MAY legitimately contain.
 *
 * `node` is here because the approved EJS runtime is the Worker's own Node
 * binary, invoked by yt-dlp when an extractor needs a JS solver. It is allowed
 * STRUCTURALLY — being on this list is not permission to appear anywhere; the
 * containment assertions still have to hold for it.
 */
export const ALLOWED_ACQUISITION_DESCENDANTS = Object.freeze([
  "node",
  ...YTDLP_RUNTIME_BASENAMES,
  "python",
]);

/** Normalizes a `comm`/executable field to a bare lowercase basename. */
export function basenameOf(value) {
  if (typeof value !== "string" || value.length === 0) return "";
  const last = value.split("/").pop() ?? "";
  return last.trim().toLowerCase();
}

const isPositiveInt = (v) => Number.isInteger(v) && v > 0;
const isNonNegativeInt = (v) => Number.isInteger(v) && v >= 0;

/**
 * Validates a sample against the closed schema.
 *
 * Rejects, per row: any key outside `ALLOWED_SAMPLE_FIELDS`, a missing or
 * malformed required field, and a `comm` that is not a bare basename. Called
 * before a sample is used for ANY assertion, so a sampler that grows a field
 * fails the harness loudly instead of quietly writing a media URL into
 * evidence.
 */
export function validateSampleShape(sample) {
  const violations = [];
  if (!Array.isArray(sample)) {
    return Object.freeze({ ok: false, violations: Object.freeze(["the sample is not an array"]) });
  }
  if (sample.length === 0) {
    return Object.freeze({ ok: false, violations: Object.freeze(["the sample is empty"]) });
  }

  sample.forEach((row, index) => {
    const where = `row ${index}`;
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      violations.push(`${where}: not an object`);
      return;
    }

    // ── the allowlist ────────────────────────────────────────────────────
    for (const key of Object.keys(row)) {
      if (!ALLOWED_SAMPLE_FIELDS.includes(key)) {
        violations.push(`${where}: field '${key}' is outside the closed sample schema`);
      }
    }

    // ── required field types ─────────────────────────────────────────────
    if (!isPositiveInt(row.pid)) violations.push(`${where}: pid must be a positive integer`);
    if (!isNonNegativeInt(row.ppid)) {
      violations.push(`${where}: ppid must be a non-negative integer`);
    }
    if (!isPositiveInt(row.pgid)) violations.push(`${where}: pgid must be a positive integer`);

    if (typeof row.comm !== "string" || row.comm.trim().length === 0) {
      violations.push(`${where}: comm must be a non-empty string`);
    } else if (/[/\s]/.test(row.comm)) {
      // A basename cannot contain a path separator or whitespace. Whitespace is
      // what a full command line would bring, so this is the structural guard
      // against `comm` quietly becoming `argv[0] argv[1] ...`.
      violations.push(`${where}: comm must be a bare basename, not a path or command line`);
    }

    // `netns` may be an explicit null ONLY to mean "measurement failed"; the
    // namespace evaluator then treats it as a mismatch, never as agreement.
    if (row.netns !== null && !isSafeNetns(row.netns)) {
      violations.push(`${where}: netns must be a namespace identity or explicit null`);
    }
  });

  return Object.freeze({ ok: violations.length === 0, violations: Object.freeze(violations) });
}

/** `net:[4026532001]`, or the bare inode. Nothing that could carry free text. */
function isSafeNetns(value) {
  if (typeof value !== "string") return false;
  return /^net:\[\d+\]$/.test(value) || /^\d+$/.test(value);
}

/** Every descendant of `rootPid`, by ppid chain. The root itself is excluded. */
export function descendantsOf(sample, rootPid) {
  const rows = Array.isArray(sample) ? sample : [];
  const byParent = new Map();
  for (const row of rows) {
    const list = byParent.get(row.ppid) ?? [];
    list.push(row);
    byParent.set(row.ppid, list);
  }

  const out = [];
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid)) continue; // a cycle in a sample is malformed, not infinite
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

/**
 * The §30 rule: no forbidden executable may be running under the Worker while
 * durable state says `downloading`.
 */
export function forbiddenDescendants(sample, rootPid) {
  return descendantsOf(sample, rootPid)
    .map((row) => ({ pid: row.pid, comm: basenameOf(row.comm) }))
    .filter((row) => FORBIDDEN_DOWNLOADING_DESCENDANTS.includes(row.comm));
}

/**
 * Structural classification of the acquisition hierarchy.
 *
 * Deliberately NOT "the tree must look exactly like this". Extractors differ,
 * and Node is not required for every site. The rule is the negative one —
 * nothing forbidden — plus: everything present is on the allowed list.
 */
export function classifyAcquisitionTree(sample, rootPid) {
  const descendants = descendantsOf(sample, rootPid).map((row) => ({
    pid: row.pid,
    ppid: row.ppid,
    pgid: row.pgid,
    comm: basenameOf(row.comm),
    netns: row.netns ?? null,
  }));

  const forbidden = descendants.filter((row) =>
    FORBIDDEN_DOWNLOADING_DESCENDANTS.includes(row.comm),
  );
  const unknown = descendants.filter(
    (row) =>
      !FORBIDDEN_DOWNLOADING_DESCENDANTS.includes(row.comm) &&
      !ALLOWED_ACQUISITION_DESCENDANTS.includes(row.comm),
  );

  return Object.freeze({
    descendants: Object.freeze(descendants),
    /** Basenames only — the shape that is safe to write into evidence. */
    basenames: Object.freeze([...new Set(descendants.map((row) => row.comm))].sort()),
    forbidden: Object.freeze(forbidden),
    /**
     * An executable that is neither approved nor on the forbidden list is NOT
     * quietly tolerated. The harness cannot know it is harmless, so it is
     * surfaced and the caller treats it as a failure.
     */
    unknown: Object.freeze(unknown),
    nodeProcesses: Object.freeze(descendants.filter((row) => row.comm === "node")),
  });
}

/**
 * §22 — prove the EXACT owned yt-dlp process, not "a Python process exists".
 *
 * The discriminator that makes this meaningful is the process GROUP LEADERSHIP
 * check. `process-runner.server.ts` spawns the acquisition with
 * `detached: true`, which calls `setsid`/`setpgid` and makes the child its own
 * process-group leader — so the owned yt-dlp process necessarily has
 * `pgid === pid`. An unrelated Python descendant inherits the Worker's group
 * instead and fails this, which is precisely the distinction the previous
 * "some python3 exists" check could not draw. It is also the property every
 * containment and termination assertion downstream depends on, since those are
 * expressed in terms of that group.
 */
export function evaluateYtdlpIdentity(sample, workerPid, ytdlpPid, expectedNetns) {
  if (!isPositiveInt(ytdlpPid)) {
    return Object.freeze({
      identified: false,
      reason: "no owned yt-dlp PID was established by the sampler",
    });
  }

  const rows = Array.isArray(sample) ? sample : [];
  const row = rows.find((entry) => entry.pid === ytdlpPid) ?? null;
  if (!row) {
    return Object.freeze({
      identified: false,
      reason: `the established yt-dlp PID ${ytdlpPid} is absent from the sample`,
    });
  }

  const failures = [];

  const descendantPids = new Set(descendantsOf(rows, workerPid).map((entry) => entry.pid));
  if (!descendantPids.has(ytdlpPid)) {
    failures.push(`PID ${ytdlpPid} is not a descendant of the Worker process`);
  }

  const comm = basenameOf(row.comm);
  if (!YTDLP_RUNTIME_BASENAMES.includes(comm)) {
    failures.push(`PID ${ytdlpPid} runs '${comm}', which is not an approved yt-dlp runtime shape`);
  }

  if (row.pgid !== row.pid) {
    // Not a group leader => not the process the Worker spawned detached, so the
    // group-based containment and termination proofs would be measuring the
    // wrong group.
    failures.push(
      `PID ${ytdlpPid} is not its own process-group leader (pgid ${row.pgid}); ` +
        "the owned acquisition process is spawned detached and must lead its group",
    );
  }

  if (expectedNetns == null) {
    failures.push("the expected media network namespace is unknown");
  } else if (row.netns !== expectedNetns) {
    failures.push(`PID ${ytdlpPid} is not in the Worker's media network namespace`);
  }

  return Object.freeze({
    identified: failures.length === 0,
    pid: ytdlpPid,
    comm,
    pgid: row.pgid,
    failures: Object.freeze(failures),
    reason: failures.length === 0 ? "the owned yt-dlp process was positively identified" : failures.join("; "),
  });
}

/**
 * §23/§31 — Node/EJS containment, anchored to the VERIFIED owned yt-dlp PID.
 *
 * The caller must pass an identity from `evaluateYtdlpIdentity` that actually
 * identified; an unverified anchor makes every clause below meaningless, so
 * this returns `anchored: false` and the caller raises BLOCKED rather than
 * reporting containment against a process it could not name.
 */
export function evaluateNodeContainment(classified, ytdlpIdentity, expectedNetns) {
  if (!ytdlpIdentity?.identified) {
    return Object.freeze({
      anchored: false,
      exercised: false,
      contained: false,
      reason: "the owned yt-dlp process was not identified, so containment cannot be anchored",
    });
  }

  const nodes = classified.nodeProcesses;
  if (nodes.length === 0) {
    return Object.freeze({
      anchored: true,
      exercised: false,
      contained: false,
      reason: "no Node/EJS descendant appeared for this source",
    });
  }

  const anchorPid = ytdlpIdentity.pid;
  const anchorPgid = ytdlpIdentity.pgid;

  const failures = [];
  for (const node of nodes) {
    const chain = ancestryOf(classified.descendants, node.pid);
    if (!chain.includes(anchorPid)) {
      failures.push(`node ${node.pid} is not a descendant of the owned yt-dlp process`);
    }
    if (node.pgid !== anchorPgid) {
      failures.push(`node ${node.pid} left the owned process group`);
    }
    if (expectedNetns != null && node.netns !== expectedNetns) {
      failures.push(`node ${node.pid} is not in the Worker's media network namespace`);
    }
  }

  return Object.freeze({
    anchored: true,
    exercised: true,
    contained: failures.length === 0,
    count: nodes.length,
    failures: Object.freeze(failures),
  });
}

/** pid -> its ancestor pids within the sampled set. */
function ancestryOf(rows, pid) {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const chain = [];
  let cursor = byPid.get(pid);
  const guard = new Set();
  while (cursor && !guard.has(cursor.pid)) {
    guard.add(cursor.pid);
    chain.push(cursor.ppid);
    cursor = byPid.get(cursor.ppid);
  }
  return chain;
}

/**
 * §32 — every sampled process shares the Worker's media network namespace.
 *
 * A row whose namespace could not be read is a MISMATCH candidate, not a pass:
 * `null` never equals the expected inode, so an unreadable namespace surfaces
 * as an offender the caller must treat as unmeasured rather than as agreement.
 */
export function evaluateNamespaceIdentity(classified, expectedNetns) {
  if (expectedNetns == null) {
    return Object.freeze({ measured: false, reason: "expected namespace identity unknown" });
  }
  const offenders = classified.descendants
    .filter((row) => row.netns !== expectedNetns)
    .map((row) => ({ pid: row.pid, comm: row.comm, netns: row.netns }));
  return Object.freeze({
    measured: true,
    consistent: offenders.length === 0,
    expected: expectedNetns,
    offenders: Object.freeze(offenders),
  });
}

/**
 * §39/§40 — after cancellation or shutdown, the owned group is gone.
 *
 * "Gone" means no surviving descendant at all, not "no ffmpeg": a lingering
 * yt-dlp or Node process is exactly the leak these cases exist to detect.
 */
export function evaluateTerminationCleanliness(sample, rootPid) {
  const survivors = descendantsOf(sample, rootPid).map((row) => ({
    pid: row.pid,
    comm: basenameOf(row.comm),
  }));
  return Object.freeze({
    clean: survivors.length === 0,
    survivors: Object.freeze(survivors),
  });
}
