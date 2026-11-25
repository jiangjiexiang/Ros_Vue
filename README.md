# 四足巡检机器狗平台

用于四足巡检机器狗的 Vue 平台，包含实时地图、运动控制、巡检任务、地图场景、巡检记录、告警和多机器狗管理。

## 启动

### 使用 ROS 开发容器

Docker 只提供 ROS 2、Node.js 和 RViz 开发工具，不包含本项目，也不会自动启动项目。源码挂载在容器的 `/root/ros2_ws`。

```bash
docker exec -it ros2-humble-dev bash
```

进入容器后手动启动：

```bash
cd /root/ros2_ws/RobotConsole
npm ci
bash scripts/start_console.sh
```

打开 http://localhost:5173 。修改 Vue 文件后页面会自动刷新。

### 本机 Ubuntu / WSL

需要 Node.js 18+、ROS 2 Humble 和 foxglove_bridge。

```bash
npm ci
bash scripts/start_console.sh
```

脚本会启动前端、后端和 Foxglove。

## 配置

优先在网页“系统配置”中修改，保存后立即写入配置文件，不需要修改前端或后端代码。可配置 ROS 工作空间、地图目录、全部 ROS 话题（包括相机和 3D 点云）、全局线/角速度、指令频率、断链停车时间、仿真是否自动建图以及建图和导航任务。话题修改后请重新连接机器人，任务修改后请重启对应任务；`mapping.auto_start` 默认是 `false`，在下次启动仿真场景时生效。

“机器狗管理”可为每台设备选择 2D/3D 雷达、建图算法和定位方式。2D 支持 SLAM Toolbox、Cartographer 和 AMCL；3D 支持 FAST-LIO 与 FAST-LIO Localization，也可填写自定义 ROS 包和 Launch 文件名。首页只展示这些实际配置，不代表算法已在线运行。

FAST-LIO 接入默认点云为 `/points`、IMU 为 `/imu`；常见输出为 `/Odometry`、`/cloud_registered`、`/path` 和 `camera_init → body` TF。平台会在选择 FAST-LIO 且未另改里程计时使用 `/Odometry`，并兼容其 TF 坐标链。所有话题仍可在系统配置中修改。算法本体及所需 ROS 包由机器人侧部署，平台负责配置、启动任务管理和结果接入。

也可以手工修改 `config/ros_config.json`：

```json
{
  "workspace": "..",
  "maps_dir": "maps"
}
```

- `workspace`：ROS 工作空间目录，后端会加载其中的 `install/setup.bash`。默认是项目上一级目录，也可以改成你的 ROS 工作空间绝对路径。
- `maps_dir`：地图保存和读取目录。相对路径按项目目录计算。
- `tasks`：Foxglove、建图和导航命令。
- `topics`：机器人话题名称。

前端地址默认无需设置。如果后端或 Foxglove 不在本机，修改 `src/config.js` 即可。

## 页面与多机器人

左侧导航包含七个页面：

- **巡检总览**：机器狗状态、任务进展、完成率和最新告警。
- **巡检工作台**：机器狗机载实时画面、SLAM、导航点、建图和运动控制集中在同一页面。
- **单机监控**：实时地图、运动控制、遥测和图层。
- **巡检任务**：任务列表、巡检点与动作编辑、执行进度和控制。
- **地图场景**：建图、导航、多场景切换和栅格地图编辑。
- **巡检记录**：任务筛选、巡检点结果、传感器读数和时间线。
- **告警中心**：告警筛选、确认、处理和关联任务回溯。
- **机器狗管理**：新增、编辑、删除和切换机器狗配置，支持实体机器狗与本机仿真一键接入。
- **系统配置**：在线修改 ROS 工作空间、地图目录、全部话题、相机以及建图和导航任务参数。

“巡检工作台”的“机器人连接”只需从下拉框选择配置好的机器人，选择后会自动连接或切换，不需要重复输入 IP，也没有手动连接/断开按钮。

机器人配置同时保存在后端 `data/robots.json` 和当前浏览器的 `localStorage`。每台机器人支持独立局域网 IP / 主机名、端口、通信协议和可选话题命名空间，例如命名空间为 `robot2` 时，`/scan` 会转换为 `/robot2/scan`。平台预置室内、仓库、户外三条 3D 仿真狗，均使用 FAST-LIO。

通信支持 Foxglove（默认端口 `8765`）、ROS 原生 `rosbridge_server`（默认端口 `9090`）和自研 DogLink。三条仿真狗使用 DogLink，统一网关进程分别监听 `8770`、`8771`、`8772`，各连接只订阅对应场景命名空间的话题。

当前为一个活动连接：切换机器人会断开上一台并清空其地图与遥测，再连接新机器人，避免不同机器人的数据混在同一地图中。

## 地图管理

在右侧“任务控制”中打开“地图”标签，可以：

- 查看地图名称、修改时间和文件大小。
- 在多个场景之间切换，并将选中的场景用于导航。
- 使用障碍、空闲、未知三种笔刷直接编辑 SLAM 栅格地图。
- 调整笔刷大小、缩放和平移视图，支持撤销和重做。
- 覆盖保存或另存为新场景；覆盖保存前会在地图目录的 `.backups/` 中备份原图。
- 重命名地图，同时更新 YAML 与 PGM 文件名及 YAML 内的图像路径。
- 删除不再需要的地图文件。
- 修改后自动刷新导航页面的地图下拉框。

删除正在用于导航的地图前，请先停止对应导航任务。编辑或切换场景后，请重启导航任务以加载最新地图。

## 开发

```text
src/App.vue                 页面布局
src/assets/main.css         全局样式
src/components/             页面组件
src/composables/useFoxglove.js  ROS 数据通信
src/features/               巡检业务页面
src/layout/                 应用外壳与导航
src/router.js               页面路由
server/index.js             后端与 ROS 任务管理
config/ros_config.json      ROS 配置
scripts/start_console.sh    启动脚本
scripts/test_sub.py         ROS 订阅测试脚本
```

检查代码：

```bash
npm run build
node --check server/index.js
```

## 建图和导航

本项目不包含具体机器人的建图或导航实现，默认 `mapping` 和 `navigation` 任务为空。根据自己的机器人修改 `config/ros_config.json`，例如：

```json
{
  "command": "ros2",
  "args": ["launch", "your_slam_package", "slam.launch.py"]
}
```

保存地图默认使用 `nav2_map_server/map_saver_cli`，也可以修改 `save_map`。

仿真场景支持独立的“纯定位 + 点击导航”：在工作台“定位”或“导航”页选择平台保存的 ASCII PCD 地图并启动，FAST-LIO 提供局部里程计，项目内 ICP 节点将位姿校正到保存地图，输出 `/localization`、`/localization/path` 和 `/global_map`。启动后直接双击地图目标即可进行 A* 规划与关节运动控制，无需预设巡检任务；实时点云会叠加到障碍栅格并重规划，人工 WASD 指令会打断自动导航。建图与纯定位使用独立任务状态，停止场景会同时停止相关任务。

测试不同机器人或仿真器时，可通过 `ROS_CONFIG_FILE` 指向项目外的配置文件，不需要修改仓库默认配置：

```bash
ROS_CONFIG_FILE=/path/to/test_config.json bash scripts/start_console.sh
```

网页和 Foxglove 可以独立运行；实际建图、保存地图和导航需要你的 ROS 环境提供对应功能包。

## GPU 仿真测试

项目提供三个 Isaac Sim 场景，均使用 Unitree Go2 关节模型、真实碰撞和 CUDA 物理计算：

- `indoor`：室内巡检，包含办公室隔墙、门洞、桌椅和巡检柜。
- `warehouse`：仓库障碍，包含货架、堆垛、安全柱和窄通道。
- `outdoor`：户外坡道，包含 12° 连续坡道、平台、台阶和岩石。

在“仿真测试”中可以分别启动三条狗，三个场景可同时运行。平台默认使用无界面物理实例，并降低单机器人场景的 PhysX 预分配，以便在 16 GiB 显存上同时运行；相机、3D 点云和 IMU 保持启用。FAST-LIO 默认仅在手动开始建图后启动，也可在“系统配置 → 建图控制”中开启场景启动时自动建图。也可以从终端启动带图形窗口的单场景：

```bash
bash scripts/start_simulation.sh indoor
bash scripts/start_simulation.sh warehouse
bash scripts/start_simulation.sh outdoor
```

Go2 默认保持站立，蓝色圆环为建议巡检点。启动后，网页会显示运动摇杆和位置、朝向、速度遥测；拖动摇杆可以控制前进、后退和转向，松手或点击“停止运动”即停车，控制指令超过 0.6 秒未更新也会自动停车。

默认使用 `cuda:0`，可通过 `SIM_DEVICE` 修改设备，通过 `ISAACLAB_PYTHON` 指定 Isaac Lab Python 解释器。室内、仓库、户外控制端口分别为 `8766`、`8767`、`8769`，DogLink 端口分别为 `8770`、`8771`、`8772`，话题命名空间分别为 `/indoor`、`/warehouse`、`/outdoor`。可用 `SIMULATION_CONTROL_URL_INDOOR`、`SIMULATION_CONTROL_URL_WAREHOUSE`、`SIMULATION_CONTROL_URL_OUTDOOR` 修改后端连接地址。

仿真使用本机 `ROS_DOMAIN_ID=88` 和 `ROS_LOCALHOST_ONLY=1`，正常模式按物理步长实时运行。仿真任务会清除实机使用的 `FASTRTPS_DEFAULT_PROFILES_FILE`，避免固定 peers 配置隔离本机节点；通用建图、导航和实机 Foxglove 任务仍保留该环境变量。

每个场景会同时启动 ROS 2 双向桥接，提供以下话题：

- 订阅 `/cmd_vel`（`geometry_msgs/Twist`），网页可通过 Foxglove 使用同一话题控制仿真。
- 发布 `/odom`、`/imu`、`/scan` 和 `/battery`。
- 发布 `/points`（`PointCloud2`）：16 通道、360°、2° 水平分辨率、20 m 量程、10 Hz，包含 `ring` 和逐点 `time` 字段，供 FAST-LIO 运动补偿与 3D 接入链路验证。
- 发布 `/camera1/preview/compressed`，为 Go2 机载第一视角（640×360、30 Hz、JPEG）。
- 发布 `map → odom → base_link → base_scan` 的 `/tf`，巡检工作台可以显示机器狗位置与 3D 点云。3D 雷达机器狗不订阅或显示 2D 激光；2D 激光图层与健康检查仅在选择 2D 雷达时出现。

可在终端验证：

```bash
ros2 topic list
ros2 topic echo /odom --once
ros2 topic pub --once /cmd_vel geometry_msgs/msg/Twist '{linear: {x: 0.3}, angular: {z: 0.0}}'
ros2 topic pub --once /cmd_vel geometry_msgs/msg/Twist '{linear: {x: 0.0}, angular: {z: 0.0}}'
```

无界面物理自检（以室内场景为例）：

```bash
bash scripts/start_simulation.sh indoor --headless --test-steps 120
```

仿真运动使用 RSL-RL 训练的 Go2 关节运动策略，WASD 和摇杆提供速度目标，策略以 50 Hz 推理并通过 12 个关节驱动机器狗，物理循环为 200 Hz，不直接写入基座运动速度或自动扶正。线/角速度目标限制为 ±1 m/s、±1 rad/s，与策略训练范围一致。模型来自 [Isaac-Velocity-Flat-Unitree-Go2-v0-No-Env-Noise](https://huggingface.co/OneSleepyGuy/Isaac-Velocity-Flat-Unitree-Go2-v0-No-Env-Noise)，本地文件为 `simulation/policies/go2_velocity_flat.pt`。建图和导航仍需安装并配置 SLAM、Nav2 功能包，不能直接替代真实步态与整机联调。
