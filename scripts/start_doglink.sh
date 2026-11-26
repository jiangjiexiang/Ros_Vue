#!/bin/bash
set -eo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source /opt/ros/humble/setup.bash
if [[ -f "$PROJECT_ROOT/../ros2_ws/install/setup.bash" ]]; then
    source "$PROJECT_ROOT/../ros2_ws/install/setup.bash"
fi

ARGS=(
    --host "${DOGLINK_HOST:-127.0.0.1}"
    --port "${DOGLINK_PORT:-8768}"
)

if ros2 pkg prefix doglink >/dev/null 2>&1; then
    exec ros2 run doglink gateway_node "${ARGS[@]}" "$@"
fi

export PYTHONPATH="$PROJECT_ROOT/ros_packages/doglink${PYTHONPATH:+:$PYTHONPATH}"
exec /usr/bin/python3 -m doglink.gateway_node "${ARGS[@]}" "$@"
