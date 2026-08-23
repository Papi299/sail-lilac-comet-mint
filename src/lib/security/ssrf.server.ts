import { AppError } from "@/lib/errors";
import { hostnameLooksBlocked, validatePublicHttpUrl } from "@/lib/validation/url";
import { lookupHost, validateResolvedAddresses } from "@/lib/security/safe-http.server";

/**
 * Defense-in-depth URL + DNS policy check.
 *
 * This is NOT DNS-rebinding protection for a subsequent fetch(hostname):
 * application-controlled HTTP must use safeHttpRequest(), which pins the
 * connection to a validated address. yt-dlp performs its own networking and
 * is fail-closed unless YTDLP_NETWORK_ISOLATED is explicitly attested.
 */
export async function assertSafeUrl(raw: string): Promise<{ url: string; hostname: string }> {
  const checked = validatePublicHttpUrl(raw);
  if (!checked.ok) {
    throw new AppError("INVALID_URL", checked.message);
  }

  if (checked.hostname === "sample") {
    return { url: checked.url, hostname: "sample" };
  }

  const hostname = checked.hostname;
  if (hostnameLooksBlocked(hostname)) {
    throw new AppError("INVALID_URL");
  }

  let answers;
  try {
    answers = await lookupHost(hostname);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("NETWORK_ERROR");
  }

  await validateResolvedAddresses(hostname, answers);
  return { url: checked.url, hostname };
}
