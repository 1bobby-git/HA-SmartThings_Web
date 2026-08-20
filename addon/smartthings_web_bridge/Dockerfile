# syntax=docker/dockerfile:1.7

ARG BUILD_ARCH
ARG PLAYWRIGHT_VERSION=1.62.1
ARG PLAYWRIGHT_BASE_AMD64=mcr.microsoft.com/playwright:v1.62.1-resolute@sha256:af843e6c2a9ad4df5daa8a68268fb59d28ab5ef55203f67c1573e4d0e154e176
ARG PLAYWRIGHT_BASE_AARCH64=mcr.microsoft.com/playwright:v1.62.1-resolute@sha256:13d069848a305570be16443bb904132fef75fcd897703022a1a1c7841e0abac9

FROM ${PLAYWRIGHT_BASE_AMD64} AS amd64
FROM ${PLAYWRIGHT_BASE_AARCH64} AS aarch64
FROM ${BUILD_ARCH}

ARG PLAYWRIGHT_VERSION
ENV PLAYWRIGHT_VERSION=${PLAYWRIGHT_VERSION}
ENV DISPLAY=:99
ENV STW_DATA_DIR=/data
ENV STW_HOST=127.0.0.1
ENV STW_PORT=8098

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    nginx \
    openbox \
    xz-utils \
    x11vnc \
    xvfb \
    websockify \
    novnc \
  && rm -rf /var/lib/apt/lists/*

ARG S6_OVERLAY_VERSION=3.2.3.2
RUN set -eux; \
  arch="$(uname -m)"; \
  curl -fsSL "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz" -o /tmp/s6-overlay-noarch.tar.xz; \
  curl -fsSL "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${arch}.tar.xz" -o /tmp/s6-overlay-arch.tar.xz; \
  tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz; \
  tar -C / -Jxpf /tmp/s6-overlay-arch.tar.xz; \
  rm -f /tmp/s6-overlay-noarch.tar.xz /tmp/s6-overlay-arch.tar.xz

WORKDIR /app
COPY package.json package-lock.json tsconfig.json vitest.config.ts ./
COPY bridge ./bridge
RUN npm ci --omit=dev

COPY addon/smartthings_web_bridge/rootfs /
COPY addon/smartthings_web_bridge/apparmor.txt /etc/apparmor.d/smartthings_web_bridge
RUN chmod +x /etc/s6-overlay/s6-rc.d/*/run

EXPOSE 8099
ENTRYPOINT ["/init"]
