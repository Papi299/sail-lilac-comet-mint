import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../../lib/errors.ts";
import { setSafeHttpTestHooks } from "../../lib/security/safe-http.server.ts";
import { setYtdlpProcessRunnerForTests, ytdlpExtractor } from "./ytdlp.server.ts";

const PUBLIC_LOOKUP = async () => [{ address: "8.8.8.8" as const, family: 4 as const }];

function restoreIsolationFlag(previous: string | undefined) {
  if (previous === undefined) delete process.env.YTDLP_NETWORK_ISOLATED;
  else process.env.YTDLP_NETWORK_ISOLATED = previous;
}

describe("yt-dlp network policy", () => {
  const previous = process.env.YTDLP_NETWORK_ISOLATED;

  afterEach(() => {
    restoreIsolationFlag(previous);
    setYtdlpProcessRunnerForTests(null);
    setSafeHttpTestHooks(null);
  });

  it("refuses metadata extraction before any network-capable spawn by default", async () => {
    delete process.env.YTDLP_NETWORK_ISOLATED;
    let spawned = 0;
    setYtdlpProcessRunnerForTests(async () => {
      spawned += 1;
      return { code: 0, stdout: "{}", stderr: "" };
    });
    await assert.rejects(
      () => ytdlpExtractor.getMetadata("https://example.com/watch?v=1"),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "EXTRACTOR_UNAVAILABLE");
        assert.notEqual(err.code, "UNSUPPORTED_SITE");
        return true;
      },
    );
    assert.equal(spawned, 0);
  });

  it("refuses download before any network-capable spawn by default", async () => {
    process.env.YTDLP_NETWORK_ISOLATED = "false";
    let spawned = 0;
    setYtdlpProcessRunnerForTests(async () => {
      spawned += 1;
      return { code: 0, stdout: "{}", stderr: "" };
    });
    await assert.rejects(
      () =>
        ytdlpExtractor.download("https://example.com/watch?v=1", { formatId: "preset:720" }, {
          workDir: "/tmp/unused-ytdlp-policy",
        }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "EXTRACTOR_UNAVAILABLE");
        return true;
      },
    );
    assert.equal(spawned, 0);
  });

  it("calls the injected subprocess hook when isolation is attested", async () => {
    process.env.YTDLP_NETWORK_ISOLATED = "true";
    let spawned = 0;
    let command: string | null = null;
    setSafeHttpTestHooks({ lookup: PUBLIC_LOOKUP });
    setYtdlpProcessRunnerForTests(async (opts) => {
      spawned += 1;
      command = opts.command;
      return { code: 0, stdout: "{}", stderr: "" };
    });
    await assert.rejects(() => ytdlpExtractor.getMetadata("https://example.com/watch?v=1"));
    assert.equal(spawned, 1);
    assert.ok(command);
  });
});
