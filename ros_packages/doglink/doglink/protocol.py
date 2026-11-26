import json
import math
import struct
from array import array


WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAGIC_BINARY = 0x44
BIN_POINTCLOUD2 = 1
BIN_COMPRESSED_IMAGE = 2
BIN_OCCUPANCY_GRID = 3

WS_MAX_FRAME_SIZE = 1024 * 1024
WS_MAX_MESSAGE_SIZE = 1024 * 1024
MAX_POINTCLOUD_POINTS = 60000
FLOAT32_MAX = 3.4028234663852886e38
TELEMETRY_QUEUE_MAX_FRAMES = 128
TELEMETRY_QUEUE_MAX_BYTES = 2 * 1024 * 1024
CONTROL_QUEUE_MAX_FRAMES = 256
CONTROL_QUEUE_MAX_BYTES = 16 * 1024 * 1024

POINT_FIELD_FORMATS = {
    1: "b",
    2: "B",
    3: "h",
    4: "H",
    5: "i",
    6: "I",
    7: "f",
    8: "d",
}

KNOWN_TYPES = {
    "/cmd_vel": "geometry_msgs/msg/Twist",
    "/manual_cmd_vel": "geometry_msgs/msg/Twist",
    "/goal_pose": "geometry_msgs/msg/PoseStamped",
    "/initialpose": "geometry_msgs/msg/PoseWithCovarianceStamped",
    "/odom": "nav_msgs/msg/Odometry",
    "/Odometry": "nav_msgs/msg/Odometry",
    "/imu": "sensor_msgs/msg/Imu",
    "/scan": "sensor_msgs/msg/LaserScan",
    "/points": "sensor_msgs/msg/PointCloud2",
    "/cloud_registered": "sensor_msgs/msg/PointCloud2",
    "/map": "nav_msgs/msg/OccupancyGrid",
    "/plan": "nav_msgs/msg/Path",
    "/path": "nav_msgs/msg/Path",
    "/global_map": "sensor_msgs/msg/PointCloud2",
    "/localization": "nav_msgs/msg/Odometry",
    "/amcl_pose": "geometry_msgs/msg/PoseWithCovarianceStamped",
    "/tf": "tf2_msgs/msg/TFMessage",
    "/battery": "std_msgs/msg/UInt16",
    "/camera1/preview/compressed": "sensor_msgs/msg/CompressedImage",
    "/navigate_to_pose/_action/feedback": "nav2_msgs/action/NavigateToPose_FeedbackMessage",
    "/navigate_to_pose/_action/status": "action_msgs/msg/GoalStatusArray",
}

SENSOR_QOS_SCHEMAS = {
    "sensor_msgs/msg/LaserScan",
    "sensor_msgs/msg/PointCloud2",
    "sensor_msgs/msg/CompressedImage",
    "sensor_msgs/msg/Imu",
    "nav_msgs/msg/Odometry",
    "std_msgs/msg/UInt16",
    "std_msgs/msg/Int32",
}

CONTROL_SCHEMAS = {
    "nav_msgs/msg/OccupancyGrid",
    "action_msgs/msg/GoalStatusArray",
}


def normalize_schema(schema: str) -> str:
    if not schema:
        return ""
    if "/" not in schema:
        return schema
    parts = schema.split("/")
    if len(parts) == 2:
        return f"{parts[0]}/msg/{parts[1]}"
    return schema


def known_topic_type(topic: str) -> str:
    if topic in KNOWN_TYPES:
        return KNOWN_TYPES[topic]
    for known_topic, schema in KNOWN_TYPES.items():
        if topic.endswith(known_topic):
            return schema
    return ""


def finite_or_none(value: float):
    return float(value) if math.isfinite(value) else None


def json_safe(value):
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, array)):
        return [json_safe(item) for item in value]
    return value


def json_dumps(value) -> str:
    return json.dumps(
        json_safe(value),
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def encode_ws_frame(opcode: int, payload: bytes) -> bytes:
    header = bytearray([0x80 | (opcode & 0x0F)])
    length = len(payload)
    if length < 126:
        header.append(length)
    elif length < 65536:
        header.append(126)
        header.extend(struct.pack("!H", length))
    else:
        header.append(127)
        header.extend(struct.pack("!Q", length))
    return bytes(header) + payload


def pack_binary_message(msg_type: int, topic: str, meta: dict, payload: bytes) -> bytes:
    topic_bytes = topic.encode("utf-8")
    meta_bytes = json_dumps(meta).encode("utf-8")
    header = struct.pack("<BBHI", MAGIC_BINARY, msg_type, len(topic_bytes), len(meta_bytes))
    return header + topic_bytes + meta_bytes + payload


class WebSocketProtocolError(Exception):
    def __init__(self, code: int, reason: str):
        super().__init__(reason)
        self.code = code
        self.reason = reason


