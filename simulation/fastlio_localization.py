import copy
import math
import threading
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

import rclpy
from geometry_msgs.msg import PoseStamped, PoseWithCovarianceStamped, TransformStamped
from nav_msgs.msg import Odometry, Path as RosPath
from rclpy.executors import ExternalShutdownException
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import PointCloud2
from sensor_msgs_py import point_cloud2
from std_msgs.msg import Header
from tf2_msgs.msg import TFMessage


def quaternion_matrix(w, x, y, z):
    norm = math.sqrt(w * w + x * x + y * y + z * z)
    if norm < 1e-12:
        return np.eye(3)
    w, x, y, z = w / norm, x / norm, y / norm, z / norm
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ])


def matrix_quaternion(matrix):
    m = np.asarray(matrix)
    trace = float(np.trace(m))
    if trace > 0:
        scale = math.sqrt(trace + 1.0) * 2
        return (
            0.25 * scale,
            (m[2, 1] - m[1, 2]) / scale,
            (m[0, 2] - m[2, 0]) / scale,
            (m[1, 0] - m[0, 1]) / scale,
        )
    index = int(np.argmax(np.diag(m)))
    if index == 0:
        scale = math.sqrt(max(1e-12, 1 + m[0, 0] - m[1, 1] - m[2, 2])) * 2
        return ((m[2, 1] - m[1, 2]) / scale, 0.25 * scale, (m[0, 1] + m[1, 0]) / scale, (m[0, 2] + m[2, 0]) / scale)
    if index == 1:
        scale = math.sqrt(max(1e-12, 1 + m[1, 1] - m[0, 0] - m[2, 2])) * 2
        return ((m[0, 2] - m[2, 0]) / scale, (m[0, 1] + m[1, 0]) / scale, 0.25 * scale, (m[1, 2] + m[2, 1]) / scale)
    scale = math.sqrt(max(1e-12, 1 + m[2, 2] - m[0, 0] - m[1, 1])) * 2
    return ((m[1, 0] - m[0, 1]) / scale, (m[0, 2] + m[2, 0]) / scale, (m[1, 2] + m[2, 1]) / scale, 0.25 * scale)


def odometry_transform(message):
    pose = message.pose.pose
    p, q = pose.position, pose.orientation
    transform = np.eye(4)
    transform[:3, :3] = quaternion_matrix(q.w, q.x, q.y, q.z)
    transform[:3, 3] = (p.x, p.y, p.z)
    return transform


def set_pose(pose, transform):
    qw, qx, qy, qz = matrix_quaternion(transform[:3, :3])
    pose.position.x = float(transform[0, 3])
    pose.position.y = float(transform[1, 3])
    pose.position.z = float(transform[2, 3])
    pose.orientation.w = qw
    pose.orientation.x = qx
    pose.orientation.y = qy
    pose.orientation.z = qz


def set_transform(message, transform):
    qw, qx, qy, qz = matrix_quaternion(transform[:3, :3])
    message.translation.x = float(transform[0, 3])
    message.translation.y = float(transform[1, 3])
    message.translation.z = float(transform[2, 3])
    message.rotation.w = qw
    message.rotation.x = qx
    message.rotation.y = qy
    message.rotation.z = qz


def voxel_downsample(points, size):
    if len(points) == 0:
        return points
    _, indices = np.unique(np.floor(points / size).astype(np.int32), axis=0, return_index=True)
    return points[indices]


def rigid_alignment(source, target):
    source_center = source.mean(axis=0)
    target_center = target.mean(axis=0)
    covariance = (source - source_center).T @ (target - target_center)
    u, _, vt = np.linalg.svd(covariance)
    rotation = vt.T @ u.T
    if np.linalg.det(rotation) < 0:
        vt[-1] *= -1
        rotation = vt.T @ u.T
    transform = np.eye(4)
    transform[:3, :3] = rotation
    transform[:3, 3] = target_center - rotation @ source_center
    return transform


def icp(source, target_tree, initial, max_iterations=20):
    transform = initial.copy()
    inlier_ratio = 0.0
    rmse = float("inf")
    for _ in range(max_iterations):
        transformed = source @ transform[:3, :3].T + transform[:3, 3]
        distances, indices = target_tree.query(transformed, k=1)
        cutoff = 1.5 if inlier_ratio < 0.3 else 0.8
        valid = distances < cutoff
        if valid.sum() < 30:
            break
        matched_source = transformed[valid]
        matched_target = target_tree.data[indices[valid]]
        delta = rigid_alignment(matched_source, matched_target)
        transform = delta @ transform
        inlier_ratio = float(valid.mean())
        rmse = float(np.sqrt(np.mean(distances[valid] ** 2)))
        if np.linalg.norm(delta[:3, 3]) < 1e-4 and np.linalg.norm(delta[:3, :3] - np.eye(3)) < 1e-5:
            break
    transformed = source @ transform[:3, :3].T + transform[:3, 3]
    distances, _ = target_tree.query(transformed, k=1)
    valid = distances < 0.8
    if valid.sum() >= 30:
        inlier_ratio = float(valid.mean())
        rmse = float(np.sqrt(np.mean(distances[valid] ** 2)))
    return transform, inlier_ratio, rmse


def load_pcd(path):
    data_marker = None
    with open(path, encoding="ascii") as stream:
        for index, line in enumerate(stream):
            if line.strip().upper().startswith("DATA "):
                data_marker = line.strip().split()[1].lower()
                header_lines = index + 1
                break
    if data_marker != "ascii":
        raise ValueError("仅支持平台保存的 ASCII PCD 地图")
    points = np.loadtxt(path, dtype=np.float64, skiprows=header_lines, usecols=(0, 1, 2))
    if points.ndim != 2 or len(points) < 30:
        raise ValueError("PCD 地图有效点数量不足")
    return points[np.isfinite(points).all(axis=1)]


class FastlioLocalization(Node):
    def __init__(self):
        super().__init__("fastlio_global_localization")
        self.declare_parameter("map_file", "")
        self.declare_parameter("topic_namespace", "")
        self.map_file = self.get_parameter("map_file").value
        namespace = self.get_parameter("topic_namespace").value.strip("/")
        self.topic = lambda name: f"/{namespace}/{name.lstrip('/')}" if namespace else name
        if not self.map_file or not Path(self.map_file).is_file():
            raise ValueError(f"定位地图不存在: {self.map_file}")
        self.map_points = voxel_downsample(load_pcd(self.map_file), 0.20)
        self.map_tree = cKDTree(self.map_points)
        self.correction = np.eye(4)
        self.latest_fastlio = None
        self.latest_odom = None
        self.scan_points = None
        self.scan_fastlio = None
        self.scan_lock = threading.Lock()
        self.scan_condition = threading.Condition(self.scan_lock)
        self.running = True
        self.path_poses = []
        self.path_counter = 0
        self.body_sensor = np.eye(4)
        self.body_sensor[0, 3] = 0.15
        self.body_sensor[2, 3] = 0.20

        self.map_publisher = self.create_publisher(PointCloud2, self.topic("/global_map"), 10)
        self.localization_publisher = self.create_publisher(Odometry, self.topic("/localization"), 10)
        self.path_publisher = self.create_publisher(RosPath, self.topic("/localization/path"), 10)
        self.tf_publisher = self.create_publisher(TFMessage, self.topic("/tf"), 10)
        self.create_subscription(PointCloud2, self.topic("/points"), self.on_scan, qos_profile_sensor_data)
        self.create_subscription(Odometry, self.topic("/Odometry"), self.on_odometry, 10)
        self.create_subscription(PoseWithCovarianceStamped, self.topic("/initialpose"), self.on_initial_pose, 10)
        self.map_timer = self.create_timer(2.0, self.publish_map)
        self.worker = threading.Thread(target=self.localization_worker, daemon=True)
        self.worker.start()
        self.publish_map()
        self.get_logger().info(f"纯定位已启动，地图 {self.map_file}，体素点 {len(self.map_points)}")

    def on_initial_pose(self, message):
        pose = message.pose.pose
        yaw = 2.0 * math.atan2(pose.orientation.z, pose.orientation.w)
        correction = np.eye(4)
        correction[:3, :3] = quaternion_matrix(math.cos(yaw / 2), 0, 0, math.sin(yaw / 2))
        correction[:3, 3] = (pose.position.x, pose.position.y, 0.0)
        with self.scan_lock:
            self.correction = correction
        self.get_logger().info("已更新全局初始定位")

    def on_odometry(self, message):
        fastlio = odometry_transform(message)
        with self.scan_lock:
            self.latest_fastlio = fastlio
            correction = self.correction.copy()
        localized = correction @ fastlio
        output = copy.deepcopy(message)
        output.header.frame_id = "map"
        output.child_frame_id = "body"
        set_pose(output.pose.pose, localized)
        self.localization_publisher.publish(output)
        self.latest_odom = output
        self.publish_tf(output.header.stamp, correction)
        self.path_counter += 1
        if self.path_counter % 5 == 0:
            pose = PoseStamped()
            pose.header = output.header
            pose.pose = output.pose.pose
            self.path_poses.append(pose)
            if len(self.path_poses) > 1000:
                self.path_poses.pop(0)
            path = RosPath()
            path.header = output.header
            path.poses = self.path_poses
            self.path_publisher.publish(path)

    def on_scan(self, message):
        if self.latest_fastlio is None:
            return
        points = np.asarray(list(point_cloud2.read_points(message, field_names=("x", "y", "z"), skip_nans=True)))
        if points.ndim != 2 or len(points) < 30:
            return
        with self.scan_lock:
            self.scan_points = voxel_downsample(points, 0.20)
            self.scan_fastlio = self.latest_fastlio.copy()
            self.scan_condition.notify()

    def localization_worker(self):
        while self.running:
            with self.scan_lock:
                if self.scan_points is None:
                    self.scan_condition.wait(timeout=0.5)
                if self.scan_points is None or not self.running:
                    continue
                source = self.scan_points
                fastlio = self.scan_fastlio.copy()
                self.scan_points = None
                initial = self.correction.copy()
            transform = initial @ fastlio @ self.body_sensor
            aligned, fitness, rmse = icp(source, self.map_tree, transform)
            if fitness < 0.35 or rmse > 0.8:
                self.get_logger().warning(f"地图匹配暂不接受: fitness={fitness:.2f}, RMSE={rmse:.2f}")
                continue
            map_body = aligned @ np.linalg.inv(self.body_sensor)
            correction = map_body @ np.linalg.inv(fastlio)
            with self.scan_lock:
                self.correction = correction
            self.get_logger().info(f"地图匹配成功: fitness={fitness:.2f}, RMSE={rmse:.2f}")

    def publish_tf(self, stamp, correction):
        transform = TransformStamped()
        transform.header.stamp = stamp
        transform.header.frame_id = "map"
        transform.child_frame_id = "camera_init"
        set_transform(transform.transform, correction)
        self.tf_publisher.publish(TFMessage(transforms=[transform]))

    def publish_map(self):
        message = point_cloud2.create_cloud_xyz32(
            Header(stamp=self.get_clock().now().to_msg(), frame_id="map"),
            self.map_points.astype(np.float32),
        )
        self.map_publisher.publish(message)

    def destroy_node(self):
        self.running = False
        with self.scan_lock:
            self.scan_condition.notify_all()
        self.worker.join(timeout=1.0)
        super().destroy_node()


def main():
    rclpy.init()
    node = FastlioLocalization()
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
