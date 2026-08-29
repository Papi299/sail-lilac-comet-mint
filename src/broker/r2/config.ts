/* eslint-disable no-control-regex */
import { z } from "zod";
import type { R2BrokerConfig } from "./broker-service.ts";

/**
 * Trusted-broker configuration boundary.
 *
 * This is the ONLY place the persistent R2 parent credential is read, and the
 * process that runs it lives outside the media network namespace. The media
 * Worker has no equivalent loader, by design: `src/worker/runtime/config.server.ts`
 * cannot express a parent R2 credential at all.
 *
 * Error handling follows the Worker runtime's rule exactly — a failure names
 * the offending VARIABLE and never renders its value, so a malformed parent
 * secret cannot be echoed into a systemd journal.
 */

/** Matches any ASCII control character. Rejected everywhere in this module. */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const MAX_CREDENTIAL_LENGTH = 8192;
const MAX_PATH_LENGTH = 4096;

const AccountIdSchema = z
  .string()
  .regex(/^[a-f0-9]{32}$/, "must be 32 lowercase hex characters");

const BucketSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, "must be a valid bucket name");

const JurisdictionSchema = z.enum(["default", "eu", "us"]);

const CredentialSchema = z
  .string()
  .min(1)
  .max(MAX_CREDENTIAL_LENGTH)
  .refine((s) => !CONTROL_CHARACTERS.test(s), "must not contain control characters");

/**
 * The socket must be an absolute path with no relative segment. It is created
 * by the broker and bind-mounted into the Worker container; a traversal
 * expression here would place the boundary somewhere the deployment did not
 * intend.
 */
const SocketPathSchema = z
  .string()
  .min(2)
  .max(MAX_PATH_LENGTH)
  .refine((p) => p.startsWith("/"), "must be an absolute path")
  .refine((p) => !CONTROL_CHARACTERS.test(p), "must not contain control characters")
  .refine(
    (p) => !p.split("/").some((seg) => seg === "." || seg === ".."),
    "must not contain relative path segments",
  );

export type R2BrokerRuntimeConfig = {
  readonly socketPath: string;
  readonly broker: R2BrokerConfig;
};

export class R2BrokerConfigError extends Error {
  readonly variables: readonly string[];

  constructor(variables: readonly string[]) {
    const listed = [...new Set(variables)].sort();
    super(
      listed.length > 0
        ? `Invalid R2 broker configuration: ${listed.join(", ")}`
        : "Invalid R2 broker configuration",
    );
    this.name = "R2BrokerConfigError";
    this.variables = Object.freeze(listed);
  }
}

function optional(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function read<S extends z.ZodTypeAny>(
  name: string,
  raw: string | undefined,
  schema: S,
  invalid: string[],
): z.output<S> | undefined {
  if (raw === undefined) {
    invalid.push(name);
    return undefined;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    invalid.push(name);
    return undefined;
  }
  return parsed.data;
}

/**
 * Loads and strictly validates the broker's configuration.
 *
 * Throws `R2BrokerConfigError` naming only the offending variables. The caller
 * must not listen after a throw — a broker that cannot authenticate to R2 must
 * be ABSENT rather than present-and-failing, so that the Worker's dependency on
 * it fails closed at the systemd level.
 */
export function loadR2BrokerConfig(
  env: NodeJS.ProcessEnv = process.env,
): R2BrokerRuntimeConfig {
  const invalid: string[] = [];

  const socketPath = read(
    "R2_BROKER_SOCKET_PATH",
    optional(env.R2_BROKER_SOCKET_PATH),
    SocketPathSchema,
    invalid,
  );
  const accountId = read("R2_ACCOUNT_ID", optional(env.R2_ACCOUNT_ID), AccountIdSchema, invalid);
  const bucket = read("R2_BUCKET", optional(env.R2_BUCKET), BucketSchema, invalid);

  const jurisdictionRaw = optional(env.R2_JURISDICTION);
  let jurisdiction: "default" | "eu" | "us" = "default";
  if (jurisdictionRaw !== undefined) {
    const parsed = JurisdictionSchema.safeParse(jurisdictionRaw);
    if (!parsed.success) invalid.push("R2_JURISDICTION");
    else jurisdiction = parsed.data;
  }

  const parentAccessKeyId = read(
    "R2_BROKER_PARENT_ACCESS_KEY_ID",
    optional(env.R2_BROKER_PARENT_ACCESS_KEY_ID),
    CredentialSchema,
    invalid,
  );
  // NOT trimmed: surrounding bytes are part of the key material.
  const parentSecretAccessKey = read(
    "R2_BROKER_PARENT_SECRET_ACCESS_KEY",
    env.R2_BROKER_PARENT_SECRET_ACCESS_KEY,
    CredentialSchema,
    invalid,
  );

  if (
    invalid.length > 0 ||
    socketPath === undefined ||
    accountId === undefined ||
    bucket === undefined ||
    parentAccessKeyId === undefined ||
    parentSecretAccessKey === undefined
  ) {
    throw new R2BrokerConfigError(invalid);
  }

  return Object.freeze({
    socketPath,
    broker: Object.freeze({
      accountId,
      bucket,
      jurisdiction,
      parentAccessKeyId,
      parentSecretAccessKey,
    }),
  });
}
