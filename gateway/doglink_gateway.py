#!/usr/bin/env python3
"""
DogLink 轻量级 ROS 2 WebSocket 传输网关
- 零第三方 Python 依赖（仅使用 Python 标准库 + ROS 2 rclpy）
- 文本帧（JSON）：话题发现、按需订阅/退订、控制指令、心跳 RTT、轻量结构化消息
- 二进制帧（Magic 0x44）：PointCloud2 / CompressedImage / OccupancyGrid 高效传输
"""

import argparse
import asyncio
import base64
import hashlib
import json
import math
import signal
import struct
import threading
import time
from array import array
from contextlib import AsyncExitStack

import rclpy
from geometry_msgs.msg import PoseStamped, PoseWithCovarianceStamped, Twist
from nav_msgs.msg import OccupancyGrid, Odometry, Path
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from rosidl_runtime_py.utilities import get_message
from sensor_msgs.msg import CompressedImage, Imu, LaserScan, PointCloud2
from std_msgs.msg import Int32, UInt16
from tf2_msgs.msg import TFMessage

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAGIC_BINARY = 0x44
BIN_POINTCLOUD2 = 1
BIN_COMPRESSED_IMAGE = 2
BIN_OCCUPANCY_GRID = 3

KNOWN_TYPES = {
    "/cmd_vel": "geometry_msgs/msg/Twist",
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
    "/tf": "tf2_msgs/msg/TFMessage",
    "/battery": "std_msgs/msg/UInt16",
    "/camera1/preview/compressed": "sensor_msgs/msg/CompressedImage",
    "/navigate_to_pose/_action/feedback": "nav2_msgs/action/NavigateToPose_FeedbackMessage",
}

SENSOR_QOS_SCHEMAS = {
    "sensor_msgs/msg/LaserScan",
    "sensor_msgs/msg/PointCloud2",
    "sensor_msgs/msg/CompressedImage",
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
    meta_bytes = json.dumps(meta, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    header = struct.pack("<BBHI", MAGIC_BINARY, msg_type, len(topic_bytes), len(meta_bytes))
    return header + topic_bytes + meta_bytes + payload


def serialize_pointcloud2(topic: str, msg: PointCloud2) -> bytes:
    x_off = y_off = z_off = None
    x_dt = y_dt = z_dt = 7
    for field in msg.fields:
        if field.name == "x":
            x_off, x_dt = field.offset, field.datatype
        elif field.name == "y":
            y_off, y_dt = field.offset, field.datatype
        elif field.name == "z":
            z_off, z_dt = field.offset, field.datatype

    if x_off is None or y_off is None or z_off is None or msg.point_step <= 0:
        return pack_binary_message(
            BIN_POINTCLOUD2,
            topic,
            {"frame_id": msg.header.frame_id, "count": 0},
            b"",
        )

    raw = bytes(msg.data)
    step = msg.point_step
    endian = ">" if msg.is_bigendian else "<"
    total = min(len(raw) // step, 60000)

    def unpack_val(base: int, off: int, dt: int) -> float:
        if dt == 8:
            return struct.unpack_from(f"{endian}d", raw, base + off)[0]
        return struct.unpack_from(f"{endian}f", raw, base + off)[0]

    coords = array("f")
    count = 0
    for i in range(total):
        base = i * step
        x = unpack_val(base, x_off, x_dt)
        y = unpack_val(base, y_off, y_dt)
        z = unpack_val(base, z_off, z_dt)
        if math.isfinite(x) and math.isfinite(y) and math.isfinite(z):
            coords.append(x)
            coords.append(y)
            coords.append(z)
            count += 1

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
        body = {
            "distance_remaining": float(msg.distance_remaining),
            "estimated_time_remaining": {
                "sec": int(msg.estimated_time_remaining.sec),
                "nanosec": int(msg.estimated_time_remaining.nanosec),
            },
        }
    else:
        return False, None

    text = json.dumps({"op": "msg", "topic": topic, "type": schema, "msg": body}, separators=(",", ":"))
    return False, text.encode("utf-8")


class WebSocketClient:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        self.reader = reader
        self.writer = writer
        self.send_lock = asyncio.Lock()
        self.send_queue = asyncio.Queue(maxsize=128)
        self.sender_task = None
        self.subscriptions = set()
        self.closed = False

    async def send_text(self, text: str):
        await self._send_raw(encode_ws_frame(0x1, text.encode("utf-8")))

    async def send_pong(self, data: bytes):
        await self._send_raw(encode_ws_frame(0xA, data))

    def start_sender(self):
        self.sender_task = asyncio.create_task(self._send_queued_frames())

    def enqueue_frame(self, frame: bytes):
        if self.closed:
            return
        if self.send_queue.full():
            try:
                self.send_queue.get_nowait()
                self.send_queue.task_done()
            except asyncio.QueueEmpty:
                pass
        try:
            self.send_queue.put_nowait(frame)
        except asyncio.QueueFull:
            pass

    async def _send_queued_frames(self):
        while not self.closed:
            frame = await self.send_queue.get()
            try:
                await self._send_raw(frame)
            finally:
                self.send_queue.task_done()

    async def _send_raw(self, frame: bytes):
        if self.closed:
            return
        async with self.send_lock:
            if self.closed:
                return
            try:
                self.writer.write(frame)
                await self.writer.drain()
            except Exception:
                self.closed = True

    def close(self):
        if self.closed and self.sender_task is None:
            return
        self.closed = True
        if self.sender_task is not None:
            self.sender_task.cancel()
            self.sender_task = None
        while not self.send_queue.empty():
            try:
                self.send_queue.get_nowait()
                self.send_queue.task_done()
            except asyncio.QueueEmpty:
                break
        try:
            self.writer.close()
        except Exception:
            pass


class DogLinkGatewayNode(Node):
    def __init__(self, loop: asyncio.AbstractEventLoop, node_name: str):
        super().__init__(node_name)
        self.loop = loop
        self.ws_clients = set()
        self.ros_subs = {}
        self.ros_pubs = {}
        self.topic_subscribers = {}
        self.cached_topics = []
        self.subscription_created = {}
        self.state_lock = threading.Lock()
        self.create_timer(2.0, self.refresh_topics)
        self.get_logger().info("DogLink ROS 2 网关节点已初始化")

    def discover_topics(self):
        items = []
        for topic, types in self.get_topic_names_and_types():
            if types:
                items.append({"topic": topic, "schemaName": types[0]})
        items.sort(key=lambda x: x["topic"])
        return items

    def refresh_topics(self):
        topics = self.discover_topics()
        if topics != self.cached_topics:
            self.cached_topics = topics
            payload = json.dumps({"op": "topics", "topics": topics}, separators=(",", ":"))
            self.loop.call_soon_threadsafe(self._broadcast_text, payload)
        self.recover_subscriptions()

    def recover_subscriptions(self):
        now = time.monotonic()
        with self.state_lock:
            candidates = [
                (topic, sub) for topic, sub in self.ros_subs.items()
                if now - self.subscription_created.get(topic, now) >= 8.0
            ]
        for topic, sub in candidates:
            if self.count_publishers(topic) > 0:
                continue
            with self.state_lock:
                if self.ros_subs.get(topic) is not sub:
                    continue
                self.ros_subs.pop(topic, None)
                self.subscription_created.pop(topic, None)
                clients = list(self.topic_subscribers.get(topic, ()))
            self.destroy_subscription(sub)
            if clients:
                self.get_logger().warning(f"发布者尚未发现，重新订阅 ROS 话题: {topic}")
                self.subscribe_topic(clients[0], topic)

    def _broadcast_text(self, text: str):
        frame = encode_ws_frame(0x1, text.encode("utf-8"))
        for client in list(self.ws_clients):
            client.enqueue_frame(frame)

    def _dispatch_topic(self, topic: str, is_binary: bool, payload: bytes):
        with self.state_lock:
            targets = list(self.topic_subscribers.get(topic, ()))
        frame = encode_ws_frame(0x2 if is_binary else 0x1, payload)
        for client in targets:
            client.enqueue_frame(frame)

    def subscribe_topic(self, client: WebSocketClient, topic: str):
        with self.state_lock:
            subs = self.topic_subscribers.setdefault(topic, set())
            subs.add(client)
            client.subscriptions.add(topic)
            if topic in self.ros_subs:
                return

        schema = ""
        for item in self.cached_topics or self.discover_topics():
            if item["topic"] == topic:
                schema = item["schemaName"]
                break
        if not schema:
            schema = known_topic_type(topic)
        if not schema:
            self.get_logger().warning(f"未找到话题 {topic} 的消息类型，暂无法订阅")
            return

        try:
            msg_cls = get_message(schema)
        except Exception as err:
            self.get_logger().warning(f"加载消息类型 {schema} 失败: {err}")
            return

        qos = qos_profile_sensor_data if schema in SENSOR_QOS_SCHEMAS else 10

        def on_message(msg):
            try:
                is_binary, encoded = serialize_ros_message(topic, schema, msg)
                if encoded is not None:
                    self.loop.call_soon_threadsafe(self._dispatch_topic, topic, is_binary, encoded)
            except Exception as err:
                self.get_logger().debug(f"序列化 {topic} 失败: {err}")

        sub = self.create_subscription(msg_cls, topic, on_message, qos)
        with self.state_lock:
            self.ros_subs[topic] = sub
            self.subscription_created[topic] = time.monotonic()
        self.get_logger().info(f"已订阅 ROS 话题: {topic} ({schema})")

    def unsubscribe_topic(self, client: WebSocketClient, topic: str):
        sub_to_destroy = None
        with self.state_lock:
            client.subscriptions.discard(topic)
            subs = self.topic_subscribers.get(topic)
            if subs:
                subs.discard(client)
                if not subs:
                    self.topic_subscribers.pop(topic, None)
                    sub_to_destroy = self.ros_subs.pop(topic, None)
                    self.subscription_created.pop(topic, None)
        if sub_to_destroy is not None:
            self.destroy_subscription(sub_to_destroy)

    def remove_client(self, client: WebSocketClient):
        self.ws_clients.discard(client)
        for topic in list(client.subscriptions):
            self.unsubscribe_topic(client, topic)

    def publish_from_client(self, topic: str, schema: str, msg_dict: dict):
        norm = normalize_schema(schema) or known_topic_type(topic)
        if not norm:
            return
        pub = self.ros_pubs.get(topic)
        if pub is None:
            if norm == "geometry_msgs/msg/Twist":
                pub = self.create_publisher(Twist, topic, 10)
            elif norm == "geometry_msgs/msg/PoseStamped":
                pub = self.create_publisher(PoseStamped, topic, 10)
            elif norm == "geometry_msgs/msg/PoseWithCovarianceStamped":
                pub = self.create_publisher(PoseWithCovarianceStamped, topic, 10)
            else:
                return
            self.ros_pubs[topic] = pub

        if norm == "geometry_msgs/msg/Twist":
            m = Twist()
            lin = msg_dict.get("linear", {})
            ang = msg_dict.get("angular", {})
            m.linear.x = float(lin.get("x", 0.0))
            m.linear.y = float(lin.get("y", 0.0))
            m.linear.z = float(lin.get("z", 0.0))
            m.angular.x = float(ang.get("x", 0.0))
            m.angular.y = float(ang.get("y", 0.0))
            m.angular.z = float(ang.get("z", 0.0))
            pub.publish(m)
        elif norm == "geometry_msgs/msg/PoseStamped":
            m = PoseStamped()
            m.header.stamp = self.get_clock().now().to_msg()
            m.header.frame_id = msg_dict.get("header", {}).get("frame_id", "map")
            pose = msg_dict.get("pose", {})
            pos = pose.get("position", {})
            ori = pose.get("orientation", {})
            m.pose.position.x = float(pos.get("x", 0.0))
            m.pose.position.y = float(pos.get("y", 0.0))
            m.pose.position.z = float(pos.get("z", 0.0))
            m.pose.orientation.x = float(ori.get("x", 0.0))
            m.pose.orientation.y = float(ori.get("y", 0.0))
            m.pose.orientation.z = float(ori.get("z", 0.0))
            m.pose.orientation.w = float(ori.get("w", 1.0))
            pub.publish(m)
        elif norm == "geometry_msgs/msg/PoseWithCovarianceStamped":
            m = PoseWithCovarianceStamped()
            m.header.stamp = self.get_clock().now().to_msg()
            m.header.frame_id = msg_dict.get("header", {}).get("frame_id", "map")
            pose_block = msg_dict.get("pose", {})
            pose = pose_block.get("pose", {})
            pos = pose.get("position", {})
            ori = pose.get("orientation", {})
            m.pose.pose.position.x = float(pos.get("x", 0.0))
            m.pose.pose.position.y = float(pos.get("y", 0.0))
            m.pose.pose.position.z = float(pos.get("z", 0.0))
            m.pose.pose.orientation.x = float(ori.get("x", 0.0))
            m.pose.pose.orientation.y = float(ori.get("y", 0.0))
            m.pose.pose.orientation.z = float(ori.get("z", 0.0))
            m.pose.pose.orientation.w = float(ori.get("w", 1.0))
            cov = pose_block.get("covariance")
            if isinstance(cov, list) and len(cov) == 36:
                m.pose.covariance = [float(v) for v in cov]
            pub.publish(m)


async def read_ws_frame(reader: asyncio.StreamReader):
    b0, b1 = await reader.readexactly(2)
    fin = (b0 & 0x80) != 0
    opcode = b0 & 0x0F
    masked = (b1 & 0x80) != 0
    length = b1 & 0x7F

    if length == 126:
        (length,) = struct.unpack("!H", await reader.readexactly(2))
    elif length == 127:
        (length,) = struct.unpack("!Q", await reader.readexactly(8))

    mask = await reader.readexactly(4) if masked else None
    payload = await reader.readexactly(length) if length > 0 else b""
    if mask and payload:
        payload = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
    return fin, opcode, payload


async def handle_ws_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, node: DogLinkGatewayNode):
    client = None
    try:
        raw_http = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=5.0)
        lines = raw_http.decode("latin1").split("\r\n")
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()

        ws_key = headers.get("sec-websocket-key")
        if not ws_key:
            writer.write(b"HTTP/1.1 400 Bad Request\r\n\r\n")
            await writer.drain()
            writer.close()
            return

        accept = base64.b64encode(hashlib.sha1((ws_key + WS_GUID).encode("ascii")).digest()).decode("ascii")
        resp = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
        )
        writer.write(resp.encode("ascii"))
        await writer.drain()

        client = WebSocketClient(reader, writer)
        node.ws_clients.add(client)

        topics = node.cached_topics or node.discover_topics()
        node.cached_topics = topics
        hello = json.dumps({
            "op": "hello",
            "server": "DogLink/1.0",
            "capabilities": ["clientPublish", "binaryStream"],
            "topics": topics,
        }, separators=(",", ":"))
        await client.send_text(hello)
        client.start_sender()

        fragments = bytearray()
        frag_opcode = 0
        while not client.closed:
            fin, opcode, payload = await asyncio.wait_for(read_ws_frame(reader), timeout=30.0)
            if opcode == 0x8:
                break
            if opcode == 0x9:
                await client.send_pong(payload)
                continue
            if opcode == 0xA:
                continue

            if opcode != 0x0:
                frag_opcode = opcode
                fragments = bytearray(payload)
            else:
                fragments.extend(payload)

            if not fin:
                continue

            if frag_opcode == 0x1:
                try:
                    msg = json.loads(bytes(fragments).decode("utf-8"))
                except Exception:
                    continue
                op = msg.get("op")
                if op == "ping":
                    await client.send_text(json.dumps({"op": "pong", "ts": msg.get("ts")}))
                elif op == "sub" and isinstance(msg.get("topic"), str):
                    node.subscribe_topic(client, msg["topic"])
                elif op == "unsub" and isinstance(msg.get("topic"), str):
                    node.unsubscribe_topic(client, msg["topic"])
                elif op == "pub" and isinstance(msg.get("topic"), str):
                    node.publish_from_client(msg["topic"], msg.get("type", ""), msg.get("msg", {}))
    except (asyncio.IncompleteReadError, ConnectionError, TimeoutError):
        pass
    finally:
        if client is not None:
            node.remove_client(client)
            client.close()
        else:
            try:
                writer.close()
            except Exception:
                pass


async def run_gateway(host: str, ports: list[int], node_name: str):
    loop = asyncio.get_running_loop()
    rclpy.init()
    node = DogLinkGatewayNode(loop, node_name)

    stop_event = threading.Event()

    def spin_ros():
        while rclpy.ok() and not stop_event.is_set():
            rclpy.spin_once(node, timeout_sec=0.02)

    ros_thread = threading.Thread(target=spin_ros, daemon=True)
    ros_thread.start()

    async with AsyncExitStack() as stack:
        servers = []
        for port in ports:
            server = await asyncio.start_server(lambda r, w: handle_ws_client(r, w, node), host, port)
            await stack.enter_async_context(server)
            servers.append(server)
            node.get_logger().info(f"DogLink WebSocket 网关监听中: ws://{host}:{port}")

        def stop_servers():
            for server in servers:
                server.close()

        loop.add_signal_handler(signal.SIGTERM, stop_servers)
        try:
            await asyncio.gather(*(server.serve_forever() for server in servers))
        except asyncio.CancelledError:
            pass
        finally:
            loop.remove_signal_handler(signal.SIGTERM)
            stop_event.set()
            ros_thread.join(timeout=1.0)
            node.destroy_node()
            if rclpy.ok():
                rclpy.shutdown()


def main():
    parser = argparse.ArgumentParser(description="DogLink ROS 2 轻量级 WebSocket 网关")
    parser.add_argument("--host", default="0.0.0.0", help="监听地址 (默认 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8768, help="WebSocket 端口 (默认 8768)")
    parser.add_argument("--ports", type=int, nargs="+", help="同时监听多个 WebSocket 端口")
    parser.add_argument("--node-name", default="doglink_gateway", help="ROS 2 节点名称")
    args = parser.parse_args()

    try:
        asyncio.run(run_gateway(args.host, args.ports or [args.port], args.node_name))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
