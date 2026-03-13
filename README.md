# 机器人中控台 (Robot Control Console)

## 项目简介
这是一个基于 Web 的机器人中控台，用于实时监控和控制 ROS1 机器人。该项目集成了地图展示、摇杆控制、状态监测以及建图管理等功能。
![1](img/1.png)
## 核心功能
*   实时 SLAM 栅格地图显示。
*   机器人摇杆远程控制。
*   电池电压与里程计数据实时监测。
*   可视化建图控制（开始/停止建图）。
*   地图保存功能，支持在网页端输入地图名称。
*   视图自动重置功能，在开始建图/导航时自动对齐视野。
*   页面自动连接 ROSBridge WebSocket（默认 `ws://<页面主机>:8765`）。
*   连接成功会显示“已连接”，连接失败会显示错误信息。

## 环境要求
*   Ubuntu 20.04/22.04 (WSL 兼容)
*   ROS1 Noetic
*   Node.js (建议版本 v18+)
*   rosbridge_server

## 快速启动
在项目根目录下执行以下脚本，即可同时启动后端服务和前端界面：
```bash
bash start_console.sh
```
启动成功后，在浏览器访问：`http://localhost:5173`

## 部署配置 (重要)
当您将项目部署到自己的电脑或机器人上时，请务必根据实际路径修改以下配置文件：

### 1. 修改 `ros_config.json`
该文件位于项目根目录，控制着所有 ROS 指令的触发和路径：

*   **`save_dir`**: 修改为您希望保存地图的 **绝对路径**。
    ```json
    "save_dir": "/home/your_username/your_workspace/maps"
    ```
*   **`maps_dir`**: 修改为您读取历史地图的目录（通常与 `save_dir` 一致）。
*   **`tasks`**:
    *   如果您使用的导航包或建图包名称不同（例如不是 `fishbot_navigation`），请修改 `args` 中的包名和 `.launch` 文件名。
*   **`topics`**:
    *   如果您的机器人传感器话题名不同（如激光雷达话题不是 `/scan`），请在此处修改。

### 2. 修改 `server.js`
后端服务中 hardcode 了部分路径，请搜索以下变量并修改：
*   **`ros1Setup`**: 修改为您的 ROS1 工作空间 `setup.bash` 的实际路径。
    ```javascript
    const ros1Setup = '/home/your_username/catkin_ws/devel/setup.bash';
    ```

### 3. 修改 `start_console.sh`
启动脚本中也包含一些本地路径：
*   **`FISHBOT_WORKSPACE`**: 修改为您的机器人工作空间路径。
    ```bash
    FISHBOT_WORKSPACE="/home/your_username/workspace/fishbot"
    ```

### 4. 修改 `src/App.vue` (可选)
如果您的网页控制端和机器人不在同一台机器上：
*   找到 `const DEFAULT_WS_URL = \`ws://${window.location.hostname}:8765\``。
*   将 `window.location.hostname` 改为机器人的 **实际 IP 地址**。

## 配置说明
项目核心逻辑由 `ros_config.json` 驱动，你可以直接在该文件中修改 ROS1 指令：
*   `startup`: 配置后台自动运行的任务（如 rosbridge_websocket）。
*   `mapping`: 配置建图算法及其参数。
*   `navigation`: 配置导航启动命令及参数。
*   `save_map`: 配置地图保存命令及保存路径。
*   `topics`: 配置前端使用的话题名（不同机器人可直接改这里）。

`topics` 典型字段：
*   `cmd_vel`
*   `battery`
*   `map`
*   `scan`
*   `tf`
*   `odom`
*   `plan`
*   `goal_pose`
*   `initial_pose`
*   `navigate_feedback`
*   `imu`

## 地图保存说明
通过网页端保存的地图文件（.yaml 和 .pgm）默认存储在以下路径：
`/home/jiang/workspace/fishbot/maps`

## 技术路线
*   前端框架：Vue 3 + Vite
*   后端服务：Node.js (Express)
*   协议：ROSBridge WebSocket 协议
*   机器人系统：ROS1
