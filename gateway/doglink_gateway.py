#!/usr/bin/env python3
from pathlib import Path
import sys

package_src = Path(__file__).resolve().parent.parent / "ros_packages" / "doglink"
if str(package_src) not in sys.path:
    sys.path.insert(0, str(package_src))

from doglink.gateway_node import main


if __name__ == "__main__":
    main()
