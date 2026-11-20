#!/usr/bin/env python3
"""Deterministic builder for VideoFetch's patched yt-dlp runtime (LD-3e).

Builds ONE file: the exact upstream yt-dlp 2026.08.19 platform-independent zipimport executable with exactly two archive
members replaced by the reviewed files that sit next to this script:

    yt_dlp/downloader/http.py   the LD-3e chunk correction (independently reviewed laboratory source, unchanged)
    yt_dlp/version.py           the downstream identity: `--version` prints 2026.08.19+videofetch.ld3e1

Every other byte is copied from the upstream file. Nothing is compressed, fetched, timestamped or looked up: the output is
a pure function of the upstream file and the two members, so the same inputs give the same bytes on any host, Python
(3.9 or later), locale, working directory or umask.

Method (member transplant). The upstream file is a 23-byte shebang line followed by a ZIP archive. The builder first
accounts for every byte of it: the shebang, 1,053 local records back to back, the central directory and the end record,
nothing between or after them. It then writes the same shebang and records in the same order; each of the two replaced
members gets a new local record (method STORED, its own CRC-32 and sizes) carrying the member's original name, extra
field, timestamp and attributes; the central directory is rewritten with the new offsets, and the end record with the new
directory size and offset.

It REFUSES (exit status 1, nothing written) when:
  - the upstream file's size or SHA-256 is not the pinned one;
  - the archive structure is not exactly the accepted one (shebang, record order, no gap, no trailing byte, no ZIP64,
    no data descriptor, no encryption, no archive comment, one disk);
  - a member's metadata is outside the accepted representation, or a member name repeats;
  - any member fails its CRC, or the ordered member inventory (each member's SHA-256 and name) is not the pinned one;
  - a member to replace is missing, appears more than once, or its upstream bytes are not the pinned ones;
  - a replacement file's SHA-256 is not the pinned one;
  - re-assembling the upstream records unchanged does not reproduce the upstream file byte for byte;
  - the output cannot be verified: re-parsed strictly, every untouched member identical in bytes and metadata, every
    replaced member holding exactly its replacement, every CRC valid, and the output's size and SHA-256 the pinned ones;
  - the output path already exists.
The output is created with O_EXCL and mode 0444. The Worker image installs it root-owned, mode 0555, and verifies the same
SHA-256 again after this script exits (Dockerfile.worker) and before every use (src/worker/runtime/ytdlp-runtime.server.ts).

Usage: python3 -I -B build_patched_ytdlp.py <upstream yt-dlp 2026.08.19 file> <output path>
"""
import hashlib
import io
import os
import struct
import sys
import zipfile
import zlib

UPSTREAM_BYTES = 3072469
UPSTREAM_SHA256 = "1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6"
SHEBANG = b"#!/usr/bin/env python3\n"
MEMBER_COUNT = 1053
# SHA-256 of the ordered inventory: one line "<member SHA-256>  <member name>\n" per member, in archive order.
UPSTREAM_INVENTORY_SHA256 = "0ec4533e7517564a1c00676a1e06ec2764b8094874ce93c187252a322ab9b92b"

# (member name, upstream member SHA-256, replacement SHA-256), in archive order. Paths are relative to this script.
REPLACEMENTS = (
    ("yt_dlp/version.py",
     "5d7c9a50dbacbdb3596a77c9856a7c1aeded2ffce3cfdd25a7df76954791cf4d",
     "108f4a37073c75f4610ce335e02740748a2f431f7d894026b32cd31feeebf92c"),
    ("yt_dlp/downloader/http.py",
     "e111fffdc894f68253ce3c5155fa1aa7390e58caa9a33eeb28d9ef78134e2cd0",
     "657dae31370ae3b93c3071e80399195087dc3898fe41ce79e5c0b68720d0c75a"),
)

OUTPUT_BYTES = 3088241
OUTPUT_SHA256 = "2dfa21ec04eebb61612e3e6eb5d24f13527264275a0a34d6ef7e5d33a9260259"

# The accepted representation of every member, as the upstream archive has it.
MADE_BY = 798                       # Unix, ZIP specification 3.0
DOS_TIME, DOS_DATE = 2080, 10273    # 2000-01-01 01:01:00
EXTERNAL_ATTR = 0o100644 << 16      # a regular file, mode 0644
CENTRAL_EXTRA_LEN, LOCAL_EXTRA_LEN = 24, 28
# method -> (version needed to extract, internal attributes) of an UPSTREAM member.
UPSTREAM_METHODS = {8: (20, 1), 0: (10, 0)}
STORED, STORED_NEEDS = 0, 10        # how a replaced member is written

LOCAL = struct.Struct("<4sHHHHHIIIHH")
CENTRAL = struct.Struct("<4sHHHHHHIIIHHHHHII")
END = struct.Struct("<4sHHHHIIH")


class Refused(Exception):
    pass


def refuse(check, detail):
    raise Refused(f"{check}: {detail}")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def parse(raw, prefix_len):
    """Accounts for every byte of a shebang-prefixed archive. Returns the members in archive order."""
    if len(raw) < prefix_len + END.size:
        refuse("archive structure", "too short")
    end_pos = len(raw) - END.size
    sig, disk, cd_disk, here, entries, cd_size, cd_offset, comment_len = END.unpack_from(raw, end_pos)
    if sig != b"PK\x05\x06" or comment_len != 0:
        refuse("archive structure", "the end record is not the last 22 bytes, or the archive has a comment")
    if disk != 0 or cd_disk != 0 or here != entries:
        refuse("archive structure", "more than one disk")
    if entries == 0xFFFF or cd_size == 0xFFFFFFFF or cd_offset == 0xFFFFFFFF or raw[end_pos - 20:end_pos - 16] == b"PK\x06\x07":
        refuse("archive structure", "ZIP64 records")
    cd_pos = prefix_len + cd_offset
    if cd_pos + cd_size != end_pos:
        refuse("archive structure", "bytes between the central directory and the end record")
    members, pos = [], cd_pos
    for _ in range(entries):
        if pos + CENTRAL.size > end_pos:
            refuse("archive structure", "the central directory ends early")
        fields = CENTRAL.unpack_from(raw, pos)
        if fields[0] != b"PK\x01\x02":
            refuse("archive structure", "a central record has no signature")
        n, m, k = fields[10], fields[11], fields[12]
        tail = raw[pos + CENTRAL.size:pos + CENTRAL.size + n + m + k]
        members.append({"central": fields, "name": tail[:n], "tail": tail})
        pos += CENTRAL.size + n + m + k
    if pos != end_pos:
        refuse("archive structure", "bytes between the last central record and the end record")
    cursor = prefix_len
    for mem in members:
        start = prefix_len + mem["central"][16]
        if start != cursor:
            refuse("archive structure", f"a gap or an overlap before {mem['name']!r}")
        local = LOCAL.unpack_from(raw, start)
        if local[0] != b"PK\x03\x04":
            refuse("archive structure", f"no local record for {mem['name']!r}")
        n, m = local[9], local[10]
        name = raw[start + LOCAL.size:start + LOCAL.size + n]
        if name != mem["name"]:
            refuse("archive structure", f"the local and central names differ for {mem['name']!r}")
        length = LOCAL.size + n + m + local[7]
        mem["local"] = local
        mem["record"] = raw[start:start + length]
        mem["local_tail"] = raw[start + LOCAL.size:start + LOCAL.size + n + m]
        mem["data"] = raw[start + LOCAL.size + n + m:start + length]
        cursor = start + length
    if cursor != cd_pos:
        refuse("archive structure", "bytes between the last local record and the central directory")
    return members


def content(mem):
    """The member's uncompressed bytes, with its CRC-32 and size checked."""
    c = mem["central"]
    if c[4] == 0:
        data = mem["data"]
    elif c[4] == 8:
        inflater = zlib.decompressobj(-15)
        data = inflater.decompress(mem["data"]) + inflater.flush()
        if not inflater.eof or inflater.unused_data:
            refuse("member CRC", f"{mem['name']!r} is not one complete deflate stream")
    else:
        refuse("member metadata", f"{mem['name']!r} uses compression method {c[4]}")
    if len(data) != c[9] or (zlib.crc32(data) & 0xFFFFFFFF) != c[7]:
        refuse("member CRC", f"{mem['name']!r} fails its size or CRC-32")
    return data


def check_representation(mem, replaced):
    """The accepted metadata. A replaced member is STORED with the upstream member's other fields."""
    c, lo, name = mem["central"], mem["local"], mem["name"]
    method = c[4]
    if replaced:
        needed, iattr = STORED_NEEDS, 1
        if method != STORED:
            refuse("member metadata", f"{name!r} is not stored")
    else:
        if method not in UPSTREAM_METHODS:
            refuse("member metadata", f"{name!r} uses compression method {method}")
        needed, iattr = UPSTREAM_METHODS[method]
    expected_central = (MADE_BY, needed, 0, method, DOS_TIME, DOS_DATE, CENTRAL_EXTRA_LEN, 0, 0, iattr, EXTERNAL_ATTR)
    observed_central = (c[1], c[2], c[3], c[4], c[5], c[6], c[11], c[12], c[13], c[14], c[15])
    if observed_central != expected_central:
        refuse("member metadata", f"{name!r} central record {observed_central} is not {expected_central}")
    expected_local = (needed, 0, method, DOS_TIME, DOS_DATE, c[7], c[8], c[9], LOCAL_EXTRA_LEN)
    observed_local = (lo[1], lo[2], lo[3], lo[4], lo[5], lo[6], lo[7], lo[8], lo[10])
    if observed_local != expected_local:
        refuse("member metadata", f"{name!r} local record {observed_local} is not {expected_local}")
    try:
        text = name.decode("ascii")
    except UnicodeDecodeError:
        refuse("member metadata", f"{name!r} is not an ASCII name")
    parts = text.split("/")
    if text.startswith("/") or "\\" in text or any(p in ("", ".", "..") for p in parts):
        refuse("member metadata", f"{name!r} is not a safe relative name")


def assemble(prefix, members, replacements):
    """The archive with each named member's record replaced by a STORED record of the given bytes."""
    out, central = bytearray(prefix), bytearray()
    for mem in members:
        offset = len(out) - len(prefix)
        c = list(mem["central"])
        new = replacements.get(mem["name"])
        if new is None:
            out += mem["record"]
        else:
            crc = zlib.crc32(new) & 0xFFFFFFFF
            lo = list(mem["local"])
            lo[1], lo[3], lo[6], lo[7], lo[8] = STORED_NEEDS, STORED, crc, len(new), len(new)
            out += LOCAL.pack(*lo) + mem["local_tail"] + new
            c[2], c[4], c[7], c[8], c[9] = STORED_NEEDS, STORED, crc, len(new), len(new)
        c[16] = offset
        central += CENTRAL.pack(*c) + mem["tail"]
    cd_offset = len(out) - len(prefix)
    out += central + END.pack(b"PK\x05\x06", 0, 0, len(members), len(members), len(central), cd_offset, 0)
    return bytes(out)


def build(upstream, replacement_files):
    """Returns the output bytes for the upstream bytes and {member name: replacement bytes}. Refuses on any deviation."""
    if len(upstream) != UPSTREAM_BYTES:
        refuse("upstream size", f"{len(upstream)} bytes, pinned {UPSTREAM_BYTES}")
    if sha256(upstream) != UPSTREAM_SHA256:
        refuse("upstream digest", f"{sha256(upstream)}, pinned {UPSTREAM_SHA256}")
    if not upstream.startswith(SHEBANG):
        refuse("archive structure", "the file does not start with the accepted shebang line")
    members = parse(upstream, len(SHEBANG))
    if len(members) != MEMBER_COUNT:
        refuse("archive structure", f"{len(members)} members, pinned {MEMBER_COUNT}")
    names = [m["name"] for m in members]
    if len(set(names)) != len(names):
        refuse("duplicate member", "a member name repeats")
    for mem in members:
        check_representation(mem, replaced=False)
    inventory = b"".join(sha256(content(m)).encode() + b"  " + m["name"] + b"\n" for m in members)
    if sha256(inventory) != UPSTREAM_INVENTORY_SHA256:
        refuse("member inventory", f"{sha256(inventory)}, pinned {UPSTREAM_INVENTORY_SHA256}")
    replacements = {}
    for name, upstream_member_sha, replacement_sha in REPLACEMENTS:
        key = name.encode("ascii")
        hits = [m for m in members if m["name"] == key]
        if len(hits) != 1:
            refuse("missing member", f"{name} appears {len(hits)} times")
        if sha256(content(hits[0])) != upstream_member_sha:
            refuse("upstream member digest", f"{name} is {sha256(content(hits[0]))}, pinned {upstream_member_sha}")
        new = replacement_files.get(name)
        if new is None or sha256(new) != replacement_sha:
            refuse("replacement digest", f"{name} is {sha256(new) if new is not None else 'absent'}, pinned {replacement_sha}")
        replacements[key] = new
    if set(replacement_files) != {name for name, _, _ in REPLACEMENTS}:
        refuse("replacement digest", "an unexpected replacement was supplied")
    if assemble(SHEBANG, members, {}) != upstream:
        refuse("identity reconstruction", "re-assembling the upstream records does not reproduce the upstream file")
    output = assemble(SHEBANG, members, replacements)
    verify(upstream, members, replacements, output)
    return output


def verify(upstream, members, replacements, output):
    """The output re-parsed strictly, compared member by member, and checked by Python's own zipfile reader."""
    rebuilt = parse(output, len(SHEBANG))
    if output[:len(SHEBANG)] != SHEBANG or [m["name"] for m in rebuilt] != [m["name"] for m in members]:
        refuse("output verification", "the shebang, the member names or their order changed")
    for old, new in zip(members, rebuilt):
        replaced = old["name"] in replacements
        check_representation(new, replaced=replaced)
        if replaced:
            if content(new) != replacements[old["name"]]:
                refuse("output verification", f"{old['name']!r} does not hold its replacement")
            if new["local_tail"] != old["local_tail"] or new["tail"] != old["tail"]:
                refuse("output verification", f"{old['name']!r} lost its name, extra field or comment")
        else:
            if new["record"] != old["record"] or new["tail"] != old["tail"] or new["central"][:16] != old["central"][:16]:
                refuse("output verification", f"{old['name']!r} changed")
    with zipfile.ZipFile(io.BytesIO(output)) as z:
        if z.testzip() is not None or [i.filename.encode("ascii") for i in z.infolist()] != [m["name"] for m in members]:
            refuse("output verification", "Python's zipfile reader disagrees")
        for name, new in replacements.items():
            if z.read(name.decode("ascii")) != new:
                refuse("output verification", f"zipfile reads other bytes for {name!r}")
    if len(output) != OUTPUT_BYTES or sha256(output) != OUTPUT_SHA256:
        refuse("output verification", f"{len(output)} bytes, SHA-256 {sha256(output)}; pinned {OUTPUT_BYTES}, {OUTPUT_SHA256}")


def main(argv):
    if len(argv) != 3:
        sys.stderr.write("usage: build_patched_ytdlp.py <upstream yt-dlp 2026.08.19 file> <output path>\n")
        return 2
    upstream_path, output_path = argv[1], argv[2]
    here = os.path.dirname(os.path.abspath(__file__))
    try:
        if os.path.lexists(output_path):
            refuse("output path", "it already exists")
        with open(upstream_path, "rb") as f:
            upstream = f.read(UPSTREAM_BYTES + 1)
        replacement_files = {}
        for name, _, _ in REPLACEMENTS:
            with open(os.path.join(here, *name.split("/")), "rb") as f:
                replacement_files[name] = f.read()
        output = build(upstream, replacement_files)
    except Refused as err:
        sys.stderr.write(f"REFUSED {err}\n")
        return 1
    fd = os.open(output_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o444)
    try:
        view = memoryview(output)
        while view:
            view = view[os.write(fd, view):]
        os.fsync(fd)
    finally:
        os.close(fd)
    sys.stdout.write(f"built {len(output)} bytes, SHA-256 {sha256(output)}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
