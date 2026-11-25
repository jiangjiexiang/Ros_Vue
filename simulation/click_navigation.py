import heapq
import math
import time
from pathlib import Path

import numpy as np

import rclpy
from geometry_msgs.msg import PoseStamped, Twist
from nav_msgs.msg import Odometry, Path as RosPath
from rclpy.executors import ExternalShutdownException
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import PointCloud2
from sensor_msgs_py import point_cloud2

from fastlio_localization import load_pcd


def angle_wrap(value):
    return (value + math.pi) % (2 * math.pi) - math.pi


def yaw_from_pose(pose):
    q = pose.orientation
    return math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.z + q.z * q.z))


class GridMap:
    def __init__(self, points, resolution=0.25, robot_radius=0.32):
        self.resolution = resolution
        obstacles = points[(points[:, 2] >= 0.35) & (points[:, 2] <= 2.2)]
        self.min_x = float(points[:, 0].min() - 0.5)
        self.min_y = float(points[:, 1].min() - 0.5)
        self.width = int(np.ceil((points[:, 0].max() - self.min_x + 0.5) / resolution))
        self.height = int(np.ceil((points[:, 1].max() - self.min_y + 0.5) / resolution))
        self.occupied = np.zeros((self.height, self.width), dtype=bool)
        cells = np.floor((obstacles[:, :2] - [self.min_x, self.min_y]) / resolution).astype(int)
        radius_cells = int(np.ceil(robot_radius / resolution))
        for x, y in cells:
            for dx in range(-radius_cells, radius_cells + 1):
                for dy in range(-radius_cells, radius_cells + 1):
                    if math.hypot(dx * resolution, dy * resolution) > robot_radius:
                        continue
                    gx, gy = x + dx, y + dy
                    if 0 <= gx < self.width and 0 <= gy < self.height:
                        self.occupied[gy, gx] = True

    def add_obstacle_points(self, points, position, yaw):
        if len(points) == 0:
            return
        cosine, sine = math.cos(yaw), math.sin(yaw)
        world = points[:, :2].copy()
        world[:, 0] = points[:, 0] * cosine - points[:, 1] * sine + position.x
        world[:, 1] = points[:, 0] * sine + points[:, 1] * cosine + position.y
        cells = np.floor((world - [self.min_x, self.min_y]) / self.resolution).astype(int)
        for x, y in cells:
            for dx in range(-1, 2):
                for dy in range(-1, 2):
                    gx, gy = x + dx, y + dy
                    if 0 <= gx < self.width and 0 <= gy < self.height:
                        self.occupied[gy, gx] = True

    def cell(self, x, y):
        return int(math.floor((x - self.min_x) / self.resolution)), int(math.floor((y - self.min_y) / self.resolution))

    def point(self, cell):
        return self.min_x + (cell[0] + 0.5) * self.resolution, self.min_y + (cell[1] + 0.5) * self.resolution

    def free(self, cell):
        x, y = cell
        return 0 <= x < self.width and 0 <= y < self.height and not self.occupied[y, x]

    def nearest_free(self, cell):
        if self.free(cell):
            return cell
        candidates = []
        for y in range(self.height):
            for x in range(self.width):
                if not self.occupied[y, x]:
                    distance = math.hypot(x - cell[0], y - cell[1])
                    if distance <= 6:
                        candidates.append((distance, (x, y)))
        return min(candidates)[1] if candidates else None

    def line_free(self, start, end):
        distance = math.hypot(end[0] - start[0], end[1] - start[1])
        steps = max(1, int(distance * 2))
        for index in range(steps + 1):
            ratio = index / steps
            cell = (
                round(start[0] + (end[0] - start[0]) * ratio),
                round(start[1] + (end[1] - start[1]) * ratio),
            )
            if not self.free(cell):
                return False
        return True

    def plan(self, start, goal):
        start = self.nearest_free(start)
        goal = self.nearest_free(goal)
        if start is None or goal is None:
            return []
        queue = [(0.0, start)]
        costs = {start: 0.0}
        previous = {}
        neighbors = [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)]
        while queue:
            _, current = heapq.heappop(queue)
            if current == goal:
                break
            for dx, dy in neighbors:
                candidate = current[0] + dx, current[1] + dy
                if not self.free(candidate):
                    continue
                cost = costs[current] + math.hypot(dx, dy)
                if cost >= costs.get(candidate, float("inf")):
                    continue
                costs[candidate] = cost
                previous[candidate] = current
                heuristic = math.hypot(goal[0] - candidate[0], goal[1] - candidate[1])
                heapq.heappush(queue, (cost + heuristic, candidate))
        if goal not in costs:
            return []
        cells = [goal]
        while cells[-1] != start:
            cells.append(previous[cells[-1]])
        cells.reverse()
        simplified = [cells[0]]
        index = 0
        while index < len(cells) - 1:
            candidate = len(cells) - 1
            while candidate > index + 1 and not self.line_free(cells[index], cells[candidate]):
                candidate -= 1
            simplified.append(cells[candidate])
            index = candidate
        return [self.point(cell) for cell in simplified]


class ClickNavigation(Node):
    def __init__(self):
        super().__init__("click_navigation")
        self.declare_parameter("map_file", "")
        self.declare_parameter("topic_namespace", "")
        self.map_file = self.get_parameter("map_file").value
        namespace = self.get_parameter("topic_namespace").value.strip("/")
        self.topic = lambda name: f"/{namespace}/{name.lstrip('/')}" if namespace else name
        if not self.map_file or not Path(self.map_file).is_file():
            raise ValueError(f"导航地图不存在: {self.map_file}")
        self.grid = GridMap(load_pcd(self.map_file))
        self.pose = None
        self.yaw = 0.0
        self.waypoints = []
        self.goal = None
        self.active = False
        self.last_command = None
        self.last_command_time = self.get_clock().now()
        self.last_obstacle_update = 0.0
        self.command_publisher = self.create_publisher(Twist, self.topic("/cmd_vel"), 10)
        self.plan_publisher = self.create_publisher(RosPath, self.topic("/plan"), 10)
        self.create_subscription(Odometry, self.topic("/localization"), self.on_localization, 10)
        self.create_subscription(PoseStamped, self.topic("/goal_pose"), self.on_goal, 10)
        self.create_subscription(PointCloud2, self.topic("/points"), self.on_points, qos_profile_sensor_data)
        self.create_subscription(Twist, self.topic("/cmd_vel"), self.on_command, 10)
        self.get_logger().info(f"点击导航已启动，地图 {self.map_file}")

    def on_goal(self, message):
        if self.pose is None:
            self.get_logger().warning("等待定位位姿，无法开始导航")
            return
        self.goal = (message.pose.position.x, message.pose.position.y)
        self.active = True
        self.replan(message.header)

    def on_points(self, message):
        now = time.monotonic()
        if self.pose is None or now - self.last_obstacle_update < 0.5:
            return
        self.last_obstacle_update = now
        points = np.asarray(list(point_cloud2.read_points(message, field_names=("x", "y", "z"), skip_nans=True)))
        if points.ndim != 2 or len(points) == 0:
            return
        points = points[(points[:, 2] > 0.05) & (points[:, 2] < 2.2)][::4]
        self.grid.add_obstacle_points(points, self.pose, self.yaw)
        if self.active:
            self.replan(message.header)

    def replan(self, header):
        start = self.grid.cell(self.pose.x, self.pose.y)
        goal = self.grid.cell(*self.goal)
        self.waypoints = self.grid.plan(start, goal)
        if not self.waypoints:
            self.get_logger().warning("目标不可达，请在地图空闲区域重新点击")
            self.stop_motion()
            return
        self.publish_plan(header)
        self.get_logger().info(f"路径已更新，包含 {len(self.waypoints)} 个跟踪点")

    def on_localization(self, message):
        self.pose = message.pose.pose.position
        self.yaw = yaw_from_pose(message.pose.pose)
        if self.active:
            self.track_path()

    def on_command(self, message):
        values = (message.linear.x, message.angular.z)
        if self.last_command is not None and values == self.last_command:
            return
        if self.active:
            self.get_logger().info("检测到人工速度指令，停止自动导航")
            self.active = False
            self.waypoints = []

    def track_path(self):
        while self.waypoints:
            target = self.waypoints[0]
            if math.hypot(target[0] - self.pose.x, target[1] - self.pose.y) > 0.30:
                break
            self.waypoints.pop(0)
        if not self.waypoints:
            self.active = False
            self.publish_velocity(0.0, 0.0)
            self.get_logger().info("已到达点击目标")
            return
        target = self.waypoints[0]
        desired_yaw = math.atan2(target[1] - self.pose.y, target[0] - self.pose.x)
        error = angle_wrap(desired_yaw - self.yaw)
        angular = max(-1.0, min(1.0, 2.0 * error))
        distance = math.hypot(target[0] - self.pose.x, target[1] - self.pose.y)
        linear = min(0.6, distance) * max(0.0, math.cos(error))
        if abs(error) > 1.2:
            linear = 0.0
        self.publish_velocity(linear, angular)

    def publish_velocity(self, linear, angular):
        message = Twist()
        message.linear.x = float(linear)
        message.angular.z = float(angular)
        self.last_command = (message.linear.x, message.angular.z)
        self.command_publisher.publish(message)

    def publish_plan(self, header):
        message = RosPath()
        message.header = header
        message.header.frame_id = "map"
        for x, y in self.waypoints:
            pose = PoseStamped()
            pose.header = message.header
            pose.pose.position.x = x
            pose.pose.position.y = y
            pose.pose.orientation.w = 1.0
            message.poses.append(pose)
        self.plan_publisher.publish(message)

    def stop_motion(self):
        self.active = False
        self.waypoints = []
        self.publish_velocity(0.0, 0.0)

    def destroy_node(self):
        if rclpy.ok():
            self.publish_velocity(0.0, 0.0)
        super().destroy_node()


def main():
    rclpy.init()
    node = ClickNavigation()
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
