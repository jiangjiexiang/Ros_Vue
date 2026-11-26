from pathlib import Path

from launch import LaunchDescription
from launch_ros.actions import Node


def generate_launch_description():
    package_root = Path(__file__).resolve().parent.parent
    return LaunchDescription([
        Node(
            package="doglink",
            executable="gateway_node",
            name="doglink_gateway",
            parameters=[package_root / "config" / "doglink.yaml"],
            output="screen",
        )
    ])
