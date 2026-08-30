# VideoFetch media network-namespace holder image.
# (PHASE-8B-SAFE-EGRESS-PROTOTYPE-RECOVERY-001)
#
# Replaces the recovered prototype's `alpine:vf` — a local-only image that
# existed on exactly one VM, was built by an unrecorded command and could not
# be reproduced or audited. Nothing is deployed from this file yet.
#
# SUPPLY-CHAIN CHOICE
#
# Two stages, and the base image appears ONLY in the first one:
#
#   build   Alpine + gcc + musl, used to compile deploy/media-netns/holder.c
#           into a fully static binary. Nothing from this stage is shipped.
#   final   FROM scratch, containing the single static binary and nothing else.
#
# So the base image is a BUILD-TIME dependency, not a runtime one. The shipped
# image has no shell, no libc, no package manager, no busybox, no CA bundle and
# no /etc — the attack surface inside the media namespace is one process that
# only knows how to wait for SIGTERM. A compromised Worker sharing this
# namespace gains nothing by reaching the holder, because there is nothing
# there to execute.
#
# PINNING
#
# HOLDER_BUILD_BASE is IMMUTABLE by default: an exact patch tag AND the
# manifest-list (OCI image index) digest that tag resolved to.
#
#   alpine:3.22.5@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce
#
# The digest is what actually pins the build. `alpine:3.22.5` alone is a TAG,
# and a tag is mutable even when it looks specific — Alpine republishes patch
# tags when a base package is rebuilt. `alpine:3.22` would be worse still: it
# floats across every patch release. Neither can support a claim that this
# image is reproducible, so neither is the committed default. The patch tag is
# retained alongside the digest purely so a human can read which release this
# is; the digest is the part the runtime honours.
#
# VERIFICATION PERFORMED before committing this reference:
#
#   1. `alpine:3.22.5` was resolved against the official Docker Hub registry
#      (`library/alpine`), which reported this manifest-list digest.
#   2. The digest was confirmed to be the SHA-256 of the returned index
#      document — i.e. genuinely content-addressed, not merely quoted.
#   3. Fetching the manifest BY that digest returned byte-identical content.
#   4. The index was confirmed to contain a `linux/arm64` (v8) entry, which is
#      the platform the real target actually builds on.
#
# NOT verified: this exact digest has never been built or run on the Lima VM.
# No build was performed as part of that check, and none is claimed.
#
# A multi-platform index digest is used deliberately rather than the arm64
# sub-manifest digest, so the same committed reference stays correct if the
# image is ever built on a different architecture.
#
#   docker build --platform linux/arm64 \
#     -t videofetch-media-netns:latest deploy/media-netns
#
# To move to a newer Alpine, replace BOTH the tag and the digest together, and
# repeat the verification above. An override is still possible for a private
# mirror, but the committed default no longer depends on anyone remembering to
# supply one.
#
# ARCHITECTURE
#
# The real target is a Lima VM on an Apple M1 Pro, so the image must build and
# run on linux/arm64. Nothing here is architecture-specific — no downloaded
# binary, no arch-conditional package, no x86 assumption — and the source is
# compiled for whatever platform the build runs on. Pass `--platform
# linux/arm64` explicitly when building from a non-arm64 builder.

ARG HOLDER_BUILD_BASE=alpine:3.22.5@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce

FROM ${HOLDER_BUILD_BASE} AS build

# musl-dev supplies the static libc; gcc links it in. Both are discarded with
# this stage.
RUN apk add --no-cache gcc musl-dev

WORKDIR /src
COPY holder.c ./holder.c

# -static      no dynamic loader, so `FROM scratch` is viable at all.
# -Os -s       smallest possible, symbols stripped.
# -Werror      the holder is trivial; a warning in it means something is wrong.
RUN gcc -static -Os -s -Wall -Wextra -Werror -o /holder holder.c

FROM scratch

# The single artefact. There is nothing else in this image.
COPY --from=build /holder /holder

# The holder needs no privileges whatsoever: VM root installs the nftables
# policy from OUTSIDE, via nsenter, and never through this process. Running as
# a non-root numeric uid costs nothing and removes the last reason for anything
# in this namespace to be uid 0. There is no /etc/passwd to resolve a name
# against, so the id is numeric by necessity as well as by preference.
USER 65534:65534

ENTRYPOINT ["/holder"]
