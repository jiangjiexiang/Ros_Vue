/**
 * Foxglove WebSocket v1 协议通信模块
 * 处理与 foxglove_bridge 的连接、话题订阅、消息发布
 */
import { ref, reactive, readonly } from 'vue'

// ======================== 状态 ========================
const connectionState = ref('disconnected') // disconnected | connecting | connected | error
const serverName = ref('')
const serverCapabilities = ref([])
const availableChannels = reactive(new Map()) // channelId → {topic, encoding, schemaName, ...}
const errorMessage = ref('')

// ======================== 内部变量 ========================
let ws = null
let nextClientChannelId = 1
let nextSubscriptionId = 1
const subscriptionCallbacks = new Map() // subscriptionId → callback(parsedJSON)
const subscriptionIdToChannelId = new Map() // subscriptionId → channelId
const clientChannels = new Map()        // clientChannelId → {topic, ...}

// ======================== 连接管理 ========================

/**
 * 连接到 foxglove_bridge WebSocket 服务器
 * @param {string} url - WebSocket URL, 例如 ws://localhost:8765
 */
function connect(url) {
    if (ws) {
        disconnect()
    }

    connectionState.value = 'connecting'
    errorMessage.value = ''

    try {
        ws = new WebSocket(url, ['foxglove.sdk.v1', 'foxglove.websocket.v1'])
        ws.binaryType = 'arraybuffer'

        ws.onopen = () => {
            console.log('[Foxglove] WebSocket 已连接，等待 serverInfo...')
        }

        ws.onclose = (e) => {
            console.log('[Foxglove] WebSocket 已断开:', e.code, e.reason)
            connectionState.value = 'disconnected'
            cleanup()
        }

        ws.onerror = (e) => {
            console.error('[Foxglove] WebSocket 错误:', e)
            connectionState.value = 'error'
            errorMessage.value = '连接失败，请检查地址和 foxglove_bridge 是否运行'
        }

        ws.onmessage = (event) => {
            if (typeof event.data === 'string') {
                handleJsonMessage(JSON.parse(event.data))
            } else if (event.data instanceof ArrayBuffer) {
                handleBinaryMessage(event.data)
            }
        }
    } catch (err) {
        connectionState.value = 'error'
        errorMessage.value = err.message
    }
}

/**
 * 断开连接
 */
function disconnect() {
    if (ws) {
        ws.close()
        ws = null
    }
    cleanup()
    connectionState.value = 'disconnected'
}

function cleanup() {
    availableChannels.clear()
    subscriptionCallbacks.clear()
    clientChannels.clear()
    nextClientChannelId = 1
    nextSubscriptionId = 1
    serverName.value = ''
    serverCapabilities.value = []
}

// ======================== JSON 消息处理 ========================

function handleJsonMessage(msg) {
    switch (msg.op) {
        case 'serverInfo':
            handleServerInfo(msg)
            break
        case 'advertise':
            handleAdvertise(msg)
            break
        case 'unadvertise':
            handleUnadvertise(msg)
            break
        case 'status':
            console.log(`[Foxglove] 状态 [${msg.level}]: ${msg.message}`)
            break
        case 'advertiseServices':
            // 忽略服务列表通知，避免显示未知消息警告
            break
        default:
            console.log('[Foxglove] 未知的 JSON 消息:', msg.op)
    }
}

function handleServerInfo(msg) {
    serverName.value = msg.name || 'Unknown Server'
    serverCapabilities.value = msg.capabilities || []
    connectionState.value = 'connected'
    console.log('[Foxglove] 服务器:', msg.name)
    console.log('[Foxglove] 能力:', msg.capabilities)
    console.log('[Foxglove] 支持的编码:', msg.supportedEncodings)

    // 触发自定义事件，通知其他模块服务器已准备好
    window.dispatchEvent(new CustomEvent('foxglove:connected', { detail: msg }))
}

function handleAdvertise(msg) {
    if (!msg.channels) return
    for (const ch of msg.channels) {
        availableChannels.set(ch.id, ch)
        console.log(`[Foxglove] 话题: ${ch.topic}, 编码: ${ch.encoding}, 类型: ${ch.schemaName}`)
    }
    console.log(`[Foxglove] 收到 ${msg.channels.length} 个话题频道`)
    // 触发事件通知
    window.dispatchEvent(new CustomEvent('foxglove:channels', {
        detail: Array.from(availableChannels.values())
    }))
}

function handleUnadvertise(msg) {
    if (!msg.channelIds) return
    for (const id of msg.channelIds) {
        availableChannels.delete(id)
    }
}

// ======================== 二进制消息处理 ========================

/**
 * 解析服务器发来的二进制消息
 * Message Data 格式:
 *   [opcode: 1 byte] [subscriptionId: uint32 LE] [timestamp: uint64 LE] [payload: remaining]
 */
function handleBinaryMessage(buffer) {
    const view = new DataView(buffer)
    const opcode = view.getUint8(0)

    if (opcode === 0x01) {
        // Message Data
        const subscriptionId = view.getUint32(1, true) // little-endian
        const channelId = subscriptionIdToChannelId.get(subscriptionId)
        const channel = availableChannels.get(channelId)

        // 时间戳: bytes 5-12 (uint64)
        const payloadOffset = 13
        const payloadBytes = new Uint8Array(buffer, payloadOffset)

        // 根据编码处理
        if (channel && channel.encoding === 'cdr') {
            handleCdrMessage(subscriptionId, channel, buffer, payloadOffset)
        } else {
            // 默认尝试 JSON
            const jsonStr = new TextDecoder().decode(payloadBytes)
            try {
                const data = JSON.parse(jsonStr)
                const callback = subscriptionCallbacks.get(subscriptionId)
                if (callback) callback(data)
            } catch (err) {
                console.error('[Foxglove] JSON 解析失败，且非已知 CDR 类型:', err)
                console.debug('[Foxglove] 原始数据 (Hex):', Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join(' '))
            }
        }
    } else {
        console.log('[Foxglove] 收到二进制消息, opcode:', opcode)
    }
}

/**
 * CDR 二进制解析辅助类
 */
class CdrReader {
    constructor(buffer, offset) {
        this.view = new DataView(buffer)
        this.pos = offset
        this.baseOffset = offset
    }

    // 对齐到 n 字节
    align(n) {
        const offsetFromBase = this.pos - this.baseOffset
        const padding = (n - (offsetFromBase % n)) % n
        this.pos += padding
    }

    readUint16() {
        this.align(2)
        const v = this.view.getUint16(this.pos, true)
        this.pos += 2
        return v
    }

    readInt32() {
        this.align(4)
        const v = this.view.getInt32(this.pos, true)
        this.pos += 4
        return v
    }

    readUint32() {
        this.align(4)
        const v = this.view.getUint32(this.pos, true)
        this.pos += 4
        return v
    }

    readFloat32() {
        this.align(4)
        const v = this.view.getFloat32(this.pos, true)
        this.pos += 4
        return v
    }

    readFloat64() {
        this.align(8)
        const v = this.view.getFloat64(this.pos, true)
        this.pos += 8
        return v
    }

    readString() {
        const len = this.readUint32() // 含 null 终止符的长度
        if (len <= 1) {
            this.pos += len
            return ""
        }
        const bytes = new Uint8Array(this.view.buffer, this.pos, len - 1)
        this.pos += len
        return new TextDecoder().decode(bytes)
    }

    readFloat32Array() {
        const len = this.readUint32()
        const result = []
        for (let i = 0; i < len; i++) {
            result.push(this.readFloat32())
        }
        return result
    }

    readInt8Array() {
        const len = this.readUint32()
        const arr = new Int8Array(this.view.buffer, this.pos, len)
        this.pos += len
        return Array.from(arr)
    }
}

/**
 * 极简 CDR 解析器 (针对复杂 ROS 类型)
 */
function handleCdrMessage(subId, channel, buffer, offset) {
    const callback = subscriptionCallbacks.get(subId)
    if (!callback) return

    // CDR 消息跳过 4 字节封装头 (00 01 00 00)
    const reader = new CdrReader(buffer, offset + 4)

    try {
        if (channel.schemaName === 'std_msgs/msg/UInt16' || channel.schemaName === 'std_msgs/UInt16') {
            const value = reader.readUint16()
            callback({ data: value })
        } else if (channel.schemaName === 'std_msgs/msg/Int32' || channel.schemaName === 'std_msgs/Int32') {
            const value = reader.readInt32()
            callback({ data: value })
        } else if (channel.schemaName === 'nav_msgs/msg/OccupancyGrid' || channel.schemaName === 'nav_msgs/OccupancyGrid') {
            console.log(`[Foxglove] 开始解析 CDR 地图 (len=${buffer.byteLength})...`)
            // 1. Header
            reader.readInt32() // stamp.sec
            reader.readUint32() // stamp.nanosec
            reader.readString() // frame_id

            // 2. MapMetaData info
            reader.readInt32() // map_load_time.sec
            reader.readUint32() // map_load_time.nanosec
            const resolution = reader.readFloat32()
            const width = reader.readUint32()
            const height = reader.readUint32()

            console.log(`[Foxglove] 地图尺寸: ${width}x${height}, 分辨率: ${resolution}`)

            // 3. Origin Pose
            const ox = reader.readFloat64()
            const oy = reader.readFloat64()
            const oz = reader.readFloat64()
            const qx = reader.readFloat64()
            const qy = reader.readFloat64()
            const qz = reader.readFloat64()
            const qw = reader.readFloat64()

            // 4. Data
            const data = reader.readInt8Array()

            console.log(`[Foxglove] 地图解析成功, 数据量: ${data.length}`)

            callback({
                info: {
                    resolution,
                    width,
                    height,
                    origin: {
                        position: { x: ox, y: oy, z: oz },
                        orientation: { x: qx, y: qy, z: qz, w: qw }
                    }
                },
                data: data
            })
        } else if (channel.schemaName === 'sensor_msgs/msg/LaserScan' || channel.schemaName === 'sensor_msgs/LaserScan') {
            // Header
            const stampSec = reader.readInt32()
            const stampNsec = reader.readUint32()
            const frameId = reader.readString()

            const angleMin = reader.readFloat32()
            const angleMax = reader.readFloat32()
            const angleIncrement = reader.readFloat32()
            const timeIncrement = reader.readFloat32()
            const scanTime = reader.readFloat32()
            const rangeMin = reader.readFloat32()
            const rangeMax = reader.readFloat32()
            const ranges = reader.readFloat32Array()
            const intensities = reader.readFloat32Array()

            callback({
                header: { stamp: { sec: stampSec, nsec: stampNsec }, frame_id: frameId },
                angle_min: angleMin,
                angle_max: angleMax,
                angle_increment: angleIncrement,
                ranges: ranges,
                range_min: rangeMin,
                range_max: rangeMax
            })
        } else if (channel.schemaName === 'tf2_msgs/msg/TFMessage' || channel.schemaName === 'tf2_msgs/TFMessage') {
            const numTransforms = reader.readUint32()
            const transforms = []
            for (let i = 0; i < numTransforms; i++) {
                // Header
                const stampSec = reader.readInt32()
                const stampNsec = reader.readUint32()
                const frameId = reader.readString()
                const childFrameId = reader.readString()

                // Transform
                const tx = reader.readFloat64()
                const ty = reader.readFloat64()
                const tz = reader.readFloat64()
                const rx = reader.readFloat64()
                const ry = reader.readFloat64()
                const rz = reader.readFloat64()
                const rw = reader.readFloat64()

                transforms.push({
                    header: { frame_id: frameId, stamp: { sec: stampSec, nsec: stampNsec } },
                    child_frame_id: childFrameId,
                    transform: {
                        translation: { x: tx, y: ty, z: tz },
                        rotation: { x: rx, y: ry, z: rz, w: rw }
                    }
                })
            }
            callback({ transforms })
        } else if (channel.schemaName === 'nav_msgs/msg/Odometry' || channel.schemaName === 'nav_msgs/Odometry') {
            const stampSec = reader.readInt32()
            const stampNsec = reader.readUint32()
            const frameId = reader.readString()
            const childFrameId = reader.readString()

            // Pose position
            const px = reader.readFloat64()
            const py = reader.readFloat64()
            const pz = reader.readFloat64()

            // Pose orientation
            const qx = reader.readFloat64()
            const qy = reader.readFloat64()
            const qz = reader.readFloat64()
            const qw = reader.readFloat64()

            // skip covariance 36 float64
            reader.align(8)
            reader.pos += 36 * 8

            // Twist linear
            const lx = reader.readFloat64()
            const ly = reader.readFloat64()
            const lz = reader.readFloat64()

            // Twist angular
            const ax = reader.readFloat64()
            const ay = reader.readFloat64()
            const az = reader.readFloat64()

            // skip covariance 36 float64
            reader.align(8)
            reader.pos += 36 * 8

            callback({
                header: { stamp: { sec: stampSec, nsec: stampNsec }, frame_id: frameId },
                child_frame_id: childFrameId,
                pose: {
                    pose: {
                        position: { x: px, y: py, z: pz },
                        orientation: { x: qx, y: qy, z: qz, w: qw }
                    }
                },
                twist: {
                    twist: {
                        linear: { x: lx, y: ly, z: lz },
                        angular: { x: ax, y: ay, z: az }
                    }
                }
            })
        } else if (channel.schemaName === 'nav_msgs/msg/Path' || channel.schemaName === 'nav_msgs/Path') {
            // Header
            reader.readInt32()  // stamp.sec
            reader.readUint32() // stamp.nanosec
            reader.readString() // frame_id
            // Poses array
            const numPoses = reader.readUint32()
            const poses = []
            for (let i = 0; i < numPoses; i++) {
                // Header (stamp + frame_id)
                reader.readInt32()
                reader.readUint32()
                reader.readString()
                // Position
                const px = reader.readFloat64()
                const py = reader.readFloat64()
                const pz = reader.readFloat64()
                // Orientation
                const qx = reader.readFloat64()
                const qy = reader.readFloat64()
                const qz = reader.readFloat64()
                const qw = reader.readFloat64()
                poses.push({ position: { x: px, y: py, z: pz }, orientation: { x: qx, y: qy, z: qz, w: qw } })
            }
            callback({ poses })
        } else {
            console.warn(`[Foxglove] 暂不支持 CDR 解析类型: ${channel.schemaName}。`)
        }
    } catch (err) {
        console.error('[Foxglove] CDR 解析失败:', err)
    }
}

// ======================== 订阅话题 ========================

/**
 * 根据话题名查找 channelId
 * @param {string} topicName - 话题名, 如 "/battery_state"
 * @returns {number|null} channelId
 */
function findChannelByTopic(topicName) {
    for (const [id, ch] of availableChannels) {
        if (ch.topic === topicName) {
            return id
        }
    }
    return null
}

/**
 * 订阅一个话题
 * @param {string} topicName - 话题名
 * @param {Function} callback - 收到消息时的回调 (parsedJSON) => void
 * @returns {number|null} subscriptionId, 失败返回 null
 */
function subscribe(topicName, callback) {
    const channelId = findChannelByTopic(topicName)
    if (channelId === null) {
        console.warn(`[Foxglove] 找不到话题: ${topicName}`)
        return null
    }

    const subId = nextSubscriptionId++
    subscriptionCallbacks.set(subId, callback)
    subscriptionIdToChannelId.set(subId, channelId)

    const msg = {
        op: 'subscribe',
        subscriptions: [{
            id: subId,
            channelId
        }]
    }

    ws.send(JSON.stringify(msg))
    console.log(`[Foxglove] 已订阅 ${topicName} (subId=${subId}, channelId=${channelId})`)
    return subId
}

/**
 * 取消订阅
 * @param {number} subscriptionId
 */
function unsubscribe(subscriptionId) {
    subscriptionCallbacks.delete(subscriptionId)

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            op: 'unsubscribe',
            subscriptionIds: [subscriptionId]
        }))
    }
}

// ======================== 发布消息 (Client Publish) ========================

/**
 * 声明客户端发布频道 (Client Advertise)
 * @param {string} topic - 话题名, 如 "/cmd_vel"
 * @param {string} schemaName - 消息类型, 如 "geometry_msgs/Twist"
 * @param {string} encoding - 编码方式, 默认 "json"
 * @returns {number} clientChannelId
 */
function clientAdvertise(topic, schemaName, encoding = 'json') {
    if (!serverCapabilities.value.includes('clientPublish')) {
        console.warn('[Foxglove] 服务器不支持 clientPublish 能力')
    }

    const channelId = nextClientChannelId++
    clientChannels.set(channelId, { topic, schemaName, encoding })

    const msg = {
        op: 'advertise',
        channels: [{
            id: channelId,
            topic,
            encoding,
            schemaName
        }]
    }

    ws.send(JSON.stringify(msg))
    console.log(`[Foxglove] Client Advertise: ${topic} (channelId=${channelId})`)
    return channelId
}

/**
 * 发送消息到已声明的客户端频道
 * Client Message Data 二进制格式:
 *   [opcode: 0x01 (1 byte)] [channelId: uint32 LE (4 bytes)] [payload: remaining bytes]
 *
 * @param {number} channelId - clientAdvertise 返回的 channelId
 * @param {object} data - 消息对象, 会被 JSON.stringify
 */
function publishMessage(channelId, data) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return
    }

    const jsonStr = JSON.stringify(data)
    const jsonBytes = new TextEncoder().encode(jsonStr)

    // 构造二进制包: 1 byte opcode + 4 bytes channelId + JSON payload
    const buffer = new ArrayBuffer(1 + 4 + jsonBytes.length)
    const view = new DataView(buffer)

    view.setUint8(0, 0x01)                  // opcode: ClientMessageData
    view.setUint32(1, channelId, true)       // channelId (little-endian)

    const payload = new Uint8Array(buffer, 5)
    payload.set(jsonBytes)

    ws.send(buffer)
}

/**
 * 发送导航目标点到 /goal_pose
 * geometry_msgs/PoseStamped 格式
 *
 * @param {number} channelId - /goal_pose 对应的客户端频道 ID
 * @param {number} x - 目标点 x (米)
 * @param {number} y - 目标点 y (米)
 * @param {number} yaw - 目标方向 (弧度)，默认0
 */
function sendGoalPose(channelId, x, y, yaw = 0) {
    const halfYaw = yaw / 2
    const qz = Math.sin(halfYaw)
    const qw = Math.cos(halfYaw)
    const stamp = Date.now() / 1000
    const sec = Math.floor(stamp)
    const nanosec = Math.round((stamp - sec) * 1e9)
    const msg = {
        header: {
            stamp: { sec, nanosec },
            frame_id: 'map'
        },
        pose: {
            position: { x, y, z: 0.0 },
            orientation: { x: 0.0, y: 0.0, z: qz, w: qw }
        }
    }
    publishMessage(channelId, msg)
    console.log(`[Foxglove] 发送目标点: (${x.toFixed(3)}, ${y.toFixed(3)}), yaw=${yaw.toFixed(3)}`)
}

/**
 * 发送 Twist 消息到 /cmd_vel
 * geometry_msgs/Twist 格式:
 * {
 *   linear:  { x, y, z },
 *   angular: { x, y, z }
 * }
 *
 * @param {number} channelId - /cmd_vel 对应的客户端频道 ID
 * @param {number} linearX - 线速度 (m/s), 正为前进, 负为后退
 * @param {number} angularZ - 角速度 (rad/s), 正为左转, 负为右转
 */
function sendTwist(channelId, linearX, angularZ) {
    const twist = {
        linear: { x: linearX, y: 0.0, z: 0.0 },
        angular: { x: 0.0, y: 0.0, z: angularZ }
    }
    publishMessage(channelId, twist)
}

/**
 * 发送初始位置估计到 /initialpose (AMCL 2D Pose Estimate)
 * geometry_msgs/PoseWithCovarianceStamped 格式
 *
 * @param {number} channelId - /initialpose 对应的客户端频道 ID
 * @param {number} x - 初始位置 x (米)
 * @param {number} y - 初始位置 y (米)
 * @param {number} yaw - 初始朝向 (弧度)
 */
function sendInitialPose(channelId, x, y, yaw = 0) {
    const halfYaw = yaw / 2
    const qz = Math.sin(halfYaw)
    const qw = Math.cos(halfYaw)
    const stamp = Date.now() / 1000
    const sec = Math.floor(stamp)
    const nanosec = Math.round((stamp - sec) * 1e9)
    // 标准 AMCL 初始协方差矩阵 (6x6, 行优先)
    const cov = [
        0.25, 0, 0, 0, 0, 0,
        0, 0.25, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0.0685
    ]
    const msg = {
        header: { stamp: { sec, nanosec }, frame_id: 'map' },
        pose: {
            pose: {
                position: { x, y, z: 0.0 },
                orientation: { x: 0.0, y: 0.0, z: qz, w: qw }
            },
            covariance: cov
        }
    }
    publishMessage(channelId, msg)
    console.log(`[Foxglove] 初始位置: (${x.toFixed(3)}, ${y.toFixed(3)}), yaw=${yaw.toFixed(3)}`)
}

// ======================== 导出 ========================

export function useFoxglove() {
    return {
        // 状态 (只读)
        connectionState: readonly(connectionState),
        serverName: readonly(serverName),
        serverCapabilities: readonly(serverCapabilities),
        errorMessage: readonly(errorMessage),
        availableChannels,

        // 方法
        connect,
        disconnect,
        subscribe,
        unsubscribe,
        clientAdvertise,
        publishMessage,
        sendTwist,
        sendGoalPose,
        sendInitialPose,
        findChannelByTopic
    }
}

