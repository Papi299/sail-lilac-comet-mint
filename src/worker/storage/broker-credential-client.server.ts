import { request as httpRequest } from "node:http";
import { Buffer } from "node:buffer";
import {
  R2CredentialResponseSchema,
  R2_BROKER_MINT_PATH,
  type R2CredentialRequest,
} from "../../shared/worker/r2-broker.ts";
import type {
  R2CredentialProvider,
  R2CredentialRequestInput,
  R2TemporaryCredential,
} from "./credential-provider.ts";

/**
 * The media Worker's client for the trusted host broker.
 *
 * Transport is an AF_UNIX socket, never a port. That choice is load-bearing:
 * credential acquisition creates NO network egress, so it neither depends on
 * nor can be used to widen the externally-owned safe-egress policy that
 * contains this container. The Worker still holds no NET_ADMIN, no SYS_ADMIN,
 * no Docker socket and no host networking.
 *
 * The client trusts the broker for authorization but verifies its ANSWER: a
 * response whose echoed action, bucket or object key does not match what was
 * requested is discarded. That keeps a confused or substituted broker from
 * silently upgrading an operation's authority.
 */

/** A credential request is small; the answer is a few hundred bytes. */
const MAX_RESPONSE_BYTES = 16_384;

/** Bounded so a wedged broker stalls one operation, not the whole Worker. */
export const R2_BROKER_CLIENT_TIMEOUT_MS = 5_000;

export type R2CredentialBrokerFailure =
  | "broker_unavailable"
  | "broker_refused"
  | "broker_response_invalid"
  | "credential_expired";

/**
 * A credential acquisition failure.
 *
 * Carries a bounded category and never a value: no object key, no bucket, no
 * token, and no `cause` chain that could drag one of those along.
 */
export class R2CredentialBrokerError extends Error {
  readonly failure: R2CredentialBrokerFailure;

  constructor(failure: R2CredentialBrokerFailure) {
    super(`R2 credential broker: ${failure}`);
    this.name = "R2CredentialBrokerError";
    this.failure = failure;
  }
}

export type BrokerR2CredentialProviderDeps = {
  /** Absolute path to the broker's Unix socket, bind-mounted into this container. */
  socketPath: string;
  /** The single bucket this Worker may address. Sent, and re-checked on return. */
  bucket: string;
  clock?: () => number;
  timeoutMs?: number;
};

export class BrokerR2CredentialProvider implements R2CredentialProvider {
  private readonly socketPath: string;
  private readonly bucket: string;
  private readonly clock: () => number;
  private readonly timeoutMs: number;

  constructor(deps: BrokerR2CredentialProviderDeps) {
    this.socketPath = deps.socketPath;
    this.bucket = deps.bucket;
    this.clock = deps.clock ?? (() => Date.now());
    this.timeoutMs = deps.timeoutMs ?? R2_BROKER_CLIENT_TIMEOUT_MS;
  }

  public async mint(input: R2CredentialRequestInput): Promise<R2TemporaryCredential> {
    const payload: R2CredentialRequest = {
      bucket: this.bucket,
      objectKey: input.objectKey,
      action: input.action,
      ttlSeconds: input.ttlSeconds,
    };

    const raw = await this.post(JSON.stringify(payload));

    const parsed = R2CredentialResponseSchema.safeParse(raw);
    if (!parsed.success) throw new R2CredentialBrokerError("broker_response_invalid");

    const response = parsed.data;

    // Verify the broker answered the question we actually asked. A mismatch is
    // never "close enough" — it is discarded.
    if (
      response.action !== input.action ||
      response.bucket !== this.bucket ||
      response.objectKey !== input.objectKey
    ) {
      throw new R2CredentialBrokerError("broker_response_invalid");
    }

    // An already-expired credential is refused BEFORE it reaches the S3 client,
    // so an expired grant can never be presented to R2.
    if (response.expiresAt <= this.clock()) {
      throw new R2CredentialBrokerError("credential_expired");
    }

    return Object.freeze({
      accessKeyId: response.accessKeyId,
      secretAccessKey: response.secretAccessKey,
      sessionToken: response.sessionToken,
      expiresAt: response.expiresAt,
    });
  }

  /**
   * One bounded request/response over the Unix socket.
   *
   * Every failure mode — socket missing (broker not running), connection
   * refused, timeout, non-200, oversized or unparseable body — resolves to a
   * thrown `R2CredentialBrokerError`. There is no path that returns a partial
   * or default credential.
   */
  private post(body: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (failure: R2CredentialBrokerFailure) => {
        if (settled) return;
        settled = true;
        reject(new R2CredentialBrokerError(failure));
      };

      const req = httpRequest(
        {
          socketPath: this.socketPath,
          path: R2_BROKER_MINT_PATH,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let total = 0;
          let overflowed = false;

          res.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > MAX_RESPONSE_BYTES) {
              overflowed = true;
              res.destroy();
              return;
            }
            chunks.push(chunk);
          });

          res.on("end", () => {
            if (settled) return;
            if (overflowed) return fail("broker_response_invalid");

            // A refusal is a refusal. The body carries only a category code,
            // which is deliberately NOT surfaced further: the Worker's job is
            // to fail the operation closed, not to reason about why.
            if (res.statusCode !== 200) return fail("broker_refused");

            try {
              settled = true;
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
              settled = false;
              fail("broker_response_invalid");
            }
          });

          res.on("error", () => fail("broker_unavailable"));
        },
      );

      req.on("timeout", () => {
        req.destroy();
        fail("broker_unavailable");
      });

      // Covers ENOENT (no socket -> broker not running), ECONNREFUSED and
      // EACCES. All of them mean the same thing to the caller: no credential.
      req.on("error", () => fail("broker_unavailable"));

      req.end(body);
    });
  }
}
