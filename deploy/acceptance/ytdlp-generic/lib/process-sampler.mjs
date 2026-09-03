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

/**
 * A plain executable basename, safe to carry into evidence verbatim.
 *
 * It is matched against the RAW `comm` field, never against a normalized
 * substitute (§4 of CORRECTION-07). The pattern admits no `/` and no
 * whitespace, so "is this already a bare basename?" is exactly the question it
 * answers — and a field that is not one fails it.
 *
 * ── Why normalizing first was a laundering step ────────────────────────────
 *
 * The previous parser computed `basenameOf(raw)` and validated THAT, so
 *
 *     suspicious/python3   ->   python3
 *     /usr/bin/ffmpeg      ->   ffmpeg
 *     foo/node             ->   node
 *
 * and an executable the harness had never approved acquired the identity of one
 * it had. `python3` is an APPROVED yt-dlp runtime shape: an unknown descendant
 * called `foo/python3` stopped being an unknown descendant, became a candidate
 * for `establishYtdlpPid`, and could be graded as the owned acquisition process.
 * The check that exists to catch an out-of-band executable was the check that
 * gave it cover.
 *
 * The rule is therefore: a raw field that is ALREADY a plain basename is
 * lowercased and kept; anything else keeps its row but loses its name to
 * `UNCLASSIFIED_COMM`. Paths are not stripped, unusual names are not trimmed
 * into approved ones, and the row is never dropped — inside the Worker an
 * unclassified descendant is not on the approved list, so it lands in
 * `unknown` and FAILS `process.no-unknown-descendants`, which is the honest
 * reading of "something we do not recognize was running".
 */
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

    // §4 of CORRECTION-07: the RAW field decides, and nothing is normalized
    // before that decision. See `SAFE_COMM_PATTERN` for why.
    const raw = matched[4];
    rows.push({
      pid: numbers[0],
      ppid: numbers[1],
      pgid: numbers[2],
      comm: SAFE_COMM_PATTERN.test(raw) ? raw.toLowerCase() : UNCLASSIFIED_COMM,
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

  /**
   * The container's main PID on the host — the Worker's own node process.
   *
   * §6 of CORRECTION-07: a non-zero exit is a FAILED command, and its stdout is
   * not a measurement however well-formed it looks. `docker inspect` writes its
   * diagnostics to stderr, so a partial or stale stdout beside a non-zero
   * status is precisely the case where the buffer can still parse as an
   * integer — and every containment proof downstream is expressed relative to
   * this PID.
   */
  async function workerPid() {
    const result = await run("docker", ["inspect", "--format", "{{.State.Pid}}", container]);
    if (result.exitCode !== 0) {
      throw new Error(`docker inspect exited ${result.exitCode}; the Worker PID was not measured`);
    }
    const pid = Number(String(result.stdout ?? "").trim());
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("the Worker container is not running");
    return pid;
  }

  /**
   * `net:[<inode>]` for one PID, read from the host procfs. Read-only.
   *
   * §6: a failed `readlink` returns `null`, which the evaluator reads as a
   * namespace MISMATCH rather than as agreement — so consuming a non-zero
   * exit's stdout would turn an unmeasured namespace into a positive
   * containment claim.
   */
  async function netnsOf(pid) {
    const result = await run("readlink", [`/proc/${pid}/ns/net`]);
    if (result.exitCode !== 0) return null;
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
      // §6 of CORRECTION-07: a non-zero `docker top` is not a process listing.
      // A syntactically perfect listing beside a failed command is the most
      // dangerous shape this sampler can meet: the window's assertions are
      // NEGATIVE, so a truncated-but-parseable listing looks exactly like a
      // clean one. The exit status is checked BEFORE the bytes are read.
      if (top.exitCode !== 0) {
        throw new Error(
          `docker top exited ${top.exitCode}; the process listing was not measured and no ` +
            "absence may be inferred from it",
        );
      }
      // §7 of CORRECTION-06: an uninterpretable row makes the WHOLE sample
      // unmeasured. The caller records that as a sampler error, and the
      // downloading window's gap rule refuses to rest a negative claim on it.
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

    // ── §17 of CORRECTION-07: `sampleWhile` is GONE ───────────────────────
    //
    // It sampled in a loop, swallowed an individual `sample()` failure with a
    // bare `catch { continue }`, and returned the richest successful sample
    // whenever ANY sample had succeeded. That is the exact gap policy every
    // other surface of this harness has now had removed — a failed observation
    // interval erased by a later successful one — and it contradicts the
    // governing model that a property which could not be fully observed is
    // BLOCKED rather than PASS.
    //
    // No live acceptance path called it: the downloading window is driven by
    // `download-window.mjs`, which accumulates `samplingErrors` and gaps the
    // window instead. So it was a loaded exported helper whose only remaining
    // effect would have been to let a future caller reintroduce the defect by
    // reaching for the obvious-looking name. Deleting it is cheaper than
    // documenting it, and leaves nothing to reach for.
    //
    // A caller that needs repeated sampling composes `sample()` with the
    // window collector's `noteSamplerError`, which is what the real cases do.
  };
}
