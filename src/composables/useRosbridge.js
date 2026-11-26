/**
 * rosbridge_server WebSocket JSON 协议通信模块
 * 处理与 rosbridge_server 的连接、话题订阅、消息发布
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
let connectionGeneration = 0
let nextChannelId = 1
let nextClientChannelId = 1
let nextSubscriptionId = 1
let nextServiceRequestId = 1
let latestTopicsRequestId = null
let topicsRefreshTimer = null
const channelIdsByTopic = new Map()     // topic → channelId
const subscriptionCallbacks = new Map() // subscriptionId → callback(parsedJSON)
const subscriptionIdToTopic = new Map() // subscriptionId → topic
const clientChannels = new Map()        // clientChannelId → {topic, ...}
const pendingServiceCalls = new Map()   // requestId → {resolve, reject, timer, service}

const TOPICS_REFRESH_INTERVAL = 5000

// ======================== 连接管理 ========================

/**
 * 连接到 rosbridge_server WebSocket 服务器
 * @param {string} url - WebSocket URL, 例如 ws://localhost:9090
 */
function connect(url) {
    disconnect()

    connectionState.value = 'connecting'
    errorMessage.value = ''
    const generation = ++connectionGeneration

    try {
        const socket = new WebSocket(url)
        ws = socket

        const isCurrentConnection = () => (
            ws === socket && connectionGeneration === generation
        )

        socket.onopen = () => {
            if (!isCurrentConnection()) return

            connectionState.value = 'connected'
            serverName.value = 'rosbridge_server'
            serverCapabilities.value = ['clientPublish']
            console.log('[Rosbridge] WebSocket 已连接')

            // 触发自定义事件，通知其他模块服务器已准备好
            window.dispatchEvent(new CustomEvent('foxglove:connected', {
                detail: {
                    name: serverName.value,
                    capabilities: serverCapabilities.value,
                    supportedEncodings: ['json']
                }
            }))

            refreshTopics()
            topicsRefreshTimer = window.setInterval(refreshTopics, TOPICS_REFRESH_INTERVAL)
        }

        socket.onclose = (event) => {
            if (!isCurrentConnection()) return

            console.log('[Rosbridge] WebSocket 已断开:', event.code, event.reason)
            ws = null
            stopTopicsRefresh()
            cleanup()
            connectionState.value = 'disconnected'
        }

        socket.onerror = (event) => {
            if (!isCurrentConnection()) return

            console.error('[Rosbridge] WebSocket 错误:', event)
            connectionState.value = 'error'
            errorMessage.value = '连接失败，请检查地址和 rosbridge_server 是否运行'
        }

        socket.onmessage = (event) => {
            if (!isCurrentConnection() || typeof event.data !== 'string') return

            try {
                handleJsonMessage(JSON.parse(event.data))
            } catch (err) {
                console.error('[Rosbridge] JSON 解析失败:', err)
                errorMessage.value = '收到无法解析的 rosbridge 消息'
            }
        }
    } catch (err) {
        if (connectionGeneration !== generation) return
        ws = null
        connectionState.value = 'error'
        errorMessage.value = err.message
    }
}

/**
 * 断开连接
 */
function disconnect() {
    connectionGeneration++
    stopTopicsRefresh()

    const socket = ws
    ws = null
    if (socket) {
        socket.close()
    }

    cleanup()
    connectionState.value = 'disconnected'
}

function stopTopicsRefresh() {
    if (topicsRefreshTimer !== null) {
        window.clearInterval(topicsRefreshTimer)
        topicsRefreshTimer = null
    }
}

function cleanup() {
    for (const pending of pendingServiceCalls.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error(`rosbridge 服务调用因连接关闭而失败: ${pending.service}`))
    }
    pendingServiceCalls.clear()
    availableChannels.clear()
    channelIdsByTopic.clear()
    subscriptionCallbacks.clear()
    subscriptionIdToTopic.clear()
    clientChannels.clear()
    nextChannelId = 1
    nextClientChannelId = 1
    nextSubscriptionId = 1
    latestTopicsRequestId = null
    serverName.value = ''
    serverCapabilities.value = []
}

function sendJson(message) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return false
    }

    try {
        ws.send(JSON.stringify(message))
        return true
    } catch (err) {
        console.error('[Rosbridge] 消息发送失败:', err)
        errorMessage.value = err.message
        return false
    }
}

// ======================== JSON 消息处理 ========================

function handleJsonMessage(msg) {
    switch (msg.op) {
        case 'publish':
            handlePublish(msg)
            break
        case 'service_response':
            handleServiceResponse(msg)
            break
        case 'status':
            console.log(`[Rosbridge] 状态 [${msg.level}]: ${msg.msg}`)
            if (msg.level === 'error') {
                errorMessage.value = msg.msg || 'rosbridge_server 返回错误'
            }
            break
        default:
            console.log('[Rosbridge] 未知的 JSON 消息:', msg.op)
    }
}

function handlePublish(msg) {
    for (const [subscriptionId, topic] of subscriptionIdToTopic) {
        if (topic !== msg.topic) continue

        const callback = subscriptionCallbacks.get(subscriptionId)
        if (!callback) continue

        try {
            callback(msg.msg)
        } catch (err) {
            console.error(`[Rosbridge] 话题回调执行失败 (${msg.topic}):`, err)
        }
    }
}

const CANCEL_GOAL_RETURN_CODES = {
    1: 'ERROR_REJECTED',
    2: 'ERROR_UNKNOWN_GOAL_ID',
    3: 'ERROR_GOAL_TERMINATED'
}

function findReturnCode(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 6) return undefined
    for (const key of ['return_code', 'returnCode', 'return-code']) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue
        const raw = value[key] && typeof value[key] === 'object' ? value[key].data : value[key]
        if (raw !== null && raw !== '' && Number.isFinite(Number(raw))) return Number(raw)
    }
    for (const nested of Object.values(value)) {
        const code = findReturnCode(nested, depth + 1)
        if (code !== undefined) return code
    }
    return undefined
}

function handleServiceResponse(msg) {
    const pending = pendingServiceCalls.get(msg.id)
    if (pending) {
        pendingServiceCalls.delete(msg.id)
        clearTimeout(pending.timer)
        if (msg.result !== true) {
            const detail = msg.values?.error || msg.values?.message || msg.message || '服务返回失败'
            pending.reject(new Error(`${pending.service}: ${detail}`))
        } else if (pending.service.endsWith('/cancel_goal')) {
            const returnCode = findReturnCode(msg.values)
            if (returnCode === undefined) {
                pending.reject(new Error(`${pending.service}: CancelGoal 响应缺少 return_code`))
            } else if (returnCode !== 0) {
                const reason = CANCEL_GOAL_RETURN_CODES[returnCode] || `UNKNOWN_RETURN_CODE_${returnCode}`
                pending.reject(new Error(`${pending.service}: ${reason} (${returnCode})`))
            } else {
                pending.resolve({ success: true, id: msg.id, values: msg.values, returnCode })
            }
        } else {
            pending.resolve({ success: true, id: msg.id, values: msg.values })
        }
        return
    }
    if (msg.id !== latestTopicsRequestId) return

    if (msg.result === false) {
        console.error('[Rosbridge] 获取话题列表失败:', msg.values)
        errorMessage.value = '调用 /rosapi/topics 失败，请确认 rosapi 已运行'
        return
    }

    const values = msg.values || {}
    if (!Array.isArray(values.topics) || !Array.isArray(values.types)) {
        console.error('[Rosbridge] /rosapi/topics 返回格式无效:', values)
        errorMessage.value = '/rosapi/topics 返回格式无效'
        return
    }

    updateChannels(values.topics, values.types)
}

// ======================== 话题发现 ========================

function callService(service, args = {}, { timeoutMs = 2500 } = {}) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error(`rosbridge 未连接，无法调用 ${service}`))
    }
    const requestId = `service_${nextServiceRequestId++}`
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingServiceCalls.delete(requestId)
            reject(new Error(`rosbridge 服务调用超时: ${service}`))
        }, timeoutMs)
        pendingServiceCalls.set(requestId, { resolve, reject, timer, service })
        const sent = sendJson({
            op: 'call_service',
            id: requestId,
            service,
            args
        })
        if (!sent) {
            clearTimeout(timer)
            pendingServiceCalls.delete(requestId)
            reject(new Error(`rosbridge 服务调用发送失败: ${service}`))
        }
    })
}

function refreshTopics() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    const requestId = `rosapi_topics_${nextServiceRequestId++}`
    latestTopicsRequestId = requestId
    sendJson({
        op: 'call_service',
        id: requestId,
        service: '/rosapi/topics',
        args: {}
    })
}

function updateChannels(topics, types) {
    const currentTopics = new Set(topics)

    for (const [topic, channelId] of channelIdsByTopic) {
        if (!currentTopics.has(topic)) {
            channelIdsByTopic.delete(topic)
            availableChannels.delete(channelId)
        }
    }

    topics.forEach((topic, index) => {
        let channelId = channelIdsByTopic.get(topic)
        if (channelId === undefined) {
            channelId = nextChannelId++
            channelIdsByTopic.set(topic, channelId)
        }

        availableChannels.set(channelId, {
            id: channelId,
            topic,
            encoding: 'json',
            schemaName: types[index] || ''
        })
    })

    errorMessage.value = ''
    console.log(`[Rosbridge] 收到 ${topics.length} 个话题频道`)
    // 触发事件通知
    window.dispatchEvent(new CustomEvent('foxglove:channels', {
        detail: Array.from(availableChannels.values())
    }))
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
        console.warn(`[Rosbridge] 找不到话题: ${topicName}`)
        return null
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('[Rosbridge] WebSocket 未连接，无法订阅')
        return null
    }

    const subId = nextSubscriptionId++
    subscriptionCallbacks.set(subId, callback)
    subscriptionIdToTopic.set(subId, topicName)

    const sent = sendJson({
        op: 'subscribe',
        id: String(subId),
        topic: topicName,
        type: availableChannels.get(channelId).schemaName
    })
    if (!sent) {
        subscriptionCallbacks.delete(subId)
        subscriptionIdToTopic.delete(subId)
        return null
    }

    console.log(`[Rosbridge] 已订阅 ${topicName} (subId=${subId}, channelId=${channelId})`)
    return subId
}

/**
 * 取消订阅
 * @param {number} subscriptionId
 */
function unsubscribe(subscriptionId) {
    const topic = subscriptionIdToTopic.get(subscriptionId)
    subscriptionCallbacks.delete(subscriptionId)
    subscriptionIdToTopic.delete(subscriptionId)

    if (topic !== undefined) {
        sendJson({
            op: 'unsubscribe',
            id: String(subscriptionId),
            topic
        })
    }
}

// ======================== 发布消息 (Client Publish) ========================

/**
 * 声明客户端发布频道 (Client Advertise)
 * @param {string} topic - 话题名, 如 "/cmd_vel"
 * @param {string} schemaName - 消息类型, 如 "geometry_msgs/Twist"
 * @param {string} encoding - 编码方式, 默认 "json" (rosbridge 仅使用 JSON)
 * @returns {number|null} clientChannelId, 失败返回 null
 */
function clientAdvertise(topic, schemaName, encoding = 'json') {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('[Rosbridge] WebSocket 未连接，无法声明发布话题')
        return null
    }

    const channelId = nextClientChannelId++
    clientChannels.set(channelId, { topic, schemaName, encoding })

    const sent = sendJson({
        op: 'advertise',
        id: String(channelId),
        topic,
        type: schemaName
    })
    if (!sent) {
        clientChannels.delete(channelId)
        return null
    }

    console.log(`[Rosbridge] Client Advertise: ${topic} (channelId=${channelId})`)
    return channelId
}

/**
 * 发送消息到已声明的客户端频道
 * @param {number} channelId - clientAdvertise 返回的 channelId
 * @param {object} data - 消息对象, 会被 JSON.stringify
 */
function publishMessage(channelId, data) {
    const channel = clientChannels.get(channelId)
    if (!channel) {
        console.warn(`[Rosbridge] 找不到客户端发布频道: ${channelId}`)
        return
    }

    return sendJson({
        op: 'publish',
        id: String(channelId),
        topic: channel.topic,
        msg: data
    })
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
    console.log(`[Rosbridge] 发送目标点: (${x.toFixed(3)}, ${y.toFixed(3)}), yaw=${yaw.toFixed(3)}`)
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
    return publishMessage(channelId, twist)
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
    console.log(`[Rosbridge] 初始位置: (${x.toFixed(3)}, ${y.toFixed(3)}), yaw=${yaw.toFixed(3)}`)
}

// ======================== 导出 ========================

export function useRosbridge() {
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
        callService,
        sendTwist,
        sendGoalPose,
        sendInitialPose,
        findChannelByTopic
    }
}
