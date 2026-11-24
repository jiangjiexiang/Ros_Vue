#!/bin/bash
set -eo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source /opt/ros/humble/setup.bash
if [[ -f "$PROJECT_ROOT/../ros2_ws/install/setup.bash" ]]; then
    source "$PROJECT_ROOT/../ros2_ws/install/setup.bash"
fi

exec /usr/bin/python3 "$PROJECT_ROOT/gateway/doglink_gateway.py" \
    --host "${DOGLINK_HOST:-0.0.0.0}" \
    --port "${DOGLINK_PORT:-8768}" \
    "$@"
