#!/usr/bin/env python3
"""
Nav2 人工接管辅助节点：
- 监听 /manual_cmd_vel，人工 WASD/摇杆接管时立即向 Nav2 navigate_to_pose 发送 CancelGoal 并清空 /plan
"""

import time

import rclpy
from action_msgs.srv import CancelGoal
from geometry_msgs.msg import Twist
from nav_msgs.msg import Path as RosPath
from rclpy.executors import ExternalShutdownException
from rclpy.node import Node
from std_msgs.msg import Header


class Nav2BridgeHelper(Node):
    def __init__(self):
        super().__init__("nav2_bridge_helper")
        self.declare_parameter("topic_namespace", "")
        namespace = str(self.get_parameter("topic_namespace").value or "").strip("/")
        self.topic = lambda name: f"/{namespace}/{name.lstrip('/')}" if namespace else f"/{name.lstrip('/')}"

        self.last_cancel_time = 0.0
        self.plan_pub = self.create_publisher(RosPath, self.topic("/plan"), 10)
        self.cancel_client = self.create_client(CancelGoal, self.topic("/navigate_to_pose/_action/cancel_goal"))
        self.create_subscription(Twist, self.topic("/manual_cmd_vel"), self.on_manual_cmd_vel, 10)
        self.get_logger().info(f"Nav2 人工接管辅助节点已启动，命名空间: '{namespace or '/'}'")

    def on_manual_cmd_vel(self, msg: Twist):
        has_motion = abs(msg.linear.x) > 1e-3 or abs(msg.linear.y) > 1e-3 or abs(msg.angular.z) > 1e-3
        if not has_motion:
            return
        now = time.monotonic()
        if now - self.last_cancel_time < 0.5:
            return
        self.last_cancel_time = now
        if self.cancel_client.service_is_ready():
            self.cancel_client.call_async(CancelGoal.Request())
            empty_plan = RosPath()
            empty_plan.header = Header(stamp=self.get_clock().now().to_msg(), frame_id="map")
            self.plan_pub.publish(empty_plan)
            self.get_logger().info("检测到人工控制指令，已取消 Nav2 当前导航目标")


def main():
    rclpy.init()
    node = Nav2BridgeHelper()
    try:
        rclpy.spin(node)
    except (KeyboardInterrupt, ExternalShutdownException):
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
