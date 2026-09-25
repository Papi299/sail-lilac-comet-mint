import { Buffer } from "node:buffer";
import { validatePublicHttpUrl } from "@/lib/validation/url";

/**
 * Worker-owned CLEAR-HLS v1 PRIVATE MEDIA-PLAYLIST SELECTION (HLS-5).
 *
 * ─── What this module is ────────────────────────────────────────────────────
 *
 * The narrow, pure vocabulary for the one thing HLS acquisition needs and the
 * progressive path deliberately throws away: the EXACT per-rendition media
 * playlist location yt-dlp reported, statically screened, bounded, and placed
 * on an application-owned preset rung.
 *
 * It is three things and nothing else:
 *
 *   1. a static acceptance test for one candidate playlist URL;
 *   2. a minimal immutable selection record (`playlistUrl` + `height`);
 *   3. a deterministic shadow ladder that maps accepted candidates onto the
 *      application's VIDEO preset rungs.
 *
 * It performs NO I/O of any kind: no network, no DNS, no filesystem, no
 * subprocess, no clock, no randomness. Give it candidates, get a frozen map.
 *
 * ─── What this module is NOT ────────────────────────────────────────────────
 *
 *   - It is not a capability decision. A placement on the shadow ladder does
 *     NOT by itself mean the preset is advertised: analysis composes the
 *     placements with the mature progressive/split ladder, and a rung the
 *     progressive family already fulfils stays progressive (HLS-7). The
 *     progressive candidate evaluator still refuses every HLS format.
 *   - It is not a safety proof. Static screening here bounds and shapes a
 *     string; it says nothing about whether the host resolves publicly NOW.
 *     HLS-2 remains the authoritative request-time boundary — DNS, private
 *     address rejection, address pinning and per-hop redirect validation all
 *     happen there, immediately before acquisition.
 *   - It is not an acquisition plan, a downloader, or a ranking policy. There
 *     is no container, codec, bitrate or fps preference here; HLS v1 has no
 *     evidence to rank on beyond the rung itself.
 *   - It is not a persistence format. See "Freshness" below.
 *
 * ─── Privacy ────────────────────────────────────────────────────────────────
 *
 * A per-format HLS playlist URL is SENSITIVE Worker-private data: it routinely
 * carries signed query parameters, expiring tokens and opaque CDN identity. A
 * `playlistUrl` may exist transiently in Worker memory and nowhere else. It
 * must never enter `WorkerVideoMetadata`, the public `/analyze` response, any
 * Worker HTTP JSON, SQLite, a durable job row, an R2 object key, a log line,
 * an error message, or any diagnostic — and it is never interpolated into a
 * thrown error HERE, which is why every refusal below returns `null` rather
 * than explaining itself.
 *
 * Signed query strings are carried EXACTLY as written. They are not trimmed,
 * reordered, re-encoded or redacted: a stripped signature is a URL that 403s
 * later, which is a worse outcome than not selecting the rendition at all.
 *
 * ─── Freshness ──────────────────────────────────────────────────────────────
 *
 * Signed media URLs expire. Nothing here may be persisted: the selection is
 * built from the FRESH execution analysis of one job attempt and dies with it.
 * A Worker restart or a retry re-analyzes and obtains a new URL. This is the
 * existing durable-execution model (analysis runs at execution time, never
 * reusing the browser's earlier result), and HLS-5 only depends on it.
 *
 * ─── Activation ─────────────────────────────────────────────────────────────
 *
 * HLS-7 activated this channel at the source level. Analysis places admitted
 * candidates here, keeps only the rungs the final Product result gives to
 * clear HLS, and advertises those as ordinary video presets; the ordinary
 * execution planner then derives a clear-HLS plan from the FRESH analysis's
 * map. This module still holds no execution capability whatsoever — no
 * request, no transport, no processing — which is why Product analysis and
 * the planner may name it. Source activation is not deployment: nothing here
 * states that the capability is running anywhere.
 */

// ── Bounds ───────────────────────────────────────────────────────────────────

/**
 * The longest selected media-playlist URL HLS v1 will retain, in UTF-8 bytes.
 *
 * The analysis document is already bounded at 4 MiB, but that is not a licence
 * for ONE sensitive field to consume megabytes of retained execution state:
 * the shadow map holds up to nine rungs, so an unbounded URL multiplies. 4 KiB
 * matches the fragment-URL ceiling the HLS path already uses, and is generous
 * for a real signed playlist location by an order of magnitude.
 *
 * The bound is applied to the RAW candidate before any parsing work, and again
 * to the serialisation actually retained — normalisation can only lengthen a
 * string (percent-encoding), never shorten it past the check.
 */
export const CLEAR_HLS_V1_MAX_PLAYLIST_URL_BYTES = 4096;

// ── Protocol admission ───────────────────────────────────────────────────────

/**
 * The ONLY upstream protocol an HLS v1 shadow candidate may carry.
 *
 * Deliberately `m3u8_native` EXACTLY. The pinned runtime uses `m3u8` for
 * renditions it intends to hand to `FFmpegFD`, and `m3u8_native` for the ones
 * its own native HLS downloader would take. HLS v1's transport is
 * VideoFetch-owned and modelled on the native shape, so the narrower spelling
 * is the only one with evidence behind it. `m3u8` can be reviewed on its own
 * later; admitting it here would be optimism, not a decision.
 *
 * This does NOT change the source-quality observation rule, which groups both
 * spellings as `"hls"`. That rule describes what was SEEN; this one describes
 * what HLS v1 would be willing to acquire.
 */
export const CLEAR_HLS_V1_SHADOW_PROTOCOL = "m3u8_native";

/**
 * Is this raw protocol field the one HLS v1 admits?
 *
 * Whitespace and case are folded before comparison, the same conservative
 * normalisation the codec classifier already applies. Folding can only ever
 * ADMIT a value that plainly says `m3u8_native`; it can never widen the set to
 * a different protocol.
 */
export function isClearHlsShadowProtocol(protocol: unknown): boolean {
  if (typeof protocol !== "string") return false;
  return protocol.trim().toLowerCase() === CLEAR_HLS_V1_SHADOW_PROTOCOL;
}

// ── Static URL acceptance ────────────────────────────────────────────────────

/** UTF-8 length, without materialising an encoder for an oversize string. */
function withinUrlByteCeiling(value: string): boolean {
  // Every UTF-16 code unit costs at least one UTF-8 byte, so a string longer
  // than the ceiling in code units is already over it in bytes. Checking that
  // first keeps a hostile multi-megabyte field from being encoded at all.
  if (value.length > CLEAR_HLS_V1_MAX_PLAYLIST_URL_BYTES) return false;
  return Buffer.byteLength(value, "utf8") <= CLEAR_HLS_V1_MAX_PLAYLIST_URL_BYTES;
}

/**
 * The static half of the destination policy for one absolute parsed URL.
 * Returns the approved serialisation, or `null`.
 *
 * `validatePublicHttpUrl` is REUSED rather than re-implemented: it is the
 * application's existing static authority and already refuses credentials, an
 * empty or single-label host, blocked names, `.localhost`, `.local`,
 * `.internal`, `.arpa` and private literals of either family. It deliberately
 * ADMITS the `sample:` pseudo-protocol for Product fixtures, so the
 * http(s)-only rule is enforced here first and explicitly.
 *
 * The final equality makes the string that was CHECKED exactly the string that
 * is RETAINED — the consistency requirement that stops a normalising parser
 * from approving one value and handing back another.
 */
function staticallyApprovedPlaylistUrl(url: URL): string | null {
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const href = url.href;
  if (!withinUrlByteCeiling(href)) return null;
  const checked = validatePublicHttpUrl(href);
  if (!checked.ok) return null;
  if (checked.url !== href) return null;
  return href;
}

/**
 * One raw per-format `url` field, screened before it may become a selection.
 *
 * Performs NO DNS and NO network I/O. Everything here is string work.
 *
 * ABSOLUTE ONLY, and checked before `validatePublicHttpUrl` is consulted:
 * that function coerces a scheme-less string into `https://`, which is right
 * for a person typing into a form and wrong for a Worker-private location that
 * must already say what it is. `new URL(raw)` with no base therefore refuses a
 * relative reference (`/hls/media.m3u8`) and a protocol-relative one
 * (`//cdn/media.m3u8`) outright, and `file:`, `data:`, `ftp:` and `sample:`
 * are refused by the protocol gate that follows.
 *
 * What is RETAINED is the WHATWG serialisation, not the raw field, so ordinary
 * canonicalisation applies: surrounding whitespace is stripped and non-ASCII
 * query bytes are percent-encoded. That is deliberately the same reading HLS-2
 * gives a playlist location, because HLS-6 hands this exact string to HLS-2 —
 * the two must not disagree about what a URL is. The byte ceiling is applied
 * to the serialisation as well as the input, so canonicalisation cannot grow a
 * value past the bound.
 *
 * Returns the approved serialisation, or `null` — which the caller reads as
 * "this HLS shadow candidate does not exist", never as an analysis failure.
 * The raw value is not echoed, logged or thrown in any branch.
 */
export function acceptClearHlsPlaylistUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0) return null;
  // Bound the INPUT before any parsing work, so an oversize field costs a
  // length comparison rather than a URL parse.
  if (!withinUrlByteCeiling(raw)) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const approved = staticallyApprovedPlaylistUrl(parsed);
  if (approved === null) return null;

  // Re-read the RETAINED serialisation through the same invariants. The
  // approval above was made on this exact string, so this can only fail if
  // URL serialisation were not idempotent; it is asserted rather than assumed
  // because the value is about to be requested by a later phase.
  let retained: URL;
  try {
    retained = new URL(approved);
  } catch {
    return null;
  }
  if (retained.protocol !== "http:" && retained.protocol !== "https:") return null;
  if (retained.username !== "" || retained.password !== "") return null;
  return approved;
}

// ── The private selection ────────────────────────────────────────────────────

/**
 * ONE HLS rendition's private acquisition provenance.
 *
 * Deliberately minimal. The URL itself IS the provenance: once the exact media
 * playlist has been chosen, HLS acquisition needs no yt-dlp selector grammar,
 * so no upstream `format_id` is carried here. `height` exists only so HLS-6
 * can report which rung it is acting on without re-reading yt-dlp output.
 *
 * Nothing else from the raw format is retained — not headers, not cookies, not
 * a referer, not downloader options, not extractor arguments. HLS v1 uses the
 * fixed HLS-2 safe-HTTP request profile, and a source that needs special
 * upstream headers is simply not made supported by carrying them here.
 */
export type ClearHlsMediaPlaylistSelection = {
  readonly playlistUrl: string;
  readonly height: number | null;
};

/** Application-owned VIDEO preset id → the private HLS location behind it. */
export type ClearHlsMediaPlaylistSelections = Readonly<
  Record<string, ClearHlsMediaPlaylistSelection>
>;

/**
 * The closed key vocabulary of the HLS shadow map: the VIDEO ladder ONLY.
 *
 * `preset:audio` and `preset:mp3` are deliberately absent. HLS v1 has no audio
 * pairing and no independent HLS audio product, and HLS-4's approved local
 * media shape is exactly one video plus exactly one audio — so an HLS-backed
 * audio product would be a capability nothing in the chain implements.
 */
export const CLEAR_HLS_SHADOW_PRESET_ID_PATTERN =
  /^preset:(best|2160|1440|1080|720|480|360|240|144)$/;

/** The one shadow key this module owns outright rather than receiving. */
export const CLEAR_HLS_SHADOW_BEST_PRESET_ID = "preset:best";

/**
 * A rendition that passed every HLS v1 admission gate, ready to be placed.
 *
 * `playlistUrl` is already statically accepted; `height` is already bounded;
 * `index` is the upstream position, which is the FINAL deterministic order for
 * otherwise equivalent candidates.
 */
export type ClearHlsShadowCandidate = {
  readonly playlistUrl: string;
  readonly height: number | null;
  readonly index: number;
};

/**
 * One resolution rung, INJECTED by the caller.
 *
 * The boundaries are not restated here: the analyzer passes its own existing
 * ladder, so the HLS shadow map and the public video presets can never drift
 * onto different rung semantics, and this module still imports nothing from
 * the analyzer.
 */
export type ClearHlsShadowRung = {
  readonly minHeight: number;
  readonly id: string;
};

function toSelection(c: ClearHlsShadowCandidate): ClearHlsMediaPlaylistSelection {
  return Object.freeze({ playlistUrl: c.playlistUrl, height: c.height });
}

/** The deterministic winner of a set: lowest upstream position. */
function firstInUpstreamOrder(
  candidates: readonly ClearHlsShadowCandidate[],
): ClearHlsShadowCandidate | null {
  let winner: ClearHlsShadowCandidate | null = null;
  for (const c of candidates) {
    if (winner === null || c.index < winner.index) winner = c;
  }
  return winner;
}

/**
 * Application-owned VIDEO preset id → the ACCEPTED candidate placed there
 * (HLS-7).
 *
 * The placement keeps the candidate WHOLE, upstream `index` included, because
 * the rendition inventory must be able to say exactly which raw rendition won
 * a rung. The minimal `ClearHlsMediaPlaylistSelection` deliberately cannot say
 * that, and matching a URL/height pair back to a raw row would be ambiguous
 * whenever an extractor lists two equivalent rows.
 *
 * PRIVATE and transient, like everything else here: a placement lives inside
 * one analysis pass and is projected down (`projectClearHlsPlacements`) before
 * anything leaves it. The index is never execution provenance, never public,
 * and never persisted.
 */
export type ClearHlsShadowPlacements = Readonly<Record<string, ClearHlsShadowCandidate>>;

/**
 * Places accepted HLS candidates on the application's video ladder, keeping
 * each winner's upstream position (HLS-7).
 *
 * This is NOT Product ranking. It gives analysis exactly ONE candidate per
 * would-be rung, so that nothing downstream has to re-read yt-dlp output or
 * re-decide which rendition a rung meant. Whether a placed rung is actually
 * given to clear HLS is analysis's composition decision, not this function's.
 *
 * The rules, and why they are this small:
 *
 *   NAMED RUNG   a candidate belongs to exactly one bucket, by the injected
 *                boundaries: at or above this rung's floor, and below every
 *                taller rung's. A 1080p source therefore backs `preset:1080`
 *                and does NOT also masquerade as 720p, 480p and so on.
 *
 *   preset:best  the winner of the highest rung that has any member. Because
 *                membership at the TOP occupied rung is the same set either
 *                way, this is the tallest rendition available. When no
 *                candidate reaches the lowest rung — every height unknown, or
 *                every known height beneath the floor — one deterministic
 *                candidate from the whole set backs it instead, mirroring the
 *                public ladder's own unknown-height fallback rather than
 *                dropping HLS video whole.
 *
 *   TIES         upstream position, and nothing else. Container, codec,
 *                bitrate and fps preferences are the mature progressive
 *                ranking's business; HLS v1 keeps no such evidence in a
 *                selection, and inventing a parallel policy here would be a
 *                second ranking to keep in step for no present gain.
 *
 * A rung whose id is outside the closed vocabulary is SKIPPED rather than
 * emitted or thrown on. Fail-closed is the rule for this whole channel: a
 * missing shadow candidate is the defined outcome, and an unrecognised key
 * must never reach a map that execution will index by preset id.
 *
 * The map and every placed candidate are frozen copies, so no later caller can
 * rewrite a URL that admission already approved, or move a winner's index.
 */
export function placeClearHlsShadowCandidates(
  candidates: readonly ClearHlsShadowCandidate[],
  rungs: readonly ClearHlsShadowRung[],
): ClearHlsShadowPlacements {
  const out: Record<string, ClearHlsShadowCandidate> = {};
  if (candidates.length === 0) return Object.freeze(out);

  const place = (c: ClearHlsShadowCandidate): ClearHlsShadowCandidate =>
    Object.freeze({ playlistUrl: c.playlistUrl, height: c.height, index: c.index });

  const atOrAbove = (floor: number) =>
    candidates.filter((c) => c.height !== null && c.height >= floor);

  // `preset:best`: the highest occupied rung, else the whole set.
  const topRung = rungs.find((rung) => atOrAbove(rung.minHeight).length > 0);
  const best = topRung
    ? firstInUpstreamOrder(atOrAbove(topRung.minHeight))
    : firstInUpstreamOrder(candidates);
  if (best !== null && CLEAR_HLS_SHADOW_PRESET_ID_PATTERN.test(CLEAR_HLS_SHADOW_BEST_PRESET_ID)) {
    out[CLEAR_HLS_SHADOW_BEST_PRESET_ID] = place(best);
  }

  for (const rung of rungs) {
    if (!CLEAR_HLS_SHADOW_PRESET_ID_PATTERN.test(rung.id)) continue;
    const inRung = candidates.filter((c) => {
      const height = c.height;
      if (height === null || height < rung.minHeight) return false;
      // Exactly this rung: a taller candidate belongs to a higher one only.
      return !rungs.some((r) => r.minHeight > rung.minHeight && height >= r.minHeight);
    });
    const winner = firstInUpstreamOrder(inRung);
    if (winner !== null) out[rung.id] = place(winner);
  }

  return Object.freeze(out);
}

/**
 * Projects placements down to the minimal private selection map — the ONLY
 * shape that leaves analysis (HLS-7).
 *
 * `index` is dropped here and nowhere later: what execution receives is exactly
 * `playlistUrl` + `height`, frozen, keyed by the closed video vocabulary. A key
 * outside that vocabulary is skipped, fail-closed, exactly as placement does.
 */
export function projectClearHlsPlacements(
  placements: Readonly<Record<string, ClearHlsShadowCandidate>>,
): ClearHlsMediaPlaylistSelections {
  const out: Record<string, ClearHlsMediaPlaylistSelection> = {};
  for (const [id, candidate] of Object.entries(placements)) {
    if (!CLEAR_HLS_SHADOW_PRESET_ID_PATTERN.test(id)) continue;
    out[id] = toSelection(candidate);
  }
  return Object.freeze(out);
}

/**
 * The WHOLE shadow ladder as minimal selections: every rung placement can
 * fill, whether or not the Product result gives it to clear HLS.
 *
 * This is the HLS-5 contract, kept as a projection of the placement above so
 * the two can never disagree about which rendition a rung means. Product
 * analysis does not advertise from it directly: since HLS-7 it projects only
 * the rungs its composition actually gives to clear HLS.
 */
export function buildClearHlsMediaPlaylistSelections(
  candidates: readonly ClearHlsShadowCandidate[],
  rungs: readonly ClearHlsShadowRung[],
): ClearHlsMediaPlaylistSelections {
  return projectClearHlsPlacements(placeClearHlsShadowCandidates(candidates, rungs));
}

// ── The public preset an HLS-owned rung advertises (HLS-7) ───────────────────

/**
 * The facts every clear-HLS-owned public preset states, and the only ones.
 *
 * Stated ONCE so that analysis (which advertises) and the execution planner
 * (which verifies before acquiring anything) read the same contract:
 *
 *   container   `mp4`: HLS v1's only deliverable is the MP4 its fixed
 *               stream-copy remux produces;
 *   video/audio both `true`: admission requires established video AND proven
 *               audio, and the approved local shape is exactly one of each;
 *   fileSize    `null`: upstream size metadata is not the size authority for
 *               an HLS rendition — the aggregate actual-byte bound is;
 *   codecs/fps  `null`: the private selection deliberately retains no codec or
 *               frame-rate identity, and it is not widened merely to decorate
 *               browser metadata.
 *
 * Nothing here identifies HLS to the browser. It is an ordinary preset whose
 * unknown fields are unknown. The combination — PROVEN audio with NO audio
 * codec named — is never produced by the progressive family, whose proven
 * audio always carries the codec that proved it; the analyzer asserts that,
 * which is what lets the planner cross-check a preset's family against the
 * private map that claims it.
 */
export const CLEAR_HLS_PUBLIC_PRESET_FACTS = Object.freeze({
  container: "mp4",
  fileSize: null,
  hasVideo: true,
  hasAudio: true,
  videoCodec: null,
  audioCodec: null,
  fps: null,
} as const);

/**
 * Does this public preset state EXACTLY the clear-HLS facts above?
 *
 * Structural rather than typed on the public contract, so this vocabulary
 * module keeps importing nothing but its two pure helpers.
 */
export function hasClearHlsPublicPresetFacts(preset: {
  readonly container: string;
  readonly fileSize: number | null;
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
  readonly fps: number | null;
}): boolean {
  return (
    preset.container === CLEAR_HLS_PUBLIC_PRESET_FACTS.container &&
    preset.fileSize === CLEAR_HLS_PUBLIC_PRESET_FACTS.fileSize &&
    preset.hasVideo === CLEAR_HLS_PUBLIC_PRESET_FACTS.hasVideo &&
    preset.hasAudio === CLEAR_HLS_PUBLIC_PRESET_FACTS.hasAudio &&
    preset.videoCodec === CLEAR_HLS_PUBLIC_PRESET_FACTS.videoCodec &&
    preset.audioCodec === CLEAR_HLS_PUBLIC_PRESET_FACTS.audioCodec &&
    preset.fps === CLEAR_HLS_PUBLIC_PRESET_FACTS.fps
  );
}
