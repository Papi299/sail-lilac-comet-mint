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
