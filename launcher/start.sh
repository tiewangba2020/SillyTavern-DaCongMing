#!/usr/bin/env bash
# AI还没忘 · 本地记忆服务启动脚本（Linux / macOS）
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

NODE_EXE=""
if [[ -x "$ROOT/runtime/node/bin/node" ]]; then
    NODE_EXE="$ROOT/runtime/node/bin/node"
elif command -v node >/dev/null 2>&1; then
    NODE_EXE="node"
fi

if [[ -z "$NODE_EXE" ]]; then
    echo "[需要处理] 未找到 Node.js。请安装 Node.js 22.5+（https://nodejs.org/），"
    echo "           或把便携版解压到 $ROOT/runtime/node/（包含 bin/node）。"
    exit 1
fi

set +e
"$NODE_EXE" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:(a>=18?2:1))'
STATUS=$?
set -e
if [[ "$STATUS" == "1" ]]; then
    echo "[需要处理] Node.js 版本过低（需要 18+，推荐 22.5+）。"
    exit 1
elif [[ "$STATUS" == "2" ]]; then
    echo "[提示] Node.js 低于 22.5，未内置 SQLite，将使用降级存储（journal）。建议升级到 22.5+。"
fi

cd "$ROOT/server"
echo "正在启动AI还没忘本地服务……（Ctrl+C 停止；停止不会删除任何聊天或记忆数据）"
exec "$NODE_EXE" src/index.js "$@"
