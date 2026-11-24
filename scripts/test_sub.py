import rclpy
from rclpy.node import Node
from geometry_msgs.msg import PoseWithCovarianceStamped

class MinimalSubscriber(Node):
    def __init__(self):
        super().__init__('minimal_subscriber')
        self.subscription = self.create_subscription(
            PoseWithCovarianceStamped,
            '/initialpose',
            self.listener_callback,
            10)
    def listener_callback(self, msg):
        self.get_logger().info(f'I heard: {msg.pose.pose.position.x}')

rclpy.init()
minimal_subscriber = MinimalSubscriber()
rclpy.spin(minimal_subscriber)
minimal_subscriber.destroy_node()
rclpy.shutdown()
