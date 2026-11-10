ARG BROWSER_IMAGE=page-agent-browser:latest
FROM ${BROWSER_IMAGE}

RUN apt-get update --error-on=any \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       xvfb openbox scrot python3-venv libpulse0 libopus0 libva2 libva-drm2 libva-x11-2 libxkbfile1 \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/selkies \
    && /opt/selkies/bin/pip install --no-cache-dir --no-compile --only-binary=:all: pip==25.3
RUN curl -fL --retry 3 --retry-all-errors https://github.com/selkies-project/selkies/releases/download/2.1.0/selkies-2.1.0-py3-none-any.whl -o /tmp/selkies-2.1.0-py3-none-any.whl \
    && printf '%s  /tmp/selkies-2.1.0-py3-none-any.whl\n' 8bde6207ca921cb2f38c3204fafe18d40b5578165894818ae1ca9e46fca7b966 | sha256sum -c - \
    && /opt/selkies/bin/pip install --no-cache-dir --no-compile --only-binary=:all: /tmp/selkies-2.1.0-py3-none-any.whl \
    && rm /tmp/selkies-2.1.0-py3-none-any.whl
