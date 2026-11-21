// The acceptance kit's yt-dlp runtime IDENTITY, reconciled with the LD-3e
// patched build (VIDEOFETCH-LD3E-LINUX-ACCEPTANCE-KIT-IDENTITY-RECONCILIATION-001).
//
// The kit cannot import the runtime pin everywhere it needs it: the SPLIT-07
// host driver and its pure modules run on the VM's older Node, which cannot
// load TypeScript, and the two policy verifiers are standalone Python inside
// the image. So the identity lives in independent, exact copies, and this file
// is what keeps them ONE identity: every copy is compared with the authorities
// — `YTDLP_RUNTIME` (src/worker/runtime/ytdlp-runtime.server.ts), the vendored
// PATCH-MANIFEST.json and Dockerfile.worker — while the upstream INPUT and the
// HLS-08 historical base stay distinct from it, and no evidence schema moves.
//
// Source-level only: nothing here builds an image or executes an artifact.

import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  EXPECTED_YTDLP_RUNTIME,
  HISTORICAL_SPLIT07_SCHEMAS,
  SPLIT07_EVIDENCE_SCHEMA,
} from "../deploy/acceptance/ytdlp-generic/lib/release-evidence.mjs";
import { EXPECTED_RUNTIME } from "../deploy/acceptance/ytdlp-generic/lib/stage-a.mjs";
import { HLS08_ACCEPTED_BASE } from "../deploy/acceptance/ytdlp-generic/lib/hls-container.mjs";
import { HLS08_EVIDENCE_SCHEMA } from "../deploy/acceptance/ytdlp-generic/lib/hls-evidence.mjs";
import { HLS09_RELEASE_EVIDENCE_SCHEMA } from "../deploy/acceptance/ytdlp-generic/lib/hls-release-evidence.mjs";
import { HLS11_RELEASE_EVIDENCE_SCHEMA } from "../deploy/acceptance/ytdlp-generic/lib/hls11-evidence.mjs";
import { HLS12_RELEASE_EVIDENCE_SCHEMA } from "../deploy/acceptance/ytdlp-generic/lib/hls12-evidence.mjs";
import { DASH01_RELEASE_EVIDENCE_SCHEMA } from "../deploy/acceptance/ytdlp-generic/lib/dash-evidence.mjs";
import { SYNC01_RELEASE_EVIDENCE_SCHEMA } from "../deploy/acceptance/ytdlp-generic/lib/sync-evidence.mjs";
import { SPLIT06_EVIDENCE_SCHEMA } from "../deploy/acceptance/ytdlp-generic/lib/split-evidence.mjs";
import { EVIDENCE_SCHEMA_VERSION } from "../deploy/acceptance/ytdlp-generic/lib/provenance.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** The LD-3e patched artifact, literally, as reviewed. Independent of every copy under test. */
const PATCHED = Object.freeze({
  version: "2026.08.19+videofetch.ld3e1",
  sha256: "2dfa21ec04eebb61612e3e6eb5d24f13527264275a0a34d6ef7e5d33a9260259",
  bytes: 3_088_241,
  path: "/usr/local/lib/videofetch/yt-dlp",
});

/** The upstream asset the build starts from: provenance, never a release runtime. */
const UPSTREAM = Object.freeze({
  version: "2026.08.19",
  sha256: "1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6",
  bytes: 3_072_469,
});

const VERIFIERS = Object.freeze([
  "deploy/acceptance/ytdlp-generic/verify-selector.py",
  "deploy/acceptance/ytdlp-generic/verify-download-policy.py",
]);

/** Docker's logical instructions: comments dropped, `\` continuations joined (as container-policy.test.ts does). */
function dockerInstructions(source) {
  const logical = [];
  let buffer = "";
  for (const raw of source.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^\s*#/.test(line)) continue;
    if (buffer === "" && line.trim() === "") continue;
    if (/\\\s*$/.test(line)) {
      buffer += line.replace(/\\\s*$/, " ");
      continue;
    }
    buffer += line;
    if (buffer.trim().length > 0) logical.push(buffer.trim());
    buffer = "";
  }
  if (buffer.trim().length > 0) logical.push(buffer.trim());
  return logical;
}

/** Every `EXPECTED_VERSION = "<value>"` assignment in a verifier, as values. */
function verifierPins(source) {
  return [...source.matchAll(/^EXPECTED_VERSION = "([^"\n]*)"$/gm)].map((match) => match[1]);
}

let YTDLP_RUNTIME;
let manifest;
let dockerfile;
before(async () => {
  await import("./register-ts-aliases.mjs");
  ({ YTDLP_RUNTIME } = await import("../src/worker/runtime/ytdlp-runtime.server.ts"));
  manifest = JSON.parse(read("vendor/yt-dlp/2026.08.19-videofetch-ld3e/PATCH-MANIFEST.json"));
  dockerfile = dockerInstructions(read("Dockerfile.worker"));
});

describe("one patched runtime identity across every independent copy", () => {
  it("the authorities agree: YTDLP_RUNTIME, PATCH-MANIFEST.json and Dockerfile.worker name the patched artifact", () => {
    assert.equal(YTDLP_RUNTIME.expectedVersion, PATCHED.version);
    assert.equal(YTDLP_RUNTIME.sha256, PATCHED.sha256);
    assert.equal(YTDLP_RUNTIME.sizeBytes, PATCHED.bytes);
    assert.equal(YTDLP_RUNTIME.artifactPath, PATCHED.path);

    assert.equal(manifest.identity, PATCHED.version);
    assert.deepEqual(
      [manifest.output.identity, manifest.output.sha256, manifest.output.bytes, manifest.output.installedAt],
      [PATCHED.version, PATCHED.sha256, PATCHED.bytes, PATCHED.path],
    );

    // The build stage's final check, the one COPY of its output, and the
    // ownership and mode the release kit expects the image to show.
    const finalCheck = dockerfile.filter((line) => line.includes("sha256sum --check --strict"));
    assert.equal(finalCheck.length, 1);
    assert.ok(finalCheck[0].includes(`echo "${PATCHED.sha256}  /build/out/yt-dlp" | sha256sum --check --strict -`));
    assert.deepEqual(
      dockerfile.filter((line) => line.startsWith("COPY --from=ytdlp-build")),
      [`COPY --from=ytdlp-build /build/out/yt-dlp ${PATCHED.path}`],
    );
    assert.deepEqual(
      dockerfile
        .filter((line) => line.includes(`chmod`) && line.includes(PATCHED.path))
        .map((line) => line.replace(/\s+/g, " ")),
      [`RUN chown root:root ${PATCHED.path} && chmod 0555 ${PATCHED.path}`],
    );
  });

  it("SPLIT-07's EXPECTED_YTDLP_RUNTIME is exactly that artifact: version, digest, path, root:root 0555", () => {
    assert.ok(Object.isFrozen(EXPECTED_YTDLP_RUNTIME));
    assert.deepEqual({ ...EXPECTED_YTDLP_RUNTIME }, {
      path: YTDLP_RUNTIME.artifactPath,
      version: YTDLP_RUNTIME.expectedVersion,
      sha256: YTDLP_RUNTIME.sha256,
      uid: 0,
      gid: 0,
      mode: "0555",
    });
    assert.deepEqual(
      [EXPECTED_YTDLP_RUNTIME.version, EXPECTED_YTDLP_RUNTIME.sha256, EXPECTED_YTDLP_RUNTIME.path],
      [manifest.output.identity, manifest.output.sha256, manifest.output.installedAt],
    );
  });

  it("Stage A's EXPECTED_RUNTIME pins the same identity, and the EJS version bundled inside that artifact", () => {
    assert.ok(Object.isFrozen(EXPECTED_RUNTIME));
    assert.equal(EXPECTED_RUNTIME.ytdlpVersion, YTDLP_RUNTIME.expectedVersion);
    assert.equal(EXPECTED_RUNTIME.ytdlpVersion, PATCHED.version);
    assert.equal(EXPECTED_RUNTIME.bundledEjsVersion, YTDLP_RUNTIME.bundledEjsVersion);
    // The rest of the reviewed contract is untouched by LD-3e.
    assert.deepEqual(
      [EXPECTED_RUNTIME.pythonSeries, EXPECTED_RUNTIME.nodeMajor, EXPECTED_RUNTIME.nodeExpected],
      ["3.11", "22", "v22.23.2"],
    );
  });

  it("both standalone Python verifiers pin that identity exactly once, read it from the artifact, and refuse any other", () => {
    for (const path of VERIFIERS) {
      const source = read(path);
      assert.deepEqual(verifierPins(source), [YTDLP_RUNTIME.expectedVersion], path);
      assert.equal(source.match(/^\s+from yt_dlp\.version import __version__$/gm)?.length, 1, `${path}: identity read from the artifact`);
      const gate = /^( +)if __version__ != EXPECTED_VERSION:\n\1 {4}print\(f"FAIL: expected yt-dlp \{EXPECTED_VERSION\}, got \{__version__\}"\)\n\1 {4}return 2$/gm;
      assert.equal(source.match(gate)?.length, 1, `${path}: the exact-identity refusal is intact`);
    }
  });
});

describe("the upstream input and the HLS-08 base are provenance, not the release identity", () => {
  it("the upstream asset is pinned only as the build's input", () => {
    assert.deepEqual(
      [YTDLP_RUNTIME.upstream.version, YTDLP_RUNTIME.upstream.sha256],
      [UPSTREAM.version, UPSTREAM.sha256],
    );
    assert.deepEqual(
      [manifest.upstream.release, manifest.upstream.assetSha256, manifest.upstream.assetBytes],
      [UPSTREAM.version, UPSTREAM.sha256, UPSTREAM.bytes],
    );
    const adds = dockerfile.filter((line) => line.startsWith("ADD ") && line.includes("yt-dlp"));
    assert.equal(adds.length, 1);
    assert.ok(adds[0].startsWith(`ADD --checksum=sha256:${UPSTREAM.sha256} `));
    // The patched identity keeps the upstream release traceable, but is never equal to it.
    assert.ok(PATCHED.version.startsWith(`${UPSTREAM.version}+`));
  });

  it("no current acceptance expectation accepts the upstream identity", () => {
    assert.notEqual(EXPECTED_YTDLP_RUNTIME.version, UPSTREAM.version);
    assert.notEqual(EXPECTED_YTDLP_RUNTIME.sha256, UPSTREAM.sha256);
    assert.notEqual(EXPECTED_RUNTIME.ytdlpVersion, UPSTREAM.version);
    for (const path of VERIFIERS) {
      assert.ok(!verifierPins(read(path)).includes(UPSTREAM.version), path);
    }
  });

  it("the HLS-08 accepted base keeps its historical runtime — the upstream one — and is not the current pin", () => {
    assert.ok(Object.isFrozen(HLS08_ACCEPTED_BASE));
    assert.equal(HLS08_ACCEPTED_BASE.ytdlpVersion, UPSTREAM.version);
    assert.notEqual(HLS08_ACCEPTED_BASE.ytdlpVersion, YTDLP_RUNTIME.expectedVersion);
    assert.equal(HLS08_ACCEPTED_BASE.sourceCommit, "593f47dfffe79f166d40af6575c6130668e56af0");
    assert.equal(HLS08_ACCEPTED_BASE.imageDigest, "sha256:5925515fb002cd7203228325e1d30fd5987eafde3043ca1663162b9fe04df21e");
  });
});

describe("no evidence schema moved with the runtime pin", () => {
  it("every record schema the kit emits or admits is the one it was before LD-3e", () => {
    assert.deepEqual(
      {
        SPLIT07_EVIDENCE_SCHEMA,
        SPLIT06_EVIDENCE_SCHEMA,
        HLS08_EVIDENCE_SCHEMA,
        HLS09_RELEASE_EVIDENCE_SCHEMA,
        DASH01_RELEASE_EVIDENCE_SCHEMA,
        HLS11_RELEASE_EVIDENCE_SCHEMA,
        SYNC01_RELEASE_EVIDENCE_SCHEMA,
        HLS12_RELEASE_EVIDENCE_SCHEMA,
        EVIDENCE_SCHEMA_VERSION,
      },
      {
        SPLIT07_EVIDENCE_SCHEMA: "split07-release-image-candidate-09",
        SPLIT06_EVIDENCE_SCHEMA: "split06-deterministic-full-path-05",
        HLS08_EVIDENCE_SCHEMA: "hls08-deterministic-full-path-03",
        HLS09_RELEASE_EVIDENCE_SCHEMA: "hls09-release-image-full-path-02",
        DASH01_RELEASE_EVIDENCE_SCHEMA: "dash01-release-image-full-path-02",
        HLS11_RELEASE_EVIDENCE_SCHEMA: "hls11-release-image-full-path-02",
        SYNC01_RELEASE_EVIDENCE_SCHEMA: "sync01-release-image-merge-timing-01",
        HLS12_RELEASE_EVIDENCE_SCHEMA: "hls12-release-image-separate-audio-02",
        EVIDENCE_SCHEMA_VERSION: "10d-remediation-03",
      },
    );
    assert.deepEqual([...HISTORICAL_SPLIT07_SCHEMAS], [
      "split07-release-image-candidate-01",
      "split07-release-image-candidate-02",
      "split07-release-image-candidate-03",
      "split07-release-image-candidate-04",
      "split07-release-image-candidate-05",
      "split07-release-image-candidate-06",
      "split07-release-image-candidate-07",
      "split07-release-image-candidate-08",
    ]);
  });
});
