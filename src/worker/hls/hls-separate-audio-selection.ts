import {
  CLEAR_HLS_SHADOW_PRESET_ID_PATTERN,
  placeClearHlsShadowCandidates,
  type ClearHlsShadowRung,
} from "./hls-source-selection.ts";

/**
 * Worker-owned SEPARATE-AUDIO CLEAR-HLS PRIVATE SELECTION
 * (HLS-SEPARATE-AUDIO-PAIRING-IMPLEMENTATION-001).
 *
 * ─── What this module is ────────────────────────────────────────────────────
 *
 * The pure vocabulary for the THIRD clear-HLS family: one video-only fMP4
 * media playlist plus the ONE audio-only media playlist its fetched Master
 * Playlist proved belongs to it. It holds:
 *
 *   1. the minimal frozen private selection — `videoPlaylistUrl`,
 *      `audioPlaylistUrl`, `height`, and nothing else;
 *   2. the placement of proven pairs on the application's video ladder, by the
 *      SAME placement the muxed clear-HLS family uses (reused, not restated);
 *   3. the projection down to the selection map analysis returns.
 *
 * It performs NO I/O of any kind and holds no proof logic: a pair reaches this
 * module only after `hls-master-pairing.server.ts` proved it. It is a separate
 * vocabulary from the muxed `ClearHlsMediaPlaylistSelections` on purpose — the
 * muxed map names ONE self-contained playlist, this one names two halves, and
 * overloading one shape with both would make every reader guess which it holds.
 *
 * ─── Privacy ────────────────────────────────────────────────────────────────
 *
 * Both URLs are SENSITIVE, transient Worker-private data (signed queries,
 * expiring tokens, CDN identity). No master URL, group id, language, NAME or
 * any other master metadata survives into a selection: once the pair is proven,
 * the two media playlists ARE the provenance, exactly as one playlist is for
 * the muxed family. A selection may exist in the memory of ONE fresh analysis
 * and the plan derived from it, and nowhere else — never in
 * `WorkerVideoMetadata`, Worker HTTP JSON, SQLite, an object key, a log line or
 * an error.
 */

/** ONE proven separate-audio pair, as execution needs it. */
export type ClearHlsSeparateAudioSelection = {
  readonly videoPlaylistUrl: string;
  readonly audioPlaylistUrl: string;
  readonly height: number | null;
};

/** Application-owned VIDEO preset id → the private pair behind it. */
export type ClearHlsSeparateAudioSelections = Readonly<
  Record<string, ClearHlsSeparateAudioSelection>
>;

/**
 * A proven pair waiting to be placed: the selection plus its upstream position,
 * which is the final deterministic tie-break, exactly as for the muxed family.
 */
export type ClearHlsSeparateAudioCandidate = ClearHlsSeparateAudioSelection & {
  readonly index: number;
};

/** Preset id → the proven pair placed there, index kept. Private, transient. */
export type ClearHlsSeparateAudioPlacements = Readonly<Record<string, ClearHlsSeparateAudioCandidate>>;

/**
 * Places proven pairs on the injected video ladder.
 *
 * The placement rule IS the muxed family's: `placeClearHlsShadowCandidates` is
 * run over each pair's video playlist and height, and the winner of every rung
 * is mapped back to its pair by upstream index. So the two HLS families cannot
 * drift onto different rung boundaries, best-rung or tie-break semantics — the
 * one-rung-per-rendition rule, the `preset:best` unknown-height fallback and
 * lowest-upstream-index ties are all the existing function's.
 *
 * A pair whose index repeats is not placeable (the analysis guarantees one pair
 * per raw row, and a repeat would make the mapping ambiguous): every pair
 * sharing that index is dropped, fail-closed.
 */
export function placeClearHlsSeparateAudioPairs(
  pairs: readonly ClearHlsSeparateAudioCandidate[],
  rungs: readonly ClearHlsShadowRung[],
): ClearHlsSeparateAudioPlacements {
  const byIndex = new Map<number, ClearHlsSeparateAudioCandidate | null>();
  for (const pair of pairs) {
    byIndex.set(pair.index, byIndex.has(pair.index) ? null : pair);
  }
  const placeable = [...byIndex.values()].filter(
    (pair): pair is ClearHlsSeparateAudioCandidate => pair !== null,
  );

  const placed = placeClearHlsShadowCandidates(
    placeable.map((pair) => ({ playlistUrl: pair.videoPlaylistUrl, height: pair.height, index: pair.index })),
    rungs,
  );

  const out: Record<string, ClearHlsSeparateAudioCandidate> = {};
  for (const [id, winner] of Object.entries(placed)) {
    const pair = byIndex.get(winner.index);
    if (pair === undefined || pair === null) continue;
    out[id] = Object.freeze({
      videoPlaylistUrl: pair.videoPlaylistUrl,
      audioPlaylistUrl: pair.audioPlaylistUrl,
      height: pair.height,
      index: pair.index,
    });
  }
  return Object.freeze(out);
}

/**
 * Projects placements down to the minimal private selection map — the ONLY
 * separate-audio shape that leaves analysis. `index` is dropped here; a key
 * outside the closed video vocabulary is skipped, fail-closed.
 */
export function projectClearHlsSeparateAudioPlacements(
  placements: Readonly<Record<string, ClearHlsSeparateAudioCandidate>>,
): ClearHlsSeparateAudioSelections {
  const out: Record<string, ClearHlsSeparateAudioSelection> = {};
  for (const [id, pair] of Object.entries(placements)) {
    if (!CLEAR_HLS_SHADOW_PRESET_ID_PATTERN.test(id)) continue;
    out[id] = Object.freeze({
      videoPlaylistUrl: pair.videoPlaylistUrl,
      audioPlaylistUrl: pair.audioPlaylistUrl,
      height: pair.height,
    });
  }
  return Object.freeze(out);
}
