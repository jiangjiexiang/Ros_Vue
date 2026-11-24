#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${ISAACLAB_PYTHON:-/home/zju/miniconda3/envs/env_isaaclab/bin/python}"
SCENE="${1:-indoor}"
export DISPLAY="${DISPLAY:-:0}"

if [[ ! "$SCENE" =~ ^(indoor|warehouse|outdoor)$ ]]; then
    echo "用法: bash scripts/start_simulation.sh [indoor|warehouse|outdoor] [其他 Isaac Sim 参数]"
    exit 2
fi
if [[ ! -x "$PYTHON_BIN" ]]; then
    echo "未找到 Isaac Lab Python: $PYTHON_BIN"
    echo "可通过 ISAACLAB_PYTHON 环境变量指定解释器。"
    exit 1
fi
shift || true

exec "$PYTHON_BIN" "$PROJECT_ROOT/simulation/run_scene.py" \
    --scene "$SCENE" \
    --device "${SIM_DEVICE:-cuda:0}" \
    --render-interval "${SIM_RENDER_INTERVAL:-4}" \
    "$@"
