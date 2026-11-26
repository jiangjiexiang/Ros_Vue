#!/usr/bin/env python3
"""
FAST-LIO 3D 定位 + Nav2 巡检导航统一启动文件（支持命名空间隔离，适配仿真与实机）
- 定位：FAST-LIO (3D 点云 + IMU) + fastlio_localization.py (ICP 全局配准 + map->odom TF)
- 导航：Nav2 map_server + planner_server (Navfn A*) + controller_server (RegulatedPurePursuit + 3D VoxelLayer) + behavior_server + bt_navigator
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

    if not params_file:
        params_file = str(project_root / "config" / "nav2_params.yaml")
    fastlio_params = str(project_root / "config" / "fastlio_sim.yaml")

    scan_topic = f"/{namespace}/scan" if namespace else "/scan"
    points_topic = f"/{namespace}/points" if namespace else "/points"
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
            "topic": points_topic,
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
            parameters=[fastlio_params],
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
            remappings=remappings,
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
            remappings=remappings,
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
                "auto_initial_pose",
                default_value="true",
                description="启动时是否自动使用当前 /odom 位姿初始化 FAST-LIO 全局定位",
            ),
            OpaqueFunction(function=_build_actions),
        ]
    )
