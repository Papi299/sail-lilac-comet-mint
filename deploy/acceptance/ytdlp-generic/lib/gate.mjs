// The accidental-live-execution gate (§9).
//
// Pure decision function over an argv array and an environment object. It
// performs no I/O, so `acceptance.mjs` cannot become live by importing this —
// only by being handed both signals explicitly.

/** The CLI half of the double opt-in. */
export const LIVE_FLAG = "--live";

/** The environment half. Must equal `1` exactly. */
export const LIVE_ENV_NAME = "VIDEOFETCH_ACCEPT_LIVE";
export const LIVE_ENV_VALUE = "1";

/** The stage the run is asserting against. Never inferred (§11). */
export const STAGE_FLAG = "--stage";
export const STAGES = Object.freeze(["A", "B"]);

/**
 * There is deliberately NO auto-detection here.
 *
 * Not "live if a Production host is reachable", not "live if docker exists",
 * not "live if a URL was supplied". Every one of those turns a mistyped command
 * into a Production media request. The two signals below are the only inputs,
 * they are independent, and neither can be produced by accident: a flag has to
 * be typed and an environment variable has to be exported.
 */
export function evaluateLiveGate(argv, env) {
  const args = Array.isArray(argv) ? argv : [];
  const environment = env ?? {};

  const flagPresent = args.includes(LIVE_FLAG);
  const envRaw = environment[LIVE_ENV_NAME];
  // Exact match. `true`, `yes`, `0`, ` 1 ` and `1\n` are all NOT the opt-in:
  // a loose grammar here is how a stale shell profile turns into a live run.
  const envPresent = envRaw === LIVE_ENV_VALUE;

  const missing = [];
  if (!flagPresent) missing.push(LIVE_FLAG);
  if (!envPresent) missing.push(`${LIVE_ENV_NAME}=${LIVE_ENV_VALUE}`);

  return Object.freeze({
    live: flagPresent && envPresent,
    flagPresent,
    envPresent,
    missing: Object.freeze(missing),
    /** What the harness will actually do. `dry-run` is the default for everything else. */
    mode: flagPresent && envPresent ? "live" : "dry-run",
    reason:
      flagPresent && envPresent
        ? "both live signals present"
        : `refusing live execution: missing ${missing.join(" and ")}`,
  });
}

/** Reads `--stage A|B`. Absent or malformed is a hard input error, never a default. */
export function readStage(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const index = args.indexOf(STAGE_FLAG);
  if (index === -1) return { ok: false, error: `${STAGE_FLAG} is required and must be A or B` };
  const value = args[index + 1];
  if (!STAGES.includes(value)) {
    return { ok: false, error: `${STAGE_FLAG} must be exactly one of ${STAGES.join(", ")}` };
  }
  return { ok: true, stage: value };
}

/** Reads a `--key value` option. Returns null when absent. */
export function readOption(argv, flag) {
  const args = Array.isArray(argv) ? argv : [];
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  if (typeof value !== "string" || value.startsWith("--")) return null;
  return value;
}

/**
 * Reads a repeatable `--key value ...` option.
 *
 * Used for `--case-evidence`, which names one file per Stage B case. Values
 * are consumed until the next flag, so a shell glob expands naturally.
 */
export function readOptionList(argv, flag) {
  const args = Array.isArray(argv) ? argv : [];
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== flag) continue;
    for (let j = i + 1; j < args.length; j += 1) {
      const value = args[j];
      if (typeof value !== "string" || value.startsWith("--")) break;
      out.push(value);
    }
  }
  return out;
}
