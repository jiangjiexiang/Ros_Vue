#!/usr/bin/env python3
"""
FAST-LIO 3D 定位 + Nav2 巡检导航统一启动文件（支持命名空间隔离，适配仿真与实机）
- 定位：FAST-LIO (3D 点云 + IMU) + fastlio_localization.py (ICP 全局配准 + map->odom TF)
- 导航：Nav2 map_server + planner_server + controller_server + velocity_smoother + behavior_server + bt_navigator
用法示例：
  ros2 launch simulation/nav2_launch.py map:=/path/to/map.yaml namespace:=indoor
"""

from pathlib import Path

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, GroupAction, OpaqueFunction
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node, PushRosNamespace, SetRemap
from nav2_common.launch import RewrittenYaml


def _build_actions(context):
    project_root = Path(__file__).resolve().parent.parent
    namespace = LaunchConfiguration("namespace").perform(context).strip("/")
    map_yaml = LaunchConfiguration("map").perform(context).strip()
    params_file = LaunchConfiguration("params_file").perform(context).strip()
    use_sim_time = LaunchConfiguration("use_sim_time").perform(context).strip()
    auto_initial_pose = LaunchConfiguration("auto_initial_pose").perform(context).strip()
    obstacle_topic = LaunchConfiguration("obstacle_topic").perform(context).strip()
    obstacle_min_height = LaunchConfiguration("obstacle_min_height").perform(context).strip() or "0.03"

    if not map_yaml:
        raise RuntimeError("缺少 Nav2 地图：启动前请提供 map:=/绝对路径/map.yaml")
    map_path = Path(map_yaml).expanduser()
    if not map_path.is_file():
        raise RuntimeError(f"Nav2 地图 YAML 不存在: {map_path}；请检查 map 启动参数")
    map_yaml = str(map_path.resolve())
    if not params_file:
        params_file = str(project_root / "config" / "nav2_params.yaml")
    fastlio_params = str(project_root / "config" / "fastlio_sim.yaml")
    use_sim_time_enabled = use_sim_time.lower() == "true"
    if not obstacle_topic:
        obstacle_topic = "points"
        print("[nav2_launch] WARNING: 未指定独立障碍云，回退到原始 points；实机需自行过滤地面和坡道")
    if not obstacle_topic.startswith("/"):
        obstacle_topic = f"/{namespace}/{obstacle_topic}" if namespace else f"/{obstacle_topic}"

    scan_topic = f"/{namespace}/scan" if namespace else "/scan"
    odom_topic = f"/{namespace}/odom" if namespace else "/odom"
    map_topic = f"/{namespace}/map" if namespace else "/map"

    configured_params = RewrittenYaml(
        source_file=params_file,
        root_key=namespace,
        param_rewrites={
            "use_sim_time": use_sim_time,
            "yaml_filename": map_yaml,
            "scan_topic": scan_topic,
            "odom_topic": odom_topic,
            "map_topic": map_topic,
            "topic": obstacle_topic,
            "min_obstacle_height": obstacle_min_height,
        },
        convert_types=True,
    )

    remappings = [("/tf", "tf"), ("/tf_static", "tf_static")] if namespace else []
    fastlio_remappings = (
        [
            ("/points", f"/{namespace}/points"),
            ("/imu", f"/{namespace}/imu"),
            ("/Odometry", f"/{namespace}/Odometry"),
            ("/cloud_registered", f"/{namespace}/cloud_registered"),
            ("/path", f"/{namespace}/path"),
            ("/tf", f"/{namespace}/tf"),
            ("/Laser_map", f"/{namespace}/Laser_map"),
            ("/cloud_effected", f"/{namespace}/cloud_effected"),
            ("/cloud_registered_body", f"/{namespace}/cloud_registered_body"),
        ]
        if namespace
        else []
    )

    localization_nodes = ["map_server"]
    navigation_nodes = [
        "controller_server",
        "velocity_smoother",
        "planner_server",
        "behavior_server",
        "bt_navigator",
    ]

    nodes = [
        Node(
            package="fast_lio",
            executable="fastlio_mapping",
            name="fastlio_localization_odom",
            output="screen",
            parameters=[fastlio_params, {"use_sim_time": use_sim_time_enabled}],
            remappings=fastlio_remappings,
        ),
        Node(
            executable="/usr/bin/python3",
            arguments=[str(project_root / "simulation" / "fastlio_localization.py")],
            name="fastlio_global_localization",
            output="screen",
            parameters=[
                {"map_file": map_yaml},
                {"topic_namespace": namespace},
                {"auto_initial_pose": auto_initial_pose.lower() == "true"},
                {"use_sim_time": use_sim_time_enabled},
            ],
        ),
        Node(
            package="nav2_map_server",
            executable="map_server",
            name="map_server",
            output="screen",
            parameters=[configured_params],
            remappings=remappings,
        ),
        Node(
            package="nav2_controller",
            executable="controller_server",
            name="controller_server",
            output="screen",
            parameters=[configured_params],
            remappings=remappings + [("cmd_vel", "cmd_vel_nav")],
        ),
        Node(
            package="nav2_velocity_smoother",
            executable="velocity_smoother",
            name="velocity_smoother",
            output="screen",
            parameters=[configured_params],
            remappings=remappings + [("cmd_vel", "cmd_vel_nav"), ("cmd_vel_smoothed", "cmd_vel")],
        ),
        Node(
            package="nav2_planner",
            executable="planner_server",
            name="planner_server",
            output="screen",
            parameters=[configured_params],
            remappings=remappings,
        ),
        Node(
            package="nav2_behaviors",
            executable="behavior_server",
            name="behavior_server",
            output="screen",
            parameters=[configured_params],
            remappings=remappings + [("cmd_vel", "cmd_vel_nav")],
        ),
        Node(
            package="nav2_bt_navigator",
            executable="bt_navigator",
            name="bt_navigator",
            output="screen",
            parameters=[configured_params],
            remappings=remappings,
        ),
        Node(
            package="nav2_lifecycle_manager",
            executable="lifecycle_manager",
            name="lifecycle_manager_localization",
            output="screen",
            parameters=[
                {"use_sim_time": use_sim_time.lower() == "true"},
                {"autostart": True},
                {"node_names": localization_nodes},
                {"bond_timeout": 10.0},
            ],
        ),
        Node(
            package="nav2_lifecycle_manager",
            executable="lifecycle_manager",
            name="lifecycle_manager_navigation",
            output="screen",
            parameters=[
                {"use_sim_time": use_sim_time.lower() == "true"},
                {"autostart": True},
                {"node_names": navigation_nodes},
                {"bond_timeout": 10.0},
            ],
        ),
        Node(
            executable="/usr/bin/python3",
            arguments=[str(project_root / "simulation" / "nav2_bridge_helper.py")],
            name="nav2_bridge_helper",
            output="screen",
            parameters=[
                {"topic_namespace": namespace},
                {"use_sim_time": use_sim_time_enabled},
            ],
        ),
    ]

    if namespace:
        return [
            GroupAction(
                [
                    PushRosNamespace(namespace),
                    SetRemap("/tf", "tf"),
                    SetRemap("/tf_static", "tf_static"),
                    *nodes,
                ]
            )
        ]

    return nodes


def generate_launch_description():
    project_root = Path(__file__).resolve().parent.parent
    return LaunchDescription(
        [
            DeclareLaunchArgument("map", default_value="", description="Nav2 地图 YAML 绝对路径"),
            DeclareLaunchArgument("namespace", default_value="", description="机器人命名空间（如 indoor）"),
            DeclareLaunchArgument(
                "params_file",
                default_value=str(project_root / "config" / "nav2_params.yaml"),
                description="Nav2 参数文件路径",
            ),
            DeclareLaunchArgument("use_sim_time", default_value="false", description="是否使用仿真时钟"),
            DeclareLaunchArgument(
                "obstacle_topic",
                default_value="points_obstacles",
                description="障碍点云；仿真默认独立云，实机无此话题时显式设为空或 points 回退原始云（需地面/坡道过滤）",
            ),
            DeclareLaunchArgument(
                "obstacle_min_height",
                default_value="0.03",
                description="障碍点最低高度；使用实机原始点云时按地面过滤结果调整",
            ),
            DeclareLaunchArgument(
                "auto_initial_pose",
                default_value="true",
                description="启动时是否自动使用当前 /odom 位姿初始化 FAST-LIO 全局定位",
            ),
            OpaqueFunction(function=_build_actions),
        ]
    )
