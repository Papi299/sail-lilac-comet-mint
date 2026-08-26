import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildAttachmentContentDisposition,
  buildDownloadFilename,
  canonicalDownloadBasename,
  encodeRfc8187AttrValue,
  sanitizeFilename,
} from "./filenames.ts";

describe("filename sanitization", () => {
  it("strips path traversal", () => {
    assert.equal(sanitizeFilename("../../etc/passwd"), "etc-passwd");
  });

  it("removes illegal characters", () => {
    const name = sanitizeFilename('My Video:*?"<>| Title');
    assert.match(name, /^[a-zA-Z0-9._-]+$/);
    assert.equal(name.includes("/"), false);
  });

  it("falls back for empty names", () => {
    assert.equal(sanitizeFilename("***"), "video");
  });

  it("builds a user-facing download name", () => {
    assert.equal(
      buildDownloadFilename({ title: "Example Video!", quality: "1080p", container: "mp4" }),
      "Example-Video-1080p.mp4",
    );
  });

  it("limits length", () => {
    const long = "a".repeat(200);
    assert.ok(sanitizeFilename(long).length <= 80);
  });
});

function parseDisposition(header: string): { ascii: string; encoded: string } {
  const ascii = /filename="([^"]*)"/.exec(header)?.[1] ?? "";
  const encoded = /filename\*=UTF-8''([^;]*)$/.exec(header)?.[1] ?? "";
  return { ascii, encoded };
}

function decodeRfc8187(encoded: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; ) {
    if (encoded[i] === "%" && /^[0-9A-Fa-f]{2}/.test(encoded.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(encoded.slice(i + 1, i + 3), 16));
      i += 3;
    } else {
      bytes.push(encoded.charCodeAt(i));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

describe("Content-Disposition attachment helper", () => {
  it("emits a normal ASCII attachment header", () => {
    const header = buildAttachmentContentDisposition("video-1080p.mp4");
    assert.equal(
      header,
      'attachment; filename="video-1080p.mp4"; filename*=UTF-8\'\'video-1080p.mp4',
    );
    assert.doesNotThrow(() => new Headers({ "Content-Disposition": header }));
  });

  it("cannot break the quoted filename parameter with quotes", () => {
    const header = buildAttachmentContentDisposition('foo"bar.mp4');
    const { ascii, encoded } = parseDisposition(header);
    assert.match(ascii, /^[A-Za-z0-9._-]+\.mp4$/);
    assert.equal(ascii.includes('"'), false);
    assert.equal(decodeRfc8187(encoded), 'foo"bar.mp4');
    assert.doesNotThrow(() => new Headers({ "Content-Disposition": header }));
  });

  it("strips backslash path semantics to a basename", () => {
    const header = buildAttachmentContentDisposition("..\\..\\secret.mp4");
    const { ascii, encoded } = parseDisposition(header);
    assert.equal(canonicalDownloadBasename("..\\..\\secret.mp4"), "secret.mp4");
    assert.equal(ascii, "secret.mp4");
    assert.equal(decodeRfc8187(encoded), "secret.mp4");
    assert.equal(header.includes("\\"), false);
  });

  it("cannot create another Content-Disposition parameter with a semicolon", () => {
    const header = buildAttachmentContentDisposition("foo;bar.mp4");
    assert.match(header, /^attachment; filename="[^"]+"; filename\*=UTF-8''/);
    assert.equal(header.includes("filename=bar"), false);
    const { ascii, encoded } = parseDisposition(header);
    assert.equal(ascii.includes(";"), false);
    assert.equal(decodeRfc8187(encoded), "foo;bar.mp4");
  });

  it("strips CR/LF so a stored name cannot inject another header", () => {
    const header = buildAttachmentContentDisposition("good.mp4\r\nX-Evil: injected");
    assert.equal(header.includes("\r"), false);
    assert.equal(header.includes("\n"), false);
    assert.match(header, /^attachment; filename="[^"]+"; filename\*=UTF-8''[^\s;]+$/);
    assert.doesNotThrow(() => new Headers({ "Content-Disposition": header }));
    const res = new Response(null, { headers: { "Content-Disposition": header } });
    assert.equal(res.headers.get("x-evil"), null);
    assert.equal(res.headers.get("content-disposition"), header);
  });

  it("uses only the basename of POSIX and Windows paths", () => {
    assert.equal(canonicalDownloadBasename("../../secret.mp4"), "secret.mp4");
    assert.equal(canonicalDownloadBasename("..\\..\\secret.mp4"), "secret.mp4");
    const posix = parseDisposition(buildAttachmentContentDisposition("../../secret.mp4"));
    const win = parseDisposition(buildAttachmentContentDisposition("..\\..\\secret.mp4"));
    assert.equal(posix.ascii, "secret.mp4");
    assert.equal(win.ascii, "secret.mp4");
  });

  it("keeps Unicode in filename* and an ASCII filename fallback", () => {
    const name = "Résumé שלום 🌍.mp4";
    const header = buildAttachmentContentDisposition(name);
    const { ascii, encoded } = parseDisposition(header);
    assert.match(ascii, /^[A-Za-z0-9._-]+$/);
    assert.equal(/[^\x20-\x7E]/.test(ascii), false);
    assert.equal(decodeRfc8187(encoded), canonicalDownloadBasename(name));
    assert.equal(encoded.includes(" "), false);
    assert.ok(/%C3%A9/i.test(encoded) || encoded.includes(encodeRfc8187AttrValue("é")));
  });

  it("percent-encodes RFC 8187-sensitive ASCII in filename*", () => {
    const header = buildAttachmentContentDisposition("star*'%().mp4");
    const { encoded } = parseDisposition(header);
    assert.equal(encoded.includes("*"), false);
    assert.equal(encoded.includes("'"), false);
    assert.equal(encoded.includes("("), false);
    assert.equal(encoded.includes(")"), false);
    assert.equal(encoded.includes("%25") || /%25/.test(encoded), true);
    assert.match(encoded, /%2A/i);
    assert.match(encoded, /%27/i);
    assert.match(encoded, /%28/i);
    assert.match(encoded, /%29/i);
    assert.equal(decodeRfc8187(encoded), "star*'%().mp4");
  });

  it("falls back to video.bin for empty or control-only names", () => {
    assert.equal(canonicalDownloadBasename("\r\n"), "video.bin");
    assert.equal(canonicalDownloadBasename("   "), "video.bin");
    assert.equal(canonicalDownloadBasename("..."), "video.bin");
    const header = buildAttachmentContentDisposition("\r\n");
    assert.equal(
      header,
      'attachment; filename="video.bin"; filename*=UTF-8\'\'video.bin',
    );
  });
});
