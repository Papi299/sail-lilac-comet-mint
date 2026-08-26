const UNSAFE = /[^a-zA-Z0-9._-]+/g;

export function sanitizeFilename(input: string, fallback = "video"): string {
  const trimmed = input.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const replaced = trimmed.replace(UNSAFE, "-").replace(/-+/g, "-").replace(/^[.-]+|[.-]+$/g, "");
  const cut = replaced.slice(0, 80);
  const safe = cut.length > 0 ? cut : fallback;
  if (safe === "." || safe === ".." || safe.toLowerCase() === "con") return fallback;
  return safe;
}

export function buildDownloadFilename(opts: {
  title: string;
  quality?: string | null;
  container: string;
}): string {
  const base = sanitizeFilename(opts.title, "video");
  const quality = opts.quality ? sanitizeFilename(opts.quality) : "";
  const ext = sanitizeFilename(opts.container.replace(/^\./, ""), "mp4").replace(/-/g, "");
  const name = quality ? `${base}-${quality}` : base;
  return `${name}.${ext}`;
}

export function safeJoinDownloadName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "video.bin";
  return sanitizeFilename(base.replace(/\.[^.]+$/, ""), "video") + (base.includes(".") ? `.${sanitizeFilename(base.split(".").pop() || "bin")}` : "");
}

const FALLBACK_ATTACHMENT_NAME = "video.bin";
const RFC8187_ATTR_CHAR = /[A-Za-z0-9!#$&+\-.^_`|~]/;

function isolateBasename(input: string): string {
  const parts = String(input ?? "").split(/[/\\]/);
  return parts[parts.length - 1] ?? "";
}

function stripAsciiControls(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) continue;
    out += ch;
  }
  return out;
}

export function canonicalDownloadBasename(filename: string): string {
  const cleaned = stripAsciiControls(isolateBasename(filename)).normalize("NFC").trim();
  if (!cleaned || /^\.+$/.test(cleaned)) return FALLBACK_ATTACHMENT_NAME;
  return cleaned;
}

function asciiFallbackName(canonical: string): string {
  if (canonical === FALLBACK_ATTACHMENT_NAME) return FALLBACK_ATTACHMENT_NAME;
  const lastDot = canonical.lastIndexOf(".");
  const hasExt = lastDot > 0 && lastDot < canonical.length - 1;
  const stem = hasExt ? canonical.slice(0, lastDot) : canonical;
  const ext = hasExt ? canonical.slice(lastDot + 1) : "bin";
  const safeStem = sanitizeFilename(stem, "video");
  const safeExt = sanitizeFilename(ext, "bin").replace(/-/g, "") || "bin";
  return `${safeStem}.${safeExt}`;
}

export function encodeRfc8187AttrValue(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  let out = "";
  for (const byte of bytes) {
    const ch = String.fromCharCode(byte);
    if (RFC8187_ATTR_CHAR.test(ch)) {
      out += ch;
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

export function buildAttachmentContentDisposition(filename: string): string {
  const canonical = canonicalDownloadBasename(filename);
  const ascii = asciiFallbackName(canonical);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc8187AttrValue(canonical)}`;
}
