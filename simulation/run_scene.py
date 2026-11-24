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
    control["max_linear_speed"] = max(0.1, min(5.0, control["max_linear_speed"]))
    control["max_angular_speed"] = max(0.1, min(3.0, control["max_angular_speed"]))
    control["command_timeout_ms"] = max(200, min(3000, round(control["command_timeout_ms"])))
    return control


CONTROL_CONFIG = load_control_config()
parser = argparse.ArgumentParser(description="四足巡检机器狗 GPU 仿真场景")
parser.add_argument("--scene", choices=("indoor", "warehouse", "outdoor"), default="indoor")
parser.add_argument("--test-steps", type=int, default=0, help="运行指定物理步数后自动退出；0 表示持续运行")
parser.add_argument("--control-port", type=int, default=8766, help="本机网页控制桥接端口")
parser.add_argument("--render-interval", type=int, default=4, help="GUI 每隔多少个物理步渲染一次")
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


signal.signal(signal.SIGTERM, request_stop)

import torch
from PIL import Image

import isaaclab.sim as sim_utils
from isaaclab.assets import Articulation
from isaaclab.sensors.camera import Camera, CameraCfg
from isaaclab.sensors.ray_caster import MultiMeshRayCaster, MultiMeshRayCasterCfg, patterns
from isaaclab.utils.math import quat_apply_inverse
from isaaclab_assets.robots.unitree import UNITREE_GO2_CFG

SCENES = {
    "indoor": {
        "name": "室内巡检",
        "spawn": (-3.5, -2.5, 0.42),
        "camera": ([9.5, -11.5, 10.0], [0.0, 0.0, 0.0]),
        "targets": [(-3.5, 1.5), (0.0, 2.8), (3.8, 2.8), (3.8, -2.8)],
    },
    "warehouse": {
        "name": "仓库障碍",
        "spawn": (-5.5, -4.5, 0.42),
        "camera": ([11.0, -13.0, 12.0], [0.0, 0.0, 0.0]),
        "targets": [(-5.5, 0.0), (-1.8, 3.8), (2.0, 0.0), (5.5, 4.0)],
    },
    "outdoor": {
        "name": "户外坡道",
        "spawn": (-5.0, -4.0, 0.42),
        "camera": ([11.0, -13.0, 11.0], [0.0, 0.0, 0.5]),
        "targets": [(-4.0, 0.0), (-1.0, 2.5), (3.0, 2.5), (5.0, -3.0)],
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
CAMERA_UPDATE_PERIOD = 1.0 / 30.0
CAMERA_FRAME_IDS = {
    "primary": "camera_primary_optical_frame",
    "secondary": "camera_secondary_optical_frame",
}


class ControlState:
    def __init__(self, command_timeout_ms=600):
        self.lock = threading.Lock()
        self.command_timeout = command_timeout_ms / 1000.0
        self.linear_x = 0.0
        self.angular_z = 0.0
        self.command_time = 0.0
        self.gait_phase = 0.0
        self.telemetry = {"ready": False}
        self.camera_frames = {}
        self.pointcloud_data = None

    def set_command(self, linear_x, angular_z):
        with self.lock:
            self.linear_x = linear_x
            self.angular_z = angular_z
            self.command_time = time.monotonic()

    def command(self):
        with self.lock:
            if time.monotonic() - self.command_time > self.command_timeout:
                return 0.0, 0.0
            return self.linear_x, self.angular_z

    def update_telemetry(self, scene, steps, position, quaternion, velocity, yaw, linear_x, angular_z, scan):
        with self.lock:
            pointcloud_metadata = dict(POINTCLOUD_METADATA)
            pointcloud_metadata["point_count"] = (
                0 if self.pointcloud_data is None else len(self.pointcloud_data["points"])
            )
            self.telemetry = {
                "ready": True,
                "scene": scene,
                "steps": steps,
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

    def update_pointcloud(self, points):
        with self.lock:
            self.pointcloud_data = {"frame_id": POINTCLOUD_METADATA["frame_id"], "points": points}

    def pointcloud(self):
        with self.lock:
            return self.pointcloud_data

    def update_camera(self, name, jpeg):
        with self.lock:
            self.camera_frames[name] = jpeg

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
            jpeg = self.server.control_state.camera_frame(name)
            if jpeg is None:
                self.respond(503, {"success": False, "error": "相机图像尚未就绪"})
                return
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(jpeg)))
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Frame-Id", CAMERA_FRAME_IDS[name])
            self.send_header("X-Image-Width", str(CAMERA_WIDTH))
            self.send_header("X-Image-Height", str(CAMERA_HEIGHT))
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
            self.server.control_state.set_command(linear_x, angular_z)
            self.respond(200, {"success": True, "linearX": linear_x, "angularZ": angular_z})
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


def design_scene(scene_name):
    ground = sim_utils.GroundPlaneCfg(
        physics_material=sim_utils.RigidBodyMaterialCfg(static_friction=1.0, dynamic_friction=0.9)
    )
    ground.func("/World/Ground", ground)
    light = sim_utils.DistantLightCfg(intensity=2800.0, color=(0.82, 0.88, 1.0))
    light.func("/World/Sun", light, translation=(2.0, -3.0, 8.0))
    fill = sim_utils.DomeLightCfg(intensity=900.0, color=(0.72, 0.80, 0.90))
    fill.func("/World/Sky", fill)

    if scene_name == "indoor":
        build_indoor()
    elif scene_name == "warehouse":
        build_warehouse()
    else:
        build_outdoor()

    for index, position in enumerate(SCENES[scene_name]["targets"]):
        marker(index, position)

    robot_cfg = UNITREE_GO2_CFG.replace(prim_path="/World/Go2")
    robot_cfg.init_state.pos = SCENES[scene_name]["spawn"]
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


def apply_control(robot, control_state, dt, height_assist):
    linear_x, angular_z = control_state.command()
    activity = max(
        abs(linear_x) / CONTROL_CONFIG["max_linear_speed"],
        abs(angular_z) / CONTROL_CONFIG["max_angular_speed"],
    )
    joint_target = robot.data.default_joint_pos.clone()

    if activity > 0.01:
        control_state.gait_phase = (control_state.gait_phase + dt * 10.0) % (2.0 * math.pi)
        direction = 1.0 if linear_x >= 0.0 else -1.0
        for index, name in enumerate(robot.data.joint_names):
            phase = math.sin(control_state.gait_phase + (0.0 if name.startswith(("FL", "RR")) else math.pi))
            if "thigh" in name:
                joint_target[0, index] += 0.09 * phase * direction * activity
            elif "calf" in name:
                joint_target[0, index] -= 0.12 * max(0.0, phase) * activity

    quaternion = robot.data.root_quat_w[0].tolist()
    yaw = yaw_from_quaternion(quaternion)
    roll, pitch = roll_pitch_from_quaternion(quaternion)
    root_velocity = robot.data.root_vel_w.clone()
    root_velocity[0, 0] = linear_x * math.cos(yaw)
    root_velocity[0, 1] = linear_x * math.sin(yaw)
    root_velocity[0, 3] = max(-1.5, min(1.5, -3.0 * roll - 0.8 * root_velocity[0, 3].item()))
    root_velocity[0, 4] = max(-1.5, min(1.5, -3.0 * pitch - 0.8 * root_velocity[0, 4].item()))
    root_velocity[0, 5] = angular_z
    if height_assist:
        height_error = robot.data.default_root_state[0, 2].item() - robot.data.root_pos_w[0, 2].item()
        root_velocity[0, 2] = max(-0.4, min(0.4, 3.0 * height_error - 0.8 * root_velocity[0, 2].item()))
    robot.write_root_velocity_to_sim(root_velocity)
    robot.set_joint_position_target(joint_target)
    return linear_x, angular_z, yaw


def create_lidar():
    cfg = MultiMeshRayCasterCfg(
        prim_path="/World/Go2/base",
        update_period=0.05,
        offset=MultiMeshRayCasterCfg.OffsetCfg(pos=(0.15, 0.0, 0.20)),
        mesh_prim_paths=["/World/Environment"],
        ray_alignment="yaw",
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


def create_pointcloud_lidar():
    cfg = MultiMeshRayCasterCfg(
        prim_path="/World/Go2/base",
        update_period=POINTCLOUD_UPDATE_PERIOD,
        offset=MultiMeshRayCasterCfg.OffsetCfg(pos=(0.15, 0.0, 0.20)),
        mesh_prim_paths=["/World/Environment", "/World/Ground"],
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
    return points[valid].detach().cpu().tolist()


def create_cameras(scene):
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
    secondary = Camera(
        CameraCfg(
            prim_path="/World/CameraSecondary",
            update_period=CAMERA_UPDATE_PERIOD,
            offset=CameraCfg.OffsetCfg(pos=scene["camera"][0], convention="world"),
            spawn=spawn.replace(),
            data_types=["rgb"],
            width=CAMERA_WIDTH,
            height=CAMERA_HEIGHT,
        )
    )
    return {"primary": primary, "secondary": secondary}


def encode_camera(camera):
    rgb = camera.data.output["rgb"][0].detach().cpu().numpy()
    buffer = BytesIO()
    Image.fromarray(rgb).save(buffer, format="JPEG", quality=80)
    return buffer.getvalue()


def main():
    scene = SCENES[args_cli.scene]
    sim = sim_utils.SimulationContext(sim_utils.SimulationCfg(dt=1.0 / 180.0, device=args_cli.device))
    sim.set_camera_view(eye=scene["camera"][0], target=scene["camera"][1])
    robot = design_scene(args_cli.scene)
    lidar = create_lidar()
    pointcloud_lidar = create_pointcloud_lidar()
    cameras = create_cameras(scene)
    sim.reset()
    lidar.reset()
    pointcloud_lidar.reset()
    for camera in cameras.values():
        camera.reset()
    cameras["secondary"].set_world_poses_from_view(
        torch.tensor([scene["camera"][0]], device=sim.device),
        torch.tensor([scene["camera"][1]], device=sim.device),
    )
    reset_robot(robot)
    control_state = ControlState(CONTROL_CONFIG["command_timeout_ms"])
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
    camera_interval_steps = max(1, round(CAMERA_UPDATE_PERIOD / physics_dt))
    pointcloud_interval_steps = max(1, round(POINTCLOUD_UPDATE_PERIOD / physics_dt))
    next_step_deadline = time.perf_counter()
    while simulation_app.is_running() and not stop_requested:
        linear_x, angular_z, yaw = apply_control(robot, control_state, physics_dt, args_cli.scene != "outdoor")
        robot.write_data_to_sim()
        camera_update_due = (steps + 1) % camera_interval_steps == 0
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
                args_cli.scene, steps, position, quaternion, velocity, yaw, linear_x, angular_z, lidar_ranges(lidar)
            )
        if pointcloud_update_due:
            pointcloud_lidar.update(dt=POINTCLOUD_UPDATE_PERIOD, force_recompute=True)
            control_state.update_pointcloud(pointcloud_points(pointcloud_lidar))
        if camera_update_due:
            for name, camera in cameras.items():
                camera.update(dt=CAMERA_UPDATE_PERIOD, force_recompute=True)
                control_state.update_camera(name, encode_camera(camera))

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

        if not args_cli.headless:
            next_step_deadline += physics_dt
            now = time.perf_counter()
            if now < next_step_deadline:
                time.sleep(next_step_deadline - now)
            else:
                next_step_deadline = now
    control_server.shutdown()
    control_server.server_close()


if __name__ == "__main__":
    try:
        main()
    finally:
        if stop_requested:
            os._exit(0)
        simulation_app.close()
