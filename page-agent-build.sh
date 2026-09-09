#!/usr/bin/env bash
set -euo pipefail

APP="page-agent-extension"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="$ROOT_DIR/dist"
ZIP_OUT=""
MINIFY=1
BUILD_STARTED_AT="$(date +%s)"

cd "$ROOT_DIR"

usage() {
  cat <<'EOF'
用法：
  ./page-agent-build.sh
  ./page-agent-build.sh --no-minify
  ./page-agent-build.sh --zip dist/custom-name.zip

选项：
  --zip, -o PATH    将打包 ZIP 写入指定路径。
  --no-minify       原样复制 JS/CSS；跳过 terser 和 clean-css。

输出：
  dist/page-agent-extension-<version>/
  dist/page-agent-extension-<version>.zip         （包含：page-agent-extension/）
  dist/page-agent-extension-<version>-no-minify.zip  （--no-minify）

说明：
  - ZIP 文件名包含版本号，但 ZIP 内的顶层目录不包含版本号（例如解压后得到 page-agent-extension/）。
  - 本脚本实际创建的是 ZIP 包，而不是 .crx 文件。
  - 生成的 ZIP 用于内部发布，作为未打包的扩展程序包使用。
  - 默认会压缩 JS/CSS，但不会混淆代码。
  - 需要可读且未压缩的程序包时，使用 --no-minify。
  - JS 属性名、全局导出名、文件名和目录结构都会保留。
EOF
}

fail() {
  echo "错误：$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "缺少必要命令：$1"
}

sync_builtin_flow_index() {
  local builtin_dir="$ROOT_DIR/builtin-flows"
  mkdir -p "$builtin_dir"
  BUILTIN_DIR="$builtin_dir" node <<'NODE'
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dir = process.env.BUILTIN_DIR;
const indexFile = path.join(dir, 'index.json');
const files = fs.readdirSync(dir)
  .filter((name) => name.endsWith('.json') && name !== 'index.json')
  .sort((a, b) => a.localeCompare(b));
const flows = [];
const flowGroups = [];

for (const file of files) {
  const fullPath = path.join(dir, file);
  const raw = fs.readFileSync(fullPath, 'utf8');
  let bundle;
  try {
    bundle = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file}: invalid JSON: ${err.message}`);
  }
  const hash = 'sha256:' + crypto.createHash('sha256').update(raw).digest('hex');
  if (bundle && bundle.kind === 'pfa-flow' && bundle.flow && bundle.flow.id) {
    flows.push({ file, id: bundle.flow.id, label: bundle.flow.label || bundle.flow.name || bundle.flow.id, hash });
  } else if (bundle && bundle.kind === 'pfa-flow-group' && bundle.flowGroup && bundle.flowGroup.id) {
    flowGroups.push({ file, id: bundle.flowGroup.id, label: bundle.flowGroup.label || bundle.flowGroup.name || bundle.flowGroup.id, hash });
  } else {
    throw new Error(`${file}: expected exported pfa-flow or pfa-flow-group bundle`);
  }
}

const next = JSON.stringify({ version: 1, flows, flowGroups }, null, 2) + '\n';
const current = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : '';
if (current !== next) fs.writeFileSync(indexFile, next);
console.log(`Wrote ${path.relative(process.cwd(), indexFile)} (${flows.length} flow${flows.length === 1 ? '' : 's'}, ${flowGroups.length} flow group${flowGroups.length === 1 ? '' : 's'})`);
NODE
}

stage_start() {
  STAGE_NAME="$1"
  STAGE_STARTED_AT="$(date +%s)"
  echo "==> $STAGE_NAME"
}

stage_done() {
  local finished_at
  finished_at="$(date +%s)"
  echo "    已完成，用时 $((finished_at - STAGE_STARTED_AT)) 秒"
}

detect_parallelism() {
  local cpu_count=4
  if command -v getconf >/dev/null 2>&1; then
    cpu_count="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
  elif command -v sysctl >/dev/null 2>&1; then
    cpu_count="$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"
  fi
  [[ "$cpu_count" =~ ^[1-9][0-9]*$ ]] || cpu_count=4
  ((cpu_count > 8)) && cpu_count=8
  echo "$cpu_count"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --zip|-o)
      [[ $# -ge 2 ]] || fail "$1 需要指定路径"
      ZIP_OUT="$2"
      shift 2
      ;;
    --no-minify)
      MINIFY=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "未知参数：$1"
      ;;
  esac
done

require_command node
require_command npm
require_command rsync
require_command zip
if [[ "$MINIFY" -eq 1 ]]; then
  require_command find
  require_command mv
  require_command xargs
fi

TERSER_BIN="$ROOT_DIR/node_modules/.bin/terser"
CLEANCSS_BIN="$ROOT_DIR/node_modules/.bin/cleancss"
MINIFY_JOBS="${MINIFY_JOBS:-$(detect_parallelism)}"
if [[ "$MINIFY" -eq 1 ]]; then
  [[ -x "$TERSER_BIN" ]] || fail "缺少 terser；请运行 npm install"
  [[ -x "$CLEANCSS_BIN" ]] || fail "缺少 clean-css-cli；请运行 npm install"
  [[ "$MINIFY_JOBS" =~ ^[1-9][0-9]*$ ]] || fail "MINIFY_JOBS 必须是正整数"
fi

VERSION="$(node -p "require('./manifest.json').version" 2>/dev/null)" || fail "无法读取 manifest.json 中的版本号"
[[ -n "$VERSION" ]] || fail "manifest.json 中的版本号为空"

STAGING_DIR="$DIST_DIR/${APP}"
BUILD_DIR="$DIST_DIR/${APP}-${VERSION}"
MCP_BUNDLE_SRC="$ROOT_DIR/mcp-server/dist/page-agent-mcp-server.cjs"
MCP_BUNDLE_DEST_REL="mcp-server/page-agent-mcp-server.cjs"
if [[ -z "$ZIP_OUT" ]]; then
  if [[ "$MINIFY" -eq 1 ]]; then
    ZIP_OUT="$DIST_DIR/${APP}-${VERSION}.zip"
  else
    ZIP_OUT="$DIST_DIR/${APP}-${VERSION}-no-minify.zip"
  fi
elif [[ "$ZIP_OUT" != /* ]]; then
  ZIP_OUT="$ROOT_DIR/$ZIP_OUT"
fi

stage_start "同步内置流程索引"
sync_builtin_flow_index
stage_done

stage_start "准备 Turndown 运行时"
npm run build:turndown-runtime
[[ -f "$ROOT_DIR/dependencies/turndown/turndown.browser.umd.js" ]] || fail "未生成 Turndown 运行时"
[[ -f "$ROOT_DIR/dependencies/turndown/turndown-plugin-gfm.js" ]] || fail "未生成 Turndown GFM 运行时"
stage_done

stage_start "构建 MCP 服务器单文件包"
[[ -x "$ROOT_DIR/mcp-server/node_modules/.bin/esbuild" ]] || fail "缺少 MCP 服务器构建依赖：mcp-server/node_modules/.bin/esbuild。请先在打包机器上执行一次 'cd mcp-server && npm install'。发布的 ZIP 仍只包含 MCP 服务器单文件。"
(cd "$ROOT_DIR/mcp-server" && npm run build:single)
[[ -f "$MCP_BUNDLE_SRC" ]] || fail "未生成 MCP 服务器包：$MCP_BUNDLE_SRC"
stage_done

stage_start "准备 dist 中的扩展发布目录"
rm -rf "$STAGING_DIR" "$BUILD_DIR"
rm -f "$ZIP_OUT"
mkdir -p "$STAGING_DIR"
mkdir -p "$(dirname "$ZIP_OUT")"

rsync -a "$ROOT_DIR/" "$STAGING_DIR/" \
  --filter=':- .gitignore' \
  --exclude ".git/" \
  --exclude ".gitignore" \
  --exclude ".github/" \
  --exclude ".vscode/" \
  --exclude "docs/" \
  --exclude "CONTRIBUTING.md" \
  --exclude "SECURITY.md" \
  --exclude "README.md" \
  --exclude "tests/" \
  --exclude "mcp-server/" \
  --exclude "dist/" \
  --exclude "node_modules/" \
  --exclude "package.json" \
  --exclude "package-lock.json" \
  --exclude "pnpm-lock.yaml" \
  --exclude "yarn.lock" \
  --exclude ".DS_Store" \
  --exclude "*.pem" \
  --exclude "*.crx" \
  --exclude "*.zip" \
  --exclude "$(basename "$0")"
stage_done

stage_start "将 MCP 服务器包从 mcp-server/dist 复制到扩展发布目录"
mkdir -p "$STAGING_DIR/$(dirname "$MCP_BUNDLE_DEST_REL")"
cp "$MCP_BUNDLE_SRC" "$STAGING_DIR/$MCP_BUNDLE_DEST_REL"
chmod 755 "$STAGING_DIR/$MCP_BUNDLE_DEST_REL"
stage_done

if [[ "$MINIFY" -eq 1 ]]; then
  stage_start "压缩 JavaScript（不混淆，$MINIFY_JOBS 个并行任务）"
  export TERSER_BIN
  find "$STAGING_DIR" -type f -name "*.js" \
    ! -path "$STAGING_DIR/dependencies/turndown/*.js" \
    ! -path "$STAGING_DIR/builtin-skills/*" \
    -print0 | xargs -0 -P "$MINIFY_JOBS" -n 1 bash -c '
      file="$1"
      tmp="${file}.tmp.$$"
      "$TERSER_BIN" "$file" --ecma 2020 --compress passes=2 --comments false --output "$tmp"
      mv "$tmp" "$file"
    ' _
  stage_done

  stage_start "压缩 CSS（$MINIFY_JOBS 个并行任务）"
  export CLEANCSS_BIN
  find "$STAGING_DIR" -type f -name "*.css" ! -path "$STAGING_DIR/builtin-skills/*" -print0 | xargs -0 -P "$MINIFY_JOBS" -n 1 bash -c '
    file="$1"
    tmp="${file}.tmp.$$"
    "$CLEANCSS_BIN" -o "$tmp" "$file" >/dev/null
    mv "$tmp" "$file"
  ' _
  stage_done
else
  echo "==> 跳过 JS/CSS 压缩"
fi

stage_start "创建 ZIP"
(
  cd "$DIST_DIR"
  zip -qr "$ZIP_OUT" "${APP}"
)

# 将暂存目录重命名为带版本号的目录，便于查看
mv "$STAGING_DIR" "$BUILD_DIR"

[[ -f "$ZIP_OUT" ]] || fail "未在预期路径生成 ZIP：$ZIP_OUT"
zip -T "$ZIP_OUT" >/dev/null
stage_done

echo
echo "完成。"
echo "发布目录：$BUILD_DIR"
echo "ZIP：       $ZIP_OUT"
echo "总用时：    $(($(date +%s) - BUILD_STARTED_AT)) 秒"
echo
echo "安装："
echo "  1. 将 ZIP 发送到目标机器并解压。"
echo "  2. 打开 chrome://extensions/ 或 edge://extensions/。"
echo "  3. 启用开发者模式。"
echo "  4. 点击“加载已解压的扩展程序”，选择包含 manifest.json 的解压目录。"
