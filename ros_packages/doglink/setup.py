from glob import glob
from setuptools import find_packages, setup

package_name = "doglink"

setup(
    name=package_name,
    version="1.0.0",
    packages=find_packages(exclude=["test"]),
    data_files=[
        ("share/ament_index/resource_index/packages", ["resource/" + package_name]),
        ("share/" + package_name, ["package.xml"]),
        ("share/" + package_name + "/launch", glob("launch/*.launch.py")),
        ("share/" + package_name + "/config", glob("config/*.yaml")),
    ],
    install_requires=["setuptools"],
    zip_safe=True,
    maintainer="Ros_Vue Developers",
    maintainer_email="noreply@localhost",
    description="Lightweight ROS 2 WebSocket gateway with binary telemetry and prioritized control messages.",
    license="Proprietary",
    entry_points={
        "console_scripts": [
            "gateway_node = doglink.gateway_node:main",
        ],
    },
)
