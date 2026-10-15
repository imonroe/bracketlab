# syntax=docker/dockerfile:1
#
# BracketLab: one image with the Next.js web server, the queue worker, and the native
# imaging toolchain (HDRMerge for the RAW merge, darktable-cli for the JPEG preview).
#
#   docker build -t bracketlab .
#   docker compose up
#
# Base images are pinned by digest. Bump them deliberately, then rerun docker/smoke-test.sh.

ARG DEBIAN_IMAGE=debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f
ARG NODE_BUILD_IMAGE=node:22-trixie@sha256:def2655045ff1ee91b28a48cb3ec84feafef6d128bda0ff6903e7847ed0b27b4
ARG NODE_RUNTIME_IMAGE=node:22-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa

# HDRMerge has no release since v0.5.0 (2015). This upstream master commit carries the
# LibRaw 0.21 and Exiv2 0.28 API fixes that Debian's packaged 2020 snapshot predates.
ARG HDRMERGE_REPO=https://github.com/jcelaya/hdrmerge.git
ARG HDRMERGE_COMMIT=2dbfd7d1e7d9060cff160663292b169f374010e1

# darktable comes from the project's official openSUSE Build Service repository so it
# matches the version used for DNG acceptance testing. Debian 13 itself ships 5.0.1.
# This pins the darktable release; OBS rebuilds the same release often (for example
# 5.6.2-1.1+121.1, then +125.1) and keeps only the latest build, so the build suffix is
# matched with a glob. A different release still fails the build loudly.
ARG DARKTABLE_VERSION=5.6.2
ARG DARKTABLE_REPO_FPR=3247B7519EDBEAB422E900A3040524A84C70D8B5

# ---------------------------------------------------------------------------------------
FROM ${DEBIAN_IMAGE} AS hdrmerge-build
ARG HDRMERGE_REPO
ARG HDRMERGE_COMMIT

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git cmake make g++ pkg-config \
      qtbase5-dev qttools5-dev-tools libraw-dev libexiv2-dev zlib1g-dev libalglib-dev \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git init -q hdrmerge \
 && cd hdrmerge \
 && git remote add origin "${HDRMERGE_REPO}" \
 && git fetch -q --depth 1 origin "${HDRMERGE_COMMIT}" \
 && git checkout -q FETCH_HEAD \
 && test "$(git rev-parse HEAD)" = "${HDRMERGE_COMMIT}" \
 # Keep the exact source we built for GPLv3 corresponding-source obligations.
 && mkdir -p /out/share/bracketlab/sources \
 && git archive --format=tar.gz --prefix="hdrmerge-${HDRMERGE_COMMIT}/" \
      -o "/out/share/bracketlab/sources/hdrmerge-${HDRMERGE_COMMIT}.tar.gz" HEAD

# HDRMerge links Qt Widgets and builds a QApplication even in CLI mode, so Qt needs a
# platform plugin. "offscreen" needs no display.
ENV QT_QPA_PLATFORM=offscreen

# Debian's ALGLIBConfig.cmake sets ALGLIB_INCLUDE_DIRS/ALGLIB_LIB, but HDRMerge reads
# ALGLIB_INCLUDES/ALGLIB_LIBRARIES, so pass them explicitly as upstream's INSTALL.md does.
RUN cmake -S hdrmerge -B build \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX=/out \
      -DALGLIB_INCLUDES=/usr/include/libalglib \
      -DALGLIB_LIBRARIES=alglib \
 && cmake --build build -j"$(nproc)" \
 && cmake --install build \
 && /out/bin/hdrmerge --help > /dev/null

# ---------------------------------------------------------------------------------------
FROM ${NODE_BUILD_IMAGE} AS app-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build \
 && npm test

# ---------------------------------------------------------------------------------------
FROM ${NODE_RUNTIME_IMAGE} AS node-runtime

# ---------------------------------------------------------------------------------------
FROM ${DEBIAN_IMAGE} AS runtime
ARG HDRMERGE_COMMIT
ARG DARKTABLE_VERSION
ARG DARKTABLE_REPO_FPR

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && curl -fsSL https://download.opensuse.org/repositories/graphics:/darktable/Debian_13/Release.key \
      | gpg --dearmor -o /usr/share/keyrings/darktable.gpg \
 && gpg --no-default-keyring --keyring /usr/share/keyrings/darktable.gpg --with-colons --fingerprint \
      | grep -q "^fpr:::::::::${DARKTABLE_REPO_FPR}:" \
 && echo "deb [signed-by=/usr/share/keyrings/darktable.gpg] https://download.opensuse.org/repositories/graphics:/darktable/Debian_13/ /" \
      > /etc/apt/sources.list.d/darktable.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      tini \
      libimage-exiftool-perl \
      libraw23t64 libexiv2-28 libqt5widgets5t64 libalglib4.2 zlib1g libgomp1 \
      "darktable=${DARKTABLE_VERSION}-*" \
 && apt-get purge -y --auto-remove curl gnupg \
 && rm -rf /var/lib/apt/lists/*

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=hdrmerge-build /out/bin/hdrmerge /usr/local/bin/hdrmerge
COPY --from=hdrmerge-build /out/share/bracketlab /usr/share/bracketlab

RUN groupadd --system --gid 10001 bracketlab \
 && useradd --system --uid 10001 --gid bracketlab --home-dir /nonexistent --shell /usr/sbin/nologin bracketlab \
 && mkdir -p /data \
 && chown bracketlab:bracketlab /data

WORKDIR /app
COPY --from=app-build --chown=root:root /app/.next/standalone ./
COPY --from=app-build --chown=root:root /app/.next/static ./.next/static
COPY --from=app-build --chown=root:root /app/dist/worker.mjs ./dist/worker.mjs
COPY --chown=root:root docker/entrypoint.sh /usr/local/bin/bracketlab-entrypoint
COPY --chown=root:root docker/smoke-test.sh /usr/local/bin/bracketlab-smoke-test

ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    BRACKETLAB_DATA_DIR=/data \
    BRACKETLAB_ENGINE=native \
    # See the hdrmerge-build stage: Qt aborts without a platform plugin.
    QT_QPA_PLATFORM=offscreen \
    HDRMERGE_COMMIT=${HDRMERGE_COMMIT} \
    DARKTABLE_VERSION=${DARKTABLE_VERSION}

USER bracketlab
VOLUME ["/data"]
EXPOSE 3000

# tini is PID 1: it forwards signals and reaps orphaned native helper processes.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/bracketlab-entrypoint"]
CMD ["all"]
