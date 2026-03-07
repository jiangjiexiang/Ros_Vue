#!/bin/bash
# =================================================================
# 机器人中控台 (Robot Control Console) 启动脚本
# =================================================================

# 获取脚本所在目录
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
WORKSPACE_DIR="$SCRIPT_DIR"

echo "---------------------------------------------------"
echo "正在启动机器人中控台..."
echo "工作目录: $WORKSPACE_DIR"
echo "正在清理先前可能残留的后台进程 (Gazebo, ROS 2, RViz2)..."
pkill -9 -u "$(whoami)" -f "gzserver|gzclient|gazebo|rviz2|ros2|cartographer|foxglove|component_container_isolated|robot_state_publisher|nav2" > /dev/null 2>&1
ros2 daemon stop > /dev/null 2>&1
sleep 1
echo "---------------------------------------------------"

# 1. 检查并加载 Node.js 环境 (适配 WSL/NVM)
echo "检查 Node.js 环境..."
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh"
fi

if ! command -v node &> /dev/null; then
    echo "错误: 未检测到 Node.js。请确保已安装 Node.js (建议使用 NVM)。"
    exit 1
fi

# 2. 检查 Foxglove Bridge# 2. 检查 ROS 2 依赖
echo "检查 ROS 2 依赖..."
if ! command -v ros2 &> /dev/null; then
    echo "提示: 未检测到 ROS 2 环境，尝试加载默认安装路径..."
    [ -f "/opt/ros/humble/setup.bash" ] && source /opt/ros/humble/setup.bash
fi

# 2.5 自动加载本地工作空间 (fishbot)
FISHBOT_WORKSPACE="/home/jiang/workspace/fishbot"
if [ -f "$FISHBOT_WORKSPACE/install/setup.bash" ]; then
    echo "发现 fishbot 工作空间，正在加载环境..."
    source "$FISHBOT_WORKSPACE/install/setup.bash"
else
    echo "警告: 未能在 $FISHBOT_WORKSPACE 找到安装环境，请确保已执行 colcon build"
fi

# 2.6 WSL 兼容性设置 (解决 Gazebo 报错和显卡显示问题)
export QT_X11_NO_MITSHM=1
export LIBGL_ALWAYS_SOFTWARE=0 # 如果仿真崩溃，可尝试改为 1
# 修复 Gazebo Audio 报错 (WSL 通常没有默认音频设备)
export GAZEBO_PLUGIN_PATH=$GAZEBO_PLUGIN_PATH:/opt/ros/humble/lib

if ! command -v ros2 &> /dev/null; then
    echo "错误: 依然无法加载 ROS 2 环境，请检查安装。"
    exit 1
fi

if ! ros2 pkg list | grep "foxglove_bridge" > /dev/null 2>&1; then
    echo "警告: 未检测到 foxglove_bridge。可以运行: sudo apt install -y ros-$ROS_DISTRO-foxglove-bridge"
else
    echo "OK: Foxglove Bridge 已准备就绪。"
fi

# 进入项目目录
cd "$WORKSPACE_DIR" || { echo "错误: 无法进入目录 $WORKSPACE_DIR"; exit 1; }

# 3. 检查 node_modules 是否存在
if [ ! -d "node_modules" ]; then
    echo "未检测到 node_modules，正在安装依赖..."
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

# 4. 启动后端服务 (管理 ROS 2 任务)
if [ -f "server.js" ]; then
    echo "正在启动后端服务 (端口 3000)..."
    node server.js &
    BACKEND_PID=$!
    
    # 等待后端启动
    sleep 2

    # 触发自动启动任务 (例如 Foxglove)
    echo "正在触发自动启动服务..."
    curl -s -X POST http://localhost:3000/api/run_task/startup > /dev/null
    
    # 处理退出信号，确保先停止 ROS 任务再关闭后端
    CLEANUP_DONE=false
    cleanup() {
        if [ "$CLEANUP_DONE" = true ]; then return; fi
        CLEANUP_DONE=true
        
        echo ""
        echo "---------------------------------------------------"
        echo "正在停止机器人中控台服务..."
        
        # 释放所有由后端启动的 ROS 任务 (静默执行)
        curl -s -X POST http://localhost:3000/api/stop_task/startup > /dev/null 2>&1
        curl -s -X POST http://localhost:3000/api/stop_task/mapping > /dev/null 2>&1
        
        # 强制清理可能的残留 ROS 2 进程 (安全起见)
        # 仅针对由当前用户启动的相关进程，排除 Gazebo (用户手动管理)
        pkill -9 -u "$(whoami)" -f "ros2|cartographer|foxglove|component_container_isolated|robot_state_publisher|nav2" > /dev/null 2>&1
        ros2 daemon stop > /dev/null 2>&1
        
        # 杀掉后端进程
        if [ -n "$BACKEND_PID" ]; then
            kill $BACKEND_PID 2>/dev/null
        fi
        
        echo "中控台已安全退出，所有关联进程已清理。"
        echo "---------------------------------------------------"
    }
    trap cleanup INT TERM EXIT
else
    echo "警告: 未找到 server.js，后端服务未启动。"
fi

# 5. 启动开发服务器 (前端界面)
echo "正在启动前端界面..."
npm run dev
