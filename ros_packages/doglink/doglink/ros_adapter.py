import asyncio
import math
import threading
import time

from rcl_interfaces.msg import ParameterDescriptor
from geometry_msgs.msg import PoseStamped, PoseWithCovarianceStamped, Twist
from nav_msgs.msg import OccupancyGrid, Odometry, Path
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy, qos_profile_sensor_data
from rosidl_runtime_py.utilities import get_message
from sensor_msgs.msg import CompressedImage, Imu, LaserScan, PointCloud2
from std_msgs.msg import Int32, UInt16
from tf2_msgs.msg import TFMessage

from .protocol import (
    CONTROL_SCHEMAS,
    SENSOR_QOS_SCHEMAS,
    encode_ws_frame,
    json_dumps,
    known_topic_type,
    normalize_schema,
)
from .serializers import serialize_ros_message
from .websocket import WebSocketClient


class DogLinkGatewayNode(Node):
    def __init__(self, loop: asyncio.AbstractEventLoop, node_name: str):
        super().__init__(node_name)
        self.declare_parameter("host", "127.0.0.1")
        self.declare_parameter("port", 8768)
        self.declare_parameter("ports", [], descriptor=ParameterDescriptor(dynamic_typing=True))
        self.host = str(self.get_parameter("host").value)
        self.ports = [int(port) for port in (self.get_parameter("ports").value or [])]
        if not self.ports:
            self.ports = [int(self.get_parameter("port").value)]
        self.loop = loop
        self.ws_clients = set()
        self.ros_subs = {}
        self.ros_pubs = {}
        self.ros_pub_types = {}
        self.topic_subscribers = {}
        self.pending_subscriptions = {}
        self.subscription_creating = {}
        self.subscription_generations = {}
        self.cached_topics = []
        self.cached_latched = {}
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

    def topics_for_hello(self):
        with self.state_lock:
            topics = list(self.cached_topics)
        if not topics:
            topics = self.discover_topics()
            with self.state_lock:
                if not self.cached_topics:
                    self.cached_topics = list(topics)
        return topics

    def _schema_for_topic(self, topic: str):
        with self.state_lock:
            topics = list(self.cached_topics)
            pending_schema = self.pending_subscriptions.get(topic, "")
        for item in topics:
            if item["topic"] == topic:
                return item["schemaName"]
        if pending_schema:
            return pending_schema
        schema = known_topic_type(topic)
        if schema:
            return schema
        for item in self.discover_topics():
            if item["topic"] == topic:
                return item["schemaName"]
        return ""

    def refresh_topics(self):
        topics = self.discover_topics()
        with self.state_lock:
            changed = topics != self.cached_topics
            self.cached_topics = list(topics)
        if changed:
            payload = json_dumps({"op": "topics", "topics": topics})
            self.loop.call_soon_threadsafe(self._broadcast_text, payload)
        self.recover_subscriptions()

    def _claim_subscription(self, topic: str):
        with self.state_lock:
            if (
                topic in self.ros_subs
                or topic in self.subscription_creating
                or not self.topic_subscribers.get(topic)
            ):
                return None
            generation = self.subscription_generations.get(topic, 0) + 1
            self.subscription_generations[topic] = generation
            self.subscription_creating[topic] = generation
            self.pending_subscriptions.setdefault(topic, "")
            return generation

    def recover_subscriptions(self):
        with self.state_lock:
            topics = [
                topic for topic, clients in self.topic_subscribers.items()
                if clients and topic not in self.ros_subs and topic not in self.subscription_creating
            ]
        for topic in topics:
            generation = self._claim_subscription(topic)
            if generation is not None:
                self._create_subscription(topic, generation)

    def _broadcast_text(self, text: str):
        frame = encode_ws_frame(0x1, text.encode("utf-8"))
        with self.state_lock:
            clients = list(self.ws_clients)
        for client in clients:
            client.enqueue_frame(frame, control=True)

    def _dispatch_topic(
        self,
        topic: str,
        is_binary: bool,
        payload: bytes,
        control: bool = False,
        generation: int = None,
    ):
        with self.state_lock:
            if generation is not None and self.subscription_generations.get(topic) != generation:
                return
            targets = list(self.topic_subscribers.get(topic, ()))
        frame = encode_ws_frame(0x2 if is_binary else 0x1, payload)
        for client in targets:
            client.enqueue_frame(frame, control=control)

    def _send_subscription_state(self, client: WebSocketClient, topic: str, pending: bool):
        payload = json_dumps({"op": "subscribed", "topic": topic, "pending": pending})
        self.loop.call_soon_threadsafe(client.enqueue_text, payload, True)

    def subscribe_topic(self, client: WebSocketClient, topic: str):
        cached = None
        with self.state_lock:
            if client.closed or client not in self.ws_clients:
                return
            subs = self.topic_subscribers.setdefault(topic, set())
            subs.add(client)
            client.subscriptions.add(topic)
            active = topic in self.ros_subs
            if active:
                self.pending_subscriptions.pop(topic, None)
                cached = self.cached_latched.get(topic)
            else:
                self.pending_subscriptions.setdefault(topic, "")

        if cached is not None:
            is_binary, encoded = cached
            frame = encode_ws_frame(0x2 if is_binary else 0x1, encoded)
            self.loop.call_soon_threadsafe(client.enqueue_frame, frame, True)
        self._send_subscription_state(client, topic, not active)

        if not active:
            generation = self._claim_subscription(topic)
            if generation is not None:
                self._create_subscription(topic, generation)

    def _create_subscription(self, topic: str, generation: int):
        schema = self._schema_for_topic(topic)
        if not schema:
            with self.state_lock:
                if self.subscription_creating.get(topic) == generation:
                    self.subscription_creating.pop(topic, None)
            return

        try:
            msg_cls = get_message(schema)
            is_control_topic = schema in CONTROL_SCHEMAS
            if is_control_topic:
                qos = QoSProfile(
                    depth=1,
                    durability=DurabilityPolicy.TRANSIENT_LOCAL,
                    reliability=ReliabilityPolicy.RELIABLE,
                )
            elif schema in SENSOR_QOS_SCHEMAS:
                qos = qos_profile_sensor_data
            else:
                qos = 10

            def on_message(msg):
                try:
                    with self.state_lock:
                        if (
                            self.subscription_generations.get(topic) != generation
                            or not self.topic_subscribers.get(topic)
                        ):
                            return
                    is_binary, encoded = serialize_ros_message(topic, schema, msg)
                    if encoded is not None:
                        with self.state_lock:
                            if (
                                self.subscription_generations.get(topic) != generation
                                or not self.topic_subscribers.get(topic)
                            ):
                                return
                            if is_control_topic:
                                self.cached_latched[topic] = (is_binary, encoded)
                        self.loop.call_soon_threadsafe(
                            self._dispatch_topic,
                            topic,
                            is_binary,
                            encoded,
                            is_control_topic,
                            generation,
                        )
                except Exception as err:
                    self.get_logger().debug(f"序列化 {topic} 失败: {err}")

            sub = self.create_subscription(msg_cls, topic, on_message, qos)
        except Exception as err:
            with self.state_lock:
                if self.subscription_creating.get(topic) == generation:
                    self.subscription_creating.pop(topic, None)
                if self.topic_subscribers.get(topic):
                    self.pending_subscriptions[topic] = schema
            self.get_logger().warning(f"订阅 ROS 话题 {topic} 失败: {err}")
            return

        with self.state_lock:
            if self.subscription_creating.get(topic) == generation:
                self.subscription_creating.pop(topic, None)
            clients = {
                client for client in self.topic_subscribers.get(topic, ())
                if not client.closed
            }
            install = (
                bool(clients)
                and topic not in self.ros_subs
                and self.subscription_generations.get(topic) == generation
            )
            if install:
                self.ros_subs[topic] = sub
                self.subscription_created[topic] = time.monotonic()
                self.pending_subscriptions.pop(topic, None)

        if not install:
            self.destroy_subscription(sub)
            return

        self.get_logger().info(f"已订阅 ROS 话题: {topic} ({schema})")
        for client in clients:
            self._send_subscription_state(client, topic, False)

    def unsubscribe_topic(self, client: WebSocketClient, topic: str):
        sub_to_destroy = None
        with self.state_lock:
            client.subscriptions.discard(topic)
            subs = self.topic_subscribers.get(topic)
            if subs is not None:
                subs.discard(client)
                if not subs:
                    self.topic_subscribers.pop(topic, None)
                    self.pending_subscriptions.pop(topic, None)
                    self.subscription_generations[topic] = self.subscription_generations.get(topic, 0) + 1
                    sub_to_destroy = self.ros_subs.pop(topic, None)
                    self.subscription_created.pop(topic, None)
                    self.cached_latched.pop(topic, None)
        if sub_to_destroy is not None:
            self.destroy_subscription(sub_to_destroy)

    def remove_client(self, client: WebSocketClient):
        subs_to_destroy = []
        with self.state_lock:
            self.ws_clients.discard(client)
            for topic in list(client.subscriptions):
                clients = self.topic_subscribers.get(topic)
                if clients is None:
                    continue
                clients.discard(client)
                if not clients:
                    self.topic_subscribers.pop(topic, None)
                    self.pending_subscriptions.pop(topic, None)
                    self.subscription_generations[topic] = self.subscription_generations.get(topic, 0) + 1
                    self.subscription_created.pop(topic, None)
                    self.cached_latched.pop(topic, None)
                    sub = self.ros_subs.pop(topic, None)
                    if sub is not None:
                        subs_to_destroy.append(sub)
            client.subscriptions.clear()
        for sub in subs_to_destroy:
            self.destroy_subscription(sub)

    def publish_from_client(self, topic: str, schema: str, msg_dict: dict):
        norm = normalize_schema(schema) or known_topic_type(topic)
        if not norm:
            raise ValueError("无法确定发布话题的消息类型")
        if not isinstance(msg_dict, dict):
            raise ValueError("msg 必须是对象")

        def block(parent, key):
            value = parent.get(key, {})
            if not isinstance(value, dict):
                raise ValueError(f"{key} 必须是对象")
            return value

        def number(parent, key, default):
            value = parent.get(key, default)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"{key} 必须是有限数值")
            value = float(value)
            if not math.isfinite(value):
                raise ValueError(f"{key} 必须是有限数值")
            return value

        def fill_vector(target, source):
            target.x = number(source, "x", 0.0)
            target.y = number(source, "y", 0.0)
            target.z = number(source, "z", 0.0)

        def fill_quaternion(target, source):
            target.x = number(source, "x", 0.0)
            target.y = number(source, "y", 0.0)
            target.z = number(source, "z", 0.0)
            target.w = number(source, "w", 1.0)

        header = block(msg_dict, "header")
        frame_id = header.get("frame_id", "map")
        if not isinstance(frame_id, str):
            raise ValueError("header.frame_id 必须是字符串")

        if norm == "geometry_msgs/msg/Twist":
            message = Twist()
            fill_vector(message.linear, block(msg_dict, "linear"))
            fill_vector(message.angular, block(msg_dict, "angular"))
        elif norm == "geometry_msgs/msg/PoseStamped":
            message = PoseStamped()
            message.header.frame_id = frame_id
            pose = block(msg_dict, "pose")
            fill_vector(message.pose.position, block(pose, "position"))
            fill_quaternion(message.pose.orientation, block(pose, "orientation"))
        elif norm == "geometry_msgs/msg/PoseWithCovarianceStamped":
            message = PoseWithCovarianceStamped()
            message.header.frame_id = frame_id
            pose_block = block(msg_dict, "pose")
            pose = block(pose_block, "pose")
            fill_vector(message.pose.pose.position, block(pose, "position"))
            fill_quaternion(message.pose.pose.orientation, block(pose, "orientation"))
            covariance = pose_block.get("covariance")
            if covariance is not None:
                if not isinstance(covariance, list) or len(covariance) != 36:
                    raise ValueError("pose.covariance 必须包含 36 个有限数值")
                values = []
                for value in covariance:
                    if isinstance(value, bool) or not isinstance(value, (int, float)):
                        raise ValueError("pose.covariance 必须包含 36 个有限数值")
                    value = float(value)
                    if not math.isfinite(value):
                        raise ValueError("pose.covariance 必须包含 36 个有限数值")
                    values.append(value)
                message.pose.covariance = values
        else:
            raise ValueError(f"不支持客户端发布消息类型: {norm}")

        pub = self.ros_pubs.get(topic)
        if pub is not None and self.ros_pub_types.get(topic) != norm:
            raise ValueError(f"话题 {topic} 已使用其他消息类型发布")
        if pub is None:
            pub = self.create_publisher(type(message), topic, 10)
            self.ros_pubs[topic] = pub
            self.ros_pub_types[topic] = norm
        pub.publish(message)


