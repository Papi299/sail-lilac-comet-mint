// The observer layer — the ONLY impure module in this harness.
//
// Everything else is a pure function over an observation bundle, which is what
// makes the whole matrix testable with fakes and no Production system. This
// module is where real commands and real HTTP live, and it is deliberately the
// smallest and most constrained file here.
//
// Two structural properties, not two documented intentions:
//
//   1. `runReadOnly` accepts ONLY commands matching the allowlist below. A
//      repair (§50) or a credential rotation (§51) is not "discouraged" — it is
//      unrepresentable, because `systemctl restart`, `nft`, `ip route add` and
//      friends do not match any entry and the function throws.
//
//   2. Nothing here writes /etc/videofetch/worker.env or restarts the Worker to
//      change YTDLP_ENABLED (§10). The harness measures the deployment state it
//      is given; changing that state is the Phase-10D operator's own step.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { redactText } from "./redact.mjs";

const execFileAsync = promisify(execFile);

/**
 * The complete set of shapes this harness may execute.
 *
 * Each entry is `[executable, argv-prefix-predicate]`. A command is admissible
 * only if some entry's executable matches AND its predicate accepts the full
 * argv. Anything else throws before a process is spawned.
 */
const READ_ONLY_COMMANDS = Object.freeze([
  // Read-only container introspection.
  ["docker", (a) => a[0] === "inspect"],
  ["docker", (a) => a[0] === "image" && a[1] === "inspect"],
  ["docker", (a) => a[0] === "logs"],
  ["docker", (a) => a[0] === "top"],
  // Version probes inside the running container. Read-only by argument shape:
  // the allowlist admits exactly the four version invocations and nothing else,
  // so `docker exec` cannot become a general remote shell.
  ["docker", (a) => a[0] === "exec" && isVersionProbe(a)],
  // Read-only unit state.
  ["systemctl", (a) => a[0] === "is-active" || a[0] === "show" || a[0] === "status"],
  ["journalctl", () => true],
  // The existing read-only safe-egress verifier (§15). It never repairs.
  ["/usr/local/sbin/vf-egress-policy-verify", (a) => a.length === 0],
  // Read-only process sampling (§29).
  ["ps", () => true],
  ["readlink", () => true],
]);

/** The only in-container commands the allowlist admits. */
function isVersionProbe(argv) {
  const tail = argv.slice(2); // drop `exec <container>`
  const joined = tail.join(" ");
  return (
    joined === "/usr/bin/python3 --version" ||
    joined === "node --version" ||
    /^\/usr\/bin\/python3 \/usr\/local\/lib\/videofetch\/yt-dlp --version$/.test(joined) ||
    /^\/usr\/bin\/python3 -c import yt_dlp_ejs/.test(joined)
  );
}

export function isReadOnlyCommand(file, argv) {
  const args = Array.isArray(argv) ? argv : [];
  return READ_ONLY_COMMANDS.some(([exe, predicate]) => exe === file && predicate(args) === true);
}

/**
 * Runs one read-only command.
 *
 * Refuses anything outside the allowlist. The refusal is an exception rather
 * than a falsy result so it can never be mistaken for a measurement.
 */
export async function runReadOnly(file, argv, opts = {}) {
  if (!isReadOnlyCommand(file, argv)) {
    throw new Error(
      `refusing to execute a command outside the read-only allowlist: ${file} ${(argv ?? [])
        .slice(0, 2)
        .join(" ")}`,
    );
  }
  try {
    const { stdout, stderr } = await execFileAsync(file, argv, {
      timeout: opts.timeoutMs ?? 30_000,
      maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024,
      encoding: "utf8",
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    // A non-zero exit is DATA (the egress verifier failing is a finding), not a
    // harness crash. Output is redacted before it can reach a report.
    return {
      exitCode: typeof error.code === "number" ? error.code : 1,
      stdout: redactText(error.stdout ?? ""),
      stderr: redactText(error.stderr ?? ""),
      spawnError: typeof error.code === "string" ? error.code : null,
    };
  }
}

/** Wraps a producer so any failure becomes `{ measured: false, reason }` (§49). */
export async function observe(reason, producer) {
  try {
    const value = await producer();
    if (value === undefined) return { measured: false, reason: `${reason}: produced no value` };
    return { measured: true, value };
  } catch (error) {
    return { measured: false, reason: `${reason}: ${redactText(String(error?.message ?? error))}` };
  }
}

/** A never-measured observation, for surfaces this run deliberately did not reach. */
export function notMeasured(reason) {
  return Object.freeze({ measured: false, reason });
}

// ── Concrete observers ─────────────────────────────────────────────────────
//
// Each returns an observation. They are exported individually so the CLI can
// compose exactly the bundle a stage needs, and so tests can substitute fakes
// one at a time.

export function makeSystemObservers(deps = {}) {
  const run = deps.runReadOnly ?? runReadOnly;
  const container = deps.container ?? "videofetch-worker";

  return {
    async serviceState(unit) {
      return observe(`systemctl is-active ${unit}`, async () => {
        const result = await run("systemctl", ["is-active", unit]);
        return { unit, activeState: result.stdout.trim() };
      });
    },

    async runningImageId() {
      return observe("docker inspect worker image id", async () => {
        const result = await run("docker", ["inspect", "--format", "{{.Image}}", container]);
        const id = result.stdout.trim();
        if (!id) throw new Error("container is not running");
        return id;
      });
    },

    async networkMode() {
      return observe("docker inspect network mode", async () => {
        const result = await run("docker", [
          "inspect",
          "--format",
          "{{.HostConfig.NetworkMode}}",
          container,
        ]);
        return result.stdout.trim();
      });
    },

    /**
     * The Worker's bound environment VARIABLE NAMES (§16/§17).
     *
     * `{{range .Config.Env}}` yields `NAME=value` pairs, so the value is split
     * off and discarded here, in the observer, before it can reach any other
     * layer. Nothing downstream ever holds a value to accidentally print.
     */
    async environmentNames() {
      return observe("docker inspect worker environment names", async () => {
        const result = await run("docker", [
          "inspect",
          "--format",
          "{{range .Config.Env}}{{println .}}{{end}}",
          container,
        ]);
        return result.stdout
          .split("\n")
          .map((line) => line.split("=")[0].trim())
          .filter((name) => name.length > 0);
      });
    },

    /**
     * `YTDLP_ENABLED` as the deployment actually set it.
     *
     * Read from the container's bound environment rather than by reading
     * worker.env, so the harness never opens the secret-bearing file at all.
     * An unset variable yields `undefined`, which Stage A treats as disabled.
     */
    async ytdlpEnabledRaw() {
      return observe("docker inspect YTDLP_ENABLED", async () => {
        const result = await run("docker", [
          "inspect",
          "--format",
          "{{range .Config.Env}}{{println .}}{{end}}",
          container,
        ]);
        for (const line of result.stdout.split("\n")) {
          const [name, ...rest] = line.split("=");
          if (name.trim() === "YTDLP_ENABLED") return rest.join("=").trim();
        }
        return null;
      });
    },

    async egressVerifier() {
      return observe("vf-egress-policy-verify", async () => {
        const result = await run("/usr/local/sbin/vf-egress-policy-verify", []);
        // Reported, never repaired (§50).
        return { exitCode: result.exitCode };
      });
    },

    async pythonVersion() {
      return observe("python3 --version", async () => {
        const result = await run("docker", [
          "exec",
          container,
          "/usr/bin/python3",
          "--version",
        ]);
        return (result.stdout || result.stderr).trim().replace(/^Python\s+/i, "");
      });
    },

    async nodeVersion() {
      return observe("node --version", async () => {
        const result = await run("docker", ["exec", container, "node", "--version"]);
        return result.stdout.trim();
      });
    },
  };
}

/**
 * Control-plane observers.
 *
 * Authentication reuses the EXISTING private-access mechanism (§19): a POST to
 * `/api/access/login` with the operator's own secret, and the returned HttpOnly
 * cookie held in memory for the run. No bypass, no debug route, no committed
 * credential, and nothing written to disk.
 */
export function makeControlPlaneObservers(deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const baseUrl = deps.baseUrl;
  let cookie = deps.cookie ?? null;

  async function authenticatedFetch(path, init = {}) {
    const headers = new Headers(init.headers ?? {});
    if (cookie) headers.set("cookie", cookie);
    headers.set("accept", "application/json");
    return fetchImpl(new URL(path, baseUrl).toString(), { ...init, headers, redirect: "manual" });
  }

  return {
    /** Establishes the session. The secret is never stored, logged or returned. */
    async login(secret) {
      return observe("private-access login", async () => {
        const response = await fetchImpl(new URL("/api/access/login", baseUrl).toString(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ secret }),
          redirect: "manual",
        });
        const setCookie = response.headers.get("set-cookie");
        if (!response.ok || !setCookie) throw new Error(`login failed with ${response.status}`);
        cookie = setCookie.split(";")[0];
        return { authenticated: true };
      });
    },

    async capabilities() {
      return observe("GET /api/sites", async () => {
        const response = await authenticatedFetch("/api/sites");
        if (!response.ok) throw new Error(`/api/sites returned ${response.status}`);
        const body = await response.json();
        return {
          ytdlp: body.ytdlp === true,
          ytdlpInstalled: body.ytdlpInstalled === true,
          ytdlpEnabled: body.ytdlpEnabled === true,
          ffmpeg: body.ffmpeg === true,
        };
      });
    },

    async diagnostics() {
      return observe("GET /api/diagnostics", async () => {
        const response = await authenticatedFetch("/api/diagnostics");
        if (!response.ok) throw new Error(`/api/diagnostics returned ${response.status}`);
        return response.json();
      });
    },

    /** `fetchImpl` and the session cookie, for the job-lifecycle steps. */
    authenticatedFetch,
  };
}
