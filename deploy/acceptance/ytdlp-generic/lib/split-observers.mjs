// SPLIT-06's three observation primitives.
//
// All three are OBSERVERS: they record what the real modules did and change
// nothing about what they do. Nothing here decides an outcome — the orchestrator
// compares their output against expectations it stated before the run.

import { readFile, readdir } from "node:fs/promises";
import { basenameOf } from "./process-tree.mjs";

// ── 1. Worker-owned subprocess accounting ──────────────────────────────────

/**
 * Wraps the REAL hardened process runner and records every spawn the Worker
 * itself performs, tagged with the phase that was current when it started.
 *
 * This is the module's documented `runner` test seam. It delegates to the real
 * `runProcess` with the caller's options untouched — same argv, same
 * environment, same bounds, same signal — so the subprocess that runs is the
 * subprocess production would have run. What it adds is a ledger:
 *
 *   - how many yt-dlp processes ran, and in what order;
 *   - the exact `--format` expression each acquisition was given, which is what
 *     makes "no `+` selector anywhere" a measured fact;
 *   - that no acquisition was handed a real FFmpeg location.
 *
 * The URL is the last argv element and is a loopback fixture address, so it is
 * recorded; a Production harness would redact it. The evidence record never
 * carries argv at all (`argv` is a forbidden evidence key) — this ledger is
 * consumed by assertions, and only its derived counts reach the record.
 */
export function createRunnerLedger(realRunner) {
  const spawns = [];
  let phase = "preflight";

  const runner = async (opts) => {
    const entry = {
      phase,
      command: opts.command,
      args: [...(opts.args ?? [])],
      startedAt: Date.now(),
      exitCode: null,
      stdoutBytes: null,
      stderrBytes: null,
      failed: false,
    };
    spawns.push(entry);
    try {
      const result = await realRunner(opts);
      entry.exitCode = result.code;
      // Byte COUNTS only: the streams themselves are never retained here.
      entry.stdoutBytes = Buffer.byteLength(result.stdout ?? "", "utf8");
      entry.stderrBytes = Buffer.byteLength(result.stderr ?? "", "utf8");
      return result;
    } catch (err) {
      entry.failed = true;
      throw err;
    } finally {
      entry.finishedAt = Date.now();
    }
  };

  return {
    runner,
    setPhase(next) {
      phase = next;
    },
    all() {
      return spawns.map((s) => ({ ...s, args: [...s.args] }));
    },
    inPhase(name) {
      return this.all().filter((s) => s.phase === name);
    },
    /** Spawns that are a yt-dlp invocation: the interpreter plus the artifact. */
    ytdlp() {
      return this.all().filter((s) => s.args[0]?.endsWith("/yt-dlp"));
    },
    /** The `--format=` expression of each acquisition spawn, in order. */
    formatSelectors() {
      return this.ytdlp()
        .map((s) => s.args.find((a) => a.startsWith("--format=")))
        .filter((a) => a !== undefined)
        .map((a) => a.slice("--format=".length));
    },
    /** The `--output=` template of each acquisition spawn, in order. */
    outputTemplates() {
      return this.ytdlp()
        .map((s) => s.args.find((a) => a.startsWith("--output=")))
        .filter((a) => a !== undefined)
        .map((a) => a.slice("--output=".length));
    },
  };
}

// ── 2. yt-dlp descendant accounting ────────────────────────────────────────

/**
 * The executable basenames that must never appear while the durable job says
 * `downloading`.
 *
 * "FFmpeg exists in the image" is not evidence about who owns it. The accepted
 * boundary is that acquisition performs NO local media work, so the proof has
 * to be that no media tool RAN during acquisition — not that yt-dlp was
 * configured in a way that should have prevented it.
 */
export const MEDIA_TOOL_BASENAMES = Object.freeze(["ffmpeg", "ffprobe", "avconv", "avprobe"]);

/**
 * Samples `/proc` from inside the acceptance container and records, per phase,
 * every process whose `comm` is a media tool.
 *
 * Reads `comm` only — never `cmdline`, which would hand this sampler the
 * acquisition argv. A process that starts and exits entirely between two ticks
 * is invisible to any sampler, so this is corroborating evidence rather than
 * the whole proof; the exhaustive half is the Worker-owned spawn ledger above,
 * which sees every process the Worker itself started, and the argument policy
 * (`--ffmpeg-location` at a nonexistent path, `PATH` resolving nothing) which
 * leaves yt-dlp no resolvable media tool at all.
 */
export function createMediaToolSampler({ intervalMs = 20, procRoot = "/proc" } = {}) {
  const sightings = [];
  let phase = "preflight";
  let timer = null;
  let ticks = 0;

  const tick = async () => {
    let entries;
    try {
      entries = await readdir(procRoot);
    } catch {
      return;
    }
    ticks += 1;
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      let comm;
      try {
        comm = (await readFile(`${procRoot}/${entry}/comm`, "utf8")).trim();
      } catch {
        continue;
      }
      if (MEDIA_TOOL_BASENAMES.includes(basenameOf(comm))) {
        sightings.push({ phase, comm: basenameOf(comm), pid: Number(entry) });
      }
    }
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), intervalMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    setPhase(next) {
      phase = next;
    },
    tickCount() {
      return ticks;
    },
    sightingsIn(name) {
      return sightings.filter((s) => s.phase === name).map((s) => ({ ...s }));
    },
    distinctToolsIn(name) {
      return [...new Set(this.sightingsIn(name).map((s) => s.comm))].sort();
    },
  };
}

// ── 3. The durable transition trace ────────────────────────────────────────

/**
 * Installs a SQLite trigger that records every `worker_jobs` status change.
 *
 * Deliberately a trigger and not a polling sampler, and deliberately not a
 * wrapper around the job store:
 *
 *   - a poller can miss a transition that happens between two ticks, and
 *     "we did not see `processing`" is not the same as "it did not happen";
 *   - a store wrapper would put harness code on the path the executor actually
 *     drives, which is exactly what SPLIT-06 must not do.
 *
 * The trigger observes the REAL database the REAL `SQLiteJobStore` writes, in
 * the same transactions, so the trace is durable evidence rather than a
 * reconstruction. It writes to a separate harness-owned table and touches no
 * application table, column, index or schema version.
 */
export function installStatusAudit(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS split06_status_audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      at_ms INTEGER NOT NULL
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS split06_status_insert
      AFTER INSERT ON worker_jobs
    BEGIN
      INSERT INTO split06_status_audit (job_id, from_status, to_status, at_ms)
      VALUES (NEW.job_id, NULL, NEW.status, NEW.updated_at_ms);
    END;
    CREATE TRIGGER IF NOT EXISTS split06_status_update
      AFTER UPDATE OF status ON worker_jobs
      WHEN OLD.status IS NOT NEW.status
    BEGIN
      INSERT INTO split06_status_audit (job_id, from_status, to_status, at_ms)
      VALUES (NEW.job_id, OLD.status, NEW.status, NEW.updated_at_ms);
    END;
  `);
}

/** The ordered status trace for one job, straight out of SQLite. */
export function readStatusTrace(db, jobId) {
  const rows = db
    .prepare(
      "SELECT from_status, to_status FROM split06_status_audit WHERE job_id = ? ORDER BY seq ASC",
    )
    .all(jobId);
  return rows.map((r) => r.to_status);
}
