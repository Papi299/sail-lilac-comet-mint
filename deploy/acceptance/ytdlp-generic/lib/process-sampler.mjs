// The REAL host-side process sampler (§26 of CORRECTION-01).
//
// Phase 10D must not have to write this. It is the reviewed producer for
// `downloadingSample`, and it establishes all four things the evaluator needs:
//
//   workerPid   the Worker container's main process, from `docker inspect`
//   ytdlpPid    the UNIQUE owned acquisition process, established structurally
//   expectedNetns the Worker's own network-namespace identity
//   sample[]    closed-schema rows for the Worker and every descendant
//
// ── Why `docker top -o pid,ppid,pgid,comm` ─────────────────────────────────
//
// Because it is the only readily available process listing that CANNOT return a
// command line. `ps -ef`, `/proc/<pid>/cmdline` and `docker inspect` on a child
// would each hand back the acquisition argv, whose last element is the
// operator-supplied media URL — and, during the sentinel case, the sentinel.
// Selecting the four safe columns explicitly means the URL is never read in the
// first place, rather than being read and then redacted.
//
// Nothing here mutates anything. Every command is on the read-only allowlist.

import { basenameOf, YTDLP_RUNTIME_BASENAMES } from "./process-tree.mjs";

/**
 * How the owned yt-dlp process is ESTABLISHED (as distinct from verified).
 *
 * Candidates are descendants of the Worker whose basename is an approved yt-dlp
 * runtime shape AND which lead their own process group (`pgid === pid`) — the
 * signature of the Worker's `detached: true` spawn.
 *
 * If exactly one candidate exists, that is the owned process and
 * `evaluateYtdlpIdentity` then re-checks every property independently. If zero
 * or several exist, the sampler reports a MEASUREMENT FAILURE rather than
 * picking one: guessing which of two Python processes is "the" acquisition
 * would make every downstream containment proof meaningless.
 */
export function establishYtdlpPid(sample, workerPid) {
  const rows = Array.isArray(sample) ? sample : [];
  const descendantPids = new Set();
  const byParent = new Map();
  for (const row of rows) {
    const list = byParent.get(row.ppid) ?? [];
    list.push(row);
    byParent.set(row.ppid, list);
  }
  const queue = [workerPid];
  const seen = new Set([workerPid]);
  while (queue.length > 0) {
    const pid = queue.shift();
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      descendantPids.add(child.pid);
      queue.push(child.pid);
    }
  }

  const candidates = rows.filter(
    (row) =>
      descendantPids.has(row.pid) &&
      YTDLP_RUNTIME_BASENAMES.includes(basenameOf(row.comm)) &&
      row.pgid === row.pid,
  );

  if (candidates.length === 1) {
    return { established: true, pid: candidates[0].pid };
  }
  return {
    established: false,
    reason:
      candidates.length === 0
        ? "no descendant matched the owned-acquisition signature (approved runtime basename, own process-group leader)"
        : `${candidates.length} descendants matched the owned-acquisition signature; the owned process is ambiguous`,
  };
}

/** Parses `docker top` output into closed-schema rows. */
export function parseDockerTop(stdout) {
  const lines = String(stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) return [];

  // The first line is the header emitted by `docker top`; the requested column
  // order is what we asked for, so positions are known rather than guessed.
  const rows = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const [pid, ppid, pgid, ...rest] = parts;
    const comm = rest.join(" ");
    if (!/^\d+$/.test(pid) || !/^\d+$/.test(ppid) || !/^\d+$/.test(pgid)) continue;
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      // Basename only. If `comm` ever arrives with spaces (it should not, given
      // the selected column), the closed-schema validator rejects the sample
      // rather than letting a command line through.
      comm: basenameOf(comm),
      netns: null,
    });
  }
  return rows;
}

/**
 * Builds the live sampler.
 *
 * `run` is the read-only command runner; injecting it is what lets the tests
 * drive this exact code with fake command output instead of a real container.
 */
export function makeProcessSampler(deps = {}) {
  const run = deps.runReadOnly;
  const container = deps.container ?? "videofetch-worker";
  if (typeof run !== "function") throw new Error("makeProcessSampler requires a runReadOnly");

  /** The container's main PID on the host — the Worker's own node process. */
  async function workerPid() {
    const result = await run("docker", ["inspect", "--format", "{{.State.Pid}}", container]);
    const pid = Number(String(result.stdout ?? "").trim());
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("the Worker container is not running");
    return pid;
  }

  /** `net:[<inode>]` for one PID, read from the host procfs. Read-only. */
  async function netnsOf(pid) {
    const result = await run("readlink", [`/proc/${pid}/ns/net`]);
    const value = String(result.stdout ?? "").trim();
    return /^net:\[\d+\]$/.test(value) ? value : null;
  }

  return {
    establishYtdlpPid,

    /**
     * One complete sample.
     *
     * Namespace identity is read per PID rather than assumed from the container,
     * which is the whole point of §32: a descendant that escaped the namespace
     * must be visible as a mismatch, and it cannot be if every row is stamped
     * with the container's namespace by construction.
     */
    async sample() {
      const worker = await workerPid();
      const top = await run("docker", ["top", container, "-o", "pid,ppid,pgid,comm"]);
      const rows = parseDockerTop(top.stdout);
      if (rows.length === 0) throw new Error("docker top returned no usable process rows");

      const expectedNetns = await netnsOf(worker);

      for (const row of rows) {
        // A namespace that cannot be read stays explicitly null, which the
        // evaluator treats as a mismatch — never as agreement.
        row.netns = await netnsOf(row.pid).catch(() => null);
      }

      const ytdlp = establishYtdlpPid(rows, worker);
      return {
        sample: rows,
        workerPid: worker,
        ytdlpPid: ytdlp.established ? ytdlp.pid : null,
        ytdlpEstablishment: ytdlp,
        expectedNetns,
      };
    },

    /**
     * Samples repeatedly while `predicate()` holds, returning the sample richest
     * in descendants.
     *
     * A single sample taken at an arbitrary instant can miss a short-lived Node
     * solver entirely, and "we did not see it" would then be recorded as "it
     * never ran". Sampling across the acquisition window and keeping the widest
     * observation is what makes the no-FFmpeg and containment claims meaningful
     * rather than lucky.
     */
    async sampleWhile(predicate, opts = {}) {
      const intervalMs = opts.intervalMs ?? 250;
      const maxSamples = opts.maxSamples ?? 400;
      const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

      let best = null;
      let taken = 0;
      const seenBasenames = new Set();

      while (taken < maxSamples && (await predicate())) {
        taken += 1;
        let current = null;
        try {
          current = await this.sample();
        } catch {
          // A transient failure mid-acquisition is not fatal on its own; the
          // caller raises BLOCKED only if NO sample was ever obtained.
          await sleep(intervalMs);
          continue;
        }
        for (const row of current.sample) seenBasenames.add(row.comm);
        if (best === null || current.sample.length > best.sample.length) best = current;
        // Once the owned process is established, prefer a sample that has it.
        if (best.ytdlpPid == null && current.ytdlpPid != null) best = current;
        await sleep(intervalMs);
      }

      if (best === null) return null;
      return { ...best, samplesTaken: taken, basenamesSeenAcrossRun: [...seenBasenames].sort() };
    },
  };
}
