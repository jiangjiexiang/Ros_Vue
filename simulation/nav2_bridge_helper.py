#!/usr/bin/env python3
"""
Nav2 人工接管辅助节点：
- 监听 /manual_cmd_vel，人工接管或零速停止时立即取消 navigate_to_pose 并清空 /plan
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
        empty_plan = RosPath()
        empty_plan.header = Header(stamp=self.get_clock().now().to_msg(), frame_id="map")
        self.plan_pub.publish(empty_plan)

        now = time.monotonic()
        if now - self.last_cancel_time < 0.5 or not self.cancel_client.service_is_ready():
            return
        self.last_cancel_time = now
        future = self.cancel_client.call_async(CancelGoal.Request())
        future.add_done_callback(self.on_cancel_result)

    def on_cancel_result(self, future):
        try:
            error = future.exception()
            if error is not None:
                raise error
            response = future.result()
            if response.return_code != CancelGoal.Response.ERROR_NONE:
                self.get_logger().warning(f"取消 Nav2 目标失败，返回码: {response.return_code}")
            else:
                self.get_logger().info("人工控制或停止指令已取消 Nav2 当前导航目标并清空路径")
        except Exception as err:
            self.get_logger().warning(f"取消 Nav2 目标请求失败: {err}")


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
