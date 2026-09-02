/* eslint-disable no-control-regex */
import { Buffer } from "node:buffer";
import { z } from "zod";
import { WorkerKeyIdSchema } from "../../shared/worker/auth.ts";

/**
 * Strict Worker runtime configuration boundary (Phase 8A §6/§7).
 *
 * This module is the ONLY place the production Worker runtime reads its
 * deployment environment. Nothing below the runtime layer — and in particular
 * nothing in `src/worker/http/` — may reach for `process.env` itself.
 *
 * Two rules govern every error path here:
 *  1. a malformed REQUIRED production value fails closed before `listen()`;
 *  2. the rejected VALUE is never rendered. Only the variable NAME travels out,
 *     so a malformed `WORKER_CONTROL_SECRET` can never be echoed to a log.
 */

/** Bounded upper limits. None of these are security boundaries on their own. */
const MAX_HOST_LENGTH = 255;
const MAX_PATH_LENGTH = 4096;
const MAX_SECRET_BYTES = 4096;
const MIN_SECRET_BYTES = 32;

export const WORKER_DEFAULT_BIND_HOST = "0.0.0.0";
export const WORKER_DEFAULT_PORT = 8080;

/** Matches any ASCII control character. Rejected everywhere in this module. */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

/**
 * Hostnames, IPv4 literals and bracketed/bare IPv6 literals only. Whitespace,
 * control characters and shell metacharacters are structurally impossible.
 */
const HostSchema = z
  .string()
  .min(1)
  .max(MAX_HOST_LENGTH)
  .regex(/^[A-Za-z0-9._:[\]-]+$/, "must be a bare host, IPv4 or IPv6 literal");

const PortSchema = z
  .string()
  .regex(/^[0-9]{1,5}$/, "must be a decimal integer")
  .transform((raw) => Number.parseInt(raw, 10))
  .refine((n) => Number.isInteger(n) && n >= 1 && n <= 65535, "must be 1..65535");

/**
 * An absolute POSIX path that is neither empty, nor the filesystem root, nor a
 * relative/traversal expression, and that carries no control byte.
 */
const AbsoluteDirectorySchema = z
  .string()
  .min(2)
  .max(MAX_PATH_LENGTH)
  .refine((p) => p.startsWith("/"), "must be an absolute path")
  .refine((p) => !CONTROL_CHARACTERS.test(p), "must not contain control characters")
  .refine((p) => p.replace(/\/+$/, "") !== "", "must not be the filesystem root")
  .refine(
    (p) => !p.split("/").some((seg) => seg === "." || seg === ".."),
    "must not contain relative path segments",
  );

/**
 * Filesystem roots that are ephemeral by contract. Durable Worker state placed
 * here is silently lost on restart, so the production loader refuses it.
 */
const EPHEMERAL_ROOTS = ["/tmp"] as const;

/** Splits an absolute POSIX path into its non-empty components. */
function pathComponents(p: string): string[] {
  return p.split("/").filter((segment) => segment.length > 0);
}

/**
 * Component-aware containment: true when `inner` IS `outer` or lies beneath it.
 *
 * Deliberately not a string-prefix test — `/tmp2/videofetch` is not under
 * `/tmp`, and `/var/lib/videofetch2` is not under `/var/lib/video`.
 */
function isWithinPath(outer: string, inner: string): boolean {
  const outerParts = pathComponents(outer);
  const innerParts = pathComponents(inner);
  if (outerParts.length > innerParts.length) return false;
  return outerParts.every((segment, index) => segment === innerParts[index]);
}

/**
 * The durable state directory. Everything `AbsoluteDirectorySchema` requires,
 * plus the Phase-8A contract that SQLite state never lives on ephemeral
 * storage. Low-level tests may still point an INJECTED `WorkerRuntimeConfig` at
 * a temporary directory; this restriction binds the production loader only.
 */
const PersistentDirectorySchema = AbsoluteDirectorySchema.refine(
  (p) => !EPHEMERAL_ROOTS.some((root) => isWithinPath(root, p)),
  "must not be under an ephemeral filesystem root",
);

const ControlSecretSchema = z
  .string()
  .max(MAX_SECRET_BYTES)
  .refine(
    (s) => Buffer.byteLength(s, "utf8") >= MIN_SECRET_BYTES,
    `must be at least ${MIN_SECRET_BYTES} UTF-8 bytes`,
  );

/*
 * There is deliberately NO credential schema in this module.
 *
 * The media Worker reads exactly one HMAC control secret (shared with the
 * control plane, above) and no object-store credential of any kind. The R2
 * parent credential is read only by the trusted broker, in
 * `src/broker/r2/config.ts`, in a process outside this container.
 */

/**
 * Reused verbatim from the authoritative Phase-4 R2 writer so the runtime
 * cannot drift from the semantics the writer itself enforces.
 */
const R2AccountIdSchema = z
  .string()
  .regex(/^[a-f0-9]{32}$/, "must be 32 lowercase hex characters");
const R2BucketSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, "must be a valid bucket name");
const R2JurisdictionSchema = z.enum(["default", "eu", "us"]);

/**
 * The trusted broker's Unix socket. An absolute path with no relative segment
 * and no control byte — the same discipline as every other path this module
 * accepts. It is a rendezvous point, never a secret.
 */
const BrokerSocketPathSchema = z
  .string()
  .min(2)
  .max(MAX_PATH_LENGTH)
  .refine((p) => p.startsWith("/"), "must be an absolute path")
  .refine((p) => !CONTROL_CHARACTERS.test(p), "must not contain control characters")
  .refine(
    (p) => !p.split("/").some((seg) => seg === "." || seg === ".."),
    "must not contain relative path segments",
  );

/**
 * Variables whose mere PRESENCE is a startup failure
 * (WORKER-R2-TEMP-CREDENTIAL-DELEGATION-001).
 *
 * Two families are forbidden in the media container:
 *
 *  - `R2_WRITER_*` — the superseded persistent writer contract. Supplying it
 *    would put a long-lived R2 credential inside the media namespace, which is
 *    exactly what this design removes. It is rejected rather than ignored so a
 *    stale deployment cannot quietly keep shipping the old secret.
 *  - `R2_BROKER_PARENT_*` — the parent credential. It belongs to the trusted
 *    host broker alone and must never be readable from this container.
 *
 * This check is unconditional. It does not consult `NODE_ENV`, so there is no
 * deployment mode — Production or otherwise — in which a static R2 credential
 * can be supplied to the Worker, and therefore no static-credential fallback
 * that could silently activate.
 */
export const WORKER_FORBIDDEN_R2_VARIABLES = Object.freeze([
  "R2_WRITER_ACCESS_KEY_ID",
  "R2_WRITER_SECRET_ACCESS_KEY",
  "R2_WRITER_SESSION_TOKEN",
  "R2_BROKER_PARENT_ACCESS_KEY_ID",
  "R2_BROKER_PARENT_SECRET_ACCESS_KEY",
] as const);

function boundedInt(min: number, max: number) {
  return z
    .string()
    .regex(/^[0-9]{1,17}$/, "must be a nonnegative decimal integer")
    .transform((raw) => Number.parseInt(raw, 10))
    .refine(
      (n) => Number.isSafeInteger(n) && n >= min && n <= max,
      `must be an integer between ${min} and ${max}`,
    );
}

const ExecutablePathSchema = z
  .string()
  .min(1)
  .max(MAX_PATH_LENGTH)
  .refine((s) => !CONTROL_CHARACTERS.test(s), "must not contain control characters");

/** Media-execution bounds this runtime owns. Absent means "use the default". */
const MEDIA_DEFAULTS = {
  maxFileSizeBytes: 500 * 1024 * 1024,
  maxVideoDurationSeconds: 2 * 60 * 60,
  fileExpirationMinutes: 45,
  downloadTimeoutSeconds: 600,
  analysisTimeoutSeconds: 45,
  maxRedirects: 5,
} as const;

export type WorkerRuntimeConfig = {
  readonly bindHost: string;
  readonly port: number;
  readonly dataDirectory: string;
  readonly control: {
    readonly currentKeyId: string;
    readonly currentSecret: string;
    readonly previousKeyId?: string;
    readonly previousSecret?: string;
  };
  readonly r2: {
    readonly accountId: string;
    readonly bucket: string;
    readonly jurisdiction: "default" | "eu" | "us";
    /**
     * Path to the trusted broker's Unix socket, bind-mounted into this
     * container. This is a LOCATION, not a credential.
     *
     * There is deliberately no `accessKeyId`/`secretAccessKey`/`sessionToken`
     * on this type. The media Worker holds no persistent R2 credential, and
     * the runtime configuration cannot express one — see
     * `WORKER_FORBIDDEN_R2_VARIABLES`.
     */
    readonly brokerSocketPath: string;
  };
  readonly media: {
    readonly maxFileSizeBytes: number;
    readonly maxVideoDurationSeconds: number;
    readonly fileExpirationMinutes: number;
    readonly downloadTimeoutSeconds: number;
    readonly analysisTimeoutSeconds: number;
    readonly maxRedirects: number;
    readonly tempDirectory: string | null;
    readonly ffmpegPath: string | null;
    /**
     * Generic yt-dlp APPLICATION feature state.
     *
     * This is not "is the runtime installed" — that is probed separately and
     * reported separately. It is the operator's explicit intent to allow
     * generic extraction, and it is fail-closed: absent means disabled.
     *
     * As of Phase 10C1 this flag gates nothing yet, because no user-URL yt-dlp
     * execution path exists in the Worker at all. It is the foundation the
     * later, separately authorized integration phase will gate on.
     */
    readonly ytdlp: {
      readonly enabled: boolean;
    };
  };
};

/**
 * Startup-fatal configuration failure. Carries ONLY the offending variable
 * names — never a value, never a Zod message that could embed one.
 */
export class WorkerRuntimeConfigError extends Error {
  readonly variables: readonly string[];

  constructor(variables: readonly string[]) {
    const listed = [...new Set(variables)].sort();
    super(
      listed.length > 0
        ? `Invalid Worker runtime configuration: ${listed.join(", ")}`
        : "Invalid Worker runtime configuration",
    );
    this.name = "WorkerRuntimeConfigError";
    this.variables = Object.freeze(listed);
  }
}

/**
 * Retired yt-dlp variables (PHASE-10C1-YTDLP-RUNTIME-FOUNDATION-001).
 *
 * Both are refused by PRESENCE, not by value, and the refusal is unconditional:
 *
 *  - `YTDLP_NETWORK_ISOLATED` was a Phase-8/9 operator ASSERTION that yt-dlp
 *    ran behind an isolated network. It was never the boundary. The real
 *    boundary is the externally owned media network namespace, its nftables
 *    policy, the policy verifier and the watchdog — none of which this
 *    container can read, weaken or mutate. Keeping a boolean that *looks* like
 *    a security control invites exactly the mistake of trusting it, so the
 *    contract is retired outright rather than repurposed. `false` is refused
 *    alongside `true`: a deployment still setting it is a stale deployment,
 *    and it should fail closed and loudly rather than appear correct.
 *
 *  - `YTDLP_PATH` let a single environment variable choose the yt-dlp
 *    executable AND prepend arbitrary leading arguments to every invocation
 *    (it was split on spaces). No repository path lets user input reach it, so
 *    this is not a user-input vulnerability — it is an unnecessarily loose
 *    operator execution surface, and the Production Worker has no need of it
 *    at all. The runtime identity is a reviewed constant in
 *    `ytdlp-runtime.server.ts`, not deployment configuration.
 *
 * Enabling generic yt-dlp execution is now a separate, explicit concern:
 * `YTDLP_ENABLED`. Installing the runtime does not enable it.
 */
export const WORKER_FORBIDDEN_YTDLP_VARIABLES = Object.freeze([
  "YTDLP_NETWORK_ISOLATED",
  "YTDLP_PATH",
] as const);

/**
 * Strict boolean grammar for `YTDLP_ENABLED`.
 *
 * Deliberately NOT the retired `1`/`true`/`yes` truthiness rule: a feature
 * switch that decides whether a media extractor may run at all should have
 * exactly two spellings and reject everything else, so a typo becomes a
 * startup failure rather than a silent state. Surrounding whitespace is
 * tolerated because environment files routinely introduce it; case is not,
 * because `True` and `TRUE` are guesses about the grammar rather than uses of
 * it. Every rejection fails closed: the Worker does not start.
 */
const YtdlpEnabledSchema = z
  .string()
  .transform((raw) => raw.trim())
  .refine((v) => v === "true" || v === "false", 'must be exactly "true" or "false"')
  .transform((v) => v === "true");

/** Treats an unset variable and an empty/whitespace string identically. */
function optional(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

type FieldResult<T> = { ok: true; value: T } | { ok: false };

/**
 * Runs one schema against one variable, recording only the NAME on failure.
 * The parsed input never escapes this function on the error path.
 */
function readField<S extends z.ZodTypeAny>(
  name: string,
  raw: string | undefined,
  schema: S,
  invalid: string[],
): FieldResult<z.output<S>> {
  if (raw === undefined) {
    invalid.push(name);
    return { ok: false };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    invalid.push(name);
    return { ok: false };
  }
  return { ok: true, value: parsed.data };
}

function readOptionalField<S extends z.ZodTypeAny, F>(
  name: string,
  raw: string | undefined,
  schema: S,
  invalid: string[],
  fallback: F,
): z.output<S> | F {
  const present = optional(raw);
  if (present === undefined) return fallback;
  const parsed = schema.safeParse(present);
  if (!parsed.success) {
    invalid.push(name);
    return fallback;
  }
  return parsed.data;
}

/**
 * Loads and strictly validates the production Worker runtime configuration.
 *
 * Throws `WorkerRuntimeConfigError`, naming only the offending variables. It
 * is startup-fatal by design: the caller must never reach `listen()` after it.
 * A retired yt-dlp variable (`WORKER_FORBIDDEN_YTDLP_VARIABLES`) is reported
 * through the same error, so a stale deployment is named precisely without a
 * dedicated error class.
 *
 * The Vercel-only signer identity (`R2_SIGNER_ACCESS_KEY_ID` /
 * `R2_SIGNER_SECRET_ACCESS_KEY`) is deliberately NOT read here. Signing stays
 * on the control plane.
 *
 * Neither is any R2 WRITE credential read here any more
 * (WORKER-R2-TEMP-CREDENTIAL-DELEGATION-001). The Worker receives a broker
 * socket path and obtains a short-lived, action-scoped, single-object
 * credential per operation. Supplying the superseded `R2_WRITER_*` contract, or
 * the broker's own `R2_BROKER_PARENT_*` credential, is a startup failure rather
 * than a fallback — see `WORKER_FORBIDDEN_R2_VARIABLES`.
 */
export function loadWorkerRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): WorkerRuntimeConfig {
  const invalid: string[] = [];

  // Retired yt-dlp contracts are refused by PRESENCE, before anything else, so
  // a stale deployment is reported as itself rather than masked by an
  // unrelated configuration error. Unlike the R2 family below, an empty value
  // still counts: the objection is to the variable existing at all, not to the
  // material it carries.
  for (const name of WORKER_FORBIDDEN_YTDLP_VARIABLES) {
    if (env[name] !== undefined) invalid.push(name);
  }

  const bindHost = readOptionalField(
    "WORKER_BIND_HOST",
    env.WORKER_BIND_HOST,
    HostSchema,
    invalid,
    WORKER_DEFAULT_BIND_HOST,
  );
  const port = readOptionalField(
    "WORKER_PORT",
    env.WORKER_PORT,
    PortSchema,
    invalid,
    WORKER_DEFAULT_PORT,
  );

  const dataDirectory = readField(
    "WORKER_DATA_DIRECTORY",
    optional(env.WORKER_DATA_DIRECTORY),
    PersistentDirectorySchema,
    invalid,
  );

  const currentKeyId = readField(
    "WORKER_CONTROL_KEY_ID",
    optional(env.WORKER_CONTROL_KEY_ID),
    WorkerKeyIdSchema,
    invalid,
  );
  // Secrets are NOT trimmed: surrounding bytes are part of the key material.
  const currentSecret = readField(
    "WORKER_CONTROL_SECRET",
    env.WORKER_CONTROL_SECRET,
    ControlSecretSchema,
    invalid,
  );

  // Rotation pair: both present or both absent, and distinct from the current
  // key id. A half-configured rotation is a hard startup failure, never a
  // silently ignored one.
  const previousKeyIdRaw = optional(env.WORKER_CONTROL_PREVIOUS_KEY_ID);
  const previousSecretRaw = env.WORKER_CONTROL_PREVIOUS_SECRET;
  const hasPreviousSecret = previousSecretRaw !== undefined && previousSecretRaw.length > 0;

  let previousKeyId: string | undefined;
  let previousSecret: string | undefined;

  if (previousKeyIdRaw !== undefined || hasPreviousSecret) {
    if (previousKeyIdRaw === undefined) {
      invalid.push("WORKER_CONTROL_PREVIOUS_KEY_ID");
    }
    if (!hasPreviousSecret) {
      invalid.push("WORKER_CONTROL_PREVIOUS_SECRET");
    }
    if (previousKeyIdRaw !== undefined) {
      const parsedKey = WorkerKeyIdSchema.safeParse(previousKeyIdRaw);
      if (!parsedKey.success) {
        invalid.push("WORKER_CONTROL_PREVIOUS_KEY_ID");
      } else if (currentKeyId.ok && parsedKey.data === currentKeyId.value) {
        // Rotation requires two DISTINCT identities; reusing the current key id
        // would make the rotation slot meaningless.
        invalid.push("WORKER_CONTROL_PREVIOUS_KEY_ID");
      } else {
        previousKeyId = parsedKey.data;
      }
    }
    if (hasPreviousSecret) {
      const parsedSecret = ControlSecretSchema.safeParse(previousSecretRaw);
      if (!parsedSecret.success) {
        invalid.push("WORKER_CONTROL_PREVIOUS_SECRET");
      } else {
        previousSecret = parsedSecret.data;
      }
    }
  }

  const accountId = readField(
    "R2_ACCOUNT_ID",
    optional(env.R2_ACCOUNT_ID),
    R2AccountIdSchema,
    invalid,
  );
  const bucket = readField("R2_BUCKET", optional(env.R2_BUCKET), R2BucketSchema, invalid);
  const jurisdiction = readOptionalField(
    "R2_JURISDICTION",
    env.R2_JURISDICTION,
    R2JurisdictionSchema,
    invalid,
    "default" as "default" | "eu" | "us",
  );

  // The Worker addresses R2 exclusively through the trusted broker. This is the
  // ONLY R2 access parameter it reads, and it is a socket path, not a secret.
  const brokerSocketPath = readField(
    "R2_BROKER_SOCKET_PATH",
    optional(env.R2_BROKER_SOCKET_PATH),
    BrokerSocketPathSchema,
    invalid,
  );

  // Fail closed on a superseded or parent credential being present at all.
  // Checked untrimmed: any non-empty value means real material is sitting in
  // the media container's environment, which is the condition being forbidden.
  for (const name of WORKER_FORBIDDEN_R2_VARIABLES) {
    const raw = env[name];
    if (raw !== undefined && raw.length > 0) invalid.push(name);
  }

  const media = {
    maxFileSizeBytes: readOptionalField(
      "MAX_FILE_SIZE",
      env.MAX_FILE_SIZE,
      boundedInt(1, Number.MAX_SAFE_INTEGER),
      invalid,
      MEDIA_DEFAULTS.maxFileSizeBytes,
    ),
    maxVideoDurationSeconds: readOptionalField(
      "MAX_VIDEO_DURATION",
      env.MAX_VIDEO_DURATION,
      boundedInt(1, 604800),
      invalid,
      MEDIA_DEFAULTS.maxVideoDurationSeconds,
    ),
    fileExpirationMinutes: readOptionalField(
      "FILE_EXPIRATION_MINUTES",
      env.FILE_EXPIRATION_MINUTES,
      boundedInt(1, 1440),
      invalid,
      MEDIA_DEFAULTS.fileExpirationMinutes,
    ),
    downloadTimeoutSeconds: readOptionalField(
      "DOWNLOAD_TIMEOUT",
      env.DOWNLOAD_TIMEOUT,
      boundedInt(1, 86400),
      invalid,
      MEDIA_DEFAULTS.downloadTimeoutSeconds,
    ),
    analysisTimeoutSeconds: readOptionalField(
      "ANALYSIS_TIMEOUT",
      env.ANALYSIS_TIMEOUT,
      boundedInt(1, 3600),
      invalid,
      MEDIA_DEFAULTS.analysisTimeoutSeconds,
    ),
    maxRedirects: readOptionalField(
      "MAX_REDIRECTS",
      env.MAX_REDIRECTS,
      boundedInt(0, 20),
      invalid,
      MEDIA_DEFAULTS.maxRedirects,
    ),
    tempDirectory: readOptionalField(
      "TEMP_DIRECTORY",
      env.TEMP_DIRECTORY,
      AbsoluteDirectorySchema,
      invalid,
      null as string | null,
    ),
    ffmpegPath: readOptionalField(
      "FFMPEG_PATH",
      env.FFMPEG_PATH,
      ExecutablePathSchema,
      invalid,
      null as string | null,
    ),
    // Absent => disabled. A malformed value is a startup failure, never a
    // silent fallback to either state.
    ytdlp: Object.freeze({
      enabled: readOptionalField(
        "YTDLP_ENABLED",
        env.YTDLP_ENABLED,
        YtdlpEnabledSchema,
        invalid,
        false,
      ),
    }),
  };

  // Cross-field: the durable state volume and the ephemeral media scratch are
  // two distinct filesystem roles and must not overlap. An overlap would put
  // media on the SQLite volume (or durable state on ephemeral storage), which
  // no amount of correct per-field validation would catch.
  //
  // Only checked when TEMP_DIRECTORY was explicitly supplied; the deployment
  // still owns the actual mount topology, but an obviously contradictory
  // configuration fails closed here rather than at the first durable write.
  if (dataDirectory.ok && media.tempDirectory !== null) {
    const overlaps =
      isWithinPath(dataDirectory.value, media.tempDirectory) ||
      isWithinPath(media.tempDirectory, dataDirectory.value);
    if (overlaps) {
      invalid.push("WORKER_DATA_DIRECTORY");
      invalid.push("TEMP_DIRECTORY");
    }
  }

  if (
    invalid.length > 0 ||
    !dataDirectory.ok ||
    !currentKeyId.ok ||
    !currentSecret.ok ||
    !accountId.ok ||
    !bucket.ok ||
    !brokerSocketPath.ok
  ) {
    throw new WorkerRuntimeConfigError(invalid);
  }

  return Object.freeze({
    bindHost,
    port,
    dataDirectory: dataDirectory.value,
    control: Object.freeze({
      currentKeyId: currentKeyId.value,
      currentSecret: currentSecret.value,
      ...(previousKeyId !== undefined && previousSecret !== undefined
        ? { previousKeyId, previousSecret }
        : {}),
    }),
    r2: Object.freeze({
      accountId: accountId.value,
      bucket: bucket.value,
      jurisdiction,
      brokerSocketPath: brokerSocketPath.value,
    }),
    media: Object.freeze(media),
  });
}
