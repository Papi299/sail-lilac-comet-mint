import { lookup } from "node:dns/promises";
import { AppError } from "@/lib/errors";
import {
  hostnameLooksBlocked,
  isPrivateIp,
  validatePublicHttpUrl,
} from "@/lib/validation/url";

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

  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new AppError("NETWORK_ERROR");
  }

  if (!addresses.length) {
    throw new AppError("NETWORK_ERROR");
  }

  for (const addr of addresses) {
    if (isPrivateIp(addr.address)) {
      throw new AppError("INVALID_URL");
    }
  }

  return { url: checked.url, hostname };
}

export function assertRedirectTarget(url: string) {
  const checked = validatePublicHttpUrl(url);
  if (!checked.ok) {
    throw new AppError("INVALID_URL");
  }
  return checked;
}
