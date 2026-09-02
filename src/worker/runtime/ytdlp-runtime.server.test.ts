import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../../lib/errors.ts";
import {
  approvedJsRuntimePath,
  buildYtdlpEnvironment,
  parseYtdlpVersion,
  probeYtdlpRuntime,
  setYtdlpRuntimeProcessRunnerForTests,
  YTDLP_FFMPEG_ACQUISITION_MODES,
  YTDLP_FORBIDDEN_ENVIRONMENT,
  YTDLP_RUNTIME,
  ytdlpPolicyArgs,
} from "./ytdlp-runtime.server.ts";

/**
 * PHASE-10C1-YTDLP-RUNTIME-FOUNDATION-001 — runtime foundation invariants.
 *
 * These tests assert the SEMANTICS of the closed policy: which options are
 * present, which are absent, what the environment contains, and what the
 * version probe accepts. They deliberately inspect the built argv and env
 * rather than grepping source text, so reordering or re-commenting the policy
 * cannot break them and only a real policy change can.
 *
 * No test here performs a network request or executes a real subprocess.
 */

/** Splits the built argv into a shape that can be asserted precisely. */
function parseArgs(args: readonly string[]) {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (const arg of args) {
    if (!arg.startsWith("-")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) {
      flags.add(arg.slice(0, eq));
      values.set(arg.slice(0, eq), arg.slice(eq + 1));
    } else {
      flags.add(arg);
    }
  }
  return { flags, values };
}

describe("yt-dlp runtime pin", () => {
  it("pins an exact upstream release, digest and absolute paths", () => {
    // Date-shaped release tag: never `latest`, `nightly` or a channel name.
    assert.match(YTDLP_RUNTIME.expectedVersion, /^\d{4}\.\d{2}\.\d{2}$/);
    // A 64-hex SHA-256, not a placeholder.
    assert.match(YTDLP_RUNTIME.sha256, /^[0-9a-f]{64}$/);
    // The release URL must embed the exact pinned version and must be an
    // immutable release asset, never a moving pointer.
    assert.ok(YTDLP_RUNTIME.releaseUrl.startsWith("https://github.com/yt-dlp/yt-dlp/releases/download/"));
    assert.ok(YTDLP_RUNTIME.releaseUrl.includes(`/${YTDLP_RUNTIME.expectedVersion}/`));
    assert.equal(YTDLP_RUNTIME.releaseUrl.includes("latest"), false);
    assert.equal(YTDLP_RUNTIME.releaseUrl.includes("nightly"), false);
    // Executables are addressed absolutely; nothing is resolved through PATH.
    assert.ok(YTDLP_RUNTIME.pythonPath.startsWith("/"));
    assert.ok(YTDLP_RUNTIME.artifactPath.startsWith("/"));
  });

  it("is not the self-extracting PyInstaller build", () => {
    // The PyInstaller executables unpack into a temp directory on every run,
    // which the read-only root and `noexec` media tmpfs would break. The
    // platform-independent zipimport asset is a bare `yt-dlp`.
    assert.ok(YTDLP_RUNTIME.releaseUrl.endsWith("/yt-dlp"));
    for (const variant of ["_linux", "_musllinux", "_macos", ".exe", "aarch64", ".zip", ".tar.gz"]) {
      assert.equal(
        YTDLP_RUNTIME.releaseUrl.includes(variant),
        false,
        `the pinned artifact must not be the ${variant} build`,
      );
    }
  });
});

describe("yt-dlp closed environment", () => {
  it("is built by allowlist, never by copying the ambient environment", () => {
    const env = buildYtdlpEnvironment();
    // Exactly the documented set, and nothing else.
    assert.deepEqual(Object.keys(env).sort(), [
      "HOME",
      "LANG",
      "LC_ALL",
      "PATH",
      "PYTHONDONTWRITEBYTECODE",
      "PYTHONNOUSERSITE",
      "TMPDIR",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
    ]);
  });

  it("does not leak sentinel ambient values into the child environment", () => {
    // Every variable named here is set in the AMBIENT process environment with
    // an obviously-wrong sentinel. None may survive into the built environment,
    // and the ones the policy deliberately replaces must carry the policy's
    // own value rather than the sentinel.
    const sentinels: Record<string, string> = {
      HTTP_PROXY: "http://sentinel.invalid:1",
      HTTPS_PROXY: "http://sentinel.invalid:2",
      ALL_PROXY: "socks5://sentinel.invalid:3",
      NO_PROXY: "sentinel.invalid",
      http_proxy: "http://sentinel.invalid:4",
      https_proxy: "http://sentinel.invalid:5",
      all_proxy: "socks5://sentinel.invalid:6",
      no_proxy: "sentinel.invalid",
      PYTHONPATH: "/sentinel/pythonpath",
      PYTHONHOME: "/sentinel/pythonhome",
      PYTHONUSERBASE: "/sentinel/userbase",
      PYTHONSTARTUP: "/sentinel/startup.py",
      XDG_CONFIG_HOME: "/sentinel/xdg-config",
      XDG_CACHE_HOME: "/sentinel/xdg-cache",
      XDG_DATA_HOME: "/sentinel/xdg-data",
      HOME: "/sentinel/home",
    };
    const saved: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(sentinels)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    try {
      const env = buildYtdlpEnvironment();
      for (const [key, sentinel] of Object.entries(sentinels)) {
        assert.notEqual(env[key], sentinel, `${key} leaked its ambient value`);
      }
      // Proxy configuration is absent outright — an inherited proxy would send
      // every media request through a host the egress policy never vetted.
      for (const key of [
        "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
        "http_proxy", "https_proxy", "all_proxy", "no_proxy",
      ]) {
        assert.equal(env[key], undefined, `${key} must not be present at all`);
      }
      // Interpreter hijacking vectors are absent outright.
      for (const key of ["PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE", "PYTHONSTARTUP"]) {
        assert.equal(env[key], undefined, `${key} must not be present at all`);
      }
      // HOME and the XDG roots are REPLACED, not inherited, so config discovery
      // finds nothing an operator or attacker placed in the real home.
      assert.equal(env.HOME, "/nonexistent");
      assert.ok(env.XDG_CONFIG_HOME!.startsWith("/nonexistent"));
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("every documented forbidden variable is genuinely absent", () => {
    const env = buildYtdlpEnvironment();
    for (const name of YTDLP_FORBIDDEN_ENVIRONMENT) {
      // XDG roots are the one documented family that is REPLACED rather than
      // removed; they must at least not be the ambient value, which the
      // sentinel test above proves.
      if (name.startsWith("XDG_")) continue;
      assert.equal(env[name], undefined, `${name} must not be present`);
    }
  });

  it("points HOME and TMPDIR at the caller's own work directory when given", () => {
    const env = buildYtdlpEnvironment({ workDir: "/tmp/videofetch/jobs/" + "a".repeat(32) });
    assert.equal(env.HOME, "/tmp/videofetch/jobs/" + "a".repeat(32));
    assert.equal(env.TMPDIR, "/tmp/videofetch/jobs/" + "a".repeat(32));
  });

  it("sets deterministic locale and defensive interpreter settings", () => {
    const env = buildYtdlpEnvironment();
    assert.equal(env.LC_ALL, "C.UTF-8");
    assert.equal(env.LANG, "C.UTF-8");
    assert.equal(env.PYTHONNOUSERSITE, "1");
    assert.equal(env.PYTHONDONTWRITEBYTECODE, "1");
  });
});

describe("yt-dlp closed argument policy", () => {
  const { flags, values } = parseArgs(ytdlpPolicyArgs());

  it("disables configuration discovery", () => {
    // Verified against this release's own options.py, not historical spelling.
    assert.ok(flags.has("--ignore-config"));
    assert.ok(flags.has("--no-config-locations"));
  });

  it("disables plugin discovery", () => {
    // NOTE: this release spells it `--no-plugin-dirs`. There is no
    // `--no-plugins` option, so asserting the real name matters.
    assert.ok(flags.has("--no-plugin-dirs"));
  });

  it("clears default JS runtimes before enabling exactly Node", () => {
    const args = ytdlpPolicyArgs();
    const clearIndex = args.indexOf("--no-js-runtimes");
    const enableIndex = args.findIndex((a) => a.startsWith("--js-runtimes="));
    assert.ok(clearIndex >= 0, "the default runtime set must be cleared");
    assert.ok(enableIndex >= 0, "exactly one runtime must be enabled");
    // Order is load-bearing: --js-runtimes APPENDS, so clearing must come
    // first or the built-in `deno` default survives.
    assert.ok(clearIndex < enableIndex, "--no-js-runtimes must precede --js-runtimes");
  });

  it("enables Node only, at an absolute path derived from this process", () => {
    const spec = values.get("--js-runtimes");
    assert.ok(spec, "a runtime spec must be present");
    const [name, path] = [spec!.slice(0, spec!.indexOf(":")), spec!.slice(spec!.indexOf(":") + 1)];
    assert.equal(name, "node");
    assert.equal(path, approvedJsRuntimePath());
    assert.ok(path.startsWith("/"), "the runtime path must be absolute, never a PATH lookup");
    assert.equal(path, process.execPath, "the runtime is the Node this Worker already runs");
  });

  it("configures no other JavaScript runtime", () => {
    const joined = ytdlpPolicyArgs().join(" ");
    for (const runtime of ["deno", "bun", "quickjs"]) {
      assert.equal(
        joined.includes(runtime),
        false,
        `${runtime} must not be configured as a JavaScript runtime`,
      );
    }
  });

  it("disables remote component fetching", () => {
    // The requisite yt_dlp_ejs package ships inside the pinned artifact, so
    // this costs no functionality: yt-dlp never needs npm or GitHub at runtime.
    assert.ok(flags.has("--no-remote-components"));
    assert.equal(
      ytdlpPolicyArgs().some((a) => a.startsWith("--remote-components")),
      false,
      "no remote component source may be allowed",
    );
  });

  it("disables self-update", () => {
    assert.ok(flags.has("--no-update"));
    for (const forbidden of ["-U", "--update", "--update-to"]) {
      assert.equal(flags.has(forbidden), false, `${forbidden} must never be passed`);
    }
  });

  it("supplies no credential mechanism of any kind", () => {
    assert.ok(flags.has("--no-cookies"));
    assert.ok(flags.has("--no-cookies-from-browser"));
    for (const forbidden of [
      "--cookies",
      "--cookies-from-browser",
      "--netrc",
      "-n",
      "--netrc-location",
      "--netrc-cmd",
      "--username",
      "-u",
      "--password",
      "-p",
      "--video-password",
      "--twofactor",
      "--ap-username",
      "--ap-password",
      "--add-headers",
      "--add-header",
    ]) {
      assert.equal(flags.has(forbidden), false, `${forbidden} must never be passed`);
    }
  });

  it("disables playlist expansion exactly once, and never re-enables it", () => {
    const args = ytdlpPolicyArgs();
    const occurrences = args.filter((a) => a === "--no-playlist");
    assert.equal(occurrences.length, 1, "--no-playlist must appear exactly once");
    assert.ok(flags.has("--no-playlist"));

    // `--yes-playlist` sets the same dest back to false, so its presence
    // anywhere later in the argv would silently undo the policy.
    assert.equal(flags.has("--yes-playlist"), false, "--yes-playlist must never be passed");
    assert.equal(
      args.some((a) => a.startsWith("--yes-playlist")),
      false,
    );
  });

  it("keeps playlist behaviour out of caller and user control", () => {
    // The policy takes only a working directory, and the array is frozen, so
    // there is no parameter through which a caller — let alone a request —
    // could opt into playlist expansion.
    const withWorkDir = ytdlpPolicyArgs({ workDir: "/tmp/videofetch/jobs/" + "b".repeat(32) });
    assert.equal(withWorkDir.filter((a) => a === "--no-playlist").length, 1);
    assert.equal(withWorkDir.includes("--yes-playlist"), false);
    assert.ok(Object.isFrozen(withWorkDir));
  });

  it("requests exactly the native downloader, as a fixed application-owned value", () => {
    // CORRECTED: this previously asserted that NO `--downloader` option was
    // present at all. That was weaker than it looked. With no downloader
    // preference, `external_downloader` is None, and yt-dlp's dispatch is then
    // free to select FFmpegFD for several ordinary cases. Asking for `native`
    // explicitly is the stronger position.
    const downloaders = ytdlpPolicyArgs().filter((a) => a.startsWith("--downloader"));
    assert.equal(downloaders.length, 1, "exactly one downloader policy may exist");
    assert.equal(values.get("--downloader"), "native");

    // `--downloader` parses as `[PROTO:]NAME` into a dict, so a bare value
    // becomes `{default: "native"}` — the policy for every protocol.
    assert.equal(
      values.get("--downloader")!.includes(":"),
      false,
      "the downloader policy must apply to every protocol, not one protocol",
    );
  });

  it("permits no downloader arguments and no per-protocol downloader override", () => {
    for (const forbidden of [
      "--external-downloader",
      "--downloader-args",
      "--external-downloader-args",
    ]) {
      assert.equal(flags.has(forbidden), false, `${forbidden} must never be passed`);
    }
  });

  it("configures no third-party downloader and no command execution hook", () => {
    // yt-dlp acquisition must never become an arbitrary child command.
    for (const forbidden of [
      "--exec",
      "--exec-before-download",
      "--postprocessor-args",
      "--ppa",
    ]) {
      assert.equal(flags.has(forbidden), false, `${forbidden} must never be passed`);
    }

    // `ffmpeg` is deliberately NOT in this list. FFmpeg IS installed in the
    // Worker image — it is VideoFetch's own processing tool — and yt-dlp
    // recognises `ffmpeg` as a downloader name. What must not happen is
    // yt-dlp being CONFIGURED to use it, which the `native` assertion above
    // covers. The names below are third-party downloaders that are neither
    // installed nor configurable.
    const downloaderValue = values.get("--downloader") ?? "";
    for (const helper of ["aria2c", "curl", "wget", "httpie", "axel", "ffmpeg"]) {
      assert.equal(
        downloaderValue.includes(helper),
        false,
        `${helper} must not be configured as the yt-dlp downloader`,
      );
    }
  });

  it("records the acquisition modes that still resolve to FFmpeg under native", () => {
    // The native downloader does NOT mean "yt-dlp will never invoke FFmpeg".
    // Verified against the pinned release's own dispatch: live HLS and
    // rtmp_ffmpeg still resolve to FFmpegFD regardless of this policy. Those
    // are integration-time protocol gates, recorded here so the limitation is
    // impossible to lose track of.
    assert.ok(YTDLP_FFMPEG_ACQUISITION_MODES.length >= 2);
    const joined = YTDLP_FFMPEG_ACQUISITION_MODES.join(" | ").toLowerCase();
    assert.ok(joined.includes("m3u8"), "live HLS must be recorded");
    assert.ok(joined.includes("rtmp_ffmpeg"), "rtmp_ffmpeg must be recorded");
    assert.ok(Object.isFrozen(YTDLP_FFMPEG_ACQUISITION_MODES));
  });

  it("contains no URL, format selector, or output template", () => {
    // Phase 10C1 has NO user-URL execution path. The base policy is the whole
    // policy, and it must not carry the pieces an extraction would need.
    for (const forbidden of [
      "-f",
      "--format",
      "-o",
      "--output",
      "--paths",
      "-P",
      // Playlist RANGE/INDEX selection would imply playlist handling exists.
      "--playlist-items",
      "-I",
      "--max-downloads",
    ]) {
      assert.equal(flags.has(forbidden), false, `${forbidden} must not be in the base policy`);
    }
    // No bare positional argument (a URL) may be present either.
    assert.equal(
      ytdlpPolicyArgs().every((a) => a.startsWith("-")),
      true,
      "the base policy must contain only options, never a positional argument",
    );
  });

  it("is frozen so a caller cannot mutate the shared policy", () => {
    const args = ytdlpPolicyArgs();
    assert.ok(Object.isFrozen(args));
  });
});

describe("yt-dlp version parsing", () => {
  it("accepts a bare release version", () => {
    assert.equal(parseYtdlpVersion("2026.08.19\n"), "2026.08.19");
    assert.equal(parseYtdlpVersion("  2026.08.19  "), "2026.08.19");
    assert.equal(parseYtdlpVersion("2026.08.19.1"), "2026.08.19.1");
  });

  it("rejects anything that is not exactly one version line", () => {
    // The legacy probe accepted any output merely CONTAINING /20\d{2}/, which
    // would have accepted a completely different build, a warning banner, or
    // an update notice. This one does not.
    for (const bad of [
      "",
      "   ",
      "not-a-version",
      "yt-dlp 2026.08.19",
      "2026.08.19\nWARNING: you are using an outdated version",
      "WARNING: something\n2026.08.19",
      "20260819",
      "2026.8.19",
    ]) {
      assert.equal(parseYtdlpVersion(bad), null, `${JSON.stringify(bad)} must be rejected`);
    }
  });
});

describe("yt-dlp runtime probe", () => {
  afterEach(() => setYtdlpRuntimeProcessRunnerForTests(null));

  it("reports available only for the exact pinned version", async () => {
    type Invocation = { command: string; args: string[]; env?: NodeJS.ProcessEnv };
    const seen: Invocation[] = [];
    setYtdlpRuntimeProcessRunnerForTests(async (opts) => {
      seen.push({ command: opts.command, args: opts.args, env: opts.env });
      return { code: 0, stdout: `${YTDLP_RUNTIME.expectedVersion}\n`, stderr: "" };
    });

    const status = await probeYtdlpRuntime();
    assert.equal(status.available, true);
    assert.equal(status.version, YTDLP_RUNTIME.expectedVersion);
    assert.equal(status.reason, "ok");

    // The probe executes by absolute path, asks only for a version, and
    // carries the full closed policy — no URL and no network operation.
    assert.equal(seen.length, 1, "the probe must spawn exactly once");
    const call = seen[0];
    assert.equal(call.command, YTDLP_RUNTIME.pythonPath);
    assert.equal(call.args[0], YTDLP_RUNTIME.artifactPath);
    assert.equal(call.args.at(-1), "--version");
    assert.ok(call.args.includes("--ignore-config"));
    assert.ok(call.args.includes("--no-plugin-dirs"));
    // No positional argument (a URL) may ever be present.
    assert.deepEqual(
      call.args.slice(1).filter((a) => !a.startsWith("-")),
      [],
      "the probe must pass no positional argument",
    );
    assert.ok(call.env, "the probe must supply an explicit environment");
    assert.equal(call.env!.PYTHONPATH, undefined);
  });

  it("reports unavailable when a different yt-dlp version answers", async () => {
    setYtdlpRuntimeProcessRunnerForTests(async () => ({
      code: 0,
      stdout: "2025.01.01\n",
      stderr: "",
    }));
    const status = await probeYtdlpRuntime();
    assert.equal(status.available, false);
    assert.equal(status.version, null);
    assert.equal(status.reason, "version_mismatch");
  });

  it("reports unavailable on malformed output", async () => {
    setYtdlpRuntimeProcessRunnerForTests(async () => ({
      code: 0,
      stdout: "yt-dlp version 2026.08.19 (some banner)\n",
      stderr: "",
    }));
    const status = await probeYtdlpRuntime();
    assert.equal(status.available, false);
    assert.equal(status.reason, "malformed_output");
  });

  it("reports unavailable on a nonzero exit", async () => {
    setYtdlpRuntimeProcessRunnerForTests(async () => ({
      code: 1,
      stdout: "",
      stderr: "ImportError: unsupported version of Python",
    }));
    const status = await probeYtdlpRuntime();
    assert.equal(status.available, false);
    assert.equal(status.reason, "process_error");
  });

  it("reports unavailable when the interpreter or artifact is missing", async () => {
    setYtdlpRuntimeProcessRunnerForTests(async () => {
      throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    });
    const status = await probeYtdlpRuntime();
    assert.equal(status.available, false);
    assert.equal(status.reason, "process_error");
  });

  it("reports unavailable on timeout", async () => {
    setYtdlpRuntimeProcessRunnerForTests(async () => {
      throw new AppError("TIMEOUT");
    });
    const status = await probeYtdlpRuntime();
    assert.equal(status.available, false);
    assert.equal(status.reason, "timeout");
  });

  it("never surfaces raw subprocess output", async () => {
    setYtdlpRuntimeProcessRunnerForTests(async () => ({
      code: 1,
      stdout: "SENTINEL-STDOUT",
      stderr: "SENTINEL-STDERR https://example.invalid/x?token=abc123",
    }));
    const status = await probeYtdlpRuntime();
    const serialized = JSON.stringify(status);
    assert.equal(serialized.includes("SENTINEL"), false);
    assert.equal(serialized.includes("token=abc123"), false);
  });
});
