ARG NODE_VERSION=22
ARG BASE_IMAGE=page-agent-base:latest
FROM node:${NODE_VERSION}-bookworm-slim AS node
FROM ${BASE_IMAGE} AS browser

COPY --from=node /usr/local/ /usr/local/
ARG PLAYWRIGHT_VERSION=1.64.1
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/browsers

# Ubuntu's chromium-browser package is a Snap launcher. Use the Chromium build
# distributed by Playwright, including the full browser needed for extensions.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 \
       libdrm2 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libwayland-client0 libx11-6 \
       libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 \
       libxrandr2 libxtst6 libgtk-3-0 fonts-liberation fonts-noto-cjk fonts-noto-color-emoji util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --prefix /opt/browser --omit=dev --ignore-scripts "playwright@${PLAYWRIGHT_VERSION}" \
    && node /opt/browser/node_modules/playwright/cli.js install chromium --no-shell \
    && chmod -R a+rX /opt/browsers \
    && useradd --uid 1000 --create-home --shell /bin/bash pageagent

WORKDIR /app
