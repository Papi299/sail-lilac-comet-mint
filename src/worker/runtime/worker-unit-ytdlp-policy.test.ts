import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Static deployment-artefact guard for the Worker unit's yt-dlp contract
 * (PHASE-10C4-YTDLP-PRODUCTION-ACCEPTANCE-HARNESS-001 §55).
 *
 * Two jobs, and only two:
 *
 *  1. the unit's yt-dlp COMMENTS must not state the Phase-10C1-era fact that
 *     no user-URL execution path exists — false in source since Phase 10C3,
 *     and the kind of stale claim an operator would reasonably act on;
 *
 *  2. the accepted FUNCTIONAL security controls must still be there, so a
 *     comment-only reconciliation cannot quietly become a behavioural change.
 *
 * The deeper safe-egress dependency semantics are owned by
 * `safe-egress-deployment-policy.test.ts` and the broker semantics by
 * `broker-deployment-policy.test.ts`. This suite re-asserts the §55 list at the
 * level Phase 10C4 is responsible for rather than restating those in full.
 *
 * Nothing here matches whitespace or comment prose beyond the single retired
 * sentence: rewrapping, reordering or re-commenting the unit must not fail it.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const UNIT = join(REPO_ROOT, "deploy", "systemd", "videofetch-worker.service");

/** Directive lines only, with `\` continuations joined. Comments dropped. */
function directiveLines(source: string): string[] {
  const out: string[] = [];
  let buffer = "";
  for (const raw of source.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^\s*#/.test(line)) continue;
    if (buffer === "" && line.trim() === "") continue;
    if (/\\\s*$/.test(line)) {
      buffer += `${line.replace(/\\\s*$/, "")} `;
      continue;
    }
    buffer += line;
    if (buffer.trim().length > 0) out.push(buffer.trim());
    buffer = "";
  }
  if (buffer.trim().length > 0) out.push(buffer.trim());
  return out;
}

function values(lines: string[], key: string): string[] {
  return lines
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1).trim());
}

function tokens(lines: string[], key: string): string[] {
  return values(lines, key).flatMap((value) => value.split(/\s+/).filter(Boolean));
}

/** Comment text only — the half this phase reconciled. */
function commentText(source: string): string {
  return source
    .split("\n")
    .filter((line) => /^\s*#/.test(line))
    .join("\n");
}

describe("videofetch-worker.service yt-dlp deployment contract", () => {
  let source: string;
  let lines: string[];
  let comments: string;
  let execStart: string;

  before(async () => {
    source = await readFile(UNIT, "utf8");
    lines = directiveLines(source);
    comments = commentText(source);
    execStart = values(lines, "ExecStart").join("\n");
  });

  describe("the comments state the CURRENT contract", () => {
    it("no longer claims that no user-URL yt-dlp execution path exists", () => {
      // The exact retired claim, matched loosely enough to survive rewrapping
      // but tightly enough that only this statement trips it. Phase 10C3 added
      // the path; a unit still asserting its absence would tell an operator the
      // image is inert when it is not.
      const collapsed = comments.replace(/[#\s]+/g, " ");
      assert.doesNotMatch(
        collapsed,
        /no user-URL yt-dlp execution path exists/i,
        "the Phase-10C1-era claim is false in current source and must not be restated",
      );
      assert.doesNotMatch(
        collapsed,
        /no user-URL yt-dlp execution path/i,
        "no rewording of the retired claim is acceptable either",
      );
    });

    it("documents the three-value YTDLP_ENABLED grammar", () => {
      const collapsed = comments.replace(/[#\s]+/g, " ");
      assert.match(collapsed, /YTDLP_ENABLED/);
      assert.match(collapsed, /absent\s*->\s*generic execution DISABLED/i);
      assert.match(collapsed, /"false"\s*->\s*DISABLED/i);
      assert.match(collapsed, /"true"\s*->\s*generic execution ENABLED/i);
    });

    it("keeps both retired variables documented as forbidden", () => {
      for (const name of ["YTDLP_NETWORK_ISOLATED", "YTDLP_PATH"]) {
        assert.match(comments, new RegExp(`${name}\\b`), `${name} must stay documented`);
      }
      assert.match(comments.replace(/[#\s]+/g, " "), /RETIRED/);
    });

    it("still attributes safe egress to the external boundary, not to this variable", () => {
      const collapsed = comments.replace(/[#\s]+/g, " ");
      assert.match(collapsed, /SAFE EGRESS IS NOT THIS VARIABLE'S JOB/i);
      assert.match(collapsed, /externally enforced/i);
    });
  });

  describe("the unit does NOT decide the switch", () => {
    it("hardcodes no YTDLP_ENABLED value", () => {
      // A committed `Environment=YTDLP_ENABLED=true` would make enabling a
      // source change rather than a deployment decision, and would defeat the
      // operator's ability to roll the switch back (§43) without a new commit.
      for (const value of values(lines, "Environment")) {
        assert.doesNotMatch(value, /\bYTDLP_ENABLED\b/, "YTDLP_ENABLED must not be set here");
      }
      assert.doesNotMatch(execStart, /--env\s+YTDLP_ENABLED/);
      assert.doesNotMatch(execStart, /YTDLP_ENABLED=/);
    });

    it("takes the value only from the operator's worker.env", () => {
      assert.match(
        execStart,
        /--env-file\s+\/etc\/videofetch\/worker\.env\b/,
        "the deployed value must come from the environment file the operator owns",
      );
    });

    it("passes neither retired variable into the container", () => {
      for (const name of ["YTDLP_NETWORK_ISOLATED", "YTDLP_PATH"]) {
        assert.doesNotMatch(execStart, new RegExp(`--env\\s+${name}\\b`));
        assert.doesNotMatch(execStart, new RegExp(`${name}=`));
      }
    });
  });

  describe("the accepted functional controls are unchanged", () => {
    it("still requires and binds to every safe-egress and broker unit", () => {
      const required = [
        "videofetch-r2-broker.service",
        "videofetch-media-netns.service",
        "videofetch-egress-policy.service",
        "videofetch-egress-watchdog.service",
        "videofetch-media-dns.service",
      ];
      for (const unit of required) {
        assert.ok(tokens(lines, "Requires").includes(unit), `Requires= must name ${unit}`);
        assert.ok(tokens(lines, "After").includes(unit), `After= must name ${unit}`);
        assert.ok(tokens(lines, "BindsTo").includes(unit), `BindsTo= must name ${unit}`);
      }
    });

    it("still gates start on the read-only egress verifier, fatally", () => {
      const gate = values(lines, "ExecStartPre").find((v) => v.includes("vf-egress-policy-verify"));
      assert.ok(gate, "the vf-egress-policy-verify pre-start gate is required");
      assert.ok(
        !gate!.trimStart().startsWith("-"),
        "a leading '-' would make the gate's failure non-fatal",
      );
    });

    it("still gates start on the numeric broker GID verification", () => {
      const gate = values(lines, "ExecStartPre").find((v) => v.includes("vf-r2-broker-gid-verify"));
      assert.ok(gate, "the broker GID gate is required");
      assert.match(gate!, /\$\{VIDEOFETCH_BROKER_GID\}/);
      assert.ok(!gate!.trimStart().startsWith("-"));
    });

    it("still runs in the media network namespace, with no fallback", () => {
      const networks = execStart.match(/--network\s+\S+/g) ?? [];
      assert.deepEqual(networks, ["--network container:videofetch-media-netns"]);
      assert.doesNotMatch(execStart, /--network\s+(host|bridge|none|default)\b/);
    });

    it("still drops all capabilities and forbids privilege gain", () => {
      assert.match(execStart, /--cap-drop=ALL\b/);
      assert.match(execStart, /--security-opt\s+no-new-privileges\b/);
      assert.doesNotMatch(execStart, /--cap-add\b/);
      assert.doesNotMatch(execStart, /--privileged\b/);
    });

    it("still runs with a read-only root filesystem", () => {
      assert.match(execStart, /--read-only\b/);
    });

    it("still mounts the media scratch as a 2 GiB noexec,nosuid tmpfs", () => {
      const tmpfs = execStart.match(/--tmpfs\s+\/tmp\/videofetch:(\S+)/);
      assert.ok(tmpfs, "the /tmp/videofetch tmpfs is required");
      const options = tmpfs![1].split(",");
      for (const option of ["rw", "noexec", "nosuid", "size=2g", "uid=1000", "gid=1000"]) {
        assert.ok(options.includes(option), `the tmpfs must keep ${option}`);
      }
      // Option-level, not substring: `noexec` must never be relaxed to `exec`.
      assert.ok(!options.includes("exec"), "the media scratch must never be executable");
      assert.ok(!options.includes("suid"));
    });

    it("still mounts the state volume rw and the broker socket directory ro", () => {
      assert.match(execStart, /--volume\s+\/var\/lib\/videofetch:\/var\/lib\/videofetch:rw\b/);
      assert.match(
        execStart,
        /--volume\s+\/run\/videofetch-r2-broker:\/run\/videofetch-r2-broker:ro\b/,
      );
    });

    it("still adds the broker group NUMERICALLY", () => {
      assert.match(execStart, /--group-add\s+\$\{VIDEOFETCH_BROKER_GID\}/);
      assert.match(
        values(lines, "EnvironmentFile").join("\n"),
        /\/etc\/videofetch\/broker-gid\.env/,
      );
    });

    it("mounts NO Docker socket and does not reach the host runtime", () => {
      assert.doesNotMatch(execStart, /docker\.sock/);
      assert.doesNotMatch(execStart, /--volume\s+\/var\/run\/docker/);
      assert.doesNotMatch(execStart, /--pid\s+host\b/);
      assert.doesNotMatch(execStart, /--ipc\s+host\b/);
    });

    it("still starts the reviewed image reference", () => {
      assert.match(execStart, /\bvideofetch-worker:latest\b/);
    });
  });
});
