import argparse
import json
import math
import os
import signal
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path

from isaaclab.app import AppLauncher


def load_control_config():
    project_root = Path(__file__).resolve().parent.parent
    config_path = os.environ.get("ROS_CONFIG_FILE", project_root / "config" / "ros_config.json")
    control = {"max_linear_speed": 5.0, "max_angular_speed": 1.0, "command_timeout_ms": 600}
    try:
        with open(config_path, encoding="utf-8") as config_file:
            configured = json.load(config_file).get("control", {})
        for name in control:
            value = configured.get(name)
            if isinstance(value, (int, float)) and math.isfinite(value):
                control[name] = value
    except (OSError, json.JSONDecodeError):
        pass
    control["max_linear_speed"] = max(0.1, min(1.0, control["max_linear_speed"]))
    control["max_angular_speed"] = max(0.1, min(1.0, control["max_angular_speed"]))
    control["command_timeout_ms"] = max(200, min(3000, round(control["command_timeout_ms"])))
    return control


CONTROL_CONFIG = load_control_config()
parser = argparse.ArgumentParser(description="四足巡检机器狗 GPU 仿真场景")
parser.add_argument("--scene", choices=("indoor", "warehouse", "outdoor"), default="indoor")
parser.add_argument("--test-steps", type=int, default=0, help="运行指定物理步数后自动退出；0 表示持续运行")
parser.add_argument("--control-port", type=int, default=8766, help="本机网页控制桥接端口")
parser.add_argument("--render-interval", type=int, default=4, help="GUI 每隔多少个物理步渲染一次")
parser.add_argument("--overview-camera", action="store_true", help="启用 1280x720 第三人称跟随视角相机 (/camera/overview)")
AppLauncher.add_app_launcher_args(parser)
args_cli = parser.parse_args()
args_cli.enable_cameras = True
if args_cli.render_interval < 1:
    parser.error("--render-interval 必须大于等于 1")
app_launcher = AppLauncher(args_cli)
simulation_app = app_launcher.app
stop_requested = False


def request_stop(signum, frame):
    global stop_requested
    stop_requested = True
    print(f"[SCENE_SIGNAL] 收到停止信号 {signum}", flush=True)


signal.signal(signal.SIGTERM, request_stop)

import torch
from PIL import Image

import isaaclab.sim as sim_utils
from isaaclab.assets import Articulation
from isaaclab.sensors.camera import Camera, CameraCfg
from isaaclab.sensors.ray_caster import MultiMeshRayCaster, MultiMeshRayCasterCfg, patterns
from isaaclab.utils.math import quat_apply_inverse
from isaaclab_assets.robots.unitree import UNITREE_GO2_CFG

try:
    from simulation.scene_assets import (
        build_realistic_indoor,
        build_realistic_outdoor,
        build_realistic_warehouse,
    )
except ImportError:
    from scene_assets import (
        build_realistic_indoor,
        build_realistic_outdoor,
        build_realistic_warehouse,
    )

SCENES = {
    "indoor": {
        "name": "室内配电与机房巡检",
        "spawn": (-3.3, -2.2, 0.42),
        "bounds": (12.0, 10.0),
        "camera": ([9.5, -11.5, 10.0], [0.0, 0.0, 0.0]),
        "targets": [(-3.4, -1.8), (-2.1, -1.2), (1.8, -0.9), (4.5, -2.2)],
    },
    "warehouse": {
        "name": "工业仓储物流巡检",
        "spawn": (-5.5, -0.9, 0.42),
        "bounds": (16.0, 13.0),
        "camera": ([11.0, -13.0, 12.0], [0.0, 0.0, 0.0]),
        "targets": [(-5.2, -0.9), (-1.8, -0.9), (2.2, -0.9), (5.5, 4.2)],
    },
    "outdoor": {
        "name": "户外变电站巡检",
        "spawn": (-5.0, -3.4, 0.42),
        "bounds": (17.0, 14.0),
        "camera": ([11.0, -13.0, 11.0], [0.0, 0.0, 0.5]),
        "targets": [(-4.2, -0.4), (-1.2, 2.2), (3.2, -0.5), (5.2, -4.2)],
    },
}

COLORS = {
    "wall": (0.28, 0.34, 0.40),
    "indoor": (0.32, 0.48, 0.58),
    "warehouse": (0.62, 0.40, 0.16),
    "outdoor": (0.26, 0.42, 0.24),
    "crate": (0.55, 0.31, 0.12),
    "metal": (0.20, 0.25, 0.29),
    "marker": (0.04, 0.75, 0.82),
    "warning": (0.90, 0.58, 0.08),
}

LIDAR_METADATA = {
    "type": "virtual_2d_raycaster",
    "frame_id": "base_scan",
    "beams": 360,
    "angle_min": -math.pi,
    "angle_max": math.pi - math.radians(1.0),
    "angle_increment": math.radians(1.0),
    "range_min": 0.05,
    "range_max": 12.0,
}

POINTCLOUD_UPDATE_PERIOD = 0.1
POINTCLOUD_METADATA = {
    "type": "multimesh_3d_lidar",
    "frame_id": "base_scan",
    "channels": 16,
    "vertical_fov_range_deg": [-15.0, 15.0],
    "horizontal_fov_range_deg": [-180.0, 180.0],
    "horizontal_resolution_deg": 2.0,
    "horizontal_samples": 180,
    "max_points": 2880,
    "range_min": 0.05,
    "range_max": 20.0,
    "update_period": POINTCLOUD_UPDATE_PERIOD,
    "rate_hz": 10.0,
}

CAMERA_WIDTH = 640
CAMERA_HEIGHT = 360
OVERVIEW_WIDTH = 1280
OVERVIEW_HEIGHT = 720
CAMERA_UPDATE_PERIOD = 1.0 / 30.0
CAMERA_FRAME_IDS = {
    "primary": "camera_primary_optical_frame",
    "overview": "camera_overview_frame",
}


class ControlState:
    def __init__(self, command_timeout_ms=600):
        self.lock = threading.Lock()
        self.command_timeout = command_timeout_ms / 1000.0
        self.linear_x = 0.0
        self.angular_z = 0.0
        self.command_time = 0.0
        self.last_command_sequence = 0
        self.applied_linear_x = 0.0
        self.applied_angular_z = 0.0
        self.policy_action = None
        self.policy_step = 0
        self.telemetry = {"ready": False}
        self.camera_frames = {}
        self.pointcloud_data = None

    def set_command(self, linear_x, angular_z, sequence=None):
        with self.lock:
            if sequence is not None and sequence <= self.last_command_sequence:
                return False
            if sequence is not None:
                self.last_command_sequence = sequence
            self.linear_x = linear_x
            self.angular_z = angular_z
            self.command_time = time.monotonic()
            return True

    def command(self):
        with self.lock:
            if time.monotonic() - self.command_time > self.command_timeout:
                return 0.0, 0.0
            return self.linear_x, self.angular_z

    def update_telemetry(self, scene, steps, position, quaternion, velocity, yaw, linear_x, angular_z, scan, sim_time):
        with self.lock:
            pointcloud_metadata = dict(POINTCLOUD_METADATA)
            pointcloud_metadata["point_count"] = (
                0 if self.pointcloud_data is None else len(self.pointcloud_data["points"])
            )
            self.telemetry = {
                "ready": True,
                "scene": scene,
                "steps": steps,
                "sim_time": sim_time,
                "wall_time": time.time(),
                "position": {"x": position[0], "y": position[1], "z": position[2]},
                "quaternion": {"w": quaternion[0], "x": quaternion[1], "y": quaternion[2], "z": quaternion[3]},
                "velocity": {
                    "linear": {"x": velocity[0], "y": velocity[1], "z": velocity[2]},
                    "angular": {"x": velocity[3], "y": velocity[4], "z": velocity[5]},
                },
                "yaw": yaw,
                "command": {"linearX": linear_x, "angularZ": angular_z},
                "lidar": dict(LIDAR_METADATA),
                "scan": scan,
                "pointcloud": pointcloud_metadata,
            }

    def update_pointcloud(self, points, obstacle_points, sim_time):
        with self.lock:
            self.pointcloud_data = {
                "frame_id": POINTCLOUD_METADATA["frame_id"],
                "obstacle_frame_id": POINTCLOUD_METADATA["frame_id"],
                "scan_period": POINTCLOUD_UPDATE_PERIOD,
                "sim_time": sim_time,
                "wall_time": time.time(),
                "points": points,
                "obstacle_points": obstacle_points,
            }

    def pointcloud(self):
        with self.lock:
            return self.pointcloud_data

    def update_camera(self, name, jpeg, sim_time):
        with self.lock:
            self.camera_frames[name] = (jpeg, sim_time, time.time())

    def camera_frame(self, name):
        with self.lock:
            return self.camera_frames.get(name)

    def snapshot(self):
        with self.lock:
            return dict(self.telemetry)


class ControlHandler(BaseHTTPRequestHandler):
    def respond(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/status":
            self.respond(200, self.server.control_state.snapshot())
            return
        if self.path == "/pointcloud":
            pointcloud = self.server.control_state.pointcloud()
            if pointcloud is None:
                self.respond(503, {"success": False, "error": "3D 点云尚未就绪"})
                return
            self.respond(200, pointcloud)
            return
        if self.path.startswith("/camera/"):
            name = self.path.removeprefix("/camera/")
            if name not in CAMERA_FRAME_IDS:
                self.respond(404, {"success": False, "error": "相机不存在"})
                return
            frame = self.server.control_state.camera_frame(name)
            if frame is None:
                self.respond(503, {"success": False, "error": "相机图像尚未就绪"})
                return
            jpeg, sim_time, wall_time = frame
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(jpeg)))
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Frame-Id", CAMERA_FRAME_IDS[name])
            self.send_header("X-Sample-Time", str(sim_time))
            self.send_header("X-Wall-Time", str(wall_time))
            w = OVERVIEW_WIDTH if name == "overview" else CAMERA_WIDTH
            h = OVERVIEW_HEIGHT if name == "overview" else CAMERA_HEIGHT
            self.send_header("X-Image-Width", str(w))
            self.send_header("X-Image-Height", str(h))
            self.end_headers()
            self.wfile.write(jpeg)
            return
        self.respond(404, {"success": False, "error": "接口不存在"})

    def do_POST(self):
        if self.path != "/velocity":
            self.respond(404, {"success": False, "error": "接口不存在"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 2048:
                raise ValueError("请求大小无效")
            data = json.loads(self.rfile.read(length))
            linear_x = float(data["linearX"])
            angular_z = float(data["angularZ"])
            if not math.isfinite(linear_x) or not math.isfinite(angular_z):
                raise ValueError("速度必须是有限数值")
            linear_limit = CONTROL_CONFIG["max_linear_speed"]
            angular_limit = CONTROL_CONFIG["max_angular_speed"]
            linear_x = max(-linear_limit, min(linear_limit, linear_x))
            angular_z = max(-angular_limit, min(angular_limit, angular_z))
            sequence = data.get("sequence")
            if sequence is not None and (not isinstance(sequence, int) or isinstance(sequence, bool)):
                raise ValueError("指令序列号必须是整数")
            accepted = self.server.control_state.set_command(linear_x, angular_z, sequence)
            self.respond(
                200,
                {"success": accepted, "stale": not accepted, "linearX": linear_x, "angularZ": angular_z},
            )
        except (ValueError, TypeError, KeyError, json.JSONDecodeError) as err:
            self.respond(400, {"success": False, "error": str(err)})

    def log_message(self, format, *args):
        pass


def quaternion_y(angle_degrees):
    angle = math.radians(angle_degrees) / 2.0
    return (math.cos(angle), 0.0, math.sin(angle), 0.0)


def box(name, position, size, color, rotation=None):
    cfg = sim_utils.CuboidCfg(
        size=size,
        collision_props=sim_utils.CollisionPropertiesCfg(),
        visual_material=sim_utils.PreviewSurfaceCfg(diffuse_color=color, roughness=0.75),
        physics_material=sim_utils.RigidBodyMaterialCfg(static_friction=0.9, dynamic_friction=0.8),
    )
    cfg.func(
        f"/World/Environment/{name}",
        cfg,
        translation=position,
        orientation=rotation or (1.0, 0.0, 0.0, 0.0),
    )


def wall(name, position, size):
    box(name, position, size, COLORS["wall"])


def marker(index, position):
    cfg = sim_utils.CylinderCfg(
        radius=0.28,
        height=0.018,
        visual_material=sim_utils.PreviewSurfaceCfg(
            diffuse_color=COLORS["marker"], emissive_color=COLORS["marker"], roughness=0.35
        ),
    )
    cfg.func(f"/World/Route/Target_{index}", cfg, translation=(position[0], position[1], 0.025))


def boundary(width, depth):
    wall("BoundaryNorth", (0.0, depth / 2, 0.75), (width + 0.2, 0.2, 1.5))
    wall("BoundarySouth", (0.0, -depth / 2, 0.75), (width + 0.2, 0.2, 1.5))
    wall("BoundaryEast", (width / 2, 0.0, 0.75), (0.2, depth, 1.5))
    wall("BoundaryWest", (-width / 2, 0.0, 0.75), (0.2, depth, 1.5))


def build_indoor():
    boundary(12.0, 10.0)
    wall("OfficeDividerA", (-1.2, 2.0, 0.65), (0.16, 4.0, 1.3))
    wall("OfficeDividerB", (-1.2, -3.6, 0.65), (0.16, 2.8, 1.3))
    wall("MeetingRoomA", (2.0, 1.0, 0.65), (4.8, 0.16, 1.3))
    wall("MeetingRoomB", (4.8, -0.2, 0.65), (0.16, 2.4, 1.3))
    for index, (x, y) in enumerate(((1.0, 3.2), (3.5, 3.2), (-4.0, 2.7))):
        box(f"DeskTop_{index}", (x, y, 0.72), (1.4, 0.7, 0.10), COLORS["indoor"])
        for leg, (dx, dy) in enumerate(((-0.55, -0.25), (-0.55, 0.25), (0.55, -0.25), (0.55, 0.25))):
            box(f"DeskLeg_{index}_{leg}", (x + dx, y + dy, 0.35), (0.08, 0.08, 0.70), COLORS["metal"])
    for index, (x, y) in enumerate(((1.2, -2.2), (2.0, -2.2), (2.8, -2.2))):
        box(f"InspectionCabinet_{index}", (x, y, 0.55), (0.65, 0.55, 1.1), COLORS["indoor"])


def shelf(index, x, y):
    for level, z in enumerate((0.15, 0.75, 1.35)):
        box(f"Shelf_{index}_Level_{level}", (x, y, z), (2.8, 0.9, 0.10), COLORS["metal"])
    for post, (dx, dy) in enumerate(((-1.3, -0.38), (-1.3, 0.38), (1.3, -0.38), (1.3, 0.38))):
        box(f"Shelf_{index}_Post_{post}", (x + dx, y + dy, 0.75), (0.08, 0.08, 1.5), COLORS["warehouse"])
    for level, z in enumerate((0.43, 1.03)):
        for item, dx in enumerate((-0.85, 0.0, 0.85)):
            box(f"Shelf_{index}_Cargo_{level}_{item}", (x + dx, y, z), (0.65, 0.65, 0.45), COLORS["crate"])


def build_warehouse():
    boundary(16.0, 13.0)
    for index, (x, y) in enumerate(((-3.8, 1.8), (0.0, 1.8), (3.8, 1.8))):
        shelf(index, x, y)
    crates = [(-4.5, -2.0, 0.45), (-3.5, -2.0, 0.45), (-4.0, -2.0, 1.25), (1.0, -2.8, 0.5), (2.0, -2.4, 0.35)]
    for index, (x, y, z) in enumerate(crates):
        size = 0.8 if index != 4 else 0.6
        box(f"FloorCrate_{index}", (x, y, z), (size, size, size), COLORS["crate"])
    wall("NarrowPassageA", (5.4, -1.8, 0.7), (0.18, 3.2, 1.4))
    wall("NarrowPassageB", (4.0, -3.3, 0.7), (2.8, 0.18, 1.4))
    for index, (x, y) in enumerate(((-1.0, -4.5), (0.0, -4.5), (1.0, -4.5))):
        cfg = sim_utils.CylinderCfg(
            radius=0.12,
            height=0.55,
            collision_props=sim_utils.CollisionPropertiesCfg(),
            visual_material=sim_utils.PreviewSurfaceCfg(diffuse_color=COLORS["warning"]),
        )
        cfg.func(f"/World/Environment/SafetyPost_{index}", cfg, translation=(x, y, 0.275))


def build_outdoor():
    boundary(17.0, 14.0)
    box("RampUp", (-2.8, 1.8, 0.36), (3.6, 2.2, 0.16), COLORS["outdoor"], quaternion_y(-12.0))
    box("RampPlatform", (0.1, 1.8, 0.72), (2.2, 2.2, 0.18), COLORS["outdoor"])
    box("RampDown", (2.7, 1.8, 0.36), (3.6, 2.2, 0.16), COLORS["outdoor"], quaternion_y(12.0))
    for index in range(6):
        height = 0.10 * (index + 1)
        box(f"Stair_{index}", (-4.8 + index * 0.42, -1.8, height / 2), (0.44, 1.8, height), COLORS["wall"])
    for index, (x, y, radius) in enumerate(((3.8, -2.8, 0.65), (5.2, -1.8, 0.45), (2.5, -3.8, 0.40))):
        cfg = sim_utils.SphereCfg(
            radius=radius,
            collision_props=sim_utils.CollisionPropertiesCfg(),
            visual_material=sim_utils.PreviewSurfaceCfg(diffuse_color=(0.30, 0.32, 0.31), roughness=0.95),
        )
        cfg.func(f"/World/Environment/Rock_{index}", cfg, translation=(x, y, radius * 0.65))
    for index, (x, y) in enumerate(((-6.0, 4.5), (-3.0, 4.8), (0.0, 4.6), (3.0, 4.8), (6.0, 4.5))):
        box(f"SafetyBlock_{index}", (x, y, 0.25), (1.2, 0.35, 0.5), COLORS["warning"])


def design_scene(scene_name, sim):
    ground = sim_utils.GroundPlaneCfg(
        physics_material=sim_utils.RigidBodyMaterialCfg(static_friction=1.0, dynamic_friction=0.9)
    )
    ground.func("/World/Ground", ground)

    if scene_name == "outdoor":
        light = sim_utils.DistantLightCfg(intensity=3200.0, color=(1.0, 0.96, 0.88))
        light.func("/World/Sun", light, translation=(6.0, -8.0, 14.0))
        fill = sim_utils.DomeLightCfg(intensity=1350.0, color=(0.76, 0.87, 1.0))
        fill.func("/World/Sky", fill)
        build_realistic_outdoor(sim.stage)
    else:
        light = sim_utils.DistantLightCfg(intensity=1400.0, color=(0.94, 0.96, 1.0))
        light.func("/World/Sun", light, translation=(3.0, -4.0, 9.0))
        fill = sim_utils.DomeLightCfg(intensity=850.0, color=(0.86, 0.90, 0.96))
        fill.func("/World/Sky", fill)
        if scene_name == "indoor":
            build_realistic_indoor(sim.stage)
        else:
            build_realistic_warehouse(sim.stage)

    robot_cfg = UNITREE_GO2_CFG.replace(prim_path="/World/Go2")
    robot_cfg.init_state.pos = SCENES[scene_name]["spawn"]
    robot_cfg.actuators["base_legs"].stiffness = 25.0
    robot_cfg.actuators["base_legs"].damping = 0.5
    robot_cfg.init_state.joint_pos["R[L,R]_thigh_joint"] = 1.0
    return Articulation(robot_cfg)


def reset_robot(robot):
    robot.write_root_pose_to_sim(robot.data.default_root_state[:, :7])
    robot.write_root_velocity_to_sim(robot.data.default_root_state[:, 7:])
    robot.write_joint_state_to_sim(robot.data.default_joint_pos, robot.data.default_joint_vel)
    robot.reset()


def yaw_from_quaternion(quaternion):
    w, x, y, z = quaternion
    return math.atan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z))


def roll_pitch_from_quaternion(quaternion):
    w, x, y, z = quaternion
    roll = math.atan2(2.0 * (w * x + y * z), 1.0 - 2.0 * (x * x + y * y))
    pitch = math.asin(max(-1.0, min(1.0, 2.0 * (w * y - z * x))))
    return roll, pitch


def load_locomotion_policy(device):
    policy_path = Path(__file__).resolve().parent / "policies" / "go2_velocity_flat.pt"
    policy = torch.jit.load(str(policy_path), map_location=device)
    policy.eval()
    print(f"[POLICY_READY] Go2 关节运动策略: {policy_path}", flush=True)
    return policy


def apply_control(robot, control_state, dt, policy):
    target_linear_x, target_angular_z = control_state.command()
    linear_delta = 1.8 * dt
    angular_delta = 5.0 * dt
    linear_x = control_state.applied_linear_x + max(
        -linear_delta, min(linear_delta, target_linear_x - control_state.applied_linear_x)
    )
    angular_z = control_state.applied_angular_z + max(
        -angular_delta, min(angular_delta, target_angular_z - control_state.applied_angular_z)
    )

    quaternion = robot.data.root_quat_w[0].tolist()
    yaw = yaw_from_quaternion(quaternion)
    roll, pitch = roll_pitch_from_quaternion(quaternion)
    if math.hypot(roll, pitch) > 0.45:
        linear_x = 0.0
        angular_z = 0.0
    control_state.applied_linear_x = linear_x
    control_state.applied_angular_z = angular_z

    if control_state.policy_action is None:
        control_state.policy_action = torch.zeros_like(robot.data.default_joint_pos)
    if control_state.policy_step % 4 == 0:
        normalized_linear = linear_x / CONTROL_CONFIG["max_linear_speed"]
        normalized_angular = angular_z / CONTROL_CONFIG["max_angular_speed"]
        commands = torch.tensor(
            [[max(-1.0, min(1.0, normalized_linear)), 0.0, max(-1.0, min(1.0, normalized_angular))]],
            device=robot.data.default_joint_pos.device,
        )
        observations = torch.cat((
            robot.data.root_lin_vel_b,
            robot.data.root_ang_vel_b,
            robot.data.projected_gravity_b,
            commands,
            robot.data.joint_pos - robot.data.default_joint_pos,
            robot.data.joint_vel - robot.data.default_joint_vel,
            control_state.policy_action,
        ), dim=-1)
        with torch.inference_mode():
            control_state.policy_action = policy(observations)
    control_state.policy_step += 1
    robot.set_joint_position_target(robot.data.default_joint_pos + 0.25 * control_state.policy_action)
    return linear_x, angular_z, yaw


def create_lidar():
    cfg = MultiMeshRayCasterCfg(
        prim_path="/World/Go2/base",
        update_period=0.01,
        offset=MultiMeshRayCasterCfg.OffsetCfg(pos=(0.15, 0.0, 0.20)),
        mesh_prim_paths=["/World/Environment"],
        ray_alignment="base",
        pattern_cfg=patterns.LidarPatternCfg(
            channels=1,
            vertical_fov_range=(0.0, 0.0),
            horizontal_fov_range=(-180.0, 180.0),
            horizontal_res=1.0,
        ),
        max_distance=12.0,
        debug_vis=False,
    )
    return MultiMeshRayCaster(cfg)


def lidar_ranges(lidar):
    hits = lidar.data.ray_hits_w[0]
    origin = lidar.data.pos_w[0]
    ranges = torch.norm(hits - origin.unsqueeze(0), dim=-1)
    values = ranges.tolist()
    return [0.0 if value >= 11.99 or not math.isfinite(value) else value for value in values]


def create_pointcloud_lidar(terrain=True):
    mesh_prim_paths = ["/World/Environment"]
    if terrain:
        if args_cli.scene == "outdoor":
            mesh_prim_paths.append("/World/Traversable")
        mesh_prim_paths.append("/World/Ground")
    cfg = MultiMeshRayCasterCfg(
        prim_path="/World/Go2/base",
        update_period=POINTCLOUD_UPDATE_PERIOD,
        offset=MultiMeshRayCasterCfg.OffsetCfg(pos=(0.15, 0.0, 0.20)),
        mesh_prim_paths=mesh_prim_paths,
        ray_alignment="base",
        pattern_cfg=patterns.LidarPatternCfg(
            channels=POINTCLOUD_METADATA["channels"],
            vertical_fov_range=tuple(POINTCLOUD_METADATA["vertical_fov_range_deg"]),
            horizontal_fov_range=tuple(POINTCLOUD_METADATA["horizontal_fov_range_deg"]),
            horizontal_res=POINTCLOUD_METADATA["horizontal_resolution_deg"],
        ),
        max_distance=POINTCLOUD_METADATA["range_max"],
        debug_vis=False,
    )
    return MultiMeshRayCaster(cfg)


def pointcloud_points(lidar):
    hits = lidar.data.ray_hits_w[0]
    origin = lidar.data.pos_w[0]
    relative = hits - origin.unsqueeze(0)
    ranges = torch.norm(relative, dim=-1)
    points = quat_apply_inverse(lidar.data.quat_w[0], relative)
    valid = (
        torch.isfinite(points).all(dim=-1)
        & (ranges >= POINTCLOUD_METADATA["range_min"])
        & (ranges < POINTCLOUD_METADATA["range_max"] - 0.01)
    )
    coordinates = points[valid].detach().cpu().tolist()
    ray_indices = valid.nonzero(as_tuple=False).squeeze(-1).detach().cpu().tolist()
    horizontal_samples = POINTCLOUD_METADATA["horizontal_samples"]
    return [
        [*point, ray_index // horizontal_samples, 0.0]
        for point, ray_index in zip(coordinates, ray_indices)
    ]


def create_cameras(enable_overview=False):
    spawn = sim_utils.PinholeCameraCfg(
        focal_length=16.0, focus_distance=20.0, clipping_range=(0.05, 100.0)
    )
    primary = Camera(
        CameraCfg(
            prim_path="/World/Go2/base/CameraPrimary",
            update_period=CAMERA_UPDATE_PERIOD,
            offset=CameraCfg.OffsetCfg(pos=(0.28, 0.0, 0.12), convention="world"),
            spawn=spawn,
            data_types=["rgb"],
            width=CAMERA_WIDTH,
            height=CAMERA_HEIGHT,
        )
    )
    cams = {"primary": primary}
    if enable_overview:
        overview_spawn = sim_utils.PinholeCameraCfg(
            focal_length=20.0, focus_distance=20.0, clipping_range=(0.1, 120.0)
        )
        cams["overview"] = Camera(
            CameraCfg(
                prim_path="/World/OverviewCamera",
                update_period=CAMERA_UPDATE_PERIOD,
                offset=CameraCfg.OffsetCfg(pos=(-2.0, -2.0, 2.0), rot=(1.0, 0.0, 0.0, 0.0), convention="world"),
                spawn=overview_spawn,
                data_types=["rgb"],
                width=OVERVIEW_WIDTH,
                height=OVERVIEW_HEIGHT,
            )
        )
    return cams


def encode_camera(camera, quality=80):
    rgb = camera.data.output["rgb"][0].detach().cpu().numpy()
    buffer = BytesIO()
    Image.fromarray(rgb).save(buffer, format="JPEG", quality=quality)
    return buffer.getvalue()


def main():
    scene = SCENES[args_cli.scene]
    sim = sim_utils.SimulationContext(sim_utils.SimulationCfg(
        dt=1.0 / 200.0,
        device=args_cli.device,
        physx=sim_utils.PhysxCfg(
            gpu_max_rigid_contact_count=2**19,
            gpu_max_rigid_patch_count=2**14,
            gpu_found_lost_pairs_capacity=2**16,
            gpu_heap_capacity=2**24,
            gpu_temp_buffer_capacity=2**22,
            gpu_max_num_partitions=1,
        ),
    ))
    sim.set_camera_view(eye=scene["camera"][0], target=scene["camera"][1])
    robot = design_scene(args_cli.scene, sim)
    lidar = create_lidar()
    pointcloud_lidar = create_pointcloud_lidar(terrain=True)
    obstacle_pointcloud_lidar = create_pointcloud_lidar(terrain=False)
    cameras = create_cameras(enable_overview=args_cli.overview_camera)
    sim.reset()
    lidar.reset()
    pointcloud_lidar.reset()
    obstacle_pointcloud_lidar.reset()
    for camera in cameras.values():
        camera.reset()
    reset_robot(robot)
    overview_eye_smooth = None
    control_state = ControlState(CONTROL_CONFIG["command_timeout_ms"])
    locomotion_policy = load_locomotion_policy(sim.device)
    control_server = ThreadingHTTPServer(("127.0.0.1", args_cli.control_port), ControlHandler)
    control_server.control_state = control_state
    control_server.daemon_threads = True
    threading.Thread(target=control_server.serve_forever, daemon=True).start()
    print(
        f"[SCENE_READY] {args_cli.scene}: {scene['name']}，设备 {sim.device}，控制端口 {args_cli.control_port}",
        flush=True,
    )

    steps = 0
    physics_dt = sim.get_physics_dt()
    next_camera_update_time = CAMERA_UPDATE_PERIOD
    pointcloud_interval_steps = max(1, round(POINTCLOUD_UPDATE_PERIOD / physics_dt))
    next_step_deadline = time.perf_counter()
    while simulation_app.is_running() and not stop_requested:
        linear_x, angular_z, yaw = apply_control(robot, control_state, physics_dt, locomotion_policy)
        robot.write_data_to_sim()
        camera_update_due = (steps + 1) * physics_dt + 1e-9 >= next_camera_update_time
        pointcloud_update_due = (steps + 1) % pointcloud_interval_steps == 0
        render = (not args_cli.headless and steps % args_cli.render_interval == 0) or camera_update_due
        sim.step(render=render)
        robot.update(physics_dt)
        steps += 1
        if steps % 10 == 0:
            lidar.update(dt=physics_dt * 10, force_recompute=True)
            position = robot.data.root_pos_w[0].tolist()
            quaternion = robot.data.root_quat_w[0].tolist()
            velocity = robot.data.root_vel_w[0].tolist()
            control_state.update_telemetry(
                args_cli.scene,
                steps,
                position,
                quaternion,
                velocity,
                yaw,
                linear_x,
                angular_z,
                lidar_ranges(lidar),
                steps * physics_dt,
            )
        if pointcloud_update_due:
            pointcloud_lidar.update(dt=POINTCLOUD_UPDATE_PERIOD, force_recompute=True)
            obstacle_pointcloud_lidar.update(dt=POINTCLOUD_UPDATE_PERIOD, force_recompute=True)
            control_state.update_pointcloud(
                pointcloud_points(pointcloud_lidar),
                pointcloud_points(obstacle_pointcloud_lidar),
                steps * physics_dt,
            )
        if camera_update_due:
            next_camera_update_time += CAMERA_UPDATE_PERIOD
            if "overview" in cameras:
                rpos = robot.data.root_pos_w[0]
                px, py, pz = float(rpos[0].item()), float(rpos[1].item()), float(rpos[2].item())
                bw, bd = scene.get("bounds", (12.0, 10.0))
                # Keep overview camera smoothly inside hall bounds with a wide view of robot + industrial equipment
                ox = 2.35 if px < -bw * 0.15 else -2.35
                oy = -2.15 if py > -bd * 0.15 else 2.15
                ex = max(-bw * 0.5 + 0.75, min(bw * 0.5 - 0.75, px + ox))
                ey = max(-bd * 0.5 + 0.75, min(bd * 0.5 - 0.75, py + oy))
                # In indoor west room, keep camera on the same side of the x=-1.2 divider wall as the robot!
                if args_cli.scene == "indoor" and px < -1.35 and ex > -1.65:
                    ex = -1.65
                desired_eye = (ex, ey, max(1.75, pz + 1.48))
                if overview_eye_smooth is None:
                    overview_eye_smooth = desired_eye
                else:
                    overview_eye_smooth = tuple(
                        overview_eye_smooth[i] * 0.88 + desired_eye[i] * 0.12 for i in range(3)
                    )
                eyes = torch.tensor([list(overview_eye_smooth)], dtype=torch.float32, device=sim.device)
                targets = torch.tensor([[px, py, pz + 0.30]], dtype=torch.float32, device=sim.device)
                cameras["overview"].set_world_poses_from_view(eyes, targets)
            for name, camera in cameras.items():
                camera.update(dt=CAMERA_UPDATE_PERIOD, force_recompute=True)
                control_state.update_camera(
                    name,
                    encode_camera(camera, quality=88 if name == "overview" else 80),
                    steps * physics_dt,
                )

        if args_cli.test_steps and steps >= args_cli.test_steps:
            if not torch.isfinite(robot.data.root_state_w).all().item():
                raise RuntimeError("机器人物理状态出现非有限数值")
            height = robot.data.root_pos_w[0, 2].item()
            if height < -0.2:
                raise RuntimeError(f"机器人跌出场景，高度为 {height:.3f} m")
            print(
                f"[SCENE_TEST_OK] {args_cli.scene}: {steps} 步，机器人高度 {height:.3f} m，设备 {sim.device}",
                flush=True,
            )
            os._exit(0)

        if not args_cli.test_steps:
            next_step_deadline += physics_dt
            now = time.perf_counter()
            if now < next_step_deadline:
                time.sleep(next_step_deadline - now)
            elif now - next_step_deadline > 0.5:
                next_step_deadline = now
    control_server.shutdown()
    control_server.server_close()
    if args_cli.test_steps and steps < args_cli.test_steps:
        raise RuntimeError(
            f"仿真提前停止：仅完成 {steps}/{args_cli.test_steps} 步，"
            f"stop_requested={stop_requested}，app_running={simulation_app.is_running()}"
        )


if __name__ == "__main__":
    try:
        main()
    except BaseException as error:
        if args_cli.test_steps:
            print(f"[SCENE_TEST_FAILED] {type(error).__name__}: {error}", flush=True)
            os._exit(1)
        raise
    finally:
        if stop_requested and not args_cli.test_steps:
            os._exit(0)
        simulation_app.close()
