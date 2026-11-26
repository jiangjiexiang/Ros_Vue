#!/usr/bin/env python3
"""
FAST-LIO 3D 全局定位节点（原生对接 Nav2 TF 链）：
- 订阅 FAST-LIO 局部 3D 里程计 (/Odometry)、3D 点云 (/points)、底盘里程计 (/odom) 与 /initialpose
- 针对保存的 ASCII PCD 地图执行带防跳变和平滑滤波的 3D/4-DoF ICP 全局配准
- 持续发布 Nav2 所需的 map -> odom TF（平面化以保持 3D VoxelLayer 高度基准），以及 map -> camera_init TF
- 发布 /localization (Odometry)、/localization/path (Path) 与 /global_map (PointCloud2)
"""

import copy
import math
import threading
import time
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


def yaw_from_matrix(rot):
    return math.atan2(float(rot[1, 0]), float(rot[0, 0]))


def angle_wrap(angle):
    return (angle + math.pi) % (2.0 * math.pi) - math.pi


def make_yaw_transform(x, y, z, yaw):
    c, s = math.cos(yaw), math.sin(yaw)
    t = np.eye(4)
    t[0, 0], t[0, 1] = c, -s
    t[1, 0], t[1, 1] = s, c
    t[0, 3], t[1, 3], t[2, 3] = float(x), float(y), float(z)
    return t


def project_to_4dof(transform):
    yaw = yaw_from_matrix(transform[:3, :3])
    return make_yaw_transform(transform[0, 3], transform[1, 3], transform[2, 3], yaw)


def blend_4dof(current, target, alpha):
    x = current[0, 3] + alpha * (target[0, 3] - current[0, 3])
    y = current[1, 3] + alpha * (target[1, 3] - current[1, 3])
    z = current[2, 3] + alpha * (target[2, 3] - current[2, 3])
    yaw_cur = yaw_from_matrix(current[:3, :3])
    yaw_tgt = yaw_from_matrix(target[:3, :3])
    yaw = angle_wrap(yaw_cur + alpha * angle_wrap(yaw_tgt - yaw_cur))
    return make_yaw_transform(x, y, z, yaw)


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


def icp(source, target_tree, initial, max_iterations=18):
    transform = initial.copy()
    inlier_ratio = 0.0
    rmse = float("inf")
    for _ in range(max_iterations):
        transformed = source @ transform[:3, :3].T + transform[:3, 3]
        distances, indices = target_tree.query(transformed, k=1)
        cutoff = 1.2 if inlier_ratio < 0.35 else 0.65
        valid = distances < cutoff
        if valid.sum() < 30:
            break
        matched_source = transformed[valid]
        matched_target = target_tree.data[indices[valid]]
        delta = rigid_alignment(matched_source, matched_target)
        # Keep ICP updates planar + Z (avoid roll/pitch drift on sparse LiDAR)
        delta_4dof = project_to_4dof(delta)
        transform = delta_4dof @ transform
        inlier_ratio = float(valid.mean())
        rmse = float(np.sqrt(np.mean(distances[valid] ** 2)))
        if np.linalg.norm(delta_4dof[:3, 3]) < 1e-4 and abs(yaw_from_matrix(delta_4dof[:3, :3])) < 1e-4:
            break
    transformed = source @ transform[:3, :3].T + transform[:3, 3]
    distances, _ = target_tree.query(transformed, k=1)
    valid = distances < 0.65
    if valid.sum() >= 30:
        inlier_ratio = float(valid.mean())
        rmse = float(np.sqrt(np.mean(distances[valid] ** 2)))
    return transform, inlier_ratio, rmse


def load_pcd(path):
    data_marker = None
    header_lines = 0
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


def resolve_pcd_path(map_file: str) -> Path:
    path = Path(map_file)
    if path.suffix.lower() != ".pcd":
        candidate = path.with_suffix(".pcd")
        if candidate.is_file():
            return candidate
    return path


def estimate_floor_z(points: np.ndarray) -> float:
    z = points[:, 2]
    low = z[(z >= -1.0) & (z < 1.0)]
    if len(low) < 50:
        return 0.0
    hist, _ = np.histogram(low, bins=40, range=(-1.0, 1.0))
    return float(-1.0 + (int(np.argmax(hist)) + 0.5) * 0.05)


class FastlioLocalization(Node):
    def __init__(self):
        super().__init__("fastlio_global_localization")
        self.declare_parameter("map_file", "")
        self.declare_parameter("topic_namespace", "")
        self.declare_parameter("auto_initial_pose", True)

        raw_map_file = str(self.get_parameter("map_file").value or "").strip()
        namespace = str(self.get_parameter("topic_namespace").value or "").strip("/")
        self.auto_initial_pose = bool(self.get_parameter("auto_initial_pose").value)
        self.topic = lambda name: f"/{namespace}/{name.lstrip('/')}" if namespace else f"/{name.lstrip('/')}"

        self.map_path = resolve_pcd_path(raw_map_file) if raw_map_file else None
        self.map_points = None
        self.map_tree = None
        self.map_floor_z = 0.0
        if self.map_path is not None and self.map_path.is_file():
            raw_pts = load_pcd(self.map_path)
            self.map_floor_z = estimate_floor_z(raw_pts)
            self.map_points = voxel_downsample(raw_pts, 0.20)
            self.map_tree = cKDTree(self.map_points)
            self.get_logger().info(
                f"FAST-LIO 3D 定位已加载地图 {self.map_path}，体素点 {len(self.map_points)}，地面 Z≈{self.map_floor_z:.2f}m"
            )
        else:
            self.get_logger().warning(f"未找到同名 PCD 地图 ({raw_map_file})，将仅使用 FAST-LIO 里程计定位")

        self.correction = np.eye(4)
        self.initialized_pose = not self.auto_initial_pose
        self.allow_large_jump = True
        self.latest_fastlio = None
        self.latest_base_odom = None
        self.latest_localized = None
        self.last_icp_time = 0.0
        self.scan_points = None
        self.scan_fastlio = None
        self.scan_lock = threading.Lock()
        self.scan_condition = threading.Condition(self.scan_lock)
        self.running = True
        self.path_poses = []
        self.last_path_xy = None
        self.body_sensor = np.eye(4)
        # IsaacLab MultiMeshRayCaster outputs points relative to base_link XY origin (X=0);
        # keep Z=0.20 to match FAST-LIO/PCD map floor elevation (z≈0.20m).
        self.body_sensor[0, 3] = 0.0
        self.body_sensor[2, 3] = 0.20

        self.map_publisher = self.create_publisher(PointCloud2, self.topic("/global_map"), 10)
        self.localization_publisher = self.create_publisher(Odometry, self.topic("/localization"), 10)
        self.path_publisher = self.create_publisher(RosPath, self.topic("/localization/path"), 10)
        self.tf_publisher = self.create_publisher(TFMessage, self.topic("/tf"), 10)

        self.create_subscription(PointCloud2, self.topic("/points"), self.on_scan, qos_profile_sensor_data)
        self.create_subscription(Odometry, self.topic("/Odometry"), self.on_fastlio_odometry, 10)
        self.create_subscription(Odometry, self.topic("/odom"), self.on_base_odometry, 10)
        self.create_subscription(PoseWithCovarianceStamped, self.topic("/initialpose"), self.on_initial_pose, 10)

        self.tf_timer = self.create_timer(0.05, self.publish_tf_tick)
        if self.map_points is not None:
            self.map_timer = self.create_timer(3.0, self.publish_map)
            self.publish_map()
        self.worker = threading.Thread(target=self.localization_worker, daemon=True)
        self.worker.start()
        self.get_logger().info(f"FAST-LIO 全局定位节点已启动，命名空间: '{namespace or '/'}'")

    def on_base_odometry(self, message: Odometry):
        base_tf = odometry_transform(message)
        with self.scan_lock:
            self.latest_base_odom = base_tf
            if not self.initialized_pose and self.latest_fastlio is not None:
                self._align_correction_to_target(base_tf)
                self.initialized_pose = True
                self.allow_large_jump = True
                self.get_logger().info(
                    f"已用当前位姿自动初始化 FAST-LIO 全局定位: ({base_tf[0, 3]:.2f}, {base_tf[1, 3]:.2f})"
                )

    def _align_correction_to_target(self, target_map_body):
        if self.latest_fastlio is not None:
            raw_corr = target_map_body @ np.linalg.inv(self.latest_fastlio)
            self.correction = project_to_4dof(raw_corr)
        else:
            self.correction = project_to_4dof(target_map_body)

    def on_initial_pose(self, message: PoseWithCovarianceStamped):
        pose = message.pose.pose
        q = pose.orientation
        yaw = math.atan2(2.0 * (q.w * q.z + q.x * q.y), 1.0 - 2.0 * (q.y * q.y + q.z * q.z))
        z_height = self.map_floor_z + 0.38
        target = make_yaw_transform(pose.position.x, pose.position.y, z_height, yaw)
        with self.scan_lock:
            self._align_correction_to_target(target)
            self.initialized_pose = True
            self.allow_large_jump = True
        self.get_logger().info(
            f"已手动更新 FAST-LIO 全局初始定位: ({pose.position.x:.2f}, {pose.position.y:.2f}, yaw={math.degrees(yaw):.1f}°)"
        )

    def on_fastlio_odometry(self, message: Odometry):
        fastlio = odometry_transform(message)
        with self.scan_lock:
            self.latest_fastlio = fastlio
            if not self.initialized_pose and self.latest_base_odom is not None:
                self._align_correction_to_target(self.latest_base_odom)
                self.initialized_pose = True
                self.allow_large_jump = True
                self.get_logger().info(
                    f"已用当前位姿自动初始化 FAST-LIO 全局定位: ({self.latest_base_odom[0, 3]:.2f}, {self.latest_base_odom[1, 3]:.2f})"
                )
            correction = self.correction.copy()
            base_odom = None if self.latest_base_odom is None else self.latest_base_odom.copy()

        localized = correction @ fastlio
        with self.scan_lock:
            self.latest_localized = localized

        output = copy.deepcopy(message)
        output.header.stamp = self.get_clock().now().to_msg()
        output.header.frame_id = "map"
        output.child_frame_id = "body"
        set_pose(output.pose.pose, localized)
        self.localization_publisher.publish(output)

        self._publish_tf(output.header.stamp, correction, localized, base_odom)

        px, py = float(localized[0, 3]), float(localized[1, 3])
        if self.last_path_xy is None or math.hypot(px - self.last_path_xy[0], py - self.last_path_xy[1]) >= 0.12:
            self.last_path_xy = (px, py)
            pose_st = PoseStamped()
            pose_st.header = output.header
            pose_st.pose = output.pose.pose
            self.path_poses.append(pose_st)
            if len(self.path_poses) > 1000:
                self.path_poses.pop(0)
            path = RosPath()
            path.header = output.header
            path.poses = self.path_poses
            self.path_publisher.publish(path)

    def publish_tf_tick(self):
        with self.scan_lock:
            correction = self.correction.copy()
            localized = None if self.latest_localized is None else self.latest_localized.copy()
            base_odom = None if self.latest_base_odom is None else self.latest_base_odom.copy()
        stamp = self.get_clock().now().to_msg()
        self._publish_tf(stamp, correction, localized, base_odom)

    def _publish_tf(self, stamp, correction, localized, base_odom):
        transforms = []

        # 1. map -> odom (planar 2D correction for Nav2 & 3D VoxelLayer Z-ground consistency)
        if localized is not None and base_odom is not None:
            map_odom_raw = localized @ np.linalg.inv(base_odom)
            map_odom = make_yaw_transform(
                map_odom_raw[0, 3],
                map_odom_raw[1, 3],
                0.0,
                yaw_from_matrix(map_odom_raw[:3, :3]),
            )
        else:
            map_odom = np.eye(4)
        tf_map_odom = TransformStamped()
        tf_map_odom.header.stamp = stamp
        tf_map_odom.header.frame_id = "map"
        tf_map_odom.child_frame_id = "odom"
        set_transform(tf_map_odom.transform, map_odom)
        transforms.append(tf_map_odom)

        # 2. map -> camera_init (for FAST-LIO registered cloud & body chain)
        tf_map_cam = TransformStamped()
        tf_map_cam.header.stamp = stamp
        tf_map_cam.header.frame_id = "map"
        tf_map_cam.child_frame_id = "camera_init"
        set_transform(tf_map_cam.transform, correction)
        transforms.append(tf_map_cam)

        self.tf_publisher.publish(TFMessage(transforms=transforms))

    def on_scan(self, message: PointCloud2):
        if self.map_tree is None or self.latest_fastlio is None:
            return
        now = time.monotonic()
        if now - self.last_icp_time < 0.45:
            return
        pts_list = [[p[0], p[1], p[2]] for p in point_cloud2.read_points(message, field_names=("x", "y", "z"), skip_nans=True)]
        if len(pts_list) < 30:
            return
        points = np.asarray(pts_list, dtype=np.float64)
        # Filter out body self-hits (<0.35m) and ceiling (>2.0m)
        dists = np.linalg.norm(points[:, :2], axis=1)
        points = points[(dists >= 0.35) & (dists <= 18.0) & (points[:, 2] >= -0.6) & (points[:, 2] <= 1.8)]
        if len(points) < 30:
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
                if self.scan_points is None or not self.running or self.map_tree is None:
                    continue
                source = self.scan_points
                fastlio = self.scan_fastlio.copy()
                self.scan_points = None
                initial = self.correction.copy()
                allow_jump = self.allow_large_jump

            self.last_icp_time = time.monotonic()
            transform = initial @ fastlio @ self.body_sensor
            aligned, fitness, rmse = icp(source, self.map_tree, transform)
            if fitness < 0.40 or rmse > 0.55:
                continue

            map_body = aligned @ np.linalg.inv(self.body_sensor)
            candidate_corr = project_to_4dof(map_body @ np.linalg.inv(fastlio))
            pos_jump = float(np.linalg.norm(candidate_corr[:2, 3] - initial[:2, 3]))
            yaw_jump = abs(angle_wrap(yaw_from_matrix(candidate_corr[:3, :3]) - yaw_from_matrix(initial[:3, :3])))
            if not allow_jump and (pos_jump > 0.65 or yaw_jump > math.radians(20.0)):
                continue

            alpha = 0.85 if allow_jump else 0.30
            updated = blend_4dof(initial, candidate_corr, alpha)
            with self.scan_lock:
                self.correction = updated
                self.allow_large_jump = False

    def publish_map(self):
        if self.map_points is None:
            return
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
