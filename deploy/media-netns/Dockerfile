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
# HOLDER_BUILD_BASE names an explicit Alpine PATCH version rather than a
# floating `alpine:latest` or a bare `alpine:3`. To pin harder, override it
# with a manifest-list digest at build time:
#
#   docker build --platform linux/arm64 \
#     --build-arg HOLDER_BUILD_BASE=alpine@sha256:<manifest-list-digest> \
#     -t videofetch-media-netns:latest deploy/media-netns
#
# A digest is deliberately NOT hard-coded here: this repository has never
# performed a deployment, so a digest committed now could not have been
# verified against the registry by anyone who will actually run the build. The
# operator pins it at provisioning time and records it in the runbook.
#
# ARCHITECTURE
#
# The real target is a Lima VM on an Apple M1 Pro, so the image must build and
# run on linux/arm64. Nothing here is architecture-specific — no downloaded
# binary, no arch-conditional package, no x86 assumption — and the source is
# compiled for whatever platform the build runs on. Pass `--platform
# linux/arm64` explicitly when building from a non-arm64 builder.

ARG HOLDER_BUILD_BASE=alpine:3.22

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
