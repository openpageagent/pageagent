#!/usr/bin/env bash
set -euo pipefail

# Builds images directly from this project's source or extracted release.
# Daily updates reuse the existing runtime image; parent layers are explicit.
LAYER="${1:-app}"
BUILD_DEFINITION_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$BUILD_DEFINITION_DIR/.." && pwd)"
BASE_IMAGE="${PAGE_AGENT_BASE_IMAGE:-page-agent-base:latest}"
BROWSER_IMAGE="${PAGE_AGENT_BROWSER_IMAGE:-page-agent-browser:latest}"
RUNTIME_IMAGE="${PAGE_AGENT_RUNTIME_IMAGE:-page-agent-runtime:latest}"
APP_IMAGE="${PAGE_AGENT_IMAGE:-page-agent:latest}"

usage() {
  printf 'Usage: %s [app|runtime|browser|base|all] [project-dir] (default: app)\n' "$0" >&2
  printf '       project-dir is only supported for app and all.\n' >&2
}
[[ $# -le 2 ]] || { usage; exit 2; }
case "$LAYER" in all|base|browser|runtime|app) ;; *)
  usage
  exit 2 ;;
esac
if [[ $# -eq 2 ]]; then
  [[ "$LAYER" == app || "$LAYER" == all ]] || { usage; exit 2; }
  ROOT_DIR="$(cd -- "$2" && pwd)"
fi
command -v docker >/dev/null || { printf 'Docker is required.\n' >&2; exit 1; }
# Docker's predefined proxy arguments apply to RUN instructions without baking
# proxy settings into the image or declaring cache-invalidating ARGs there.
build_image() (
  local build_proxy_pair build_proxy_upper build_proxy_lower build_proxy_value
  local docker_args=(build)
  for build_proxy_pair in HTTP_PROXY:http_proxy HTTPS_PROXY:https_proxy NO_PROXY:no_proxy ALL_PROXY:all_proxy; do
    build_proxy_upper="${build_proxy_pair%%:*}"
    build_proxy_lower="${build_proxy_pair#*:}"
    # Explicit lowercase values, including empty values, override uppercase
    # environment variables and Docker's proxy defaults for the same protocol.
    if [[ "${!build_proxy_lower+x}" == x ]]; then
      build_proxy_value="${!build_proxy_lower}"
    elif [[ "${!build_proxy_upper+x}" == x ]]; then
      build_proxy_value="${!build_proxy_upper}"
    else
      continue
    fi
    export "$build_proxy_upper=$build_proxy_value" "$build_proxy_lower=$build_proxy_value"
    docker_args+=(--build-arg "$build_proxy_upper" --build-arg "$build_proxy_lower")
  done
  docker "${docker_args[@]}" "$@"
)
if [[ "$LAYER" == all || "$LAYER" == app ]]; then
  [[ -f "$ROOT_DIR/manifest.json" && ( -f "$ROOT_DIR/mcp-server/index.js" || -f "$ROOT_DIR/mcp-server/page-agent-mcp-server.cjs" ) ]] || {
    printf 'Project root must contain manifest.json and MCP server source or bundle: %s\n' "$ROOT_DIR" >&2
    exit 1
  }
fi
if [[ "$LAYER" == all || "$LAYER" == base ]]; then
  build_image -f "$BUILD_DEFINITION_DIR/base.Dockerfile" -t "$BASE_IMAGE" "$BUILD_DEFINITION_DIR"
fi
build_browser() {
  build_image -f "$BUILD_DEFINITION_DIR/browser.Dockerfile" --build-arg "BASE_IMAGE=$BASE_IMAGE" \
    -t "$BROWSER_IMAGE" "$BUILD_DEFINITION_DIR"
}
build_runtime() {
  if docker image inspect "$BROWSER_IMAGE" >/dev/null 2>&1; then
    printf 'Reusing browser image: %s\n' "$BROWSER_IMAGE"
  else
    build_browser
  fi
  build_image -f "$BUILD_DEFINITION_DIR/runtime.Dockerfile" --build-arg "BROWSER_IMAGE=$BROWSER_IMAGE" \
    -t "$RUNTIME_IMAGE" "$BUILD_DEFINITION_DIR"
}
build_app() {
  printf 'Application build context: %s\n' "$ROOT_DIR"
  build_image -f "$BUILD_DEFINITION_DIR/Dockerfile" --build-arg "RUNTIME_IMAGE=$RUNTIME_IMAGE" \
    -t "$APP_IMAGE" "$ROOT_DIR"
}
if [[ "$LAYER" == all || "$LAYER" == browser ]]; then build_browser; fi
if [[ "$LAYER" == all || "$LAYER" == runtime ]]; then build_runtime; fi
if [[ "$LAYER" == all || "$LAYER" == app ]]; then build_app; fi
