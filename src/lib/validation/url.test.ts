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

  it("rejects userinfo and non-http schemes", () => {
    assert.equal(validatePublicHttpUrl("https://user:pass@example.com/v").ok, false);
    assert.equal(validatePublicHttpUrl("https://user@example.com/v").ok, false);
    assert.equal(validatePublicHttpUrl("data:text/html,hi").ok, false);
  });

  it("rejects IPv6-encoded loopback in URLs", () => {
    assert.equal(validatePublicHttpUrl("http://[::ffff:127.0.0.1]/v").ok, false);
    assert.equal(validatePublicHttpUrl("http://[::127.0.0.1]/v").ok, false);
    assert.equal(validatePublicHttpUrl("http://[2002:7f00:1::]/v").ok, false);
    assert.equal(validatePublicHttpUrl("http://[64:ff9b::7f00:1]/v").ok, false);
  });

  it("allows public addresses as positive controls", () => {
    assert.equal(validatePublicHttpUrl("https://1.1.1.1/video.mp4").ok, true);
    assert.equal(validatePublicHttpUrl("http://[2001:4860:4860::8888]/v").ok, true);
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

  it("blocks IPv4-mapped and IPv4-compatible encodings of loopback", () => {
    assert.equal(isPrivateIp("::ffff:127.0.0.1"), true);
    assert.equal(isPrivateIp("::ffff:7f00:1"), true);
    assert.equal(isPrivateIp("::7f00:1"), true);
    assert.equal(isPrivateIp("::127.0.0.1"), true);
  });

  it("blocks 6to4 and NAT64 encodings of private IPv4", () => {
    assert.equal(isPrivateIp("2002:7f00:1::"), true);
    assert.equal(isPrivateIp("2002:0a00:0001::1"), true);
    assert.equal(isPrivateIp("64:ff9b::7f00:1"), true);
    assert.equal(isPrivateIp("64:ff9b::10.0.0.1"), true);
    assert.equal(isPrivateIp("2001:0::1"), true);
  });

  it("allows public IPv4-mapped and public global IPv6", () => {
    assert.equal(isPrivateIp("::ffff:8.8.8.8"), false);
    assert.equal(isPrivateIp("2001:4860:4860::8888"), false);
    assert.equal(isPrivateIp("2606:4700:4700::1111"), false);
  });

  it("blocks IPv4-mapped encodings of RFC1918, link-local, and loopback", () => {
    assert.equal(isPrivateIp("::ffff:10.0.0.1"), true);
    assert.equal(isPrivateIp("::ffff:169.254.169.254"), true);
    assert.equal(isPrivateIp("::ffff:192.168.1.8"), true);
    assert.equal(isPrivateIp("::ffff:127.0.0.1"), true);
  });

  it("treats unparseable IPv6-like values as private (fail closed)", () => {
    assert.equal(isPrivateIp("gggg::1"), true);
    assert.equal(isPrivateIp("::zzzz"), true);
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
