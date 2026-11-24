# ROS 2 机器人控制台

一个用于 ROS 2 机器人的 Vue 网页，包含地图显示、运动控制、建图和导航操作。

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

通常只需要修改 `config/ros_config.json`：

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

顶部导航分为三个页面：

- **监控**：实时地图、运动控制、遥测和图层。
- **任务**：独立的建图、导航和地图编辑工作区。
- **机器人**：后台新增、编辑、删除和切换机器人配置。

主页的“机器人连接”只需从下拉框选择后台配置好的机器人，不需要重复输入 IP。

机器人配置保存在当前浏览器的 `localStorage`。每台机器人支持独立局域网 IP / 主机名、端口和可选话题命名空间，例如命名空间为 `robot2` 时，`/scan` 会转换为 `/robot2/scan`。Foxglove 默认端口为 `8765`，页面会自动生成对应的 WebSocket 地址。

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

测试不同机器人或仿真器时，可通过 `ROS_CONFIG_FILE` 指向项目外的配置文件，不需要修改仓库默认配置：

```bash
ROS_CONFIG_FILE=/path/to/test_config.json bash scripts/start_console.sh
```

网页和 Foxglove 可以独立运行；实际建图、保存地图和导航需要你的 ROS 环境提供对应功能包。
