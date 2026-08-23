const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
  "metadata.goog",
  "kubernetes.default",
  "kubernetes.default.svc",
]);

export function normalizeInputUrl(raw: string): string {
  return raw.trim();
}

export function coerceHttpUrl(raw: string): string {
  const trimmed = normalizeInputUrl(raw);
  if (!trimmed) return trimmed;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return trimmed;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return `https://${trimmed}`;
}

export function isIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    return n >= 0 && n <= 255;
  });
}

export function ipv4ToInt(ip: string): number {
  const [a, b, c, d] = ip.split(".").map((x) => Number(x));
  return (((a << 24) >>> 0) + (b << 16) + (c << 8) + d) >>> 0;
}

export function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  if (!base || !isIpv4(ip) || !isIpv4(base)) return false;
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const PRIVATE_V4_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "255.255.255.255/32",
];

export function isPrivateIpv4(ip: string): boolean {
  if (!isIpv4(ip)) return false;
  return PRIVATE_V4_CIDRS.some((cidr) => inCidr(ip, cidr));
}

export function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase().trim();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fe80:") || normalized.startsWith("fe80::")) return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("ff")) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isPrivateIpv4(mapped[1]);
  const mappedHex = normalized.match(/^::ffff:([0-9a-f:]+)$/i);
  if (mappedHex) return true;
  return false;
}

export function isPrivateIp(ip: string): boolean {
  const value = ip.replace(/^\[|\]$/g, "");
  if (isIpv4(value)) return isPrivateIpv4(value);
  return isPrivateIpv6(value);
}

export function hostnameLooksBlocked(hostname: string): boolean {
  const host = hostname.replace(/\.$/, "").toLowerCase();
  if (!host) return true;
  if (BLOCKED_HOSTS.has(host)) return true;
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (host.endsWith(".arpa")) return true;
  if (isPrivateIp(host)) return true;
  return false;
}

export type UrlCheckResult =
  | { ok: true; url: string; hostname: string }
  | { ok: false; message: string; code: "INVALID_URL" | "FORBIDDEN" };

const MEDIA_PROTOCOLS = new Set(["http:", "https:"]);
const SAMPLE_PROTOCOLS = new Set(["sample:"]);

export function validatePublicHttpUrl(raw: string): UrlCheckResult {
  const trimmed = normalizeInputUrl(raw);
  if (!trimmed) {
    return { ok: false, message: "Please enter a valid video URL.", code: "INVALID_URL" };
  }

  if (/^sample:\/\//i.test(trimmed) || /^sample:/i.test(trimmed)) {
    return { ok: true, url: trimmed, hostname: "sample" };
  }

  let href = coerceHttpUrl(trimmed);
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return { ok: false, message: "Please enter a valid video URL.", code: "INVALID_URL" };
  }

  if (SAMPLE_PROTOCOLS.has(parsed.protocol)) {
    return { ok: true, url: parsed.toString(), hostname: "sample" };
  }

  if (!MEDIA_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, message: "Please enter a valid video URL.", code: "INVALID_URL" };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, message: "Please enter a valid video URL.", code: "INVALID_URL" };
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!hostname) {
    return { ok: false, message: "Please enter a valid video URL.", code: "INVALID_URL" };
  }

  if (hostnameLooksBlocked(hostname)) {
    return { ok: false, message: "Please enter a valid video URL.", code: "INVALID_URL" };
  }

  if (!hostname.includes(".") && !isIpv4(hostname) && !hostname.includes(":")) {
    return { ok: false, message: "Please enter a valid video URL.", code: "INVALID_URL" };
  }

  if (isIpv4(hostname) && isPrivateIpv4(hostname)) {
    return { ok: false, message: "Please enter a valid video URL.", code: "INVALID_URL" };
  }

  return { ok: true, url: parsed.toString(), hostname };
}

export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
