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
ENV CHROME_DEVEL_SANDBOX=/usr/local/sbin/chrome-devel-sandbox

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    nginx \
    openbox \
    xz-utils \
    x11vnc \
    x11-utils \
    xvfb \
    websockify \
    novnc \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  id -u pwuser >/dev/null; \
  arch="$(uname -m)"; \
  case "${arch}" in \
    x86_64) sandbox="/ms-playwright/chromium-1234/chrome-linux64/chrome_sandbox" ;; \
    aarch64) sandbox="/ms-playwright/chromium-1234/chrome-linux/chrome_sandbox" ;; \
    *) echo "Unsupported Chromium sandbox architecture: ${arch}" >&2; exit 1 ;; \
  esac; \
  test -f "${sandbox}"; \
  chown root:root "${sandbox}"; \
  chmod 4755 "${sandbox}"; \
  ln -s "${sandbox}" /usr/local/sbin/chrome-devel-sandbox; \
  test "$(stat -c '%u:%g:%a' "${sandbox}")" = "0:0:4755"

ARG S6_OVERLAY_VERSION=3.2.3.2
ARG S6_OVERLAY_NOARCH_SHA256=5379750ed30a84bbd2e2dd74847ba6b5bd29cd0b2e3ea2ec58049b57eb2eda12
ARG S6_OVERLAY_X86_64_SHA256=e6befcc96a437a3831386ecfc51808c5d3e939dc5fe3c02ae9284599e8aa2408
ARG S6_OVERLAY_AARCH64_SHA256=b17f17a82e7a515c682a91edaf2ffdabb73f891981b6c1fd712115693a2f8b4c
RUN set -eux; \
  arch="$(uname -m)"; \
  case "${arch}" in \
    x86_64) s6_arch_sha256="${S6_OVERLAY_X86_64_SHA256}" ;; \
    aarch64) s6_arch_sha256="${S6_OVERLAY_AARCH64_SHA256}" ;; \
    *) echo "Unsupported s6-overlay architecture: ${arch}" >&2; exit 1 ;; \
  esac; \
  curl -fsSL "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz" -o /tmp/s6-overlay-noarch.tar.xz; \
  curl -fsSL "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${arch}.tar.xz" -o /tmp/s6-overlay-arch.tar.xz; \
  echo "${S6_OVERLAY_NOARCH_SHA256}  /tmp/s6-overlay-noarch.tar.xz" | sha256sum -c -; \
  echo "${s6_arch_sha256}  /tmp/s6-overlay-arch.tar.xz" | sha256sum -c -; \
  tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz; \
  tar -C / -Jxpf /tmp/s6-overlay-arch.tar.xz; \
  rm -f /tmp/s6-overlay-noarch.tar.xz /tmp/s6-overlay-arch.tar.xz

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY tsconfig.build.json ./
COPY addon-package-manifest.json ./
RUN npm ci
COPY bridge ./bridge
RUN npm run build
RUN npm prune --omit=dev

COPY rootfs /
RUN find /etc/s6-overlay/s6-rc.d -type f \( -name run -o -name up \) -exec chmod +x {} +
RUN chmod +x /etc/s6-overlay/scripts/*

EXPOSE 8099
ENTRYPOINT ["/init"]
