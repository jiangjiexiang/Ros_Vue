import fcntl
import json
import math
import os
import struct
import threading
import time
import urllib.request
from pathlib import Path

import rclpy
from geometry_msgs.msg import TransformStamped, Twist
from nav_msgs.msg import Odometry
from rclpy.callback_groups import MutuallyExclusiveCallbackGroup
from rclpy.clock import Clock, ClockType
from rclpy.executors import MultiThreadedExecutor
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from rclpy.time import Time
from rosgraph_msgs.msg import Clock as ClockMessage
from sensor_msgs.msg import CompressedImage, Imu, LaserScan, PointCloud2, PointField
from std_msgs.msg import UInt16
from tf2_msgs.msg import TFMessage


def world_to_body(quaternion, vector):
    qw = float(quaternion["w"])
    qx = float(quaternion["x"])
    qy = float(quaternion["y"])
    qz = float(quaternion["z"])
    norm = math.sqrt(qw * qw + qx * qx + qy * qy + qz * qz)
    if norm < 1e-12:
        return tuple(float(value) for value in vector)
    qw, qx, qy, qz = qw / norm, qx / norm, qy / norm, qz / norm
    x, y, z = (float(value) for value in vector)
    return (
        (1.0 - 2.0 * (qy * qy + qz * qz)) * x
        + 2.0 * (qx * qy + qw * qz) * y
        + 2.0 * (qx * qz - qw * qy) * z,
        2.0 * (qx * qy - qw * qz) * x
        + (1.0 - 2.0 * (qx * qx + qz * qz)) * y
        + 2.0 * (qy * qz + qw * qx) * z,
        2.0 * (qx * qz + qw * qy) * x
        + 2.0 * (qy * qz - qw * qx) * y
        + (1.0 - 2.0 * (qx * qx + qy * qy)) * z,
    )


def load_topics():
    project_root = Path(__file__).resolve().parent.parent
    config_path = os.environ.get("ROS_CONFIG_FILE", project_root / "config" / "ros_config.json")
    try:
        with open(config_path, encoding="utf-8") as config_file:
            return json.load(config_file).get("topics", {})
    except (OSError, json.JSONDecodeError):
        return {}


def acquire_sim_clock_lock():
    domain = int(os.environ.get("ROS_DOMAIN_ID", "0"))
    lock_dir = Path(os.environ.get("ROS_VUE_CLOCK_LOCK_DIR", "/tmp"))
    lock_dir.mkdir(parents=True, exist_ok=True)
    lock_file = open(lock_dir / f"ros_vue_sim_clock_{domain}.lock", "a+", encoding="utf-8")
    try:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        lock_file.close()
        raise RuntimeError(
            f"ROS_DOMAIN_ID={domain} 已有仿真时钟发布者；不支持多场景共享 /clock，"
            "请改用不同 ROS_DOMAIN_ID 或统一使用 use_sim_time:=false"
        ) from error
    lock_file.seek(0)
    lock_file.truncate()
    lock_file.write(str(os.getpid()))
    lock_file.flush()
    return lock_file


class IsaacPlatformBridge(Node):
    def __init__(self):
        super().__init__("isaac_platform_bridge")
        self.declare_parameter("control_url", "http://127.0.0.1:8766")
        self.declare_parameter("topic_namespace", "")
        self.control_url = self.get_parameter("control_url").value.rstrip("/")
        self.use_sim_time = bool(self.get_parameter("use_sim_time").value)
        self.sim_clock_lock = acquire_sim_clock_lock() if self.use_sim_time else None
        topic_namespace = self.get_parameter("topic_namespace").value.strip("/")
        configured_topics = load_topics()

        def namespaced(topic):
            return f"/{topic_namespace}/{topic.lstrip('/')}" if topic_namespace else topic

        self.topics = {
            "cmd_vel": namespaced(configured_topics.get("cmd_vel", "/cmd_vel")),
            "odom": namespaced(configured_topics.get("odom", "/odom")),
            "imu": namespaced(configured_topics.get("imu", "/imu")),
            "scan": namespaced(configured_topics.get("scan", "/scan")),
            "pointcloud": namespaced(configured_topics.get("pointcloud", "/points")),
            "obstacle_pointcloud": namespaced(
                configured_topics.get("obstacle_pointcloud", "/points_obstacles")
            ),
            "battery": namespaced(configured_topics.get("battery", "/battery")),
            "tf": namespaced(configured_topics.get("tf", "/tf")),
            "camera_primary": namespaced(configured_topics.get("camera_primary", "/camera1/preview/compressed")),
            "amcl_pose": namespaced("/amcl_pose"),
            "localization": namespaced(configured_topics.get("localization", "/localization")),
        }
        self.connected = False
        self.last_error_log = 0.0
        self.last_camera_error_log = 0.0
        self.last_pointcloud_error_log = 0.0
        self.battery_ticks = 0
        self.external_map_tf_active = False
        self.last_map_tf_check = 0.0
        self.prev_world_vel = None
        self.prev_imu_time = None
        self.prev_sim_steps = None
        self.smooth_acc_world = (0.0, 0.0, 9.81)
        self.command_condition = threading.Condition()
        self.pending_command = None
        self.pending_zero = None
        self.latest_command_sequence = 0
        self.command_running = True

        self.odom_publisher = self.create_publisher(Odometry, self.topics["odom"], 10)
        self.imu_publisher = self.create_publisher(Imu, self.topics["imu"], 10)
        self.scan_publisher = self.create_publisher(LaserScan, self.topics["scan"], qos_profile_sensor_data)
        self.pointcloud_publisher = self.create_publisher(
            PointCloud2, self.topics["pointcloud"], qos_profile_sensor_data
        )
        self.obstacle_pointcloud_publisher = self.create_publisher(
            PointCloud2, self.topics["obstacle_pointcloud"], qos_profile_sensor_data
        )
        self.clock_publisher = self.create_publisher(ClockMessage, "/clock", 10)
        self.battery_publisher = self.create_publisher(UInt16, self.topics["battery"], 10)
        self.tf_publisher = self.create_publisher(TFMessage, self.topics["tf"], 10)
        self.camera_publishers = {
            "primary": self.create_publisher(
                CompressedImage, self.topics["camera_primary"], qos_profile_sensor_data
            )
        }
        self.status_cb_group = MutuallyExclusiveCallbackGroup()
        self.camera_cb_group = MutuallyExclusiveCallbackGroup()
        self.cloud_cb_group = MutuallyExclusiveCallbackGroup()
        self.cmd_subscription = self.create_subscription(Twist, self.topics["cmd_vel"], self.on_cmd_vel, 10)
        io_clock = Clock(clock_type=ClockType.STEADY_TIME)
        self.status_timer = self.create_timer(
            0.02, self.publish_simulation_state, callback_group=self.status_cb_group, clock=io_clock
        )
        self.camera_timer = self.create_timer(
            1.0 / 30.0, self.publish_camera_frames, callback_group=self.camera_cb_group, clock=io_clock
        )
        self.pointcloud_timer = self.create_timer(
            0.1, self.publish_pointcloud, callback_group=self.cloud_cb_group, clock=io_clock
        )
        self.command_worker = threading.Thread(target=self.command_loop, daemon=True)
        self.zero_worker = threading.Thread(target=self.zero_command_loop, daemon=True)
        self.command_worker.start()
        self.zero_worker.start()
        self.get_logger().info(
            f"Isaac ROS 2 桥接已启动，控制服务: {self.control_url}，use_sim_time={self.use_sim_time}"
        )

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
            sample_time = response.headers.get("X-Sample-Time")
            wall_time = response.headers.get("X-Wall-Time")
            data = {}
            if sample_time is not None:
                data["sim_time"] = float(sample_time)
            if wall_time is not None:
                data["wall_time"] = float(wall_time)
            return response.read(), frame_id, data

    def on_cmd_vel(self, message):
        with self.command_condition:
            sequence = max(time.monotonic_ns(), self.latest_command_sequence + 1)
            command = (sequence, float(message.linear.x), float(message.angular.z))
            self.latest_command_sequence = sequence
            self.pending_command = command
            if command[1] == 0.0 and command[2] == 0.0:
                self.pending_zero = command
            else:
                self.pending_zero = None
            self.command_condition.notify_all()

    def take_command(self, zero_only):
        with self.command_condition:
            while self.command_running:
                pending = self.pending_zero if zero_only else self.pending_command
                if pending is not None:
                    if zero_only:
                        self.pending_zero = None
                    else:
                        self.pending_command = None
                    if pending[0] == self.latest_command_sequence:
                        return pending
                self.command_condition.wait(timeout=0.2)
        return None

    def send_command(self, command):
        sequence, linear_x, angular_z = command
        try:
            self.request(
                "/velocity",
                {"linearX": linear_x, "angularZ": angular_z, "sequence": sequence},
                timeout=0.2,
            )
        except Exception as err:
            self.log_connection_error(f"发送速度指令失败: {err}")

    def command_loop(self):
        while self.command_running:
            command = self.take_command(zero_only=False)
            if command is None:
                continue
            if command[1] == 0.0 and command[2] == 0.0:
                continue
            self.send_command(command)

    def zero_command_loop(self):
        while self.command_running:
            command = self.take_command(zero_only=True)
            if command is not None:
                self.send_command(command)

    def message_stamp(self, data):
        if self.use_sim_time:
            if "sim_time" not in data:
                raise ValueError("仿真采样缺少 sim_time，无法在 use_sim_time 模式下发布消息")
            return Time(nanoseconds=round(float(data["sim_time"]) * 1e9)).to_msg()
        if "wall_time" in data:
            return Time(nanoseconds=round(float(data["wall_time"]) * 1e9)).to_msg()
        return self.get_clock().now().to_msg()

    def destroy_node(self):
        with self.command_condition:
            self.command_running = False
            self.command_condition.notify_all()
        self.command_worker.join(timeout=1.0)
        self.zero_worker.join(timeout=1.0)
        if self.sim_clock_lock is not None:
            self.sim_clock_lock.close()
            self.sim_clock_lock = None
        super().destroy_node()

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
                jpeg, frame_id, sample = self.request_camera(name)
                message = CompressedImage()
                message.header.stamp = self.message_stamp(sample)
                message.header.frame_id = frame_id
                message.format = "jpeg"
                message.data = jpeg
                publisher.publish(message)
            except Exception as err:
                now = time.monotonic()
                if now - self.last_camera_error_log > 5.0:
                    self.get_logger().warning(f"读取 {name} 相机图像失败: {err}")
                    self.last_camera_error_log = now

    def pointcloud_message(self, points, stamp, frame_id):
        point_step = 24
        coordinates = bytearray(len(points) * point_step)
        for index, point in enumerate(points):
            if len(point) < 5:
                raise ValueError("仿真点云缺少 ring/time 字段")
            struct.pack_into(
                "<ffffH2xf",
                coordinates,
                index * point_step,
                point[0],
                point[1],
                point[2],
                100.0,
                int(point[3]),
                point[4],
            )
        message = PointCloud2()
        message.header.stamp = stamp
        message.header.frame_id = frame_id
        message.height = 1
        message.width = len(points)
        message.fields = [
            PointField(name="x", offset=0, datatype=PointField.FLOAT32, count=1),
            PointField(name="y", offset=4, datatype=PointField.FLOAT32, count=1),
            PointField(name="z", offset=8, datatype=PointField.FLOAT32, count=1),
            PointField(name="intensity", offset=12, datatype=PointField.FLOAT32, count=1),
            PointField(name="ring", offset=16, datatype=PointField.UINT16, count=1),
            PointField(name="time", offset=20, datatype=PointField.FLOAT32, count=1),
        ]
        message.is_bigendian = False
        message.point_step = point_step
        message.row_step = message.point_step * message.width
        message.is_dense = all(math.isfinite(value) for point in points for value in point[:3])
        message.data = coordinates
        return message

    def publish_pointcloud(self):
        try:
            data = self.request("/pointcloud")
            scan_stamp = self.message_stamp(data)
            frame_id = data.get("frame_id", "base_scan")
            self.pointcloud_publisher.publish(
                self.pointcloud_message(data["points"], scan_stamp, frame_id)
            )
            self.obstacle_pointcloud_publisher.publish(
                self.pointcloud_message(
                    data.get("obstacle_points", []),
                    scan_stamp,
                    data.get("obstacle_frame_id", frame_id),
                )
            )
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

        stamp = self.message_stamp(data)
        if self.use_sim_time:
            self.clock_publisher.publish(ClockMessage(clock=stamp))
        position = data["position"]
        quaternion = data["quaternion"]
        velocity = data["velocity"]

        self.publish_tf(stamp, position, quaternion)
        self.publish_odometry(stamp, position, quaternion, velocity)
        self.publish_imu(stamp, quaternion, velocity, data.get("steps"))
        self.publish_scan(stamp, data.get("scan", []), data.get("lidar", {}))
        self.battery_ticks += 1
        if self.battery_ticks % 20 == 0:
            self.battery_publisher.publish(UInt16(data=120))

    def publish_tf(self, stamp, position, quaternion):
        now = time.monotonic()
        if now - self.last_map_tf_check >= 0.5:
            self.last_map_tf_check = now
            self.external_map_tf_active = (
                self.count_publishers(self.topics["localization"]) > 0
                or self.count_publishers(self.topics["amcl_pose"]) > 0
            )

        transforms = []
        if not self.external_map_tf_active:
            transforms.append(
                self.transform(stamp, "map", "odom", (0.0, 0.0, 0.0), (1.0, 0.0, 0.0, 0.0))
            )
        transforms.extend([
            self.transform(
                stamp,
                "odom",
                "base_link",
                (position["x"], position["y"], position["z"]),
                (quaternion["w"], quaternion["x"], quaternion["y"], quaternion["z"]),
            ),
            self.transform(stamp, "base_link", "base_scan", (0.15, 0.0, 0.20), (1.0, 0.0, 0.0, 0.0)),
            self.transform(
                stamp,
                "base_link",
                "camera_primary_optical_frame",
                (0.28, 0.0, 0.12),
                (0.5, -0.5, 0.5, -0.5),
            ),
        ])
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

    def publish_odometry(self, stamp, position, quaternion, velocity):
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

        linear = velocity["linear"]
        angular = velocity["angular"]
        body_linear = world_to_body(quaternion, (linear["x"], linear["y"], linear["z"]))
        body_angular = world_to_body(quaternion, (angular["x"], angular["y"], angular["z"]))
        message.twist.twist.linear.x = body_linear[0]
        message.twist.twist.linear.y = body_linear[1]
        message.twist.twist.linear.z = body_linear[2]
        message.twist.twist.angular.x = body_angular[0]
        message.twist.twist.angular.y = body_angular[1]
        message.twist.twist.angular.z = body_angular[2]
        self.odom_publisher.publish(message)

    def publish_imu(self, stamp, quaternion, velocity, sim_steps=None):
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

        angular = velocity["angular"]
        angular_x, angular_y, angular_z = world_to_body(
            quaternion, (angular["x"], angular["y"], angular["z"])
        )
        message.angular_velocity.x = angular_x
        message.angular_velocity.y = angular_y
        message.angular_velocity.z = angular_z

        linear = velocity["linear"]
        world_velocity = (float(linear["x"]), float(linear["y"]), float(linear["z"]))
        if sim_steps is not None and self.prev_sim_steps is not None and sim_steps > self.prev_sim_steps and self.prev_world_vel is not None:
            dt = (sim_steps - self.prev_sim_steps) / 200.0
            if 0.005 < dt < 0.5:
                raw_ax = max(-40.0, min(40.0, (world_velocity[0] - self.prev_world_vel[0]) / dt))
                raw_ay = max(-40.0, min(40.0, (world_velocity[1] - self.prev_world_vel[1]) / dt))
                raw_az = max(-20.0, min(40.0, 9.81 + (world_velocity[2] - self.prev_world_vel[2]) / dt))
                self.smooth_acc_world = (raw_ax, raw_ay, raw_az)
        if sim_steps is None or self.prev_sim_steps is None or sim_steps != self.prev_sim_steps:
            self.prev_world_vel = world_velocity
            self.prev_sim_steps = sim_steps
        world_acceleration = (
            self.smooth_acc_world[0],
            self.smooth_acc_world[1],
            self.smooth_acc_world[2] - 9.81,
        )
        specific_force = world_to_body(
            quaternion, (world_acceleration[0], world_acceleration[1], world_acceleration[2] + 9.81)
        )
        message.linear_acceleration.x = specific_force[0]
        message.linear_acceleration.y = specific_force[1]
        message.linear_acceleration.z = specific_force[2]
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
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
