# Build directly from source or an extracted release.
ARG RUNTIME_IMAGE=page-agent-runtime:latest
FROM ${RUNTIME_IMAGE} AS mcp
USER root
WORKDIR /build

COPY mcp-server/ ./mcp-server/
RUN if [ -f mcp-server/index.js ]; then \
      npm ci --prefix mcp-server --include=dev --ignore-scripts; \
    fi
COPY shared/ ./shared/
COPY resources/ ./resources/
COPY settings/ ./settings/
RUN if [ -f mcp-server/index.js ]; then \
      npm --prefix mcp-server run build:single \
      && cp mcp-server/dist/page-agent-mcp-server.cjs mcp-server/page-agent-mcp-server.cjs; \
    fi

FROM ${RUNTIME_IMAGE}
USER root

# Selkies 2.1.0 must resume a paused capture when another controller joins.
COPY docker/selkies-2.1.0.patch /tmp/selkies-2.1.0.patch
RUN cd /opt/selkies/lib/python*/site-packages \
    && git apply /tmp/selkies-2.1.0.patch \
    && rm /tmp/selkies-2.1.0.patch

COPY --from=mcp /build/mcp-server/page-agent-mcp-server.cjs /opt/page-agent/page-agent-mcp-server.cjs
COPY LICENSE mcp-server/NODEMAILER_LICENSE /opt/page-agent/
COPY . /opt/page-agent/extension/
COPY docker/start.cjs /opt/page-agent/start.cjs
COPY docker/selkies.cjs docker/openbox.xml /opt/page-agent/
RUN mkdir -p /data/page-agent

EXPOSE 10000 9999 9998
CMD ["flock", "--nonblock", "--no-fork", "/data/page-agent/browser.lock", "node", "/opt/page-agent/start.cjs"]
