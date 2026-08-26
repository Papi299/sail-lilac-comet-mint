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

function stripZoneId(ip: string): string {
  const idx = ip.indexOf("%");
  return idx >= 0 ? ip.slice(0, idx) : ip;
}

/**
 * Expand an IPv6 textual address into 16 bytes.
 * Fail closed: unparseable values return null.
 */
export function parseIpv6Bytes(ip: string): Uint8Array | null {
  let s = stripZoneId(ip.toLowerCase().trim());
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (!s.includes(":")) return null;

  const lastColon = s.lastIndexOf(":");
  const after = lastColon >= 0 ? s.slice(lastColon + 1) : "";
  if (after.includes(".")) {
    if (!isIpv4(after)) return null;
    const [a, b, c, d] = after.split(".").map((x) => Number(x));
    const hi = ((a << 8) | b).toString(16);
    const lo = ((c << 8) | d).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  if (s.split("::").length > 2) return null;
  const [headRaw, tailRaw] = s.split("::");
  const splitHextets = (part: string | undefined) => {
    if (part == null || part === "") return [] as string[];
    return part.split(":");
  };
  const head = splitHextets(headRaw);
  const tail = s.includes("::") ? splitHextets(tailRaw) : [];
  if (!s.includes("::")) {
    if (head.length !== 8) return null;
    return hextetsToBytes(head);
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return hextetsToBytes([...head, ...Array(missing).fill("0"), ...tail]);
}

function hextetsToBytes(groups: string[]): Uint8Array | null {
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    const g = groups[i] ?? "";
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    out[i * 2] = (n >> 8) & 0xff;
    out[i * 2 + 1] = n & 0xff;
  }
  return out;
}

function bytesToIpv4(bytes: Uint8Array, offset: number): string {
  return `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;
}

function prefixEquals(bytes: Uint8Array, prefix: number[], bits: number): boolean {
  let remaining = bits;
  let i = 0;
  while (remaining >= 8) {
    if (bytes[i] !== prefix[i]) return false;
    i += 1;
    remaining -= 8;
  }
  if (remaining === 0) return true;
  const mask = (0xff << (8 - remaining)) & 0xff;
  return ((bytes[i] ?? 0) & mask) === ((prefix[i] ?? 0) & mask);
}

function last32AsIpv4(bytes: Uint8Array): string {
  return bytesToIpv4(bytes, 12);
}

function isUnspecified6(bytes: Uint8Array): boolean {
  return bytes.every((b) => b === 0);
}

function isLoopback6(bytes: Uint8Array): boolean {
  return bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1;
}

function isMappedIpv4(bytes: Uint8Array): boolean {
  for (let i = 0; i < 10; i += 1) if (bytes[i] !== 0) return false;
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

function isCompatibleIpv4(bytes: Uint8Array): boolean {
  for (let i = 0; i < 12; i += 1) if (bytes[i] !== 0) return false;
  if (isUnspecified6(bytes) || isLoopback6(bytes)) return false;
  return true;
}

/**
 * Conservative: reject well-known IPv4-in-IPv6 transition prefixes entirely.
 * These can encode an arbitrary IPv4 destination (including loopback/private)
 * and are not used by ordinary public media CDNs.
 *
 * - 6to4: 2002::/16
 * - Teredo: 2001:0000::/32
 * - NAT64 well-known: 64:ff9b::/32 (covers /96 and 64:ff9b:1::/48)
 */
function isRejectedTransitionPrefix(bytes: Uint8Array): boolean {
  if (prefixEquals(bytes, [0x20, 0x02], 16)) return true;
  if (prefixEquals(bytes, [0x20, 0x01, 0x00, 0x00], 32)) return true;
  if (prefixEquals(bytes, [0x00, 0x64, 0xff, 0x9b], 32)) return true;
  return false;
}

export function isPrivateIpv6(ip: string): boolean {
  const bytes = parseIpv6Bytes(ip);
  if (!bytes) return true;

  if (isUnspecified6(bytes) || isLoopback6(bytes)) return true;
  if (prefixEquals(bytes, [0xfe, 0x80], 10)) return true;
  if (prefixEquals(bytes, [0xfc], 7)) return true;
  if (prefixEquals(bytes, [0xff], 8)) return true;
  if (isRejectedTransitionPrefix(bytes)) return true;

  if (isMappedIpv4(bytes) || isCompatibleIpv4(bytes)) {
    return isPrivateIpv4(last32AsIpv4(bytes));
  }

  return false;
}

export function isPrivateIp(ip: string): boolean {
  const value = stripZoneId(ip.replace(/^\[|\]$/g, ""));
  if (isIpv4(value)) return isPrivateIpv4(value);
  if (value.includes(":")) return isPrivateIpv6(value);
  return false;
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

  const href = coerceHttpUrl(trimmed);
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
