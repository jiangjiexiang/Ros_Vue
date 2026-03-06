#!/bin/bash
# =================================================================
# 机器人中控台 (Robot Control Console) 启动脚本
# =================================================================

# 获取脚本所在目录
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
WORKSPACE_DIR="/home/yahboom/workspace"

echo "---------------------------------------------------"
echo "正在启动机器人中控台..."
echo "工作目录: $WORKSPACE_DIR"
echo "---------------------------------------------------"

# 进入项目目录
cd "$WORKSPACE_DIR" || { echo "错误: 无法进入目录 $WORKSPACE_DIR"; exit 1; }

# 检查 node_modules 是否存在
if [ ! -d "node_modules" ]; then
    echo "未检测到依(node_modules)，正在安装依赖..."
    npm install
fi

# 获取本机 IP (用于显示访问地址)
LOCAL_IP=$(hostname -I | awk '{print $1}')

echo ""
echo "中控台即将运行。"
echo "本机访问地址: http://localhost:5173"
if [ -n "$LOCAL_IP" ]; then
    echo "外部设备访问: http://$LOCAL_IP:5173"
fi
echo "按下 Ctrl+C 可停止运行。"
echo "---------------------------------------------------"

# 启动后台服务 (管理 ROS 2 launch)
echo "正在启动后端服务 (端口 3000)..."
node server.js &
BACKEND_PID=$!

# 处理退出信号，关闭后台程序
trap "echo '正在停止中控台服务...'; kill $BACKEND_PID; exit" INT TERM EXIT

# 启动开发服务器
echo "正在启动前端界面..."
npm run dev
