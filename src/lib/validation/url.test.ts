import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  coerceHttpUrl,
  hostnameLooksBlocked,
  isPrivateIp,
  isPrivateIpv4,
  validatePublicHttpUrl,
} from "./url.ts";

describe("URL validation", () => {
  it("rejects empty input", () => {
    const result = validatePublicHttpUrl("   ");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.message, "Please enter a valid video URL.");
  });

  it("adds https when protocol is missing", () => {
    const result = validatePublicHttpUrl("example.com/watch?v=1");
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.url, "https://example.com/watch?v=1");
  });

  it("trims whitespace", () => {
    const result = validatePublicHttpUrl("  https://example.com/v  ");
    assert.equal(result.ok, true);
  });

  it("rejects javascript urls", () => {
    const result = validatePublicHttpUrl("javascript:alert(1)");
    assert.equal(result.ok, false);
  });

  it("rejects file protocol", () => {
    const result = validatePublicHttpUrl("file:///etc/passwd");
    assert.equal(result.ok, false);
  });

  it("rejects localhost", () => {
    assert.equal(validatePublicHttpUrl("http://localhost/video.mp4").ok, false);
    assert.equal(validatePublicHttpUrl("http://127.0.0.1/video.mp4").ok, false);
    assert.equal(validatePublicHttpUrl("http://[::1]/video.mp4").ok, false);
  });

  it("rejects private and metadata IPs", () => {
    assert.equal(validatePublicHttpUrl("http://192.168.1.10/v").ok, false);
    assert.equal(validatePublicHttpUrl("http://10.0.0.5/v").ok, false);
    assert.equal(validatePublicHttpUrl("http://169.254.169.254/latest/meta-data").ok, false);
    assert.equal(validatePublicHttpUrl("http://172.16.4.4/v").ok, false);
  });

  it("allows public https urls", () => {
    const result = validatePublicHttpUrl("https://archive.org/details/BigBuckBunny_124");
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.hostname, "archive.org");
  });

  it("allows sample protocol", () => {
    const result = validatePublicHttpUrl("sample://demo");
    assert.equal(result.ok, true);
  });

  it("rejects hostnames without a dot", () => {
    assert.equal(validatePublicHttpUrl("http://intranet/video").ok, false);
  });
});

describe("SSRF helpers", () => {
  it("detects private ipv4 ranges", () => {
    assert.equal(isPrivateIpv4("127.0.0.1"), true);
    assert.equal(isPrivateIpv4("10.1.2.3"), true);
    assert.equal(isPrivateIpv4("192.168.0.1"), true);
    assert.equal(isPrivateIpv4("169.254.169.254"), true);
    assert.equal(isPrivateIpv4("8.8.8.8"), false);
    assert.equal(isPrivateIpv4("1.1.1.1"), false);
  });

  it("detects private ipv6", () => {
    assert.equal(isPrivateIp("::1"), true);
    assert.equal(isPrivateIp("fc00::1"), true);
    assert.equal(isPrivateIp("fe80::1"), true);
  });

  it("blocks metadata hostnames", () => {
    assert.equal(hostnameLooksBlocked("metadata.google.internal"), true);
    assert.equal(hostnameLooksBlocked("foo.localhost"), true);
  });
});

describe("protocol coercion", () => {
  it("handles protocol-relative urls", () => {
    assert.equal(coerceHttpUrl("//cdn.example.com/a.mp4"), "https://cdn.example.com/a.mp4");
  });
});
