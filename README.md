# 机器人中控台 (Robot Control Console)

用于 ROS 2 机器人的 Web 中控台，支持建图、导航、遥控、状态监控与地图保存。

![控制台预览](img/1.png)

## 功能
- 实时显示 SLAM 栅格地图、LaserScan、点云、轨迹与目标点
- Web 摇杆发布 `cmd_vel`
- 建图任务启动/停止
- 导航任务启动/停止（支持选择地图）
- 地图保存与历史地图列表
- 自动连接 Foxglove WebSocket（默认 `ws://<当前页面主机>:8765`）

## 环境要求
- Ubuntu 22.04（WSL 可用）
- ROS 2 Humble
- Node.js 18+
- `foxglove_bridge`

## 快速启动
在 `Ros_Vue` 目录执行：

```bash
bash start_console.sh
```

默认访问地址：
- 前端：`http://localhost:5173`
- 后端：`http://localhost:3000`

## 配置总览（重点）
项目主要通过 `ros_config.json` 配置，`start_console.sh` 和 `server.js` 都会读取它。

关键结论：
- 改 `ros_config.json` 后，后端接口下一次请求会按新配置执行（`server.js` 是按请求读取配置）
- 前端通过 `/api/runtime_config` 读取 `topics`，用于订阅/发布话题
- `start_console.sh` 启动时读取一次路径、端口、环境变量等配置

## `ros_config.json` 怎么用

### 1. `tasks`
用于定义按钮触发的 ROS 任务。

- `tasks.startup`：启动中控台后自动触发（脚本会调用 `/api/run_task/startup`）
- `tasks.mapping`：建图开始/停止对应任务
- `tasks.navigation`：导航开始/停止对应任务（`/api/start_navigation` 会额外加 `map:=xxx.yaml` 参数）

每个 task 项字段：
- `id`：任务唯一 ID，用于进程跟踪和停止
- `description`：日志显示用途
- `command`：通常是 `ros2`
- `args`：命令参数数组
- `delay`：延迟启动毫秒数（可选）

### 2. `save_map`
用于“保存地图”接口 `/api/save_map`。

- `command` + `args`：保存地图命令模板
- `save_dir`：地图保存目录（会自动 `mkdir -p`）

实际执行会在 `args` 末尾拼接 `<save_dir>/<mapName>`。

### 3. `maps_dir`
用于“地图列表”接口 `/api/list_maps`。

- 后端会读取这个目录下所有 `.yaml` 文件作为可选地图
- 若未配置，回退到 `save_map.save_dir`

### 4. `paths`
用于自动 `source` ROS 环境（`server.js` 和 `start_console.sh` 都会用）。

- `ros_setup`：如 `/opt/ros/humble/setup.bash`
- `fishbot_workspace`：主工作空间路径（会 source `install/setup.bash`）
- `extra_workspaces`：额外工作空间数组（用于消息包/传感器包）

### 5. `ports`
端口配置。

- `backend`：Node 后端端口（`server.js` 监听端口）
- `frontend`：Vite 前端端口（`start_console.sh` 启动 `npm run dev` 使用）

### 6. `node`
用于启动脚本的 Node/NVM 自动安装逻辑。

- `nvm_version`
- `version`（例如 `lts/*`）

### 7. `cleanup`
进程清理用的正则（启动前/退出时 `pkill` 使用）。

- `startup_regex`
- `shutdown_regex`

### 8. `env`
启动脚本导出的环境变量。

- `qt_x11_no_mitshm`
- `libgl_always_software`
- `gazebo_plugin_path_append`

### 9. `topics`
前端运行时话题映射（核心）。

前端会读取后端 `/api/runtime_config` 返回的 `topics`，并覆盖默认值。常用字段：

- `cmd_vel`
- `battery`
- `map`
- `scan`
- `tf`
- `odom`
- `plan`
- `goal_pose`
- `initial_pose`
- `navigate_feedback`
- `imu`
- `lidar`

如果你的机器人话题名不同，只改这里即可，不需要改前端源码。

## 常见改法示例

### 1. 切换工作空间
```json
"paths": {
  "ros_setup": "/opt/ros/humble/setup.bash",
  "fishbot_workspace": "/home/your_name/workspace/your_robot_ws",
  "extra_workspaces": [
    "/home/your_name/workspace/sensor_ws"
  ]
}
```

### 2. 修改地图保存目录
```json
"save_map": {
  "command": "ros2",
  "args": ["run", "nav2_map_server", "map_saver_cli", "-f"],
  "save_dir": "/home/your_name/maps"
},
"maps_dir": "/home/your_name/maps"
```

### 3. 适配你自己的话题名
```json
"topics": {
  "cmd_vel": "/robot/cmd_vel",
  "battery": "/robot/battery",
  "map": "/slam_map",
  "scan": "/livox/scan",
  "tf": "/tf",
  "odom": "/odom"
}
```

## 技术栈
- Vue 3 + Vite
- Node.js + Express
- Foxglove WebSocket v1
- ROS 2
