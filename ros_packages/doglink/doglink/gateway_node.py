import argparse
import asyncio
import base64
import hashlib
import json
import signal
import sys
import threading
from contextlib import AsyncExitStack

import rclpy

from .protocol import WS_GUID, WS_MAX_MESSAGE_SIZE, json_dumps
from .ros_adapter import DogLinkGatewayNode
from .websocket import WebSocketClient, WebSocketProtocolError, read_ws_frame


def reject_json_constant(value: str):
    raise ValueError(f"非法 JSON 数值: {value}")


def send_client_error(client: WebSocketClient, request_op, message: str):
    payload = json_dumps({
        "op": "error",
        "request_op": request_op if isinstance(request_op, str) else None,
        "message": message,
    })
    client.enqueue_text(payload, control=True)


def handle_client_text(client: WebSocketClient, node: DogLinkGatewayNode, text: str):
    request_op = None
    try:
        message = json.loads(text, parse_constant=reject_json_constant)
        if not isinstance(message, dict):
            raise ValueError("JSON 根节点必须是对象")
        request_op = message.get("op")
        if not isinstance(request_op, str):
            raise ValueError("op 必须是字符串")

        if request_op == "ping":
            client.enqueue_text(json_dumps({"op": "pong", "ts": message.get("ts")}), control=True)
            return

        if request_op in ("sub", "unsub", "pub"):
            topic = message.get("topic")
            if not isinstance(topic, str) or not topic:
                raise ValueError("topic 必须是非空字符串")
            if request_op == "sub":
                node.subscribe_topic(client, topic)
            elif request_op == "unsub":
                node.unsubscribe_topic(client, topic)
            else:
                schema = message.get("type", "")
                if not isinstance(schema, str):
                    raise ValueError("type 必须是字符串")
                msg_dict = message.get("msg")
                if not isinstance(msg_dict, dict):
                    raise ValueError("msg 必须是对象")
                node.publish_from_client(topic, schema, msg_dict)
            return

        raise ValueError(f"不支持的 op: {request_op}")
    except Exception as err:
        send_client_error(client, request_op, str(err))


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
        with node.state_lock:
            node.ws_clients.add(client)

        topics = node.topics_for_hello()
        hello = json_dumps({
            "op": "hello",
            "server": "DogLink/1.0",
            "protocol_version": 1,
            "capabilities": ["clientPublish", "binaryStream"],
            "topics": topics,
        })
        await client.send_text(hello)
        client.start_sender()

        fragments = bytearray()
        frag_opcode = 0
        while not client.closed:
            fin, opcode, payload = await read_ws_frame(reader)
            if opcode == 0x8:
                await client.send_close(1000)
                break
            if opcode == 0x9:
                await client.send_pong(payload)
                continue
            if opcode == 0xA:
                continue

            if opcode == 0x0:
                if frag_opcode == 0:
                    raise WebSocketProtocolError(1002, "continuation 帧没有起始帧")
                if len(fragments) + len(payload) > WS_MAX_MESSAGE_SIZE:
                    raise WebSocketProtocolError(1009, "WebSocket 聚合消息超过大小上限")
                fragments.extend(payload)
            else:
                if opcode not in (0x1, 0x2):
                    raise WebSocketProtocolError(1002, "不支持的 WebSocket opcode")
                if frag_opcode != 0:
                    raise WebSocketProtocolError(1002, "分片消息尚未结束")
                frag_opcode = opcode
                fragments = bytearray(payload)

            if not fin:
                continue

            complete_opcode = frag_opcode
            complete_payload = bytes(fragments)
            fragments = bytearray()
            frag_opcode = 0
            if complete_opcode == 0x1:
                try:
                    text = complete_payload.decode("utf-8")
                except UnicodeDecodeError as err:
                    raise WebSocketProtocolError(1007, "文本帧不是合法 UTF-8") from err
                handle_client_text(client, node, text)
            else:
                send_client_error(client, None, "不支持客户端二进制消息")
    except WebSocketProtocolError as err:
        if client is not None:
            await client.send_close(err.code, err.reason)
    except (asyncio.IncompleteReadError, asyncio.TimeoutError, ConnectionError, TimeoutError):
        pass
    except Exception as err:
        node.get_logger().debug(f"WebSocket 客户端处理失败: {err}")
    finally:
        if client is not None:
            node.remove_client(client)
            client.close()
        else:
            try:
                writer.close()
            except Exception:
                pass


async def run_gateway(host: str | None, ports: list[int] | None, node_name: str):
    loop = asyncio.get_running_loop()
    rclpy.init()
    node = DogLinkGatewayNode(loop, node_name)
    if host is not None:
        node.host = host
    if ports is not None:
        node.ports = ports

    stop_event = threading.Event()

    def spin_ros():
        while rclpy.ok() and not stop_event.is_set():
            rclpy.spin_once(node, timeout_sec=0.02)

    ros_thread = threading.Thread(target=spin_ros, daemon=True)
    ros_thread.start()

    async with AsyncExitStack() as stack:
        servers = []
        for port in node.ports:
            server = await asyncio.start_server(lambda r, w: handle_ws_client(r, w, node), node.host, port)
            await stack.enter_async_context(server)
            servers.append(server)
            node.get_logger().info(f"DogLink WebSocket 网关监听中: ws://{node.host}:{port}")

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
    parser.add_argument("--host", help="监听地址，覆盖 ROS 参数 host")
    parser.add_argument("--port", type=int, help="WebSocket 端口，覆盖 ROS 参数 port")
    parser.add_argument("--ports", type=int, nargs="+", help="同时监听多个 WebSocket 端口")
    parser.add_argument("--node-name", default="doglink_gateway", help="ROS 2 节点名称")
    args = parser.parse_args(rclpy.utilities.remove_ros_args(args=sys.argv)[1:])
    ports = args.ports or ([args.port] if args.port is not None else None)

    try:
        asyncio.run(run_gateway(args.host, ports, args.node_name))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
