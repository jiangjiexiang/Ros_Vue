#!/bin/bash
set -eo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
    echo "请先安装 Node.js 18 或更高版本。"
    exit 1
fi

if [[ ! -d node_modules ]]; then
    npm ci --no-audit --no-fund
fi

node server/index.js &
BACKEND_PID=$!
FRONTEND_PID=""

cleanup() {
    trap - EXIT INT TERM
    if [[ -n "$FRONTEND_PID" ]]; then kill "$FRONTEND_PID" 2>/dev/null || true; fi
    kill "$BACKEND_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

npm run dev &
FRONTEND_PID=$!

echo "机器人控制台: http://localhost:5173"
wait -n "$BACKEND_PID" "$FRONTEND_PID"
