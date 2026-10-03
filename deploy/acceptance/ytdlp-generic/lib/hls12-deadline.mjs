// HLS-12's shared-deadline discriminator (HLS-SEPARATE-AUDIO-HLS12-SHARED-
// DEADLINE-HARDENING-001): the control the `neg-deadline` case applies, and the
// pure evaluation of what the fixture observed.
//
// ── The invariant under test ───────────────────────────────────────────────
//
// `acquireSelectedSeparateHlsMedia()` arms ONE acquisition deadline before the
// video half and hands the audio half only what is left of it. A Product that
// gave each half a fresh budget would still pass every other HLS-12 case: their
// halves are local and fast, so no deadline is ever approached.
//
// ── The control ────────────────────────────────────────────────────────────
//
// For that one job, the Product's configured download budget
// (`config.downloadTimeoutMs`, the `DOWNLOAD_TIMEOUT` value every acquisition
// already reads) is narrowed to `budgetMs`, and the fixture DELAYS two answers
// — it never alters or withholds a byte:
//
//   the video half's LAST fragment  answered `videoHoldMs` after the video map
//                                   arrived: the video half completes INSIDE
//                                   the budget, having used most of it;
//   the audio map                   answered `audioReleaseMs` after the video
//                                   map arrived, if the Product still waits.
//
// Every time is measured from the video map's arrival, which is the first
// acquisition request: the Product arms its deadline immediately before it.
//
//   one shared deadline   the audio half receives ~(budget - video time); the
//                         Product abandons the audio map at ~budget, unanswered,
//                         and the job fails `TIMEOUT` before any media tool;
//   a fresh deadline      the audio half would keep the map open until at
//                         least (video time + budget), which is after the
//                         release: it receives the map, fetches its fragments,
//                         merges and reaches `ready`.
//
// The margins are seconds, not milliseconds: no outcome depends on host
// scheduling. `hls12DeadlineControlProblems()` states them as inequalities, and
// no observed time is held to an exact millisecond (a timer released "at
// 6000 ms" can fire a fraction of a millisecond early on the monotonic clock):
// the video half must complete between `videoHoldMs - slackMs` and
// `budgetMs - slackMs`; the audio map must be requested after that completion
// (a causal order, not a time) and abandoned within ±`slackMs` of `budgetMs`.
//
// Import-free, so the self-tests and the SPLIT-07 parent read it on any Node.

/** The `neg-deadline` control, in milliseconds. */
export const HLS12_DEADLINE_CONTROL = Object.freeze({
  /** The narrowed `config.downloadTimeoutMs` (the `DOWNLOAD_TIMEOUT=10` value). */
  budgetMs: 10_000,
  /** When the video half's last fragment is answered, after the video map arrived. */
  videoHoldMs: 6_000,
  /** When the audio map is answered, after the video map arrived — if anyone still waits. */
  audioReleaseMs: 13_000,
  /** How far from the shared deadline the audio half may be stopped. */
  slackMs: 1_500,
});

/**
 * Why a control could NOT discriminate one shared deadline from a fresh one
 * per half. Empty means it can, with `slackMs` to spare at every boundary.
 */
export function hls12DeadlineControlProblems(control = HLS12_DEADLINE_CONTROL) {
  const { budgetMs, videoHoldMs, audioReleaseMs, slackMs } = control ?? {};
  const problems = [];
  if (![budgetMs, videoHoldMs, audioReleaseMs, slackMs].every((v) => Number.isSafeInteger(v) && v > 0)) {
    return ["every control value must be a positive integer number of milliseconds"];
  }
  // The video half completes inside the budget, leaving the audio half time.
  if (!(videoHoldMs + slackMs <= budgetMs - slackMs)) {
    problems.push("the video half could not complete inside the shared budget with time left for the audio half");
  }
  // One shared deadline stops the audio map before its late answer.
  if (!(budgetMs + slackMs <= audioReleaseMs)) {
    problems.push("the audio map would be answered before the shared deadline stops it");
  }
  // A fresh deadline, armed when even the EARLIEST admitted video completion
  // ended, outlives the late answer.
  if (!(audioReleaseMs + slackMs <= videoHoldMs - slackMs + budgetMs)) {
    problems.push("a fresh per-half deadline could expire before the audio map is answered");
  }
  return problems;
}

const round = (value) => (Number.isFinite(value) ? Math.round(value) : null);

/**
 * What the fixture observed of the `neg-deadline` acquisition, reduced to
 * relative times and booleans. Pure.
 *
 * @param {object} opts
 * @param {Array<object>} opts.requests the fixture ledger's Product requests of the
 *        case's acquisition phase, in arrival order (`kind`, `role`, `ordinal`,
 *        `status`, `arriveMs`, `finishMs`, `held`, `releasedMs`, `abandonedMs`)
 * @param {number} opts.videoFragments how many fragments the video playlist lists
 * @param {typeof HLS12_DEADLINE_CONTROL} [opts.control]
 */
export function evaluateHls12SharedDeadline({ requests, videoFragments, control = HLS12_DEADLINE_CONTROL }) {
  const rows = Array.isArray(requests) ? requests : [];
  const { budgetMs, videoHoldMs, audioReleaseMs, slackMs } = control;
  const media = (role) => rows.filter((r) => r?.role === role && (r.kind === "init" || r.kind === "fragment"));
  const video = media("video");
  const audio = media("audio");
  const videoMaps = video.filter((r) => r.kind === "init");
  const videoParts = video.filter((r) => r.kind === "fragment");
  const anchor = videoMaps.length === 1 && Number.isFinite(videoMaps[0].arriveMs) ? videoMaps[0].arriveMs : null;
  const after = (ms) => (anchor !== null && Number.isFinite(ms) ? ms - anchor : null);

  // The video half, whole: its map and every fragment exactly once, each fully
  // answered 200; the last fragment held and released, never abandoned.
  const ordinals = videoParts.map((r) => r.ordinal);
  const lastFragment = videoParts.find((r) => r.ordinal === videoFragments) ?? null;
  const videoWhole =
    anchor !== null &&
    Number.isSafeInteger(videoFragments) && videoFragments > 0 &&
    videoParts.length === videoFragments &&
    ordinals.every((ordinal, i) => ordinal === i + 1) &&
    video.every((r) => r.status === 200 && Number.isFinite(r.finishMs) && !Number.isFinite(r.abandonedMs));
  const videoCompleted = videoWhole ? Math.max(...video.map((r) => r.finishMs)) : null;
  const videoCompletedAfterMs = after(videoCompleted);
  const heldRelease = after(lastFragment?.releasedMs);
  // Consumed: the video half finished INSIDE the budget, late enough that a
  // fresh budget armed then would outlive the audio map's late answer.
  const videoConsumedTheSharedDeadline =
    videoWhole &&
    lastFragment.held === true &&
    heldRelease !== null &&
    videoCompletedAfterMs !== null &&
    videoCompletedAfterMs >= videoHoldMs - slackMs &&
    videoCompletedAfterMs <= budgetMs - slackMs;

  // The audio half: ONE request — its map — made only after the video half
  // completed, never answered, abandoned by the Product AT the shared deadline.
  const audioMaps = audio.filter((r) => r.kind === "init");
  const audioMap = audioMaps[0] ?? null;
  const audioMapRequestedAfterMs = after(audioMap?.arriveMs);
  const audioMapAbandonedAfterMs = after(audioMap?.abandonedMs);
  const audioDidNotReceiveAFreshDeadline =
    audio.length === 1 &&
    audioMap !== null &&
    videoCompleted !== null &&
    audioMap.arriveMs >= videoCompleted &&
    audioMap.held === true &&
    audioMap.status === null &&
    !Number.isFinite(audioMap.releasedMs) &&
    audioMapAbandonedAfterMs !== null &&
    Math.abs(audioMapAbandonedAfterMs - budgetMs) <= slackMs &&
    audioMapAbandonedAfterMs < audioReleaseMs;

  return {
    videoConsumedTheSharedDeadline,
    audioDidNotReceiveAFreshDeadline,
    observed: {
      videoMapRequests: videoMaps.length,
      videoFragmentsAnswered: videoParts.filter((r) => r.status === 200).length,
      videoHeldFragmentReleasedAfterMs: round(heldRelease),
      videoCompletedAfterMs: round(videoCompletedAfterMs),
      remainingForAudioMs: videoCompletedAfterMs === null ? null : round(budgetMs - videoCompletedAfterMs),
      audioRequests: audio.length,
      audioFragmentsRequested: audio.filter((r) => r.kind === "fragment").length,
      audioMapRequestedAfterMs: round(audioMapRequestedAfterMs),
      audioMapAnswered: audioMap === null ? null : audioMap.status !== null,
      audioMapReleasedAfterMs: round(after(audioMap?.releasedMs)),
      audioMapAbandonedAfterMs: round(audioMapAbandonedAfterMs),
      freshDeadlineEarliestAfterMs: videoCompletedAfterMs === null ? null : round(videoCompletedAfterMs + budgetMs),
    },
  };
}
