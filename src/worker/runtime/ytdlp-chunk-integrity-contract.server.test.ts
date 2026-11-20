import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { AppError, ERROR_MESSAGES } from "../../lib/errors.ts";
import { createAcquisitionActivityTracker } from "../../services/downloads/acquisition-activity.ts";
import { runProcess } from "../../services/processing/process-runner.server.ts";
import { analyzeGenericMediaInternal } from "../analysis/ytdlp-analysis.server.ts";
import { deriveExecutionPlan, type GenericSingleSourceExecutionPlan, type GenericSplitExecutionPlan } from "../execution/format-plan.ts";
import {
  buildYtdlpDownloadArgv,
  buildYtdlpDownloadEnvironment,
  downloadGenericOriginal,
  downloadGenericSplitSources,
} from "../execution/ytdlp-download.server.ts";
import { YTDLP_RUNTIME, buildYtdlpEnvironment, ytdlpPolicyArgs, type YtdlpRuntimeStatus } from "./ytdlp-runtime.server.ts";

/**
 * VIDEOFETCH-LD3E-PINNED-YTDLP-PATCHED-RUNTIME-SOURCE-IMPLEMENTATION-001 — the
 * PINNED-RUNTIME chunk-integrity contract: the LD-3e laboratory matrix, ported.
 *
 * The pinned yt-dlp 2026.08.19 HTTP downloader had two defects in its chunked
 * ("--http-chunk-size") mode: a piece that delivered nothing, or only part of
 * its range, was followed by another request at no cost, so a misbehaving
 * source drove an unbounded request loop; and a whole-file answer to a later
 * ranged request was APPENDED to the pieces already written, so the Worker
 * received a successfully "completed" file with duplicated bytes. The patched
 * runtime this repository now builds (`vendor/yt-dlp/2026.08.19-videofetch-ld3e/`)
 * corrects both. This file proves it against the exact artifact.
 *
 * PROVENANCE. A port of the accepted laboratory harness and judge of
 * VIDEOFETCH-LD3E-PINNED-YTDLP-CHUNK-DEPENDENCY-REMEDIATION-DESIGN-002
 * (`rd002_lab_v2.mjs`, `judge_rd002_v2.py`, `expectations_rd002.py` with
 * addendum 1): the same deterministic media, the same scripted origin
 * behaviours, the same four routes, the same fixture safety ceilings, the same
 * 60 judged scenarios and, for each, the same FROZEN acceptance outcome. The
 * two scenarios that addendum withdrew (k02, whose limit ended before the
 * first media request, and i10a, whose large-write-then-reset fixture is not
 * delivered reliably) are left out, as they were left unjudged; k02b and i10c
 * replace them. Each acceptance clause of the judge is its own named test, so
 * a regression names exactly the property it broke:
 *
 *   outcome            the scenario's frozen class: "exact" (an artifact byte for
 *                      byte equal to the media), "failClosed" (no artifact) or either
 *   byteExact          any returned artifact equals the media (size, SHA-256, no
 *                      differing offset): duplicated, missing or altered bytes fail
 *   requestBound       media requests <= ceil(T / floor(0.95 C)) + 2 (R + 1): each
 *                      free request delivered a full piece; every other one spends
 *                      an attempt of the policy's R retries (at most two requests each)
 *   fixtureCeiling     the fixture's own request and time ceiling was never reached
 *   noLateRequests     no media request more than 50 ms after the seam returned
 *   noOpenConnections  no fixture connection open after the settle period
 *   noSurvivor         no process naming the job directory after the settle period
 *   loopbackOnly       every request came from the loopback address
 *   publicError        a failure is an existing public code with its constant message
 *   jobDir             the job directory holds exactly the artifact, or at most a
 *                      `.part` that is a prefix of the media
 *   policyArgv         the policy's retry arguments, the native downloader and the
 *                      unusable FFmpeg location, each exactly once
 *   noOtherExecutable  every process naming the job directory during the run is the
 *                      interpreter (vacuous where the run was too short to sample)
 *   stopPrompt         (cancellation, deadline, inactivity, observation loss) no media
 *                      request later than 250 ms after the stop, the seam returned
 *                      within 1,500 ms, and the runner signalled the process group
 *
 * ROUTES. "seam": the Worker's real `downloadGenericOriginal`, argument builder,
 * hardened runner and environment, with ONE test-only argument,
 * `--http-chunk-size=<n>`, inserted before the `--` terminator (the pinned
 * generic extractor never asks for chunking; the Worker never passes it).
 * "direct": the Worker's argument list and runner without the seam, for the two
 * cases the seam refuses by design (a pre-existing `.part`). "extractor": the
 * complete pinned pipeline with a test extractor that sets
 * `downloader_options` as an extractor does (no test-only argument). "dash": the
 * Worker's split seam with a segmented-DASH pair.
 *
 * WHERE IT RUNS. Exactly the rule of the other pinned-runtime contracts: inside
 * the Worker image the artifact is at its pinned path; elsewhere only when
 * `VIDEOFETCH_PINNED_YTDLP_ARTIFACT` (and `VIDEOFETCH_PINNED_YTDLP_PYTHON`)
 * name a copy whose digest equals `YTDLP_RUNTIME.sha256`; otherwise every test
 * SKIPS and says why. Nothing leaves the loopback interface; no credential,
 * cookie or private medium exists here. When
 * `VIDEOFETCH_CHUNK_CONTRACT_RECORD` names a new file, a sanitized record of
 * every scenario is written there for review (it changes no verdict).
 */

const ARTIFACT = process.env.VIDEOFETCH_PINNED_YTDLP_ARTIFACT || YTDLP_RUNTIME.artifactPath;
const PYTHON = process.env.VIDEOFETCH_PINNED_YTDLP_PYTHON || YTDLP_RUNTIME.pythonPath;
const RECORD = process.env.VIDEOFETCH_CHUNK_CONTRACT_RECORD || "";

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

function pinnedArtifactStatus(): string | null {
  if (!existsSync(ARTIFACT)) return `pinned yt-dlp artifact not present at ${ARTIFACT}`;
  if (!existsSync(PYTHON)) return `interpreter not present at ${PYTHON}`;
  const digest = sha(readFileSync(ARTIFACT));
  if (digest !== YTDLP_RUNTIME.sha256) return `artifact digest ${digest} is not the pinned ${YTDLP_RUNTIME.sha256}`;
  return null;
}
const UNAVAILABLE = pinnedArtifactStatus();
const skip = UNAVAILABLE === null ? false : `SKIPPED — ${UNAVAILABLE}`;

// ── the fixture media and safety ──────────────────────────────────────────────

const fill = (bytes: number, label: string): Buffer => {
  const b = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 32) createHash("sha256").update(`${label}${i}`).digest().copy(b, i);
  return b;
};
type MediaKey = "S" | "L";
let MEDIA: Record<MediaKey, Buffer> = { S: Buffer.alloc(0), L: Buffer.alloc(0) };
const MEDIA_SHA256 = { S: "50c3d831", L: "56bfb19b" }; // the laboratory's media (prefixes of their SHA-256)
const DEFAULT_SAFETY = { maxRequests: 15_000, maxMs: 9_000 };
const LIMIT_BYTES = 4 * 1024 ** 3;
const SETTLE_MS = 1_200;
const STOP_LAST_REQUEST_MS = 250;
const STOP_RETURN_MS = 1_500;
const POLICY = { bounded: { retries: 2, socket: 10, fragment: 1, extractor: 1 }, watched: { retries: 20, socket: 30, fragment: 3, extractor: 1 } } as const;
const NO_FFMPEG = "--ffmpeg-location=/nonexistent/videofetch-yt-dlp-no-ffmpeg";

type Logged = { route: string; at: number; method: string; range: string | null; remote: string | null; status: number | null; sent: number };
type Safety = { maxRequests: number; maxMs: number; hit: boolean; hitAt: number | null; reason: string | null; refused: number[] };
type Handler = (req: IncomingMessage, res: ServerResponse, arg: unknown) => void;
type Scenario = { name: string; startedAt: number; handler: (req: IncomingMessage, res: ServerResponse, file?: string) => void; media: Logged[]; other: Logged[]; safety: Safety; mpd?: string };

const scenarios = new Map<string, Scenario>();
const openSockets = new Set<Socket>();
let ORIGIN = "";
let server: ReturnType<typeof createServer> | null = null;
const at = (sc: Scenario): number => Math.round((performance.now() - sc.startedAt) * 10) / 10;

function startFixture(): Promise<void> {
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const m = /^\/(w|m|x|d)\/([a-z0-9-]+)(?:\/([A-Za-z0-9.-]+))?$/.exec(path);
    const sc = m ? scenarios.get(m[2]) : undefined;
    if (!m || !sc || (m[1] === "d") !== (m[3] !== undefined)) {
      res.writeHead(404, { "content-length": 0 });
      return void res.end();
    }
    const now = at(sc);
    const isMedia = m[1] === "m" || (m[1] === "d" && m[3] !== "clip.mpd");
    if (isMedia) {
      // The fixture's own ceiling: independent of the child, of yt-dlp's counters and of the Worker's limit.
      if (sc.safety.hit || sc.media.length >= sc.safety.maxRequests || now > sc.safety.maxMs) {
        if (!sc.safety.hit) {
          sc.safety.hit = true;
          sc.safety.hitAt = now;
          sc.safety.reason = sc.media.length >= sc.safety.maxRequests ? "request ceiling" : "duration ceiling";
        }
        sc.safety.refused.push(now);
        return void req.socket.destroy();
      }
    }
    const route = m[1] === "w" ? "page" : m[1] === "m" ? "media" : m[1] === "x" ? "extractor-url" : m[3] === "clip.mpd" ? "manifest" : m[3]!;
    const logged: Logged = { route, at: now, method: req.method ?? "", range: (req.headers.range as string | undefined) ?? null, remote: req.socket.remoteAddress ?? null, status: null, sent: 0 };
    (isMedia ? sc.media : sc.other).push(logged);
    const write = res.write.bind(res) as (...a: unknown[]) => boolean;
    res.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (chunk && typeof chunk !== "function") logged.sent += (chunk as Buffer).length;
      return write(chunk, ...rest);
    }) as typeof res.write;
    const end = res.end.bind(res) as (...a: unknown[]) => ServerResponse;
    res.end = ((chunk?: unknown, ...rest: unknown[]) => {
      if (chunk && typeof chunk !== "function") logged.sent += (chunk as Buffer).length;
      return end(chunk, ...rest);
    }) as typeof res.end;
    const writeHead = res.writeHead.bind(res) as (...a: unknown[]) => ServerResponse;
    res.writeHead = ((status: number, ...rest: unknown[]) => {
      logged.status = status;
      return writeHead(status, ...rest);
    }) as typeof res.writeHead;
    if (m[1] === "w") {
      const body = Buffer.from(`<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>RD-002 lab fixture</title>\n</head>\n<body>\n<h1>RD-002 lab fixture</h1>\n<video controls preload="none">\n<source src="/m/${m[2]}" type="video/mp4">\n</video>\n</body>\n</html>\n`);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": body.length });
      return void res.end(req.method === "HEAD" ? undefined : body);
    }
    if (m[1] === "x") {
      res.writeHead(404, { "content-length": 0 });
      return void res.end();
    }
    if (m[1] === "d" && m[3] === "clip.mpd") {
      const body = Buffer.from(sc.mpd ?? "");
      res.writeHead(200, { "content-type": "application/dash+xml", "content-length": body.length });
      return void res.end(req.method === "HEAD" ? undefined : body);
    }
    sc.handler(req, res, m[3]);
  });
  server.on("connection", (s: Socket) => {
    openSockets.add(s);
    s.on("close", () => openSockets.delete(s));
  });
  return new Promise((resolve) => server!.listen(0, "127.0.0.1", () => {
    ORIGIN = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    resolve();
  }));
}

// ── answer behaviours (ported unchanged; every body slice is a real slice of the media) ──

type Range = { start: number; end: number | null };
type Piece = { start: number; end: number };
const parseRange = (h: string | undefined): Range | null => {
  const m = /^bytes=(\d+)-(\d*)$/.exec(h ?? "");
  return m ? { start: Number(m[1]), end: m[2] === "" ? null : Number(m[2]) } : null;
};
const TYPE = { "content-type": "video/mp4" };
const UNDECLARED = { ...TYPE, "transfer-encoding": "chunked" };
type State = { used?: boolean; cutDone?: boolean; answered416?: boolean; frozen?: Piece };
type Later = (req: IncomingMessage, res: ServerResponse, p: Piece, state: State) => void;

function origin(M: Buffer) {
  const TOTAL = M.length;
  const piece = (r: Range): Piece => ({ start: r.start, end: r.end !== null ? Math.min(r.end, TOTAL - 1) : TOTAL - 1 });
  const unsatisfiable = (r: Range): boolean => r.start >= TOTAL || (r.end !== null && r.end < r.start);
  const send416 = (res: ServerResponse): void => {
    res.writeHead(416, { "content-range": `bytes */${TOTAL}`, "content-length": 0 });
    res.end();
  };
  const whole200 = (res: ServerResponse): void => {
    res.writeHead(200, { ...TYPE, "content-length": TOTAL, "accept-ranges": "bytes" });
    res.end(M);
  };
  const exactPiece = (res: ServerResponse, { start, end }: Piece): void => {
    res.writeHead(206, { ...TYPE, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${TOTAL}`, "accept-ranges": "bytes" });
    res.end(M.subarray(start, end + 1));
  };
  /** A conforming origin: 200 with the whole body without `Range`, the exact requested piece with it, 416 past the end. */
  const conforming = (req: IncomingMessage, res: ServerResponse): void => {
    const r = parseRange(req.headers.range);
    if (!r) return whole200(res);
    if (unsatisfiable(r)) return send416(res);
    exactPiece(res, piece(r));
  };
  /** Conforming for a request without `Range` and for the piece at offset 0; `later` answers every satisfiable later piece. */
  const afterFirst = (later: Later): Handler => (req, res, state) => {
    const r = parseRange(req.headers.range);
    if (!r || r.start === 0) return conforming(req, res);
    if (unsatisfiable(r)) return send416(res);
    return later(req, res, piece(r), state as State);
  };
  /** `later` once (the first later piece), a conforming piece ever after. */
  const once = (later: Later): Later => (req, res, p, state) => {
    if (state.used) return exactPiece(res, p);
    state.used = true;
    return later(req, res, p, state);
  };
  const cut = (res: ServerResponse, body: Buffer, how: "end" | "reset"): void => {
    const finish = (): void => {
      if (how === "reset") (res.socket as Socket | null)?.resetAndDestroy();
      else res.socket?.end();
    };
    if (body.length > 0) res.write(body, finish);
    else {
      res.flushHeaders();
      setImmediate(finish);
    }
  };
  const half = (res: ServerResponse, upTo: number, how: "end" | "reset"): void => {
    res.writeHead(200, { ...TYPE, "content-length": TOTAL, "accept-ranges": "bytes" });
    cut(res, M.subarray(0, upTo), how);
  };
  const LATER = {
    /** A matching Content-Range for the requested piece, declared length 0, no body. */
    emptyBody: ((req, res, { start, end }) => {
      res.writeHead(206, { ...TYPE, "content-length": 0, "content-range": `bytes ${start}-${end}/${TOTAL}` });
      res.end();
    }) as Later,
    /** A matching Content-Range, no declared length (chunked coding), an empty and correctly terminated body. */
    emptyUndeclared: ((req, res, { start, end }) => {
      res.writeHead(206, { ...UNDECLARED, "content-range": `bytes ${start}-${end}/${TOTAL}` });
      res.end();
    }) as Later,
    /** A matching Content-Range for the requested piece, declared length 1, the one correct byte. */
    oneByte: ((req, res, { start, end }) => {
      res.writeHead(206, { ...TYPE, "content-length": 1, "content-range": `bytes ${start}-${end}/${TOTAL}` });
      res.end(M.subarray(start, start + 1));
    }) as Later,
    /** A self-consistent ONE-BYTE range (`bytes s-s/T`), its one correct byte. */
    oneByteRange: ((req, res, { start }) => {
      res.writeHead(206, { ...TYPE, "content-length": 1, "content-range": `bytes ${start}-${start}/${TOTAL}` });
      res.end(M.subarray(start, start + 1));
    }) as Later,
    /** Declares the whole requested piece, delivers `k` bytes of it, then ends (or resets) the connection. */
    declaredThenCut: (k: number, how: "end" | "reset"): Later => (req, res, { start, end }) => {
      res.writeHead(206, { ...TYPE, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${TOTAL}` });
      cut(res, M.subarray(start, start + Math.min(k, end - start + 1)), how);
    },
    /** `Range` ignored: 200, the whole body, no Content-Range. */
    wholeBody200: ((req, res) => whole200(res)) as Later,
    /** A range that starts `n` bytes BEFORE the requested start and runs to the requested end. */
    overlap: (n: number): Later => (req, res, { start, end }) => {
      const from = Math.max(0, start - n);
      res.writeHead(206, { ...TYPE, "content-length": end - from + 1, "content-range": `bytes ${from}-${end}/${TOTAL}` });
      res.end(M.subarray(from, end + 1));
    },
    /** A self-consistent range of only `n` bytes from the requested start. */
    shortenedRange: (n: number): Later => (req, res, p) => {
      if (p.end - p.start + 1 <= n) return exactPiece(res, p);
      res.writeHead(206, { ...TYPE, "content-length": n, "content-range": `bytes ${p.start}-${p.start + n - 1}/${TOTAL}` });
      res.end(M.subarray(p.start, p.start + n));
    },
    /** The requested range in Content-Range, but a declared length (and body) `n` bytes SHORTER. */
    lengthTooSmall: (n: number): Later => (req, res, p) => {
      const span = p.end - p.start + 1;
      if (span <= n) return exactPiece(res, p);
      res.writeHead(206, { ...TYPE, "content-length": span - n, "content-range": `bytes ${p.start}-${p.end}/${TOTAL}` });
      res.end(M.subarray(p.start, p.end + 1 - n));
    },
    /** The requested range and its bytes, but a declared length `n` bytes LONGER; the connection then ends. */
    lengthTooLarge: (n: number): Later => (req, res, p) => {
      res.writeHead(206, { ...TYPE, "content-length": p.end - p.start + 1 + n, "content-range": `bytes ${p.start}-${p.end}/${TOTAL}` });
      cut(res, M.subarray(p.start, p.end + 1), "end");
    },
    /** The requested range and its bytes, but a total `d` larger than the real one. */
    wrongTotal: (d: number): Later => (req, res, { start, end }) => {
      res.writeHead(206, { ...TYPE, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${TOTAL + d}` });
      res.end(M.subarray(start, end + 1));
    },
    /** Status 206 and the requested bytes, but NO Content-Range. */
    noContentRange206: ((req, res, { start, end }) => {
      res.writeHead(206, { ...TYPE, "content-length": end - start + 1 });
      res.end(M.subarray(start, end + 1));
    }) as Later,
    /** The requested start, but everything up to the end of the file (the requested end is ignored). */
    restOfFile: ((req, res, { start }) => {
      res.writeHead(206, { ...TYPE, "content-length": TOTAL - start, "content-range": `bytes ${start}-${TOTAL - 1}/${TOTAL}` });
      res.end(M.subarray(start));
    }) as Later,
    always416: ((req, res) => send416(res)) as Later,
    /** The requested range, no declared length, the requested bytes FOLLOWED by `n` bytes that are not media. */
    surplus: (n: number): Later => (req, res, { start, end }) => {
      res.writeHead(206, { ...UNDECLARED, "content-range": `bytes ${start}-${end}/${TOTAL}` });
      res.end(Buffer.concat([M.subarray(start, end + 1), Buffer.alloc(n, 0xee)]));
    },
    status503: ((req, res) => {
      res.writeHead(503, { "content-length": 0 });
      res.end();
    }) as Later,
    /** 416 for the first such request, 200 with the whole body (no Content-Range) for every one after it. */
    once416ThenWhole: ((req, res, p, state) => {
      if (state.answered416) return whole200(res);
      state.answered416 = true;
      send416(res);
    }) as Later,
    /** The first later piece's range and bytes, repeated for every later request whatever it asks for. */
    frozenRange: ((req, res, p, state) => {
      state.frozen ??= p;
      exactPiece(res, state.frozen);
    }) as Later,
  };
  return {
    TOTAL, conforming: conforming as Handler, afterFirst, once, LATER,
    /** Every request: a matching Content-Range for the requested piece, declared length 0, no body. */
    firstEmpty: ((req, res) => {
      const r = parseRange(req.headers.range);
      if (!r) return whole200(res);
      LATER.emptyBody(req, res, piece(r), {});
    }) as Handler,
    /** `Range` ignored on every request: 200, the whole body. */
    always200: ((req, res) => whole200(res)) as Handler,
    /** `Range` ignored on every request: 200 declaring the whole length, half the body, then an orderly end. */
    always200Truncated: ((req, res) => half(res, TOTAL / 2, "end")) as Handler,
    /** Conforming answers without a declared length (chunked transfer coding). */
    conformingUndeclared: ((req, res) => {
      const r = parseRange(req.headers.range);
      if (!r) {
        res.writeHead(200, UNDECLARED);
        return void res.end(M);
      }
      if (unsatisfiable(r)) return send416(res);
      const { start, end } = piece(r);
      res.writeHead(206, { ...UNDECLARED, "content-range": `bytes ${start}-${end}/${TOTAL}` });
      res.end(M.subarray(start, end + 1));
    }) as Handler,
    /** The requested bytes, with the total given as unknown (`/*`). */
    unknownTotal: ((req, res) => {
      const r = parseRange(req.headers.range);
      if (!r) return whole200(res);
      if (unsatisfiable(r)) return send416(res);
      const { start, end } = piece(r);
      res.writeHead(206, { ...TYPE, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/*` });
      res.end(M.subarray(start, end + 1));
    }) as Handler,
    /** A total that creeps: the first piece in full with a total two bytes past its end; every later answer is the one
     *  byte at the requested start with a total two bytes past it. Every answer matches its request exactly. */
    creepingTotal: ((req, res) => {
      const r = parseRange(req.headers.range);
      if (!r || r.end === null) return whole200(res);
      if (r.start >= TOTAL - 2) return send416(res);
      if (r.start === 0) {
        const end = Math.min(r.end, TOTAL - 3);
        res.writeHead(206, { ...TYPE, "content-length": end + 1, "content-range": `bytes 0-${end}/${end + 2}` });
        return void res.end(M.subarray(0, end + 1));
      }
      res.writeHead(206, { ...TYPE, "content-length": 1, "content-range": `bytes ${r.start}-${r.start}/${r.start + 2}` });
      res.end(M.subarray(r.start, r.start + 1));
    }) as Handler,
    /** No `Range`: 200 declaring the whole length, `upTo` bytes, then the connection ends (or resets), once when
     *  `onceOnly`. With `Range`: `ranged` answers (given the open-ended piece). */
    halfThen: (ranged: Later, how: "end" | "reset" = "end", upTo = TOTAL / 2, onceOnly = false): Handler => (req, res, raw) => {
      const state = raw as State;
      const r = parseRange(req.headers.range);
      if (!r) {
        if (onceOnly && state.cutDone) return whole200(res);
        state.cutDone = true;
        return half(res, upTo, how);
      }
      if (unsatisfiable(r)) return send416(res);
      return ranged(req, res, piece(r), state);
    },
    exactPiece: ((req, res, p) => exactPiece(res, p)) as Later,
    /** A range that starts `n` bytes before the requested start and runs to the end of the file. */
    wrongStartToEnd: (n: number): Later => (req, res, { start }) => {
      res.writeHead(206, { ...TYPE, "content-length": TOTAL - start + n, "content-range": `bytes ${start - n}-${TOTAL - 1}/${TOTAL}` });
      res.end(M.subarray(start - n));
    },
    /** Status 206, the rest of the file from the requested start, NO Content-Range. */
    restNoContentRange: ((req, res, { start }) => {
      res.writeHead(206, { ...TYPE, "content-length": TOTAL - start });
      res.end(M.subarray(start));
    }) as Later,
  };
}

// ── a segmented-DASH set (unchanged from the laboratory) ────────────────────────

const dashSegment = (tag: string, size: number): Buffer => Buffer.alloc(size, `${tag}|`);
function dashSet(nVideo: number, nAudio: number) {
  const files: Record<string, Buffer> = { "v-init.mp4": dashSegment("VINIT", 700), "a-init.mp4": dashSegment("AINIT", 600) };
  for (let i = 1; i <= nVideo; i++) files[`v-${i}.m4s`] = dashSegment(`V${i}`, 2_000 + (i % 7) * 100);
  for (let i = 1; i <= nAudio; i++) files[`a-${i}.m4s`] = dashSegment(`A${i}`, 500 + (i % 5) * 20);
  const list = (p: string, n: number): string => [`<Initialization sourceURL="${p}-init.mp4"/>`].concat(Array.from({ length: n }, (_, i) => `<SegmentURL media="${p}-${i + 1}.m4s"/>`)).join("");
  const seconds = Math.max(nVideo, nAudio) * 2;
  const mpd = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT${seconds}S" minBufferTime="PT2S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
 <Period id="p0" duration="PT${seconds}S">
  <AdaptationSet mimeType="video/mp4" contentType="video">
   <Representation id="v1080" codecs="avc1.640028" width="1920" height="1080" frameRate="30" bandwidth="4000000">
    <SegmentList timescale="1000" duration="2000">${list("v", nVideo)}</SegmentList>
   </Representation>
  </AdaptationSet>
  <AdaptationSet mimeType="audio/mp4" contentType="audio" lang="en">
   <Representation id="a128" codecs="mp4a.40.2" audioSamplingRate="48000" bandwidth="128000">
    <SegmentList timescale="1000" duration="2000">${list("a", nAudio)}</SegmentList>
   </Representation>
  </AdaptationSet>
 </Period>
</MPD>
`;
  const whole = (p: string, n: number): Buffer => Buffer.concat([files[`${p}-init.mp4`], ...Array.from({ length: n }, (_, i) => files[`${p}-${i + 1}.m4s`])]);
  return { files, mpd, video: whole("v", nVideo), audio: whole("a", nAudio) };
}
const DASH_PAIR: GenericSplitExecutionPlan = {
  strategy: "yt-dlp", operation: "merge-split", requestedFormatId: "preset:1080",
  pair: {
    video: { formatId: "v1080", protocol: "http_dash_segments", container: "mp4", hasVideo: true, hasAudio: false, videoConstraint: "codec-present", audioConstraint: "absent", fileSize: null },
    audio: { formatId: "a128", protocol: "http_dash_segments", container: "m4a", hasVideo: false, hasAudio: true, videoConstraint: "absent", audioConstraint: "codec-present", fileSize: null },
  },
  targetContainer: "mp4",
} as GenericSplitExecutionPlan;
type DashSet = ReturnType<typeof dashSet>;
const dashOrigin = (set: DashSet, special: Record<string, (req: IncomingMessage, res: ServerResponse) => void> = {}) =>
  (req: IncomingMessage, res: ServerResponse, file?: string): void => {
    const body = file ? set.files[file] : undefined;
    if (!body || !file) {
      res.writeHead(404, { "content-length": 0 });
      return void res.end();
    }
    if (special[file]) return special[file](req, res);
    const r = parseRange(req.headers.range);
    if (r && r.start < body.length) {
      const end = r.end === null ? body.length - 1 : Math.min(r.end, body.length - 1);
      res.writeHead(206, { "content-type": "video/iso.segment", "content-length": end - r.start + 1, "content-range": `bytes ${r.start}-${end}/${body.length}` });
      return void res.end(body.subarray(r.start, end + 1));
    }
    res.writeHead(200, { "content-type": "video/iso.segment", "content-length": body.length });
    res.end(body);
  };
const empty200 = (req: IncomingMessage, res: ServerResponse): void => {
  res.writeHead(200, { ...TYPE, "content-length": 0 });
  res.end();
};

// ── the record of one scenario, and the processes and signals around it ──────────

type Compared = { bytes: number; expectedBytes: number; sha256: string; expectedSha256: string; byteExact: boolean; firstDifferingOffset: number | null; isPrefixOfExpected: boolean };
type Child = { argv: string[]; exit: number | null; lines: string[] };
type Outcome = { ok: boolean; code?: string; messageIsARepositoryConstant?: boolean; exitedByItself?: boolean; exit?: number | null };
type Rec = {
  name: string; route: string; media: MediaKey | "dash"; policy: "bounded" | "watched"; testOnlyArguments: string[]; chunk: number | null; limitMs: number;
  outcome: Outcome; artifact: (Compared | { byteExact: boolean; video: Compared; audio: Compared }) | null; endedAt: number;
  requests: { mediaRequests: number; remoteAddresses: string[]; lastMediaAt: number | null; requestsLaterThan50msAfterEnd: number; refusedByFixtureLaterThan50msAfterEnd: number; bodyBytesFirstAnswer: number | null };
  fixtureSafety: { hit: boolean; reason: string | null };
  openFixtureConnectionsAfterSettle: number;
  processes: { duringRun: string[] | null; afterSettle: string[] };
  groupSignals: number;
  trigger: { kind: string; at: number } | null;
  jobDirAfter: { name: string; bytes?: number; isPrefixOfExpected?: boolean }[];
  children: Child[];
};

const groupSignals: { at: number }[] = [];
let realKill: typeof process.kill | null = null;

/** Every process whose ARGUMENTS name `needle`: "pid executable". /proc on Linux, ps elsewhere; this process excluded. */
function processesNaming(needle: string): string[] {
  const rows: { pid: number; args: string[] }[] = [];
  if (existsSync("/proc/self/cmdline")) {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const args = readFileSync(`/proc/${entry}/cmdline`).toString("utf8").split("\0").filter((a) => a.length > 0);
        if (args.length) rows.push({ pid: Number(entry), args });
      } catch {
        // the process ended while it was being read
      }
    }
  } else {
    const text = execFileSync("/bin/ps", ["-axww", "-o", "pid=,args="], { encoding: "utf8", env: { LC_ALL: "C", PATH: "/bin:/usr/bin" } });
    for (const line of text.split("\n")) {
      const fields = line.trim().split(/\s+/);
      if (fields.length > 1) rows.push({ pid: Number(fields[0]), args: fields.slice(1) });
    }
  }
  return rows.filter((r) => r.pid !== process.pid && r.args.some((a) => a.includes(needle))).map((r) => `${r.pid} ${basename(r.args[0])}`);
}

const compare = (bytes: Buffer, expected: Buffer): Compared => {
  const n = Math.min(bytes.length, expected.length);
  let diff: number | null = null;
  for (let i = 0; i < n; i++) if (bytes[i] !== expected[i]) { diff = i; break; }
  if (diff === null && bytes.length !== expected.length) diff = n;
  return {
    bytes: bytes.length, expectedBytes: expected.length, sha256: sha(bytes), expectedSha256: sha(expected),
    byteExact: bytes.equals(expected), firstDifferingOffset: diff,
    isPrefixOfExpected: bytes.length <= expected.length && expected.subarray(0, bytes.length).equals(bytes),
  };
};
const describeError = (err: unknown): Outcome => (err instanceof AppError
  ? { ok: false, code: err.code, messageIsARepositoryConstant: err.message === ERROR_MESSAGES[err.code] || err.message === "Download was cancelled." }
  : { ok: false, code: `non-AppError ${(err as Error | null)?.name}`, messageIsARepositoryConstant: false });
const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const sanitize = (text: string, workDir: string | null): string => text
  .split(ORIGIN).join("http://<fixture>")
  .split(workDir ?? "\u0000").join("<jobdir>")
  .split(ARTIFACT).join("<runtime>")
  .split(tmpdir()).join("<tmp>");

function newScenario(name: string, handler: (req: IncomingMessage, res: ServerResponse, file?: string) => void, safety = {}): Scenario {
  const sc: Scenario = { name, startedAt: performance.now(), handler, media: [], other: [], safety: { ...DEFAULT_SAFETY, ...safety, hit: false, hitAt: null, reason: null, refused: [] } };
  scenarios.set(name, sc);
  return sc;
}
const stateful = (h: Handler): ((req: IncomingMessage, res: ServerResponse) => void) => {
  const state: State = {};
  return (req, res) => h(req, res, state);
};

/** The hardened runner, with exactly two substitutions (the interpreter, and argv[0] when it is the pinned path) and the test-only arguments. */
function seamRunner(children: Child[], workDir: () => string | null, extra: string[]): typeof runProcess {
  return async (opts) => {
    assert.equal(opts.command, YTDLP_RUNTIME.pythonPath, "only yt-dlp is ever run through this adapter");
    assert.equal(opts.args[0], YTDLP_RUNTIME.artifactPath);
    let args = [ARTIFACT, ...opts.args.slice(1)];
    if (extra.length) {
      const i = args.lastIndexOf("--");
      assert.equal(i, args.length - 2, "the terminator is second to last");
      args = [...args.slice(0, i), ...extra, ...args.slice(i)];
    }
    const child: Child = { argv: args.map((a) => sanitize(a, workDir())), exit: null, lines: [] };
    children.push(child);
    const r = await runProcess({ ...opts, command: PYTHON, args });
    child.exit = r.code;
    child.lines = `${r.stdout}\n${r.stderr}`.split(/[\r\n]+/).filter(Boolean).slice(-30).map((l) => sanitize(l, workDir()));
    return r;
  };
}
const pinnedProbe = async (): Promise<YtdlpRuntimeStatus> => ({ available: true, version: YTDLP_RUNTIME.expectedVersion, reason: "ok" });
const loopback = async (raw: string) => ({ url: raw, hostname: "127.0.0.1" });

async function finish(sc: Scenario, rec: Partial<Rec>, workDir: string, endedAt: number, duringRun: string[] | null, expected: Buffer | null, signalsBefore: number): Promise<Rec> {
  await settle(SETTLE_MS); // anything the child, or a survivor, would still request arrives here
  const media = sc.media;
  rec.endedAt = endedAt;
  rec.requests = {
    mediaRequests: media.length,
    remoteAddresses: [...new Set([...media, ...sc.other].map((e) => e.remote ?? "?"))].sort(),
    lastMediaAt: media.at(-1)?.at ?? null,
    requestsLaterThan50msAfterEnd: media.filter((e) => e.at > endedAt + 50).length,
    refusedByFixtureLaterThan50msAfterEnd: sc.safety.refused.filter((t) => t > endedAt + 50).length,
    bodyBytesFirstAnswer: media[0]?.sent ?? null,
  };
  rec.fixtureSafety = { hit: sc.safety.hit, reason: sc.safety.reason };
  rec.openFixtureConnectionsAfterSettle = openSockets.size;
  for (const s of [...openSockets]) s.destroy();
  rec.processes = { duringRun, afterSettle: processesNaming(workDir) };
  rec.groupSignals = groupSignals.length - signalsBefore;
  rec.jobDirAfter = existsSync(workDir)
    ? readdirSync(workDir).sort().map((n) => {
      const p = join(workDir, n);
      const st = statSync(p);
      if (!st.isFile()) return { name: n };
      const bytes = readFileSync(p);
      return { name: n, bytes: st.size, ...(expected ? { isPrefixOfExpected: bytes.length <= expected.length && expected.subarray(0, bytes.length).equals(bytes) } : {}) };
    })
    : [];
  scenarios.delete(sc.name);
  rmSync(workDir, { recursive: true, force: true });
  return rec as Rec;
}

// ── the four routes ────────────────────────────────────────────────────────────

type SeamCfg = { media?: MediaKey; handler: Handler; chunk?: number; limitMs: number; watched?: boolean; maxFileSizeBytes?: number; trigger?: "cancel" | "inactivity" | "observation-loss"; scanAfterRequests?: number };
let PLAN: GenericSingleSourceExecutionPlan | null = null;

async function seamScenario(name: string, cfg: SeamCfg): Promise<Rec> {
  const expected = MEDIA[cfg.media ?? "S"];
  const sc = newScenario(name, stateful(cfg.handler));
  const workDir = mkdtempSync(join(tmpdir(), "ld3e-chunk-"));
  const children: Child[] = [];
  const caller = new AbortController();
  const inactivity = new AbortController();
  const observationLoss = new AbortController();
  const tracker = createAcquisitionActivityTracker({ clock: () => performance.now() });
  const extra = cfg.chunk ? [`--http-chunk-size=${cfg.chunk}`] : [];
  const rec: Partial<Rec> = { name, route: extra.length ? "seam + test-only chunk size" : "seam", media: cfg.media ?? "S", policy: cfg.watched ? "watched" : "bounded", testOnlyArguments: extra, chunk: cfg.chunk ?? null, limitMs: cfg.limitMs, children, trigger: null };
  const signalsBefore = groupSignals.length;
  let duringRun: string[] | null = null;
  const watcher = setInterval(() => {
    if (duringRun === null && sc.media.length >= (cfg.scanAfterRequests ?? 3)) duringRun = processesNaming(workDir);
    if (cfg.trigger && rec.trigger === null && (sc.media.length >= 1500 || at(sc) > 5_000)) {
      rec.trigger = { kind: cfg.trigger, at: at(sc) };
      if (cfg.trigger === "cancel") caller.abort(new AppError("PROCESSING_FAILED", "Job cancelled"));
      if (cfg.trigger === "inactivity") inactivity.abort();
      if (cfg.trigger === "observation-loss") observationLoss.abort();
    }
  }, 5);
  try {
    const res = await downloadGenericOriginal(`${ORIGIN}/w/${name}`, workDir, PLAN!, {
      limits: { maxFileSizeBytes: cfg.maxFileSizeBytes ?? LIMIT_BYTES, downloadTimeLimitMs: cfg.limitMs },
      runner: seamRunner(children, () => workDir, extra),
      probeRuntime: pinnedProbe,
      validateUrl: loopback,
      activity: tracker.record,
      signal: caller.signal,
      sizePollMs: 25,
      ...(cfg.watched ? { stopForInactivity: inactivity.signal, stopForObservationLoss: observationLoss.signal } : {}),
    });
    rec.outcome = { ok: true };
    rec.artifact = compare(readFileSync(res.filePath), expected);
  } catch (err) {
    rec.outcome = describeError(err);
    rec.artifact = null;
  }
  const endedAt = at(sc);
  clearInterval(watcher);
  return finish(sc, rec, workDir, endedAt, duringRun, expected, signalsBefore);
}

/** The Worker's argument list, runner and environment WITHOUT the seam, in a job directory that already holds a `.part`. */
async function directScenario(name: string, cfg: { handler: Handler; preseedBytes: number; limitMs: number }): Promise<Rec> {
  const expected = MEDIA.S;
  const sc = newScenario(name, stateful(cfg.handler));
  const workDir = mkdtempSync(join(tmpdir(), "ld3e-chunk-"));
  writeFileSync(join(workDir, "source.mp4.part"), expected.subarray(0, cfg.preseedBytes));
  const args = [ARTIFACT, ...[...buildYtdlpDownloadArgv({ validatedUrl: `${ORIGIN}/w/${name}`, workDir, plan: PLAN!, maxFileSizeBytes: LIMIT_BYTES, retryPolicy: "bounded" })].slice(1)];
  const child: Child = { argv: args.map((a) => sanitize(a, workDir)), exit: null, lines: [] };
  const rec: Partial<Rec> = { name, route: "direct", media: "S", policy: "bounded", testOnlyArguments: [], chunk: null, limitMs: cfg.limitMs, children: [child], trigger: null };
  const signalsBefore = groupSignals.length;
  try {
    const r = await runProcess({ command: PYTHON, args, timeoutMs: cfg.limitMs, env: buildYtdlpDownloadEnvironment({ workDir }) });
    child.exit = r.code;
    child.lines = `${r.stdout}\n${r.stderr}`.split(/[\r\n]+/).filter(Boolean).slice(-30).map((l) => sanitize(l, workDir));
    rec.outcome = { ok: r.code === 0 && existsSync(join(workDir, "source.mp4")), exitedByItself: true, exit: r.code };
  } catch (err) {
    rec.outcome = { ...describeError(err), exitedByItself: false };
  }
  const endedAt = at(sc);
  const finalPath = join(workDir, "source.mp4");
  rec.artifact = existsSync(finalPath) ? compare(readFileSync(finalPath), expected) : null;
  return finish(sc, rec, workDir, endedAt, null, expected, signalsBefore);
}

/**
 * The complete pinned pipeline with a TEST extractor that sets `downloader_options`
 * as an extractor does (the pinned generic extractor never does, and the
 * extractors that do match only their own services' hosts). Options are parsed
 * by the runtime's own parser from the Worker's argument list; the only URL is
 * the loopback fixture's.
 */
const EXTRACTOR_ROUTE = String.raw`
import json, sys
RUNTIME, CFG = sys.argv[1], json.loads(sys.argv[2])
sys.path.insert(0, RUNTIME)
import yt_dlp
from yt_dlp.extractor.common import InfoExtractor

class LD3EChunkFixtureIE(InfoExtractor):
    IE_NAME = 'ld3e:chunkfixture'
    _VALID_URL = r'http://127\.0\.0\.1:\d+/x/(?P<id>[a-z0-9-]+)'

    def _real_extract(self, url):
        video_id = self._match_id(url)
        return {'id': video_id, 'title': 'ld3e chunk fixture', 'formats': [{
            'format_id': '0', 'url': url.replace('/x/', '/m/', 1), 'ext': 'mp4',
            'vcodec': 'avc1.42E01E', 'acodec': 'mp4a.40.2',
            'downloader_options': {'http_chunk_size': CFG['extractorChunkSize']},
        }]}

parsed = yt_dlp.parse_options(CFG['argv'])
with yt_dlp.YoutubeDL(parsed.ydl_opts) as ydl:
    ie = LD3EChunkFixtureIE(ydl)
    ydl._ies = {ie.ie_key(): ie, **ydl._ies}
    ydl._ies_instances[ie.ie_key()] = ie
    sys.exit(ydl.download(parsed.urls))
`;

async function extractorScenario(name: string, cfg: { handler: Handler; extractorChunkSize: number; limitMs?: number }): Promise<Rec> {
  const expected = MEDIA.S;
  const sc = newScenario(name, stateful(cfg.handler));
  const workDir = mkdtempSync(join(tmpdir(), "ld3e-chunk-"));
  const argv = [...buildYtdlpDownloadArgv({ validatedUrl: `${ORIGIN}/x/${name}`, workDir, plan: PLAN!, maxFileSizeBytes: LIMIT_BYTES, retryPolicy: "bounded" })].slice(1);
  const timeoutMs = cfg.limitMs ?? 4_000;
  const child: Child = { argv: argv.map((a) => sanitize(a, workDir)), exit: null, lines: [] };
  const rec: Partial<Rec> = { name, route: "extractor", media: "S", policy: "bounded", testOnlyArguments: [], chunk: cfg.extractorChunkSize, limitMs: timeoutMs, children: [child], trigger: null };
  const signalsBefore = groupSignals.length;
  try {
    const r = await runProcess({ command: PYTHON, args: ["-I", "-c", EXTRACTOR_ROUTE, ARTIFACT, JSON.stringify({ argv, extractorChunkSize: cfg.extractorChunkSize })], timeoutMs, env: buildYtdlpDownloadEnvironment({ workDir }) });
    child.exit = r.code;
    child.lines = `${r.stdout}\n${r.stderr}`.split(/[\r\n]+/).filter(Boolean).slice(-30).map((l) => sanitize(l, workDir));
    rec.outcome = { ok: r.code === 0 && existsSync(join(workDir, "source.mp4")), exitedByItself: true, exit: r.code };
  } catch (err) {
    rec.outcome = { ...describeError(err), exitedByItself: false };
  }
  const endedAt = at(sc);
  const finalPath = join(workDir, "source.mp4");
  rec.artifact = existsSync(finalPath) ? compare(readFileSync(finalPath), expected) : null;
  return finish(sc, rec, workDir, endedAt, null, expected, signalsBefore);
}

async function dashScenario(name: string, cfg: { set: DashSet; special?: Record<string, (req: IncomingMessage, res: ServerResponse) => void>; limitMs: number }): Promise<Rec> {
  const sc = newScenario(name, dashOrigin(cfg.set, cfg.special));
  sc.mpd = cfg.set.mpd;
  const workDir = mkdtempSync(join(tmpdir(), "ld3e-chunk-"));
  const children: Child[] = [];
  const tracker = createAcquisitionActivityTracker({ clock: () => performance.now() });
  const rec: Partial<Rec> = { name, route: "dash", media: "dash", policy: "bounded", testOnlyArguments: [], chunk: null, limitMs: cfg.limitMs, children, trigger: null };
  const signalsBefore = groupSignals.length;
  try {
    const res = await downloadGenericSplitSources(`${ORIGIN}/d/${name}/clip.mpd`, workDir, DASH_PAIR, {
      limits: { maxFileSizeBytes: LIMIT_BYTES, downloadTimeLimitMs: cfg.limitMs },
      runner: seamRunner(children, () => workDir, []),
      probeRuntime: pinnedProbe,
      validateUrl: loopback,
      activity: tracker.record,
      sizePollMs: 25,
    });
    const video = compare(readFileSync(res.video.filePath), cfg.set.video);
    const audio = compare(readFileSync(res.audio.filePath), cfg.set.audio);
    rec.outcome = { ok: true };
    rec.artifact = { byteExact: video.byteExact && audio.byteExact, video, audio };
  } catch (err) {
    rec.outcome = describeError(err);
    rec.artifact = null;
  }
  const endedAt = at(sc);
  return finish(sc, rec, workDir, endedAt, null, null, signalsBefore);
}

// ── the frozen acceptance, and the judge's clauses ─────────────────────────────

type Required = "exact" | "failClosed" | "exactOrFailClosed";
const STOP_SCENARIOS: Record<string, "trigger" | "limit"> = { k01: "trigger", k02b: "limit", w03: "trigger", w04: "trigger" };
const PUBLIC_CODES = new Set(Object.keys(ERROR_MESSAGES));

function generalBound(rec: Rec): number | null {
  if (rec.media === "dash") return null;
  const retries = POLICY[rec.policy].retries;
  const c = rec.chunk;
  const full = c ? Math.ceil(MEDIA[rec.media].length / Math.floor(0.95 * c)) : 0;
  return full + 2 * (retries + 1);
}
function isExact(rec: Rec): boolean {
  const a = rec.artifact;
  if (!a) return false;
  const one = (x: Compared): boolean => x.byteExact && x.sha256 === x.expectedSha256 && x.bytes === x.expectedBytes && x.firstDifferingOffset === null;
  return "video" in a ? one(a.video) && one(a.audio) : one(a as Compared);
}
function observedClass(rec: Rec): "exact" | "corrupt" | "loop" | "failClosed" {
  if (rec.outcome.ok) return isExact(rec) ? "exact" : "corrupt";
  const bound = generalBound(rec);
  return (bound !== null && rec.requests.mediaRequests > bound) || rec.fixtureSafety.hit ? "loop" : "failClosed";
}

type Clause = { id: string; holds: (rec: Rec) => boolean; detail: (rec: Rec) => string };
function clausesFor(name: string, required: Required, dash: boolean): Clause[] {
  const allowed = { exact: ["exact"], failClosed: ["failClosed"], exactOrFailClosed: ["exact", "failClosed"] }[required];
  const out: Clause[] = [
    { id: "outcome", holds: (r) => allowed.includes(observedClass(r)), detail: (r) => `required ${required}, observed ${observedClass(r)} (${JSON.stringify(r.outcome)})` },
    { id: "byteExact", holds: (r) => !r.outcome.ok || isExact(r), detail: (r) => `artifact ${JSON.stringify(r.artifact)}` },
    { id: "requestBound", holds: (r) => { const b = generalBound(r); return b === null || r.requests.mediaRequests <= b; }, detail: (r) => `${r.requests.mediaRequests} media requests, general bound ${generalBound(r)}` },
    { id: "fixtureCeiling", holds: (r) => !r.fixtureSafety.hit, detail: (r) => `hit ${r.fixtureSafety.hit} (${r.fixtureSafety.reason})` },
    { id: "noLateRequests", holds: (r) => r.requests.requestsLaterThan50msAfterEnd === 0 && r.requests.refusedByFixtureLaterThan50msAfterEnd === 0, detail: (r) => `${r.requests.requestsLaterThan50msAfterEnd} answered, ${r.requests.refusedByFixtureLaterThan50msAfterEnd} refused` },
    { id: "noOpenConnections", holds: (r) => r.openFixtureConnectionsAfterSettle === 0, detail: (r) => String(r.openFixtureConnectionsAfterSettle) },
    { id: "noSurvivor", holds: (r) => r.processes.afterSettle.length === 0, detail: (r) => r.processes.afterSettle.join("; ") },
    { id: "loopbackOnly", holds: (r) => r.requests.remoteAddresses.every((a) => a === "127.0.0.1" || a === "::ffff:127.0.0.1"), detail: (r) => r.requests.remoteAddresses.join(",") },
    { id: "publicError", holds: (r) => {
      const o = r.outcome;
      if (o.ok) return true;
      if (o.exitedByItself !== undefined && o.code === undefined) return o.exitedByItself === true && typeof o.exit === "number" && o.exit !== 0;
      return o.code !== undefined && PUBLIC_CODES.has(o.code) && o.messageIsARepositoryConstant === true;
    }, detail: (r) => JSON.stringify(r.outcome) },
  ];
  if (!dash) {
    out.push({ id: "jobDir", holds: (r) => {
      const names = r.jobDirAfter.map((e) => e.name);
      if (r.outcome.ok) return names.length === 1 && names[0] === "source.mp4";
      return r.jobDirAfter.every((e) => e.name === "source.mp4.part" && e.isPrefixOfExpected === true);
    }, detail: (r) => JSON.stringify(r.jobDirAfter) });
  }
  out.push({ id: "policyArgv", holds: (r) => {
    const child = r.children.at(-1);
    if (!child) return false;
    const p = POLICY[r.policy];
    const need = [`--retries=${p.retries}`, `--socket-timeout=${p.socket}`, `--fragment-retries=${p.fragment}`, `--extractor-retries=${p.extractor}`, "--downloader=native", NO_FFMPEG];
    const chunkArgs = child.argv.filter((a) => a.startsWith("--http-chunk-size"));
    return need.every((n) => child.argv.filter((a) => a === n).length === 1) && JSON.stringify(chunkArgs) === JSON.stringify(r.testOnlyArguments);
  }, detail: (r) => JSON.stringify(r.children.at(-1)?.argv ?? null) });
  out.push({ id: "noOtherExecutable", holds: (r) => (r.processes.duringRun ?? []).every((p) => /^python/i.test(p.split(" ")[1] ?? "")),
    detail: (r) => (r.processes.duringRun === null ? "no process captured during the run" : r.processes.duringRun.join("; ")) });
  if (STOP_SCENARIOS[name]) {
    out.push({ id: "stopPrompt", holds: (r) => {
      const stopAt = STOP_SCENARIOS[name] === "limit" ? r.limitMs : r.trigger?.at;
      if (stopAt === undefined || r.requests.lastMediaAt === null) return false;
      return r.requests.lastMediaAt <= stopAt + STOP_LAST_REQUEST_MS && r.endedAt <= stopAt + STOP_RETURN_MS && r.groupSignals >= 1;
    }, detail: (r) => `stop ${STOP_SCENARIOS[name] === "limit" ? r.limitMs : r.trigger?.at} ms; last media request ${r.requests.lastMediaAt} ms; returned ${r.endedAt} ms; group signals ${r.groupSignals}` });
  }
  return out;
}

// ── the scenarios (the laboratory's 60 judged ones, with their frozen outcomes) ──

type Spec = { name: string; required: Required; dash?: boolean; run: () => Promise<Rec> };
const C64 = 65536;
function specs(): Spec[] {
  const S = origin(MEDIA.S);
  const L = origin(MEDIA.L);
  const A = S.LATER;
  const BIG = dashSet(300, 300);
  const seam = (name: string, required: Required, cfg: SeamCfg): Spec => ({ name, required, run: () => seamScenario(name, cfg) });
  return [
    // E: the two reported defects, with the reported fixture (640 KiB, a 1,024-byte chunk size)
    seam("e1a", "failClosed", { handler: S.afterFirst(A.emptyBody), chunk: 1024, limitMs: 4_000 }),
    seam("e2a", "exact", { handler: S.afterFirst(A.wholeBody200), chunk: 1024, limitMs: 8_000 }),
    // L: request-loop cases
    seam("l01", "failClosed", { handler: S.firstEmpty, chunk: C64, limitMs: 8_000 }),
    seam("l02", "failClosed", { handler: S.afterFirst(A.emptyBody), chunk: C64, limitMs: 4_000 }),
    seam("l03", "failClosed", { handler: S.afterFirst(A.oneByte), chunk: C64, limitMs: 4_000 }),
    seam("l03b", "failClosed", { handler: S.afterFirst(A.oneByteRange), chunk: C64, limitMs: 4_000 }),
    seam("l04", "failClosed", { handler: S.afterFirst(A.declaredThenCut(10, "end")), chunk: C64, limitMs: 4_000 }),
    seam("l05", "failClosed", { handler: S.afterFirst(A.frozenRange), chunk: C64, limitMs: 4_000 }),
    seam("l06", "failClosed", { handler: S.afterFirst(A.emptyUndeclared), chunk: C64, limitMs: 4_000 }),
    seam("l07a", "exact", { handler: S.always200, chunk: C64, limitMs: 8_000 }),
    seam("l07c", "failClosed", { handler: S.always200Truncated, chunk: C64, limitMs: 4_000, maxFileSizeBytes: 32 * 1024 * 1024 }),
    seam("l08", "failClosed", { handler: S.afterFirst(A.declaredThenCut(10, "reset")), chunk: C64, limitMs: 8_000 }),
    seam("l09", "failClosed", { handler: S.afterFirst(A.status503), chunk: C64, limitMs: 8_000 }),
    seam("l09w", "failClosed", { handler: S.afterFirst(A.oneByte), chunk: C64, limitMs: 6_000, watched: true }),
    seam("l12", "failClosed", { handler: S.creepingTotal, chunk: C64, limitMs: 4_000 }),
    // K: a stop during a rapid, healthy request sequence (16 MiB in 1,024-byte pieces)
    seam("k01", "failClosed", { media: "L", handler: L.conforming, chunk: 1024, limitMs: 20_000, trigger: "cancel", scanAfterRequests: 300 }),
    seam("k02b", "failClosed", { media: "L", handler: L.conforming, chunk: 1024, limitMs: 4_500, scanAfterRequests: 300 }),
    // I: integrity cases
    seam("i01", "exact", { handler: S.conforming, limitMs: 8_000 }),
    seam("i02", "exact", { handler: S.conforming, chunk: C64, limitMs: 8_000 }),
    seam("i03", "exact", { handler: S.afterFirst(A.wholeBody200), chunk: C64, limitMs: 8_000 }),
    seam("i04", "failClosed", { handler: S.afterFirst(A.overlap(100)), chunk: C64, limitMs: 8_000 }),
    seam("i05", "failClosed", { handler: S.afterFirst(A.shortenedRange(100)), chunk: C64, limitMs: 8_000 }),
    seam("i06a", "exactOrFailClosed", { handler: S.afterFirst(A.lengthTooSmall(50)), chunk: C64, limitMs: 8_000 }),
    seam("i06b", "exactOrFailClosed", { handler: S.afterFirst(A.lengthTooLarge(50)), chunk: C64, limitMs: 8_000 }),
    seam("i07a", "exact", { handler: S.afterFirst(S.once(A.wrongTotal(1000))), chunk: C64, limitMs: 8_000 }),
    seam("i07b", "exactOrFailClosed", { handler: S.afterFirst(A.wrongTotal(1000)), chunk: C64, limitMs: 8_000 }),
    seam("i08a", "exact", { handler: S.halfThen(S.exactPiece), limitMs: 8_000 }),
    seam("i08b", "exact", { handler: S.afterFirst(S.once(A.declaredThenCut(10, "end"))), chunk: C64, limitMs: 8_000 }),
    { name: "i08c", required: "exact", run: () => directScenario("i08c", { handler: S.conforming, preseedBytes: 300_000, limitMs: 8_000 }) },
    seam("i09a", "exact", { handler: S.halfThen(A.wholeBody200), limitMs: 8_000 }),
    { name: "i09b", required: "exact", run: () => directScenario("i09b", { handler: S.always200, preseedBytes: 300_000, limitMs: 8_000 }) },
    seam("i09c", "exact", { handler: S.afterFirst((req, res, p, state) => (state.used ? A.wholeBody200(req, res, p, state) : S.once(A.declaredThenCut(10, "end"))(req, res, p, state))), chunk: C64, limitMs: 8_000 }),
    seam("i10b", "exact", { handler: S.afterFirst(S.once(A.declaredThenCut(10, "reset"))), chunk: C64, limitMs: 8_000 }),
    seam("i10c", "exact", { handler: S.halfThen(S.exactPiece, "reset", 10, true), limitMs: 30_000 }),
    seam("i11", "exact", { media: "L", handler: L.conforming, chunk: 32768, limitMs: 60_000 }),
    seam("i11w", "exact", { media: "L", handler: L.conforming, chunk: 32768, limitMs: 60_000, watched: true }),
    seam("i12a", "exact", { handler: S.conformingUndeclared, limitMs: 8_000 }),
    seam("i12b", "exact", { handler: S.conformingUndeclared, chunk: C64, limitMs: 8_000 }),
    seam("i13", "exactOrFailClosed", { handler: S.afterFirst(A.always416), chunk: C64, limitMs: 8_000 }),
    seam("i13c", "exactOrFailClosed", { handler: S.halfThen(A.always416, "end", S.TOTAL - 60, true), limitMs: 8_000 }),
    seam("i13r", "exact", { handler: S.afterFirst(A.once416ThenWhole), chunk: C64, limitMs: 8_000 }),
    seam("i13cr", "exact", { handler: S.halfThen(A.once416ThenWhole, "end", S.TOTAL - 60, true), limitMs: 8_000 }),
    seam("i14", "failClosed", { handler: S.afterFirst(A.noContentRange206), chunk: C64, limitMs: 8_000 }),
    seam("i15", "exact", { handler: S.afterFirst(A.restOfFile), chunk: C64, limitMs: 8_000 }),
    seam("i16", "failClosed", { handler: S.unknownTotal, chunk: C64, limitMs: 8_000 }),
    seam("i17", "exact", { handler: S.afterFirst(A.surplus(37)), chunk: C64, limitMs: 8_000 }),
    seam("i18", "failClosed", { handler: S.halfThen(S.wrongStartToEnd(100)), limitMs: 8_000 }),
    seam("i19", "failClosed", { handler: S.halfThen(S.restNoContentRange), limitMs: 8_000 }),
    seam("i20", "failClosed", { handler: S.halfThen(A.shortenedRange(100)), limitMs: 8_000 }),
    // R: other Worker paths that must be unchanged
    seam("b01", "failClosed", { handler: S.conforming, chunk: C64, limitMs: 8_000, maxFileSizeBytes: 200_000 }),
    seam("w01", "exact", { handler: S.conforming, chunk: C64, limitMs: 8_000, watched: true }),
    seam("w03", "failClosed", { media: "L", handler: L.conforming, chunk: 1024, limitMs: 20_000, watched: true, trigger: "inactivity", scanAfterRequests: 300 }),
    seam("w04", "failClosed", { media: "L", handler: L.conforming, chunk: 1024, limitMs: 20_000, watched: true, trigger: "observation-loss", scanAfterRequests: 300 }),
    { name: "d01", required: "exact", dash: true, run: () => dashScenario("d01", { set: BIG, limitMs: 60_000 }) },
    { name: "d02", required: "exactOrFailClosed", dash: true, run: () => dashScenario("d02", { set: BIG, special: { "v-5.m4s": empty200 }, limitMs: 60_000 }) },
    // X: the extractor route (the chunk size comes from the format, as an extractor sets it)
    { name: "x1", required: "failClosed", run: () => extractorScenario("x1", { handler: S.afterFirst(A.emptyBody), extractorChunkSize: 1024 }) },
    { name: "x2", required: "exact", run: () => extractorScenario("x2", { handler: S.afterFirst(A.wholeBody200), extractorChunkSize: 1024, limitMs: 8_000 }) },
    { name: "x3", required: "exact", run: () => extractorScenario("x3", { handler: S.conforming, extractorChunkSize: C64, limitMs: 8_000 }) },
    { name: "x4", required: "failClosed", run: () => extractorScenario("x4", { handler: S.afterFirst(A.oneByte), extractorChunkSize: C64 }) },
    { name: "x5", required: "failClosed", run: () => extractorScenario("x5", { handler: S.creepingTotal, extractorChunkSize: C64 }) },
  ];
}

// Names only, so the suite tree exists before `before` builds the media.
const SCENARIO_NAMES = [
  "e1a", "e2a", "l01", "l02", "l03", "l03b", "l04", "l05", "l06", "l07a", "l07c", "l08", "l09", "l09w", "l12", "k01", "k02b",
  "i01", "i02", "i03", "i04", "i05", "i06a", "i06b", "i07a", "i07b", "i08a", "i08b", "i08c", "i09a", "i09b", "i09c", "i10b", "i10c",
  "i11", "i11w", "i12a", "i12b", "i13", "i13c", "i13r", "i13cr", "i14", "i15", "i16", "i17", "i18", "i19", "i20",
  "b01", "w01", "w03", "w04", "d01", "d02", "x1", "x2", "x3", "x4", "x5",
] as const;
const REQUIRED: Record<string, Required> = {
  e1a: "failClosed", e2a: "exact", l01: "failClosed", l02: "failClosed", l03: "failClosed", l03b: "failClosed", l04: "failClosed", l05: "failClosed",
  l06: "failClosed", l07a: "exact", l07c: "failClosed", l08: "failClosed", l09: "failClosed", l09w: "failClosed", l12: "failClosed", k01: "failClosed",
  k02b: "failClosed", i01: "exact", i02: "exact", i03: "exact", i04: "failClosed", i05: "failClosed", i06a: "exactOrFailClosed", i06b: "exactOrFailClosed",
  i07a: "exact", i07b: "exactOrFailClosed", i08a: "exact", i08b: "exact", i08c: "exact", i09a: "exact", i09b: "exact", i09c: "exact", i10b: "exact",
  i10c: "exact", i11: "exact", i11w: "exact", i12a: "exact", i12b: "exact", i13: "exactOrFailClosed", i13c: "exactOrFailClosed", i13r: "exact",
  i13cr: "exact", i14: "failClosed", i15: "exact", i16: "failClosed", i17: "exact", i18: "failClosed", i19: "failClosed", i20: "failClosed",
  b01: "failClosed", w01: "exact", w03: "failClosed", w04: "failClosed", d01: "exact", d02: "exactOrFailClosed", x1: "failClosed", x2: "exact",
  x3: "exact", x4: "failClosed", x5: "failClosed",
};

describe("pinned runtime: LD-3e chunk integrity, the ported laboratory matrix", { skip, timeout: 1_800_000 }, () => {
  const records = new Map<string, Rec>();
  let SPECS = new Map<string, Spec>();

  before(async () => {
    MEDIA = { S: fill(640 * 1024, "ld3e-media-"), L: fill(16 * 1024 * 1024, "rd002-large-") };
    assert.ok(sha(MEDIA.S).startsWith(MEDIA_SHA256.S) && sha(MEDIA.L).startsWith(MEDIA_SHA256.L), "the laboratory's exact media");
    // The artifact under test reports the patched identity (a real `--version`, as the probe would ask).
    const v = await runProcess({ command: PYTHON, args: [ARTIFACT, ...ytdlpPolicyArgs(), "--version"], timeoutMs: 30_000, env: buildYtdlpEnvironment() });
    assert.equal(v.stdout, `${YTDLP_RUNTIME.expectedVersion}\n`, "the artifact under test prints the patched identity");
    realKill = process.kill.bind(process);
    process.kill = ((pid: number, signal?: string | number) => {
      if (typeof pid === "number" && pid < 0) groupSignals.push({ at: performance.now() });
      return realKill!(pid, signal);
    }) as typeof process.kill;
    await startFixture();
    // The plan comes from the Worker's own analysis of the fixture page, through the artifact under test.
    const analysisScenario = newScenario("analysis", stateful(origin(MEDIA.S).conforming));
    const children: Child[] = [];
    const analysis = await analyzeGenericMediaInternal(`${ORIGIN}/w/analysis`, {
      limits: { analysisTimeoutSeconds: 60, maxVideoDurationSeconds: 7200, maxFileSizeBytes: LIMIT_BYTES },
      ffmpegAvailable: true,
      runner: seamRunner(children, () => null, []),
      probeRuntime: pinnedProbe,
      validateUrl: loopback,
    });
    scenarios.delete(analysisScenario.name);
    const presetIds = analysis.video.presets.map((p) => p.id);
    const derived = deriveExecutionPlan({ strategy: "yt-dlp", ...analysis }, presetIds[0]);
    assert.ok(derived.strategy === "yt-dlp" && derived.generic.operation === "keep-original", "a single progressive source");
    PLAN = (derived as { generic: GenericSingleSourceExecutionPlan }).generic;
    assert.deepEqual([PLAN.source.protocol, PLAN.source.container], ["http", "mp4"]);
    SPECS = new Map(specs().map((s) => [s.name, s]));
    assert.deepEqual([...SPECS.keys()].sort(), [...SCENARIO_NAMES].sort(), "every judged scenario is defined once");
    for (const s of SPECS.values()) assert.equal(s.required, REQUIRED[s.name], `${s.name}: the frozen acceptance outcome`);
  });

  after(async () => {
    if (realKill) process.kill = realKill;
    for (const s of [...openSockets]) s.destroy();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (RECORD && !existsSync(RECORD)) {
      writeFileSync(RECORD, JSON.stringify({
        task: "VIDEOFETCH-LD3E-PINNED-YTDLP-PATCHED-RUNTIME-SOURCE-IMPLEMENTATION-001",
        runtime: { sha256: sha(readFileSync(ARTIFACT)), identity: YTDLP_RUNTIME.expectedVersion },
        node: process.version, platform: process.platform,
        media: { S: { bytes: MEDIA.S.length, sha256: sha(MEDIA.S) }, L: { bytes: MEDIA.L.length, sha256: sha(MEDIA.L) } },
        scenarios: [...records.values()].map((r) => ({ ...r, observedClass: observedClass(r), generalBound: generalBound(r) })),
      }, null, 1));
    }
  });

  for (const name of SCENARIO_NAMES) {
    const dash = name === "d01" || name === "d02";
    describe(name, () => {
      before(async () => {
        records.set(name, await SPECS.get(name)!.run());
      }, { timeout: 180_000 });
      for (const clause of clausesFor(name, REQUIRED[name], dash)) {
        it(`${name} ${clause.id}`, () => {
          const rec = records.get(name);
          assert.ok(rec, `${name}: no record`);
          assert.ok(clause.holds(rec), `${name} ${clause.id}: ${clause.detail(rec)}`);
        });
      }
    });
  }
});
