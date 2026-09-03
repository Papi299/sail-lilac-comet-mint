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
import { DOCKER_TOP_COLUMNS } from "./observers.mjs";

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

/**
 * The header `docker top <c> -o pid,ppid,pgid,comm` actually emits.
 *
 * Verified against the pinned image on this Docker/procps combination:
 *
 *     PID                 PPID                PGID                COMMAND
 *
 * procps titles the `comm` column `COMMAND` — which is the column NAME, not the
 * command line; `-o comm` selects the executable name and `-o args` would be
 * needed for argv. That distinction is why the allowlist pins the column set.
 */
export const DOCKER_TOP_HEADER = Object.freeze(["PID", "PPID", "PGID", "COMMAND"]);

/**
 * The fixed token that stands in for a `comm` this sampler will not copy.
 *
 * Shared shape with the host PGID parser's `UNCLASSIFIED_COMM`, but kept as its
 * own constant: the two surfaces read different commands with different output
 * contracts, and collapsing them would couple parsers that are only incidentally
 * similar (§11 of CORRECTION-06).
 */
export const UNCLASSIFIED_COMM = "<unclassified>";

/** A plain executable basename, safe to carry into evidence verbatim. */
const SAFE_COMM_PATTERN = /^[\w.:+-]{1,64}$/;

/**
 * Parses `docker top` output into closed-schema rows, FAIL-CLOSED (§7-§9 of
 * CORRECTION-06).
 *
 * ── Why dropping a row is not survivable here ─────────────────────────────
 *
 * This feeds the downloading window, whose assertions are NEGATIVE: no FFmpeg
 * during acquisition, no unknown descendants, no namespace escape. Their
 * evidence is the ABSENCE of matching rows. A row that silently disappears is
 * therefore indistinguishable from a row that was never there — and the row
 * most likely to be unusual is exactly the one those checks exist to catch: an
 * external downloader, a shell, an FFmpeg invoked out of band.
 *
 * The previous parser did `continue` on a short row and on a non-numeric id, so
 * one unreadable line left the remaining rows looking clean and the window
 * PASSING.
 *
 * ── What is fail-closed, and what is not ───────────────────────────────────
 *
 * The numeric prefix is what must parse: a row whose pid/ppid/pgid cannot be
 * read cannot be placed in the tree at all, so the whole SAMPLE is unmeasured.
 * The caller turns that into a sampler error, and the window's gap rule turns
 * that into BLOCKED.
 *
 * A valid row with an unusual `comm` is different — it is structurally
 * understood and stays in the tree, reported as `UNCLASSIFIED_COMM`. Inside the
 * Worker container an unclassified descendant is not an approved acquisition
 * executable, so it lands in `unknownSeen` and FAILS `process.no-unknown-
 * descendants` rather than vanishing into a clean result.
 *
 * ── The header ─────────────────────────────────────────────────────────────
 *
 * It is VALIDATED, not skipped. Blindly dropping the first line means an output
 * whose header is missing or unexpected silently loses its first process row —
 * and column positions we cannot confirm are positions we cannot parse by.
 *
 * @returns `{ ok: true, rows }` or `{ ok: false, reason }`. The reason names the
 *   line NUMBER and the defect, never the line's content.
 */
export function parseDockerTop(stdout) {
  const lines = String(stdout ?? "")
    .split("\n")
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return { ok: false, reason: "docker top returned no output at all" };
  }

  const header = lines[0].trim().split(/\s+/);
  if (
    header.length !== DOCKER_TOP_HEADER.length ||
    !header.every((title, index) => title.toUpperCase() === DOCKER_TOP_HEADER[index])
  ) {
    return {
      ok: false,
      reason:
        `docker top did not return the expected ${DOCKER_TOP_HEADER.join("/")} header, so the ` +
        "column positions cannot be trusted and no row may be interpreted",
    };
  }

  const rows = [];
  for (let index = 1; index < lines.length; index += 1) {
    // Three numeric columns, then the remainder as `comm`. The remainder is NOT
    // re-split: it is one field, because the command selected one field.
    const matched = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(lines[index]);
    if (!matched) {
      return {
        ok: false,
        reason:
          `line ${index + 1} of the docker top listing does not begin with the three numeric ids ` +
          "the requested columns produce, so it cannot be placed in the process tree; the sample " +
          "cannot be interpreted",
      };
    }

    const numbers = [Number(matched[1]), Number(matched[2]), Number(matched[3])];
    if (!numbers.every((value) => Number.isSafeInteger(value))) {
      return {
        ok: false,
        reason: `line ${index + 1} of the docker top listing has an out-of-range id field`,
      };
    }

    const comm = basenameOf(matched[4]);
    rows.push({
      pid: numbers[0],
      ppid: numbers[1],
      pgid: numbers[2],
      // Kept verbatim only when it is a plain basename. Never dropped.
      comm: SAFE_COMM_PATTERN.test(comm) ? comm : UNCLASSIFIED_COMM,
      netns: null,
    });
  }

  if (rows.length === 0) {
    return { ok: false, reason: "docker top returned a header but no process rows" };
  }
  return { ok: true, rows };
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
      const top = await run("docker", ["top", container, "-o", DOCKER_TOP_COLUMNS]);
      // §7: an uninterpretable row makes the WHOLE sample unmeasured. The
      // caller records that as a sampler error, and the downloading window's
      // gap rule refuses to rest a negative claim on it.
      const parsed = parseDockerTop(top.stdout);
      if (!parsed.ok) throw new Error(parsed.reason);
      const rows = parsed.rows;

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
