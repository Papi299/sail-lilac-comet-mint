# yt-dlp 2026.08.19, VideoFetch LD-3e variant (`2026.08.19+videofetch.ld3e1`)

This directory holds everything the Worker image needs, besides the upstream release asset, to build its yt-dlp
runtime. The image does not install the upstream executable as-is: it installs the upstream executable with exactly
two archive members replaced by the files here. `PATCH-MANIFEST.json` lists every digest named below.

## Upstream

| | |
|---|---|
| Project | yt-dlp, <https://github.com/yt-dlp/yt-dlp> |
| Release | `2026.08.19`; tag commit `3a08beaf031ab68f966401ead017ac81fe8486cf` ("Release 2026.08.19"), whose parent is `594bd50c2c78ac432f81600d309fdc4e0a92d82c`, the `RELEASE_GIT_HEAD` recorded inside the artifact |
| Asset | `yt-dlp`, the platform-independent Unix zipimport executable: 3,072,469 bytes, SHA-256 `1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6`, as published in the release's `SHA2-256SUMS` |
| Archive | a 23-byte `#!/usr/bin/env python3` line, then a ZIP archive of 1,053 members |

The two members this variant replaces are byte-identical, in the upstream asset, to the release tag's sources:
`yt_dlp/downloader/http.py` is git blob `6dcf7e7b6981156b8a59cf9ca065836d4d64882d` and `yt_dlp/version.py` is git blob
`9b3a255f266bdea78505723455a5d546749a2b7c`.

## The two replacement members

**`yt_dlp/downloader/http.py`** (SHA-256 `657dae31370ae3b93c3071e80399195087dc3898fe41ce79e5c0b68720d0c75a`) is the
LD-3e chunk correction. It is byte-identical to the laboratory source accepted by independent review
(`evidence/I-candidate-patch/candidate-v1.http.py` in the review archive of
VIDEOFETCH-LD3E-PINNED-YTDLP-CHUNK-DEPENDENCY-REMEDIATION-DESIGN-002, archive SHA-256
`237279332c05d1a6653c3a19ed059c095997182a4e88bf82d6075981e659c873`). That source was derived from the upstream member
by asserted text edits at eight sites of `HttpFD.real_download`:

- a ranged piece may continue without spending a retry attempt only when it started where requested, covered the
  request (or reached the end of the file), kept the total of the pieces before it, and was delivered in full;
- a partial answer for another range is never written: it spends an attempt of the existing `--retries` budget;
- the output file is closed before any rewrite, so a whole-file answer can never be appended to earlier pieces;
- a read never goes past the range the answer declared;
- the 100-byte "already downloaded" allowance after HTTP 416 applies only when this run's own total agrees.

No new number, limit or retry policy is introduced. The upstream HTTP 416 recovery, which re-sends the same `Range`,
is unchanged; it is a documented limitation that fails closed.

**`yt_dlp/version.py`** (SHA-256 `108f4a37073c75f4610ce335e02740748a2f431f7d894026b32cd31feeebf92c`) gives the variant
its own identity. Relative to the upstream member, `__version__` and `_pkg_version` change from `2026.08.19` to
`2026.08.19+videofetch.ld3e1` (a PEP 440 local version label), and two comment lines are added. `RELEASE_GIT_HEAD`,
`VARIANT`, `UPDATE_HINT`, `CHANNEL` and `ORIGIN` are unchanged. `yt-dlp --version` therefore prints
`2026.08.19+videofetch.ld3e1`, which the Worker's runtime probe requires exactly.

## Build

`build_patched_ytdlp.py` (SHA-256 `8f828d06cf28f136cd337befc69ec4a828fa39f0d4b335b1803b01bdc2119126`) is a
dependency-free Python script. It verifies the upstream asset's size, digest, archive structure, every member's
metadata and CRC, and the ordered member inventory (SHA-256
`0ec4533e7517564a1c00676a1e06ec2764b8094874ce93c187252a322ab9b92b`); verifies both upstream members and both
replacements against their pinned digests; copies every other member byte for byte; writes the two replacements as
STORED members with their original names, timestamps and attributes; re-verifies the result; and writes it only if
its size and SHA-256 are the pinned ones:

| Output | |
|---|---|
| Identity | `2026.08.19+videofetch.ld3e1` |
| Size | 3,088,241 bytes |
| SHA-256 | `2dfa21ec04eebb61612e3e6eb5d24f13527264275a0a34d6ef7e5d33a9260259` |

`Dockerfile.worker` runs it in a separate build stage with no network, checks the output's SHA-256 again with
`sha256sum`, and copies only the output into the final image, at `/usr/local/lib/videofetch/yt-dlp`, root-owned and
mode 0555. At run time `probeYtdlpRuntime` (`src/worker/runtime/ytdlp-runtime.server.ts`) hashes the installed file and
refuses it unless the SHA-256 matches, before it ever runs `--version`.

To reproduce the build locally from a copy of the upstream asset:

```sh
python3 -I -B vendor/yt-dlp/2026.08.19-videofetch-ld3e/build_patched_ytdlp.py <upstream yt-dlp> <new output path>
```

The output depends only on the two inputs: the same bytes result on any host, Python 3.9 or later, locale, working
directory or umask.

The laboratory executable of the design task (`98195b3e6d41980def10331eaacdc5e040c0a2f65da57200e409d3cd139c4a56`)
replaced `http.py` only and still reported `2026.08.19`. This build differs from it only in the `yt_dlp/version.py`
member, so its digest is new.

## Licence

yt-dlp is released into the public domain under the Unlicense; `LICENSE` here is the upstream file at the release tag
(git blob `68a49daad8ff7e35068f2b7a97d643aab440eaec`). The two replacement members are derived from upstream files under
that licence. The `yt_dlp_ejs` package bundled in the upstream asset is copied unchanged, so its terms are the same as
for the unmodified asset the image shipped before.

## Changing this directory

Any change to a file here is a new candidate. It needs its own review and the full pinned-runtime qualification, and
the pins in the builder, in `PATCH-MANIFEST.json`, in `Dockerfile.worker` and in `YTDLP_RUNTIME` must change together;
`ytdlp-patched-runtime-policy.test.ts` and `container-policy.test.ts` fail if they do not agree.
