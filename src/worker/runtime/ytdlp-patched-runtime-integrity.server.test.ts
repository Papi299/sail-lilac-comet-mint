import { describe, it, afterEach, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "../../lib/errors.ts";
import {
  probeYtdlpRuntime,
  setYtdlpRuntimeArtifactForTests,
  setYtdlpRuntimeProcessRunnerForTests,
  YTDLP_RUNTIME,
  type YtdlpRuntimeStatus,
} from "./ytdlp-runtime.server.ts";

/**
 * VIDEOFETCH-LD3E-PINNED-YTDLP-PATCHED-RUNTIME-SOURCE-IMPLEMENTATION-001 — the
 * runtime probe authenticates the artifact's bytes BEFORE it executes it.
 *
 * `probeYtdlpRuntime` reads the installed artifact once (bounded, read-only,
 * no symbolic link followed), requires its exact size and SHA-256, and only
 * then runs `--version`, which must print the exact patched identity. These
 * tests drive the REAL integrity code against real temporary files; only the
 * subprocess is faked, and the fake records every call, so "the wrong
 * artifact never reached the subprocess" is an observed fact, not an
 * inference. The pinned artifact itself is exercised by the pinned-runtime
 * contract files, which skip unless its digest is the pin.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

type Call = { command: string; args: readonly string[]; timeoutMs: number; signal?: AbortSignal };

let calls: Call[] = [];
let answer: () => Promise<{ code: number; stdout: string; stderr: string }> = async () => ({
  code: 0,
  stdout: `${YTDLP_RUNTIME.expectedVersion}\n`,
  stderr: "",
});

function recordingRunner(): void {
  calls = [];
  setYtdlpRuntimeProcessRunnerForTests(async (opts) => {
    calls.push({ command: opts.command, args: opts.args, timeoutMs: opts.timeoutMs, signal: opts.signal });
    return answer();
  });
}

let dir = "";
let path = "";
const GOOD = Buffer.concat([Buffer.from("#!/usr/bin/env python3\n"), Buffer.alloc(600_000, 0x5a)]);
const GOOD_SHA = sha256(GOOD);

function installGood(): void {
  writeFileSync(path, GOOD);
  setYtdlpRuntimeArtifactForTests({ path, sha256: GOOD_SHA, sizeBytes: GOOD.length });
}

describe("LD-3e runtime integrity: the probe authenticates the bytes before executing them", () => {
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "ytdlp-integrity-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => {
    rmSync(join(dir, "a"), { recursive: true, force: true });
    mkdirSync(join(dir, "a"));
    path = join(dir, "a", "yt-dlp");
  });
  afterEach(() => {
    setYtdlpRuntimeProcessRunnerForTests(null);
    setYtdlpRuntimeArtifactForTests(null);
    answer = async () => ({ code: 0, stdout: `${YTDLP_RUNTIME.expectedVersion}\n`, stderr: "" });
  });

  it("reports available only after the exact bytes AND the exact identity", async () => {
    installGood();
    recordingRunner();
    const status = await probeYtdlpRuntime();
    assert.deepEqual(status, { available: true, version: YTDLP_RUNTIME.expectedVersion, reason: "ok" });
    assert.equal(calls.length, 1, "the version probe runs once, after the bytes were authenticated");
    assert.equal(calls[0].command, YTDLP_RUNTIME.pythonPath);
    assert.equal(calls[0].args[0], YTDLP_RUNTIME.artifactPath, "the command line always names the real artifact path");
    assert.equal(calls[0].args.at(-1), "--version");
  });

  it("refuses a wrong digest with the correct size, and never executes it", async () => {
    const bad = Buffer.from(GOOD);
    bad[GOOD.length - 1] ^= 0x01;
    writeFileSync(path, bad);
    setYtdlpRuntimeArtifactForTests({ path, sha256: GOOD_SHA, sizeBytes: GOOD.length });
    recordingRunner();
    const status = await probeYtdlpRuntime();
    assert.deepEqual(status, { available: false, version: null, reason: "digest_mismatch" });
    assert.equal(calls.length, 0, "a wrong artifact must never reach the subprocess");
  });

  it("refuses the correct version from the wrong executable", async () => {
    // The fake subprocess would answer the exact pinned identity. It is never asked.
    writeFileSync(path, Buffer.concat([GOOD.subarray(0, 100), Buffer.from("X"), GOOD.subarray(101)]));
    setYtdlpRuntimeArtifactForTests({ path, sha256: GOOD_SHA, sizeBytes: GOOD.length });
    recordingRunner();
    const status = await probeYtdlpRuntime();
    assert.equal(status.available, false);
    assert.equal(status.reason, "digest_mismatch");
    assert.equal(calls.length, 0);
  });

  it("refuses the wrong version from the correct executable", async () => {
    installGood();
    answer = async () => ({ code: 0, stdout: `${YTDLP_RUNTIME.upstream.version}\n`, stderr: "" });
    recordingRunner();
    const status = await probeYtdlpRuntime();
    assert.deepEqual(status, { available: false, version: null, reason: "version_mismatch" });
    assert.equal(calls.length, 1, "the bytes passed, so the identity was asked for, and refused");
  });

  it("refuses a file of another size without reading it through", async () => {
    // A sparse 4 GiB file: hashing it would take seconds; the size check refuses it at once.
    writeFileSync(path, GOOD);
    truncateSync(path, 4 * 1024 ** 3);
    setYtdlpRuntimeArtifactForTests({ path, sha256: GOOD_SHA, sizeBytes: GOOD.length });
    recordingRunner();
    const begun = performance.now();
    const status = await probeYtdlpRuntime();
    const elapsed = performance.now() - begun;
    assert.equal(status.reason, "digest_mismatch");
    assert.equal(calls.length, 0);
    assert.ok(elapsed < 2_000, `the oversized file was refused by its size, not hashed (${Math.round(elapsed)} ms)`);
  });

  it("refuses an appended byte and a truncated file", async () => {
    for (const bytes of [Buffer.concat([GOOD, Buffer.from([0])]), GOOD.subarray(0, GOOD.length - 1)]) {
      writeFileSync(path, bytes);
      setYtdlpRuntimeArtifactForTests({ path, sha256: GOOD_SHA, sizeBytes: GOOD.length });
      recordingRunner();
      const status = await probeYtdlpRuntime();
      assert.equal(status.reason, "digest_mismatch");
      assert.equal(calls.length, 0);
    }
  });

  it("refuses a missing artifact", async () => {
    setYtdlpRuntimeArtifactForTests({ path: join(dir, "a", "absent"), sha256: GOOD_SHA, sizeBytes: GOOD.length });
    recordingRunner();
    const status = await probeYtdlpRuntime();
    assert.deepEqual(status, { available: false, version: null, reason: "artifact_unreadable" });
    assert.equal(calls.length, 0, "a missing artifact must never be marked available or executed");
  });

  it("refuses a directory in the artifact's place", async () => {
    mkdirSync(path);
    setYtdlpRuntimeArtifactForTests({ path, sha256: GOOD_SHA, sizeBytes: GOOD.length });
    recordingRunner();
    const status = await probeYtdlpRuntime();
    assert.equal(status.reason, "artifact_unreadable");
    assert.equal(calls.length, 0);
  });

  it("refuses an unreadable artifact", { skip: process.getuid?.() === 0 ? "root reads mode-000 files" : false }, async () => {
    installGood();
    chmodSync(path, 0o000);
    try {
      recordingRunner();
      const status = await probeYtdlpRuntime();
      assert.equal(status.reason, "artifact_unreadable");
      assert.equal(calls.length, 0);
    } finally {
      chmodSync(path, 0o644);
    }
  });

  it("refuses a symbolic link, even to the exact bytes", async () => {
    const target = join(dir, "a", "real-yt-dlp");
    writeFileSync(target, GOOD);
    symlinkSync(target, path);
    setYtdlpRuntimeArtifactForTests({ path, sha256: GOOD_SHA, sizeBytes: GOOD.length });
    recordingRunner();
    const status = await probeYtdlpRuntime();
    assert.equal(status.reason, "artifact_unreadable", "the link is not followed");
    assert.equal(calls.length, 0);
  });

  it("re-authenticates on every probe: a replaced executable is refused, and nothing is cached", async () => {
    installGood();
    recordingRunner();
    assert.equal((await probeYtdlpRuntime()).available, true);
    const swap = join(dir, "a", "swap");
    const other = Buffer.from(GOOD);
    other[23] ^= 0xff;
    writeFileSync(swap, other);
    renameSync(swap, path);
    assert.equal((await probeYtdlpRuntime()).reason, "digest_mismatch", "the replacement is refused");
    writeFileSync(swap, GOOD);
    renameSync(swap, path);
    assert.equal((await probeYtdlpRuntime()).available, true, "the restored artifact is accepted again");
    assert.equal(calls.length, 2, "only the two authenticated probes reached the subprocess");
  });

  it("re-throws a cancellation that comes before the integrity read, without executing", async () => {
    installGood();
    recordingRunner();
    const controller = new AbortController();
    controller.abort();
    const err = await probeYtdlpRuntime({ signal: controller.signal }).then(
      (s: YtdlpRuntimeStatus) => s,
      (e: unknown) => e,
    );
    assert.ok(err instanceof AppError, "a cancellation, not a status");
    assert.equal((err as AppError).code, "PROCESSING_FAILED");
    assert.equal((err as AppError).message, "Download was cancelled.", "the hardened runner's own cancellation error");
    assert.equal(calls.length, 0);
  });

  it("re-throws a cancellation that arrives during the integrity read, without executing", async () => {
    installGood();
    recordingRunner();
    const controller = new AbortController();
    const pending = probeYtdlpRuntime({ signal: controller.signal });
    controller.abort(); // the probe is awaiting its file open; the read loop sees the abort
    const err = await pending.then((s: YtdlpRuntimeStatus) => s, (e: unknown) => e);
    assert.ok(err instanceof AppError);
    assert.equal((err as AppError).code, "PROCESSING_FAILED");
    assert.equal(calls.length, 0, "a cancelled probe never starts the subprocess");
  });

  it("re-throws a cancellation that arrives during the version subprocess", async () => {
    installGood();
    const controller = new AbortController();
    const runnerCancelled = new AppError("PROCESSING_FAILED", "Download was cancelled.");
    answer = async () => {
      controller.abort();
      throw runnerCancelled;
    };
    recordingRunner();
    const err = await probeYtdlpRuntime({ signal: controller.signal }).then((s: YtdlpRuntimeStatus) => s, (e: unknown) => e);
    assert.equal(err, runnerCancelled, "the runner's cancellation propagates verbatim");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].signal, controller.signal);
  });

  it("gives the version subprocess the caller's budget, unchanged by the integrity read", async () => {
    installGood();
    recordingRunner();
    await probeYtdlpRuntime({ timeoutMs: 2_000 });
    assert.equal(calls[0].timeoutMs, 2_000);
  });

  it("authenticates concurrent probes independently", async () => {
    installGood();
    recordingRunner();
    const good = await Promise.all(Array.from({ length: 8 }, () => probeYtdlpRuntime()));
    assert.ok(good.every((s) => s.available), "eight concurrent probes of the exact bytes all succeed");
    assert.equal(calls.length, 8);
    const bad = Buffer.from(GOOD);
    bad[1000] ^= 0x01;
    writeFileSync(path, bad);
    calls = [];
    const refused = await Promise.all(Array.from({ length: 8 }, () => probeYtdlpRuntime()));
    assert.ok(refused.every((s) => s.reason === "digest_mismatch"), "eight concurrent probes of a modified file are all refused");
    assert.equal(calls.length, 0);
  });

  it("never surfaces a path, a byte or a digest in its status", async () => {
    const bad = Buffer.from(GOOD);
    bad[5] ^= 0x01;
    writeFileSync(path, bad);
    setYtdlpRuntimeArtifactForTests({ path, sha256: GOOD_SHA, sizeBytes: GOOD.length });
    recordingRunner();
    const statuses = [
      await probeYtdlpRuntime(),
      (setYtdlpRuntimeArtifactForTests({ path: join(dir, "a", "absent"), sha256: GOOD_SHA, sizeBytes: GOOD.length }), await probeYtdlpRuntime()),
    ];
    for (const status of statuses) {
      const text = JSON.stringify(status);
      for (const needle of [dir, "yt-dlp", GOOD_SHA, sha256(bad), YTDLP_RUNTIME.sha256, "#!/usr/bin"]) {
        assert.equal(text.includes(needle), false, `the status must not carry ${needle}`);
      }
      assert.deepEqual(Object.keys(status).sort(), ["available", "reason", "version"]);
    }
  });

  it("authenticates the pinned path against the pinned digest when no test artifact is installed", async () => {
    setYtdlpRuntimeArtifactForTests(null);
    recordingRunner();
    const status = await probeYtdlpRuntime();
    const installed = existsSync(YTDLP_RUNTIME.artifactPath);
    if (!installed) {
      // A developer machine: the pinned file is absent, so nothing is executed.
      assert.deepEqual(status, { available: false, version: null, reason: "artifact_unreadable" });
      assert.equal(calls.length, 0);
    } else {
      // Inside the image: the installed file must be the pinned bytes.
      const bytes = readFileSync(YTDLP_RUNTIME.artifactPath);
      const pinned = bytes.length === YTDLP_RUNTIME.sizeBytes && sha256(bytes) === YTDLP_RUNTIME.sha256;
      assert.equal(status.available, pinned);
      assert.equal(calls.length, pinned ? 1 : 0);
    }
  });
});

describe("LD-3e runtime integrity: no other selection route", () => {
  const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

  it("the runtime module reads no environment variable", () => {
    const code = strip(readFileSync(join(ROOT, "src", "worker", "runtime", "ytdlp-runtime.server.ts"), "utf8"));
    assert.equal(/process\.env/.test(code), false, "no environment variable can select the artifact, its digest or its identity");
    assert.equal(/process\.argv/.test(code), false);
  });

  /** Every source file under the given top-level folders (a file walk, so it also works in an export without `.git`). */
  function sources(...tops: string[]): string[] {
    const out: string[] = [];
    const walk = (rel: string): void => {
      for (const entry of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const child = `${rel}/${entry.name}`;
        if (entry.isDirectory()) walk(child);
        else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) out.push(child);
      }
    };
    for (const top of tops) walk(top);
    return out;
  }

  it("only test files call the runtime module's test seams", () => {
    const callers = sources("src", "deploy", "scripts").filter((f) =>
      /setYtdlpRuntime(ArtifactForTests|ProcessRunnerForTests)/.test(readFileSync(join(ROOT, f), "utf8")));
    const outsideTests = callers.filter((f) => !/\.test\.(ts|mjs)$/.test(f) && f !== "src/worker/runtime/ytdlp-runtime.server.ts");
    assert.ok(callers.length >= 3, `the scan found the seams' own users (${callers.length})`);
    assert.deepEqual(outsideTests, [], "no production module can substitute the artifact or the runner");
  });

  it("the Worker configuration knows no yt-dlp variable beyond the three it already had", () => {
    const config = strip(readFileSync(join(ROOT, "src", "worker", "runtime", "config.server.ts"), "utf8"));
    const named = [...new Set([...config.matchAll(/\bYTDLP_[A-Z0-9_]+\b/g)].map((m) => m[0]))].sort();
    // YTDLP_ENABLED is the feature switch; the other two are RETIRED variables the loader refuses.
    assert.deepEqual(
      named.filter((n) => !["WORKER_FORBIDDEN_YTDLP_VARIABLES"].includes(n) && !n.startsWith("YTDLP_ENABLED_")),
      ["YTDLP_ENABLED", "YTDLP_NETWORK_ISOLATED", "YTDLP_PATH"],
      "no environment variable can select the artifact, its digest or its identity",
    );
  });
});
