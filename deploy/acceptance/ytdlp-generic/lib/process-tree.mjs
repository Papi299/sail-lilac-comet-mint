// Process-tree observation and classification (§29-§32).
//
// Pure over a SAMPLE. Taking the sample is the observer layer's job; deciding
// what a sample means is this module's, so every rule below is testable without
// a Production container.
//
// What a sample entry may carry — and this is a closed list on purpose (§29):
//
//   pid, ppid, pgid, comm (executable BASENAME only), netns (namespace inode)
//
// What it must NEVER carry: the full command line. `argv` for the acquisition
// process ends in the operator-supplied media URL (§24), so capturing it would
// place a third-party URL — and, during the sentinel case, the sentinel itself —
// into evidence that §46 requires to stay clean. The basename is sufficient for
// every assertion this harness makes.

/** A sample entry carrying a command line is a defect, not a richer sample. */
export const FORBIDDEN_SAMPLE_FIELDS = Object.freeze([
  "cmdline",
  "args",
  "argv",
  "command",
  "cmd",
  "exe",
  "url",
]);

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
 * Executables the acquisition hierarchy MAY legitimately contain.
 *
 * `node` is here because the approved EJS runtime is the Worker's own Node
 * binary, invoked by yt-dlp when an extractor needs a JS solver. It is allowed
 * STRUCTURALLY — being on this list is not permission to appear anywhere; §31's
 * containment assertions still have to hold for it.
 */
export const ALLOWED_ACQUISITION_DESCENDANTS = Object.freeze([
  "node",
  "python3",
  "python3.11",
  "python",
  "yt-dlp",
]);

/** Normalizes a `comm`/executable field to a bare lowercase basename. */
export function basenameOf(value) {
  if (typeof value !== "string" || value.length === 0) return "";
  const last = value.split("/").pop() ?? "";
  return last.trim().toLowerCase();
}

/**
 * Rejects a sample that carries anything outside the closed field list.
 *
 * Called before a sample is used for ANY assertion, so an observer that grows a
 * `cmdline` field fails the harness loudly instead of quietly writing a media
 * URL into the evidence file.
 */
export function validateSampleShape(sample) {
  const rows = Array.isArray(sample) ? sample : [];
  const violations = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      violations.push("non-object sample row");
      continue;
    }
    for (const field of Object.keys(row)) {
      if (FORBIDDEN_SAMPLE_FIELDS.includes(field.toLowerCase())) {
        violations.push(`sample row ${row.pid ?? "?"} carries forbidden field '${field}'`);
      }
    }
  }
  return Object.freeze({ ok: violations.length === 0, violations: Object.freeze(violations) });
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
 *
 * Returns the offenders rather than a boolean so the evidence record can name
 * exactly what was seen — by basename, which is safe.
 */
export function forbiddenDescendants(sample, rootPid) {
  return descendantsOf(sample, rootPid)
    .map((row) => ({ pid: row.pid, comm: basenameOf(row.comm) }))
    .filter((row) => FORBIDDEN_DOWNLOADING_DESCENDANTS.includes(row.comm));
}

/**
 * Structural acceptance of the acquisition hierarchy.
 *
 * Deliberately NOT "the tree must look exactly like this". Extractors differ,
 * and §30 explicitly says Node is not required for every site. The rule is the
 * negative one — nothing forbidden — plus: everything that IS present is on the
 * allowed list.
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
     * surfaced and the caller treats it as a failure — unknown-is-safe is the
     * assumption this whole boundary exists to avoid making.
     */
    unknown: Object.freeze(unknown),
    ytdlpProcesses: Object.freeze(
      descendants.filter((row) => row.comm.startsWith("python") || row.comm === "yt-dlp"),
    ),
    nodeProcesses: Object.freeze(descendants.filter((row) => row.comm === "node")),
  });
}

/**
 * §31 — Node/EJS containment.
 *
 * Every clause is measured, never inferred from "the source was YouTube". When
 * no Node descendant is present the answer is `exercised: false`, which the
 * caller reports as NOT_EXERCISED — never as a pass.
 */
export function evaluateNodeContainment(classified, ytdlpPid, expectedNetns) {
  const nodes = classified.nodeProcesses;
  if (nodes.length === 0) {
    return Object.freeze({
      exercised: false,
      contained: false,
      reason: "no Node/EJS descendant appeared for this source",
    });
  }

  const ytdlp = classified.descendants.find((row) => row.pid === ytdlpPid) ?? null;
  const expectedPgid = ytdlp?.pgid ?? null;

  const failures = [];
  for (const node of nodes) {
    const chain = ancestryOf(classified.descendants, node.pid);
    if (!chain.includes(ytdlpPid)) {
      failures.push(`node ${node.pid} is not a descendant of the owned yt-dlp process`);
    }
    if (expectedPgid === null || node.pgid !== expectedPgid) {
      failures.push(`node ${node.pid} left the owned process group`);
    }
    if (expectedNetns != null && node.netns !== expectedNetns) {
      failures.push(`node ${node.pid} is not in the Worker's media network namespace`);
    }
  }

  return Object.freeze({
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
