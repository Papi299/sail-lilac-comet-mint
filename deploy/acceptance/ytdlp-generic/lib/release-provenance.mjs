// SPLIT-07 release-source provenance: the image the evidence names IS the
// source the evidence names.
//
// SPLIT-06's gate (`lib/split-provenance.mjs`) answers a different question. It
// asks whether overlaying the ALREADY ACCEPTED image with the candidate's
// source is equivalent to building the candidate, which is why it compares
// runtime-compatibility files between two commits. SPLIT-07 builds the image
// for real, so there is no equivalence argument to make and no second commit to
// compare against: the only question is whether the build context is exactly
// one clean Git commit, and whether it still is once Docker has read it.
//
// What this module establishes, fail-closed, BEFORE any Docker command:
//
//   A  the context is a real Git WORKTREE — not a directory whose files happen
//      to resemble a commit, and not a bare repository;
//   B  its HEAD is exactly the expected full commit;
//   C  that observed commit's tree is exactly the expected full tree;
//   D  nothing tracked is modified or deleted in the worktree;
//   E  nothing is staged — the index agrees with HEAD;
//   F  nothing untracked or ignored exists anywhere in the worktree, because
//      `docker build` sends the whole context and `.dockerignore` is not a
//      provenance boundary;
//   G  no index entry is marked assume-unchanged or skip-worktree, either of
//      which hides a modification from `git status`;
//   H  the release recipe is present at the expected path, and its committed
//      blob is recorded by object name and content digest.
//
// The same clean-worktree gate (A–G) binds the HARNESS checkout too
// (`verifyHarnessProvenance`, since `-02`): the driver, the SPLIT-06
// orchestrator, the Python verifiers, the image probe and the evidence
// evaluator are all executable acceptance code, and a locally modified harness
// could change what is measured or what counts as PASS. Recording its HEAD is
// not provenance; verifying it against explicit expectations is.
//
// The CLI values are EXPECTATIONS. What these functions return are
// OBSERVATIONS, and only observations reach evidence.
//
// Git is reached through an injected runner, so every refusal is testable
// without a repository and without Docker. Plain ESM whose only imports are
// pure harness modules: it runs on the VM's older Node.

import { createHash } from "node:crypto";
import { RELEASE_DOCKERFILE } from "./release-container.mjs";

/** A full, lowercase Git object name. An abbreviation is not provenance. */
export const FULL_GIT_SHA = /^[0-9a-f]{40}$/;

export function isFullGitSha(value) {
  return typeof value === "string" && FULL_GIT_SHA.test(value);
}

/**
 * Release inputs whose committed identity is recorded for chain of custody.
 *
 * These are the files `Dockerfile.worker` reads to decide what the image
 * contains: the recipe itself, the dependency graph it installs with `npm ci`,
 * the loader the entry point starts with, and the module whose pinned
 * yt-dlp version/digest `container-policy.test.ts` requires the recipe to
 * match. Recording their object names makes a later "which source produced
 * this image" question answerable from the evidence alone.
 */
export const RELEASE_INPUT_FILES = Object.freeze([
  RELEASE_DOCKERFILE,
  "package.json",
  "package-lock.json",
  "scripts/register-ts-aliases.mjs",
  "scripts/ts-alias-hooks.mjs",
  "src/worker/runtime/ytdlp-runtime.server.ts",
]);

/** The harness directory the candidate containers mount, relative to its root. */
export const HARNESS_DIRECTORY = "deploy/acceptance/ytdlp-generic";

/** The driver file that must be the one actually executing the run. */
export const HARNESS_DRIVER_PATH = `${HARNESS_DIRECTORY}/run-release-image-acceptance.mjs`;

/** A refusal. Its message is for the operator; nothing here reaches evidence. */
export class ReleaseProvenanceError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseProvenanceError";
  }
}

/**
 * The shared clean-worktree gate, for one provenance ROLE.
 *
 * `role` names the checkout in every refusal ("release build context",
 * "harness"), so an operator can tell which of the two failed.
 *
 * @param {object} opts
 * @param {(args: string[], options?: object) => Promise<{code: number|null, stdout: string}>} opts.git
 *        runs `git <args>` against the checkout: an argv, never a shell
 * @param {string} opts.expectedCommit full 40-hex expected commit
 * @param {string} opts.expectedTree   full 40-hex expected tree
 * @param {string} opts.role           the checkout's role, for messages
 */
async function verifyCleanWorktree({ git, expectedCommit, expectedTree, role }) {
  // A. A real worktree. `--is-inside-work-tree` is false for a bare repository
  //    and fails outright outside one, so a plain directory of look-alike
  //    files — the exact thing §8 refuses to accept as provenance — stops here
  //    rather than being measured as if it were a commit.
  const insideWorktree = await git(["rev-parse", "--is-inside-work-tree"]);
  if (insideWorktree.code !== 0 || String(insideWorktree.stdout ?? "").trim() !== "true") {
    throw new ReleaseProvenanceError(
      `the ${role} is not inside a Git worktree, so it cannot be tied to a commit`,
    );
  }
  // The checkout must BE the worktree root, not a subdirectory of one: a
  // subtree's cleanliness says nothing about the commit Git reports.
  const root = String((await git(["rev-parse", "--show-toplevel"])).stdout ?? "").trim();
  const prefix = (await git(["rev-parse", "--show-prefix"])).stdout ?? "";
  if (String(prefix).trim() !== "") {
    throw new ReleaseProvenanceError(`the ${role} is a subdirectory of a worktree rooted at ${root}`);
  }

  // B. The exact commit.
  const commit = await revParse(git, "HEAD", role);
  if (commit !== expectedCommit) {
    throw new ReleaseProvenanceError(`the ${role}'s HEAD is ${commit}, not the expected ${expectedCommit}`);
  }

  // C. The exact tree, of the commit just observed, so B and C describe one
  //    object even if HEAD moved between the two reads.
  const tree = await revParse(git, `${commit}^{tree}`, role);
  if (tree !== expectedTree) {
    throw new ReleaseProvenanceError(`commit ${commit} has tree ${tree}, not the expected ${expectedTree}`);
  }

  // D/F. Modified, deleted, staged AND untracked, in one listing. The explicit
  //      flags override any local configuration that would hide an entry.
  const dirty = await lines(git, [
    "status", "--porcelain=v1", "--untracked-files=all", "--ignored=no", "--ignore-submodules=none",
  ], role);
  if (dirty.length > 0) {
    throw new ReleaseProvenanceError(`the ${role} is not clean: ${summarize(dirty)}`);
  }

  // F. IGNORED content too. `git status` hides it, `.dockerignore` is not a
  //    provenance boundary, `docker build` sends whatever is there, and a
  //    mounted harness directory exposes whatever is there to the container.
  const ignored = await lines(git, [
    "status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none",
  ], role);
  if (ignored.length > 0) {
    throw new ReleaseProvenanceError(`the ${role} holds content Git does not track: ${summarize(ignored)}`);
  }

  // E. Nothing staged, stated as its own fact rather than inferred from the
  //    status listing: the index must agree with HEAD exactly.
  const staged = await lines(git, ["diff-index", "--cached", "--name-only", commit], role);
  if (staged.length > 0) {
    throw new ReleaseProvenanceError(`the ${role} has staged changes: ${summarize(staged)}`);
  }

  // G. No index entry may hide a modification from status.
  const hidden = (await lines(git, ["ls-files", "-v"], role)).filter((line) => /^[a-zS] /.test(line));
  if (hidden.length > 0) {
    throw new ReleaseProvenanceError(
      `index entries in the ${role} are marked assume-unchanged or skip-worktree: ${summarize(hidden)}`,
    );
  }

  return { commit, tree, root };
}

/**
 * Verifies the release build context and returns what was OBSERVED.
 *
 * @param {object} opts
 * @param {(args: string[]) => Promise<{code: number|null, stdout: string}>} opts.git
 *        runs `git <args>` against the context: an argv, never a shell
 * @param {string} opts.expectedSource  full 40-hex expected release commit
 * @param {string} opts.expectedTree    full 40-hex expected release tree
 */
export async function verifyReleaseContextProvenance({ git, expectedSource, expectedTree }) {
  requireFullSha("--source", expectedSource);
  requireFullSha("--tree", expectedTree);
  const { commit: source, tree, root } = await verifyCleanWorktree({
    git, expectedCommit: expectedSource, expectedTree, role: "release build context",
  });

  // H. The release inputs, by committed object name and content digest. Read
  //    from the OBSERVED commit rather than from the worktree: a digest taken
  //    from Git's own object store is a statement about the commit, which is
  //    what the evidence claims.
  const inputs = [];
  for (const path of RELEASE_INPUT_FILES) {
    const object = await objectAt(git, source, path);
    if (object === null) {
      throw new ReleaseProvenanceError(`the release input ${path} is absent from commit ${source}`);
    }
    inputs.push({ path, object, sha256: await blobSha256(git, source, path) });
  }
  const dockerfile = inputs.find((input) => input.path === RELEASE_DOCKERFILE);

  return {
    source,
    tree,
    root,
    contextClean: true,
    dockerfilePath: RELEASE_DOCKERFILE,
    dockerfileObject: dockerfile.object,
    dockerfileSha256: dockerfile.sha256,
    releaseInputs: inputs,
  };
}

/**
 * Verifies the HARNESS checkout and returns what was OBSERVED (since `-02`).
 *
 * The same gate as the release context — worktree root, exact commit, exact
 * tree, nothing modified, staged, untracked, ignored or hidden — against the
 * operator's explicit `--harness-source`/`--harness-tree`, never against values
 * derived from the checkout being verified. It additionally records the Git
 * tree object of the mounted harness directory and the driver's blob, so the
 * record names exactly the acceptance code that ran.
 *
 * The driver calls this before any Docker command AND again at every later
 * checkpoint, finishing after both SPLIT-06 children and before the parent
 * record is assembled: the harness is mounted and consumed throughout the run,
 * so a harness that was clean only at the start proves nothing about the end.
 */
export async function verifyHarnessProvenance({ git, expectedCommit, expectedTree }) {
  requireFullSha("--harness-source", expectedCommit);
  requireFullSha("--harness-tree", expectedTree);
  const { commit, tree, root } = await verifyCleanWorktree({
    git, expectedCommit, expectedTree, role: "harness",
  });
  const directoryTree = await objectAt(git, commit, HARNESS_DIRECTORY);
  if (directoryTree === null) {
    throw new ReleaseProvenanceError(`the harness commit ${commit} carries no ${HARNESS_DIRECTORY}`);
  }
  const driverObject = await objectAt(git, commit, HARNESS_DRIVER_PATH);
  if (driverObject === null) {
    throw new ReleaseProvenanceError(`the harness commit ${commit} carries no ${HARNESS_DRIVER_PATH}`);
  }
  return {
    commit,
    tree,
    root,
    contextClean: true,
    directory: HARNESS_DIRECTORY,
    directoryTree,
    driverPath: HARNESS_DRIVER_PATH,
    driverObject,
  };
}

/**
 * The source-side manifest of what `Dockerfile.worker` is supposed to place
 * into `/app`: sorted `relative-path` + SHA-256 of the committed bytes.
 *
 * Read from the OBSERVED commit's objects, never from the worktree. The context
 * is verified clean, so the two agree — but a manifest taken from Git is a
 * statement about a commit, and that is what the identity comparison in §10
 * needs to be about.
 *
 * `src/broker` is excluded deliberately, not incidentally: the recipe removes
 * it after `COPY src`, because the media image must contain no code that knows
 * how to mint from the R2 parent credential. The exclusion is returned
 * alongside the manifest so the evidence can state it as an accounted-for
 * removal rather than a silent gap.
 */
export const IMAGE_SOURCE_ROOTS = Object.freeze([
  "package.json",
  "package-lock.json",
  "scripts/register-ts-aliases.mjs",
  "scripts/ts-alias-hooks.mjs",
  "src",
]);

/** The one subtree `Dockerfile.worker` copies and then removes. */
export const IMAGE_SOURCE_EXCLUDED_PREFIX = "src/broker/";

export async function buildExpectedSourceManifest({ git, source }) {
  requireFullSha("source", source);
  // `-r` recurses, `-z` is NUL-delimited so a path containing whitespace or a
  // quote cannot be misread, and `--full-tree` makes the listing independent of
  // any working subdirectory.
  const listing = await git(["ls-tree", "-r", "-z", "--full-tree", source, "--", ...IMAGE_SOURCE_ROOTS]);
  if (listing.code !== 0) {
    throw new ReleaseProvenanceError(`git ls-tree failed for commit ${source}`);
  }
  const entries = [];
  const excluded = [];
  for (const record of String(listing.stdout ?? "").split("\0")) {
    if (record.length === 0) continue;
    // `<mode> SP <type> SP <object> TAB <path>`
    const tab = record.indexOf("\t");
    if (tab < 0) throw new ReleaseProvenanceError("unparsable git ls-tree record");
    const [mode, type, object] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    // Only REGULAR files reach `/app` as comparable content. A symlink's target
    // is not its bytes, and a gitlink is not a file at all, so either one being
    // present here would make the manifest a different claim than it appears to
    // be — they are refused rather than skipped.
    if (type !== "blob") {
      throw new ReleaseProvenanceError(`commit ${source} carries a non-blob entry under /app: ${path}`);
    }
    if (mode === "120000") {
      throw new ReleaseProvenanceError(`commit ${source} carries a symlink under /app: ${path}`);
    }
    if (path.startsWith(IMAGE_SOURCE_EXCLUDED_PREFIX)) {
      excluded.push({ path, object });
      continue;
    }
    entries.push({ path, object, sha256: await blobSha256(git, source, path) });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  excluded.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (entries.length === 0) {
    throw new ReleaseProvenanceError(`commit ${source} carries no application source under /app`);
  }
  if (excluded.length === 0) {
    throw new ReleaseProvenanceError(
      `commit ${source} carries no ${IMAGE_SOURCE_EXCLUDED_PREFIX} to account for; the recipe's ` +
        "broker removal is no longer describable, so the manifest's exclusion would be a false claim",
    );
  }
  return { entries, excludedEntries: excluded };
}

/**
 * One deterministic digest over a manifest, so two sides can be compared — and
 * quoted in evidence — as a single value.
 *
 * Newline-delimited `sha256 SP SP path`, which is `sha256sum`'s own shape: the
 * format a reviewer can reproduce by hand against a checkout.
 */
export function renderManifest(entries) {
  return `${entries.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n")}\n`;
}

export function manifestDigest(entries) {
  return createHash("sha256").update(renderManifest(entries)).digest("hex");
}

/**
 * Compares the source manifest with the manifest observed inside the image.
 *
 * Path + byte content, both directions, deterministic. Returns a result rather
 * than throwing, because the driver records a FAIL for a mismatch instead of
 * aborting: an image that disagrees with its source is a finding to report, not
 * an operational error to hide.
 */
export function compareSourceManifests({ expected, observed }) {
  const expectedByPath = new Map(expected.map((entry) => [entry.path, entry.sha256]));
  const observedByPath = new Map(observed.map((entry) => [entry.path, entry.sha256]));
  const missing = [];
  const mismatched = [];
  const unexpected = [];
  for (const [path, sha256] of expectedByPath) {
    if (!observedByPath.has(path)) {
      missing.push(path);
      continue;
    }
    if (observedByPath.get(path) !== sha256) mismatched.push(path);
  }
  for (const path of observedByPath.keys()) {
    if (!expectedByPath.has(path)) unexpected.push(path);
  }
  missing.sort();
  mismatched.sort();
  unexpected.sort();
  return {
    equal: missing.length === 0 && mismatched.length === 0 && unexpected.length === 0,
    expectedFileCount: expectedByPath.size,
    observedFileCount: observedByPath.size,
    comparedFileCount: [...expectedByPath.keys()].filter((path) => observedByPath.has(path)).length,
    missingFromImage: missing,
    contentMismatched: mismatched,
    unexpectedInImage: unexpected,
    expectedManifestDigest: manifestDigest(expected),
    observedManifestDigest: manifestDigest(observed),
  };
}

function requireFullSha(flag, value) {
  if (!isFullGitSha(value)) throw new ReleaseProvenanceError(`${flag} must be a full lowercase 40-hex SHA`);
}

async function revParse(git, rev, role = "release build context") {
  const result = await git(["rev-parse", "--verify", "--quiet", rev]);
  const value = String(result.stdout ?? "").trim();
  if (result.code !== 0 || !isFullGitSha(value)) {
    throw new ReleaseProvenanceError(`git could not resolve ${rev} in the ${role}`);
  }
  return value;
}

/** The object name at `<commit>:<path>`, or null when there is none. */
async function objectAt(git, commit, path) {
  const result = await git(["rev-parse", "--verify", "--quiet", `${commit}:${path}`]);
  const value = String(result.stdout ?? "").trim();
  return result.code === 0 && isFullGitSha(value) ? value : null;
}

/**
 * SHA-256 of the committed BYTES at `<commit>:<path>`.
 *
 * `cat-file` output is read as a Buffer by the runner contract's `stdoutBuffer`
 * when one is supplied, and falls back to a latin1 round-trip otherwise — Git
 * blobs are arbitrary bytes, and decoding them as UTF-8 would corrupt any file
 * that is not valid UTF-8 before it was hashed.
 */
async function blobSha256(git, commit, path) {
  const result = await git(["cat-file", "blob", `${commit}:${path}`], { binary: true });
  if (result.code !== 0) {
    throw new ReleaseProvenanceError(`git could not read ${commit}:${path}`);
  }
  const bytes = result.stdoutBuffer ?? Buffer.from(String(result.stdout ?? ""), "latin1");
  return createHash("sha256").update(bytes).digest("hex");
}

/** Non-empty output lines, leading status columns intact. */
async function lines(git, args, role = "release build context") {
  const result = await git(args);
  if (result.code !== 0) {
    throw new ReleaseProvenanceError(`git ${args[0]} failed in the ${role} (exit ${result.code})`);
  }
  return String(result.stdout ?? "")
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.length > 0);
}

function summarize(entries) {
  const shown = entries.slice(0, 5).join("; ");
  return entries.length > 5 ? `${shown}; and ${entries.length - 5} more` : shown;
}
