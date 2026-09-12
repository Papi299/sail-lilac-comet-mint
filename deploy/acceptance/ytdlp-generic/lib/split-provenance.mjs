// SPLIT-06 source provenance: the Docker build context IS the source the
// evidence names.
//
// The host driver builds the acceptance overlay from a directory and records a
// commit and a tree as the run's source. Those must be one fact, not two. This
// module makes them one, fail-closed, BEFORE anything is built:
//
//   A  the context's HEAD is exactly the expected full commit;
//   B  that observed commit's tree is exactly the expected full tree;
//   C  the context is clean:
//        - nothing tracked is modified, staged or deleted, and nothing
//          untracked exists anywhere in the worktree;
//        - nothing IGNORED exists inside the paths the overlay copies: an
//          ignored file there is invisible to a plain `git status` and would
//          still reach `COPY`;
//        - no index entry under those paths is marked assume-unchanged or
//          skip-worktree, either of which hides a modification from status;
//   D  the accepted base image's source commit exists in the context;
//   E  every file the accepted image's runtime was built from or is coupled to
//      is the SAME Git object at that accepted commit and at the candidate.
//      That is the premise that makes "overlay the accepted image with the
//      candidate's source" equivalent to "build the candidate". When it fails
//      the overlay strategy does not apply, and the run stops.
//
// The CLI values are EXPECTATIONS. What `verifyOverlayContextProvenance`
// returns are OBSERVATIONS, and only observations are recorded as evidence.
//
// Git is reached through an injected runner, so every refusal is testable
// without a repository and without Docker. Plain ESM whose only import is the
// pure container model: it runs on the VM's older Node and inside the image.

import { OVERLAY_COPIED_PATHS } from "./split-container.mjs";

/** A full, lowercase Git object name. An abbreviation is not provenance. */
export const FULL_GIT_SHA = /^[0-9a-f]{40}$/;

/**
 * The files whose content the accepted image's runtime was built from or is
 * coupled to. The overlay does not take these from the candidate, or — for the
 * runtime pin — the candidate's copy must agree with the artifact the image
 * already holds:
 *
 *   package.json, package-lock.json   the image's installed dependency graph
 *   Dockerfile.worker                 the recipe that installed yt-dlp/FFmpeg
 *   src/worker/runtime/ytdlp-runtime.server.ts
 *                                     the pin the image's yt-dlp must match
 *   scripts/register-ts-aliases.mjs,  the loader the container starts with,
 *   scripts/ts-alias-hooks.mjs        which stays the image's own copy
 */
export const OVERLAY_RUNTIME_COMPATIBILITY_FILES = Object.freeze([
  "package.json",
  "package-lock.json",
  "Dockerfile.worker",
  "src/worker/runtime/ytdlp-runtime.server.ts",
  "scripts/register-ts-aliases.mjs",
  "scripts/ts-alias-hooks.mjs",
]);

/** A refusal. Its message is for the operator; nothing here reaches evidence. */
export class ProvenanceError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProvenanceError";
  }
}

export function isFullGitSha(value) {
  return typeof value === "string" && FULL_GIT_SHA.test(value);
}

/**
 * Verifies the build context and returns what was OBSERVED.
 *
 * @param {object} opts
 * @param {(args: string[]) => Promise<{code: number|null, stdout: string}>} opts.git
 *        runs `git <args>` against the context: an argv, never a shell
 * @param {string} opts.expectedHead  full 40-hex candidate commit
 * @param {string} opts.expectedTree  full 40-hex candidate tree
 * @param {string} opts.baseSource    full 40-hex source commit of the accepted image
 */
export async function verifyOverlayContextProvenance({ git, expectedHead, expectedTree, baseSource }) {
  requireFullSha("--head", expectedHead);
  requireFullSha("--tree", expectedTree);
  requireFullSha("--base-source", baseSource);

  // A. The exact commit.
  const commit = await revParse(git, "HEAD");
  if (commit !== expectedHead) {
    throw new ProvenanceError(`the build context's HEAD is ${commit}, not the expected ${expectedHead}`);
  }

  // B. The exact tree, of the commit just observed, so A and B describe one
  //    object even if HEAD moved between the two reads.
  const tree = await revParse(git, `${commit}^{tree}`);
  if (tree !== expectedTree) {
    throw new ProvenanceError(`commit ${commit} has tree ${tree}, not the expected ${expectedTree}`);
  }

  // C. Clean. The explicit flags override any local configuration that would
  //    otherwise hide an entry from the listing.
  const dirty = await lines(git, [
    "status", "--porcelain=v1", "--untracked-files=all", "--ignored=no", "--ignore-submodules=none",
  ]);
  if (dirty.length > 0) {
    throw new ProvenanceError(`the build context is not clean: ${summarize(dirty)}`);
  }
  const untrackedInCopied = await lines(git, [
    "status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none",
    "--", ...OVERLAY_COPIED_PATHS,
  ]);
  if (untrackedInCopied.length > 0) {
    throw new ProvenanceError(
      `the copied paths hold content Git does not track: ${summarize(untrackedInCopied)}`,
    );
  }
  const hidden = (await lines(git, ["ls-files", "-v", "--", ...OVERLAY_COPIED_PATHS]))
    .filter((line) => /^[a-zS] /.test(line));
  if (hidden.length > 0) {
    throw new ProvenanceError(
      `index entries under the copied paths are marked assume-unchanged or skip-worktree: ${summarize(hidden)}`,
    );
  }

  // D. The accepted base source exists, as a commit, in this repository.
  const base = await git(["cat-file", "-e", `${baseSource}^{commit}`]);
  if (base.code !== 0) {
    throw new ProvenanceError(`the accepted base source ${baseSource} is not a commit in the build context`);
  }

  // E. Overlay runtime compatibility, compared as Git objects. A file absent
  //    from either commit is DIFFERENT: absence is not agreement.
  const runtimeCompatibilityFiles = [];
  for (const path of OVERLAY_RUNTIME_COMPATIBILITY_FILES) {
    const atBase = await objectAt(git, baseSource, path);
    const atCandidate = await objectAt(git, commit, path);
    runtimeCompatibilityFiles.push({
      path,
      state: atBase !== null && atBase === atCandidate ? "SAME" : "DIFFERENT",
    });
  }
  const drifted = runtimeCompatibilityFiles.filter((f) => f.state !== "SAME").map((f) => f.path);
  if (drifted.length > 0) {
    throw new ProvenanceError(
      `the accepted-image overlay is no longer justified: ${drifted.join(", ")} differ between ` +
        `${baseSource} and ${commit}, so the overlay strategy does not apply to this candidate`,
    );
  }

  return {
    commit,
    tree,
    acceptedBaseSourceCommit: baseSource,
    contextClean: true,
    overlayRuntimeCompatibilityVerified: true,
    runtimeCompatibilityFiles,
  };
}

function requireFullSha(flag, value) {
  if (!isFullGitSha(value)) throw new ProvenanceError(`${flag} must be a full lowercase 40-hex SHA`);
}

async function revParse(git, rev) {
  const result = await git(["rev-parse", "--verify", "--quiet", rev]);
  const value = String(result.stdout ?? "").trim();
  if (result.code !== 0 || !isFullGitSha(value)) {
    throw new ProvenanceError(`git could not resolve ${rev} in the build context`);
  }
  return value;
}

/** The object name at `<commit>:<path>`, or null when there is none. */
async function objectAt(git, commit, path) {
  const result = await git(["rev-parse", "--verify", "--quiet", `${commit}:${path}`]);
  const value = String(result.stdout ?? "").trim();
  return result.code === 0 && isFullGitSha(value) ? value : null;
}

/** Non-empty output lines, leading status columns intact. */
async function lines(git, args) {
  const result = await git(args);
  if (result.code !== 0) {
    throw new ProvenanceError(`git ${args[0]} failed in the build context (exit ${result.code})`);
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
