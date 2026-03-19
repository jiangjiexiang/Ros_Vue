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
- `robot_workspace`：主工作空间路径（会 source `install/setup.bash`）
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

### 10. `sensor`
传感器坐标系配置，用于确保雷达数据在地图上正确对齐。

- `scan_frame`：2D 激光雷达的 TF 坐标系名称（如 `"base_scan"`、`"laser_frame"`、`"laser_link"`）
- `lidar_frame`：3D 点云雷达的 TF 坐标系名称（如 `"livox_frame"`），没有 3D 雷达填 `""` 即可
- `manual_offset`：手动偏移量（备用），TF 正常时设为 `null`

**如何查看你的雷达坐标系名称：**

```bash
# 方法 1：查看 /scan 话题的 frame_id
ros2 topic echo /scan --once
# 看输出中 header.frame_id 的值，那就是你的 scan_frame

# 方法 2：查看完整 TF 树
ros2 run tf2_tools view_frames
# 会生成一张 PDF 图，找到雷达对应的坐标系名称
```

**原理说明：**

系统通过 TF 坐标变换树确定雷达在地图上的位置：
```
map → odom → base_link → laser_frame（你的雷达）
```
`scan_frame` 告诉系统你的雷达坐标系叫什么，以便从 TF 树中查到 `base_link → 雷达` 的偏移量，保证雷达点画在地图上的正确位置。

## 常见改法示例

### 1. 切换工作空间
如果你的机器人代码不在默认路径下，需要修改 `paths` 指向你自己的 ROS 2 工作空间。

- `ros_setup`：ROS 2 系统安装路径，一般不用改
- `robot_workspace`：你的机器人主工作空间根目录（包含 `src/`、`install/` 等），启动时会自动 `source install/setup.bash`
- `extra_workspaces`：额外的工作空间（比如传感器驱动或自定义消息包所在的工作空间），可以填多个

```json
"paths": {
  "ros_setup": "/opt/ros/humble/setup.bash",
  "robot_workspace": "/home/your_name/workspace/your_robot_ws",
  "extra_workspaces": [
    "/home/your_name/workspace/sensor_ws"
  ]
}
```

### 2. 修改地图保存目录
建图完成后保存地图的位置，和导航时可选地图列表的读取目录。

- `save_map.save_dir`：地图保存目录，后端会自动建目录
- `save_map.command` + `args`：保存地图用的 ROS 2 命令模板，保存时会在 `args` 后面拼接完整路径
- `maps_dir`：导航页面「选择地图」下拉框读取 `.yaml` 地图文件的目录，通常和 `save_dir` 保持一致

```json
"save_map": {
  "command": "ros2",
  "args": ["run", "nav2_map_server", "map_saver_cli", "-f"],
  "save_dir": "/home/your_name/maps"
},
"maps_dir": "/home/your_name/maps"
```

### 3. 适配你自己的话题名
如果你的机器人用的话题名和默认值不同（比如加了命名空间前缀），只改这里即可，不需要改前端代码。

常用字段说明：
- `cmd_vel`：摇杆/键盘控制发布的速度指令话题
- `battery`：电池电压话题（`std_msgs/UInt16`）
- `map`：建图算法发布的栅格地图话题
- `scan`：2D 激光雷达扫描数据话题
- `tf`：坐标变换话题（用于定位机器人和雷达在地图上的位置）
- `odom`：里程计话题（显示速度等遥测信息）
- `plan`：导航规划路径话题
- `goal_pose`：发送导航目标点的话题
- `initial_pose`：设置初始位置的话题（AMCL 定位）
- `navigate_feedback`：导航进度反馈话题（剩余距离、预计时间）
- `imu`：IMU 数据话题
- `lidar`：3D 点云数据话题（如 Livox）

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

### 4. 启动时同时运行多个节点
`tasks` 中的每个类别（`startup`、`mapping`、`navigation`）都是数组，可以放多个任务。启动时会按顺序执行，`delay` 可以控制延迟。

每个任务的字段：

| 字段 | 说明 |
|------|------|
| `id` | **必须唯一**，用于跟踪和停止进程 |
| `description` | 日志显示的描述 |
| `command` | 通常填 `"ros2"` |
| `args` | 参数数组，如 `["launch", "包名", "xxx.launch.py"]` 或 `["run", "包名", "节点名"]` |
| `delay` | 延迟启动（毫秒），如 `2000` 表示等 2 秒后再启动 |

示例：启动 Foxglove + 底盘驱动：
```json
"startup": [
    {
        "id": "foxglove",
        "description": "Foxglove 数据桥接",
        "command": "ros2",
        "args": ["run", "foxglove_bridge", "foxglove_bridge", "--ros-args", "-p", "include_hidden:=true"],
        "delay": 0
    },
    {
        "id": "base_driver",
        "description": "底盘驱动节点",
        "command": "ros2",
        "args": ["launch", "your_robot_bringup", "robot.launch.py"],
        "delay": 2000
    }
]
```

### 5. 适配不同机器人的雷达位置
仅有 2D 雷达的小车：
```json
"sensor": {
  "scan_frame": "laser_frame",
  "lidar_frame": "",
  "manual_offset": null
}
```

如果 TF 查不到正确偏移（雷达点和地图边界对不上），手动填入雷达相对底盘中心的偏移：
```json
"sensor": {
  "scan_frame": "laser_frame",
  "lidar_frame": "",
  "manual_offset": { "x": 0.1, "y": 0, "yaw": 0 }
}
```
- `x`：前后偏移（米），正值 = 雷达在底盘前方
- `y`：左右偏移（米），正值 = 雷达在底盘左边
- `yaw`：旋转角度（弧度），通常为 `0`

## 技术栈
- Vue 3 + Vite
- Node.js + Express
- Foxglove WebSocket v1
- ROS 2
