import asyncio
import struct
from collections import deque

from .protocol import (
    CONTROL_QUEUE_MAX_BYTES,
    CONTROL_QUEUE_MAX_FRAMES,
    TELEMETRY_QUEUE_MAX_BYTES,
    TELEMETRY_QUEUE_MAX_FRAMES,
    WS_MAX_FRAME_SIZE,
    WebSocketProtocolError,
    encode_ws_frame,
)


class WebSocketClient:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        self.reader = reader
        self.writer = writer
        self.send_lock = asyncio.Lock()
        self.control_queue = deque()
        self.telemetry_queue = deque()
        self.control_bytes = 0
        self.telemetry_bytes = 0
        self.queue_event = asyncio.Event()
        self.sender_task = None
        self.subscriptions = set()
        self.closed = False

    async def send_text(self, text: str):
        await self._send_raw(encode_ws_frame(0x1, text.encode("utf-8")))

    async def send_pong(self, data: bytes):
        await self._send_raw(encode_ws_frame(0xA, data))

    async def send_close(self, code: int, reason: str = ""):
        reason_bytes = reason.encode("utf-8")[:123].decode("utf-8", "ignore").encode("utf-8")
        await self._send_raw(encode_ws_frame(0x8, struct.pack("!H", code) + reason_bytes))

    def start_sender(self):
        self.sender_task = asyncio.create_task(self._send_queued_frames())

    def enqueue_text(self, text: str, control: bool = False):
        return self.enqueue_frame(encode_ws_frame(0x1, text.encode("utf-8")), control=control)

    def enqueue_frame(self, frame: bytes, control: bool = False):
        if self.closed:
            return False
        if control:
            if (
                len(self.control_queue) >= CONTROL_QUEUE_MAX_FRAMES
                or self.control_bytes + len(frame) > CONTROL_QUEUE_MAX_BYTES
            ):
                self.close()
                return False
            self.control_queue.append(frame)
            self.control_bytes += len(frame)
        else:
            if len(frame) > TELEMETRY_QUEUE_MAX_BYTES:
                return False
            while self.telemetry_queue and (
                len(self.telemetry_queue) >= TELEMETRY_QUEUE_MAX_FRAMES
                or self.telemetry_bytes + len(frame) > TELEMETRY_QUEUE_MAX_BYTES
            ):
                dropped = self.telemetry_queue.popleft()
                self.telemetry_bytes -= len(dropped)
            self.telemetry_queue.append(frame)
            self.telemetry_bytes += len(frame)
        self.queue_event.set()
        return True

    def _pop_queued_frame(self):
        if self.control_queue:
            frame = self.control_queue.popleft()
            self.control_bytes -= len(frame)
            return frame
        if self.telemetry_queue:
            frame = self.telemetry_queue.popleft()
            self.telemetry_bytes -= len(frame)
            return frame
        return None

    async def _send_queued_frames(self):
        try:
            while not self.closed:
                frame = self._pop_queued_frame()
                if frame is None:
                    self.queue_event.clear()
                    frame = self._pop_queued_frame()
                    if frame is None:
                        await self.queue_event.wait()
                        continue
                await self._send_raw(frame)
        except asyncio.CancelledError:
            pass

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
                self.close()

    def close(self):
        self.closed = True
        self.queue_event.set()
        current_task = asyncio.current_task()
        if self.sender_task is not None and self.sender_task is not current_task:
            self.sender_task.cancel()
        self.sender_task = None
        self.control_queue.clear()
        self.telemetry_queue.clear()
        self.control_bytes = 0
        self.telemetry_bytes = 0
        try:
            self.writer.close()
        except Exception:
            pass




async def read_ws_frame(reader: asyncio.StreamReader):
    b0, b1 = await reader.readexactly(2)
    fin = (b0 & 0x80) != 0
    opcode = b0 & 0x0F
    masked = (b1 & 0x80) != 0
    length = b1 & 0x7F

    if b0 & 0x70:
        raise WebSocketProtocolError(1002, "不支持 RSV 扩展位")
    if length == 126:
        (length,) = struct.unpack("!H", await reader.readexactly(2))
    elif length == 127:
        (length,) = struct.unpack("!Q", await reader.readexactly(8))

    if length > WS_MAX_FRAME_SIZE:
        raise WebSocketProtocolError(1009, "WebSocket 单帧超过大小上限")
    if opcode >= 0x8 and (not fin or length > 125):
        raise WebSocketProtocolError(1002, "非法 WebSocket 控制帧")

    mask = await reader.readexactly(4) if masked else None
    payload = await reader.readexactly(length) if length > 0 else b""
    if mask and payload:
        payload = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
    return fin, opcode, payload


