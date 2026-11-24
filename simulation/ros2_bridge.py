import json
import math
import os
import sys
import time
import urllib.request
from array import array
from pathlib import Path

import rclpy
from geometry_msgs.msg import TransformStamped, Twist
from nav_msgs.msg import Odometry
from rclpy.callback_groups import MutuallyExclusiveCallbackGroup
from rclpy.executors import MultiThreadedExecutor
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import CompressedImage, Imu, LaserScan, PointCloud2, PointField
from std_msgs.msg import UInt16
from tf2_msgs.msg import TFMessage


def load_topics():
    project_root = Path(__file__).resolve().parent.parent
    config_path = os.environ.get("ROS_CONFIG_FILE", project_root / "config" / "ros_config.json")
    try:
        with open(config_path, encoding="utf-8") as config_file:
            return json.load(config_file).get("topics", {})
    except (OSError, json.JSONDecodeError):
        return {}


class IsaacPlatformBridge(Node):
    def __init__(self):
        super().__init__("isaac_platform_bridge")
        self.declare_parameter("control_url", "http://127.0.0.1:8766")
        self.control_url = self.get_parameter("control_url").value.rstrip("/")
        configured_topics = load_topics()
        self.topics = {
            "cmd_vel": configured_topics.get("cmd_vel", "/cmd_vel"),
            "odom": configured_topics.get("odom", "/odom"),
            "imu": configured_topics.get("imu", "/imu"),
            "scan": configured_topics.get("scan", "/scan"),
            "pointcloud": configured_topics.get("pointcloud", "/points"),
            "battery": configured_topics.get("battery", "/battery"),
            "tf": configured_topics.get("tf", "/tf"),
            "camera_primary": configured_topics.get("camera_primary", "/camera1/preview/compressed"),
            "camera_secondary": configured_topics.get("camera_secondary", "/camera2/preview/compressed"),
        }
        self.connected = False
        self.last_error_log = 0.0
        self.last_camera_error_log = 0.0
        self.last_pointcloud_error_log = 0.0
        self.battery_ticks = 0
        self.prev_world_vel = None
        self.prev_imu_time = None

        self.odom_publisher = self.create_publisher(Odometry, self.topics["odom"], 10)
        self.imu_publisher = self.create_publisher(Imu, self.topics["imu"], 10)
        self.scan_publisher = self.create_publisher(LaserScan, self.topics["scan"], qos_profile_sensor_data)
        self.pointcloud_publisher = self.create_publisher(
            PointCloud2, self.topics["pointcloud"], qos_profile_sensor_data
        )
        self.battery_publisher = self.create_publisher(UInt16, self.topics["battery"], 10)
        self.tf_publisher = self.create_publisher(TFMessage, self.topics["tf"], 10)
        self.camera_publishers = {
            name: self.create_publisher(CompressedImage, self.topics[f"camera_{name}"], qos_profile_sensor_data)
            for name in ("primary", "secondary")
        }
        self.status_cb_group = MutuallyExclusiveCallbackGroup()
        self.camera_cb_group = MutuallyExclusiveCallbackGroup()
        self.cloud_cb_group = MutuallyExclusiveCallbackGroup()
        self.cmd_subscription = self.create_subscription(Twist, self.topics["cmd_vel"], self.on_cmd_vel, 10)
        self.status_timer = self.create_timer(0.02, self.publish_simulation_state, callback_group=self.status_cb_group)
        self.camera_timer = self.create_timer(1.0 / 30.0, self.publish_camera_frames, callback_group=self.camera_cb_group)
        self.pointcloud_timer = self.create_timer(0.1, self.publish_pointcloud, callback_group=self.cloud_cb_group)
        self.get_logger().info(f"Isaac ROS 2 桥接已启动，控制服务: {self.control_url}")

    def request(self, path, payload=None, timeout=0.25):
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            f"{self.control_url}{path}",
            data=body,
            headers={"Content-Type": "application/json"},
            method="GET" if body is None else "POST",
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.load(response)

    def request_camera(self, name, timeout=0.25):
        request = urllib.request.Request(f"{self.control_url}/camera/{name}", method="GET")
        with urllib.request.urlopen(request, timeout=timeout) as response:
            if response.headers.get_content_type() != "image/jpeg":
                raise ValueError("相机接口未返回 JPEG")
            frame_id = response.headers.get("X-Frame-Id", f"camera_{name}_optical_frame")
            return response.read(), frame_id

    def on_cmd_vel(self, message):
        try:
            self.request(
                "/velocity",
                {"linearX": message.linear.x, "angularZ": message.angular.z},
                timeout=0.2,
            )
        except Exception as err:
            self.log_connection_error(f"发送速度指令失败: {err}")

    def log_connection_error(self, message):
        now = time.monotonic()
        if now - self.last_error_log > 5.0:
            self.get_logger().warning(message)
            self.last_error_log = now
        if self.connected:
            self.get_logger().warning("Isaac 仿真连接已断开")
            self.connected = False

    def publish_camera_frames(self):
        for name, publisher in self.camera_publishers.items():
            try:
                jpeg, frame_id = self.request_camera(name)
                message = CompressedImage()
                message.header.stamp = self.get_clock().now().to_msg()
                message.header.frame_id = frame_id
                message.format = "jpeg"
                message.data = jpeg
                publisher.publish(message)
            except Exception as err:
                now = time.monotonic()
                if now - self.last_camera_error_log > 5.0:
                    self.get_logger().warning(f"读取 {name} 相机图像失败: {err}")
                    self.last_camera_error_log = now

    def publish_pointcloud(self):
        try:
            data = self.request("/pointcloud")
            points = data["points"]
            if not points:
                return
            coordinates = array(
                "f",
                (
                    val
                    for point in points
                    for val in (point[0], point[1], point[2], 100.0)
                ),
            )
            is_dense = all(math.isfinite(coordinate) for coordinate in coordinates)
            if sys.byteorder != "little":
                coordinates.byteswap()

            message = PointCloud2()
            message.header.stamp = self.get_clock().now().to_msg()
            message.header.frame_id = data.get("frame_id", "base_scan")
            message.height = 1
            message.width = len(points)
            message.fields = [
                PointField(name="x", offset=0, datatype=PointField.FLOAT32, count=1),
                PointField(name="y", offset=4, datatype=PointField.FLOAT32, count=1),
                PointField(name="z", offset=8, datatype=PointField.FLOAT32, count=1),
                PointField(name="intensity", offset=12, datatype=PointField.FLOAT32, count=1),
            ]
            message.is_bigendian = False
            message.point_step = 16
            message.row_step = message.point_step * message.width
            message.is_dense = is_dense
            message.data = coordinates.tobytes()
            self.pointcloud_publisher.publish(message)
        except Exception as err:
            now = time.monotonic()
            if now - self.last_pointcloud_error_log > 5.0:
                self.get_logger().warning(f"读取或发布 3D 点云失败: {err}")
                self.last_pointcloud_error_log = now

    def publish_simulation_state(self):
        try:
            data = self.request("/status")
            if not data.get("ready"):
                return
            if not self.connected:
                self.get_logger().info(f"已连接 Isaac 场景: {data.get('scene', 'unknown')}")
                self.connected = True
        except Exception as err:
            self.log_connection_error(f"读取仿真状态失败: {err}")
            return

        stamp = self.get_clock().now().to_msg()
        position = data["position"]
        quaternion = data["quaternion"]
        velocity = data["velocity"]
        yaw = data["yaw"]

        self.publish_tf(stamp, position, quaternion)
        self.publish_odometry(stamp, position, quaternion, velocity, yaw)
        self.publish_imu(stamp, quaternion, velocity)
        self.publish_scan(stamp, data.get("scan", []), data.get("lidar", {}))
        self.battery_ticks += 1
        if self.battery_ticks % 20 == 0:
            self.battery_publisher.publish(UInt16(data=120))

    def publish_tf(self, stamp, position, quaternion):
        transforms = [
            self.transform(stamp, "map", "odom", (0.0, 0.0, 0.0), (1.0, 0.0, 0.0, 0.0)),
            self.transform(
                stamp,
                "odom",
                "base_link",
                (position["x"], position["y"], position["z"]),
                (quaternion["w"], quaternion["x"], quaternion["y"], quaternion["z"]),
            ),
            self.transform(stamp, "base_link", "base_scan", (0.15, 0.0, 0.20), (1.0, 0.0, 0.0, 0.0)),
        ]
        self.tf_publisher.publish(TFMessage(transforms=transforms))

    @staticmethod
    def transform(stamp, parent, child, translation, rotation):
        message = TransformStamped()
        message.header.stamp = stamp
        message.header.frame_id = parent
        message.child_frame_id = child
        message.transform.translation.x = translation[0]
        message.transform.translation.y = translation[1]
        message.transform.translation.z = translation[2]
        message.transform.rotation.w = rotation[0]
        message.transform.rotation.x = rotation[1]
        message.transform.rotation.y = rotation[2]
        message.transform.rotation.z = rotation[3]
        return message

    def publish_odometry(self, stamp, position, quaternion, velocity, yaw):
        message = Odometry()
        message.header.stamp = stamp
        message.header.frame_id = "odom"
        message.child_frame_id = "base_link"
        message.pose.pose.position.x = position["x"]
        message.pose.pose.position.y = position["y"]
        message.pose.pose.position.z = position["z"]
        message.pose.pose.orientation.w = quaternion["w"]
        message.pose.pose.orientation.x = quaternion["x"]
        message.pose.pose.orientation.y = quaternion["y"]
        message.pose.pose.orientation.z = quaternion["z"]

        world_x = velocity["linear"]["x"]
        world_y = velocity["linear"]["y"]
        message.twist.twist.linear.x = math.cos(yaw) * world_x + math.sin(yaw) * world_y
        message.twist.twist.linear.y = -math.sin(yaw) * world_x + math.cos(yaw) * world_y
        message.twist.twist.linear.z = velocity["linear"]["z"]
        message.twist.twist.angular.x = velocity["angular"]["x"]
        message.twist.twist.angular.y = velocity["angular"]["y"]
        message.twist.twist.angular.z = velocity["angular"]["z"]
        self.odom_publisher.publish(message)

    def publish_imu(self, stamp, quaternion, velocity):
        message = Imu()
        message.header.stamp = stamp
        message.header.frame_id = "base_link"
        qw = float(quaternion["w"])
        qx = float(quaternion["x"])
        qy = float(quaternion["y"])
        qz = float(quaternion["z"])
        message.orientation.w = qw
        message.orientation.x = qx
        message.orientation.y = qy
        message.orientation.z = qz
        # Rotate world angular velocity and world gravity (0, 0, +9.81) into body frame via R(q*)
        wx = float(velocity["angular"]["x"])
        wy = float(velocity["angular"]["y"])
        wz = float(velocity["angular"]["z"])
        r00 = 1.0 - 2.0 * (qy * qy + qz * qz)
        r01 = 2.0 * (qx * qy + qw * qz)
        r02 = 2.0 * (qx * qz - qw * qy)
        r10 = 2.0 * (qx * qy - qw * qz)
        r11 = 1.0 - 2.0 * (qx * qx + qz * qz)
        r12 = 2.0 * (qy * qz + qw * qx)
        r20 = 2.0 * (qx * qz + qw * qy)
        r21 = 2.0 * (qy * qz - qw * qx)
        r22 = 1.0 - 2.0 * (qx * qx + qy * qy)
        message.angular_velocity.x = r00 * wx + r01 * wy + r02 * wz
        message.angular_velocity.y = r10 * wx + r11 * wy + r12 * wz
        message.angular_velocity.z = r20 * wx + r21 * wy + r22 * wz
        g = 9.81
        message.linear_acceleration.x = r02 * g
        message.linear_acceleration.y = r12 * g
        message.linear_acceleration.z = r22 * g
        self.imu_publisher.publish(message)

    def publish_scan(self, stamp, ranges, lidar):
        if not ranges:
            return
        message = LaserScan()
        message.header.stamp = stamp
        message.header.frame_id = lidar.get("frame_id", "base_scan")
        message.angle_min = lidar.get("angle_min", -math.pi)
        message.angle_increment = lidar.get("angle_increment", math.radians(1.0))
        message.angle_max = lidar.get(
            "angle_max", message.angle_min + (len(ranges) - 1) * message.angle_increment
        )
        message.range_min = lidar.get("range_min", 0.05)
        message.range_max = lidar.get("range_max", 12.0)
        message.scan_time = 0.05
        message.ranges = [float("inf") if value <= 0.0 else float(value) for value in ranges]
        self.scan_publisher.publish(message)


def main():
    rclpy.init()
    node = IsaacPlatformBridge()
    executor = MultiThreadedExecutor(num_threads=4)
    executor.add_node(node)
    try:
        executor.spin()
    except KeyboardInterrupt:
        pass
    finally:
        executor.shutdown()
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
