import math
import struct
import sys
from array import array

from sensor_msgs.msg import PointCloud2

from .protocol import (
    BIN_COMPRESSED_IMAGE,
    BIN_OCCUPANCY_GRID,
    BIN_POINTCLOUD2,
    FLOAT32_MAX,
    MAX_POINTCLOUD_POINTS,
    POINT_FIELD_FORMATS,
    finite_or_none,
    json_dumps,
    pack_binary_message,
)


def serialize_pointcloud2(topic: str, msg: PointCloud2) -> bytes:
    def empty_cloud():
        return pack_binary_message(
            BIN_POINTCLOUD2,
            topic,
            {"frame_id": msg.header.frame_id, "count": 0},
            b"",
        )

    fields = {}
    for field in msg.fields:
        if field.name in ("x", "y", "z"):
            fields[field.name] = (int(field.offset), int(field.datatype))

    step = int(msg.point_step)
    if step <= 0 or any(name not in fields for name in ("x", "y", "z")):
        return empty_cloud()

    unpackers = {}
    for name, (offset, datatype) in fields.items():
        fmt = POINT_FIELD_FORMATS.get(datatype)
        if fmt is None or offset < 0 or offset + struct.calcsize(fmt) > step:
            return empty_cloud()
        unpackers[name] = (offset, fmt)

    width = int(msg.width)
    height = int(msg.height)
    row_step = int(msg.row_step)
    if width <= 0 or height <= 0:
        return empty_cloud()
    if row_step < width * step:
        return empty_cloud()

    raw = bytes(msg.data)
    endian = ">" if msg.is_bigendian else "<"
    coords = array("f")
    count = 0
    processed = 0
    for row in range(height):
        if processed >= MAX_POINTCLOUD_POINTS:
            break
        row_base = row * row_step
        if row_base >= len(raw):
            break
        row_points = min(
            width,
            (len(raw) - row_base) // step,
            MAX_POINTCLOUD_POINTS - processed,
        )
        processed += row_points
        for col in range(row_points):
            base = row_base + col * step
            values = []
            for name in ("x", "y", "z"):
                offset, fmt = unpackers[name]
                values.append(struct.unpack_from(f"{endian}{fmt}", raw, base + offset)[0])
            if all(math.isfinite(value) and abs(value) <= FLOAT32_MAX for value in values):
                coords.extend(values)
                count += 1

    if sys.byteorder != "little":
        coords.byteswap()
    return pack_binary_message(
        BIN_POINTCLOUD2,
        topic,
        {"frame_id": msg.header.frame_id, "count": count},
        coords.tobytes(),
    )


def serialize_ros_message(topic: str, schema: str, msg):
    if schema == "sensor_msgs/msg/PointCloud2":
        return True, serialize_pointcloud2(topic, msg)

    if schema == "sensor_msgs/msg/CompressedImage":
        return True, pack_binary_message(
            BIN_COMPRESSED_IMAGE,
            topic,
            {"format": msg.format, "frame_id": msg.header.frame_id},
            bytes(msg.data),
        )

    if schema == "nav_msgs/msg/OccupancyGrid":
        info = msg.info
        meta = {
            "info": {
                "width": int(info.width),
                "height": int(info.height),
                "resolution": float(info.resolution),
                "origin": {
                    "position": {
                        "x": float(info.origin.position.x),
                        "y": float(info.origin.position.y),
                        "z": float(info.origin.position.z),
                    },
                    "orientation": {
                        "x": float(info.origin.orientation.x),
                        "y": float(info.origin.orientation.y),
                        "z": float(info.origin.orientation.z),
                        "w": float(info.origin.orientation.w),
                    },
                },
            }
        }
        payload = array("b", msg.data).tobytes()
        return True, pack_binary_message(BIN_OCCUPANCY_GRID, topic, meta, payload)

    if schema in ("std_msgs/msg/UInt16", "std_msgs/msg/Int32"):
        body = {"data": int(msg.data)}
    elif schema == "nav_msgs/msg/Odometry":
        p = msg.pose.pose.position
        q = msg.pose.pose.orientation
        lin = msg.twist.twist.linear
        ang = msg.twist.twist.angular
        body = {
            "header": {"frame_id": msg.header.frame_id},
            "pose": {
                "pose": {
                    "position": {"x": float(p.x), "y": float(p.y), "z": float(p.z)},
                    "orientation": {"x": float(q.x), "y": float(q.y), "z": float(q.z), "w": float(q.w)},
                }
            },
            "twist": {
                "twist": {
                    "linear": {"x": float(lin.x), "y": float(lin.y), "z": float(lin.z)},
                    "angular": {"x": float(ang.x), "y": float(ang.y), "z": float(ang.z)},
                }
            },
        }
    elif schema == "geometry_msgs/msg/PoseStamped":
        p = msg.pose.position
        q = msg.pose.orientation
        body = {
            "header": {"frame_id": msg.header.frame_id},
            "pose": {
                "position": {"x": float(p.x), "y": float(p.y), "z": float(p.z)},
                "orientation": {"x": float(q.x), "y": float(q.y), "z": float(q.z), "w": float(q.w)},
            },
        }
    elif schema == "geometry_msgs/msg/PoseWithCovarianceStamped":
        p = msg.pose.pose.position
        q = msg.pose.pose.orientation
        body = {
            "header": {"frame_id": msg.header.frame_id},
            "pose": {
                "pose": {
                    "position": {"x": float(p.x), "y": float(p.y), "z": float(p.z)},
                    "orientation": {"x": float(q.x), "y": float(q.y), "z": float(q.z), "w": float(q.w)},
                },
                "covariance": [float(value) for value in msg.pose.covariance],
            },
        }
    elif schema == "sensor_msgs/msg/Imu":
        q = msg.orientation
        ang = msg.angular_velocity
        acc = msg.linear_acceleration
        body = {
            "header": {"frame_id": msg.header.frame_id},
            "orientation": {"x": float(q.x), "y": float(q.y), "z": float(q.z), "w": float(q.w)},
            "angular_velocity": {"x": float(ang.x), "y": float(ang.y), "z": float(ang.z)},
            "linear_acceleration": {"x": float(acc.x), "y": float(acc.y), "z": float(acc.z)},
        }
    elif schema == "sensor_msgs/msg/LaserScan":
        body = {
            "header": {"frame_id": msg.header.frame_id},
            "angle_min": float(msg.angle_min),
            "angle_max": float(msg.angle_max),
            "angle_increment": float(msg.angle_increment),
            "range_min": float(msg.range_min),
            "range_max": float(msg.range_max),
            "ranges": [finite_or_none(r) for r in msg.ranges],
        }
    elif schema == "tf2_msgs/msg/TFMessage":
        transforms = []
        for tf in msg.transforms:
            t = tf.transform.translation
            r = tf.transform.rotation
            transforms.append({
                "header": {"frame_id": tf.header.frame_id},
                "child_frame_id": tf.child_frame_id,
                "transform": {
                    "translation": {"x": float(t.x), "y": float(t.y), "z": float(t.z)},
                    "rotation": {"x": float(r.x), "y": float(r.y), "z": float(r.z), "w": float(r.w)},
                },
            })
        body = {"transforms": transforms}
    elif schema == "nav_msgs/msg/Path":
        poses = []
        for ps in msg.poses:
            p = ps.pose.position
            q = ps.pose.orientation
            poses.append({
                "position": {"x": float(p.x), "y": float(p.y), "z": float(p.z)},
                "orientation": {"x": float(q.x), "y": float(q.y), "z": float(q.z), "w": float(q.w)},
            })
        body = {"poses": poses}
    elif schema == "nav2_msgs/action/NavigateToPose_FeedbackMessage":
        fb = getattr(msg, "feedback", msg)
        body = {
            "distance_remaining": float(fb.distance_remaining),
            "estimated_time_remaining": {
                "sec": int(fb.estimated_time_remaining.sec),
                "nanosec": int(fb.estimated_time_remaining.nanosec),
            },
        }
    elif schema == "action_msgs/msg/GoalStatusArray":
        status_list = []
        latest_index = None
        latest_stamp = None
        for index, item in enumerate(getattr(msg, "status_list", [])):
            goal_info = getattr(item, "goal_info", None)
            raw_uuid = getattr(goal_info, "goal_id", None)
            uuid_bytes = bytes(getattr(raw_uuid, "uuid", [])) if raw_uuid is not None else b""
            stamp = getattr(goal_info, "stamp", None)
            stamp_key = (
                int(getattr(stamp, "sec", 0)),
                int(getattr(stamp, "nanosec", 0)),
            )
            status_list.append({
                "goal_id": uuid_bytes.hex(),
                "status": int(item.status),
                "stamp": {"sec": stamp_key[0], "nanosec": stamp_key[1]},
            })
            if latest_stamp is None or stamp_key > latest_stamp:
                latest_index = index
                latest_stamp = stamp_key
        body = {
            "status_list": status_list,
            "latest": status_list[latest_index] if latest_index is not None else None,
        }
    else:
        return False, None

    text = json_dumps({"op": "msg", "topic": topic, "type": schema, "msg": body})
    return False, text.encode("utf-8")


