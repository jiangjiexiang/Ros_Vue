/**
 * ROS1 rosbridge 协议通信模块
 * 保持原 useFoxglove 接口，避免上层组件大改。
 */
import { ref, reactive, readonly } from 'vue'

// ======================== 状态 ========================
const connectionState = ref('disconnected') // disconnected | connecting | connected | error
const serverName = ref('')
const serverCapabilities = ref([])
const availableChannels = reactive(new Map())
const errorMessage = ref('')

// ======================== 内部变量 ========================
let ws = null
let nextClientChannelId = 1
let nextSubscriptionId = 1
const subscriptionCallbacks = new Map() // subscriptionId -> callback
const subscriptionTopics = new Map() // subscriptionId -> topic
const clientChannels = new Map() // clientChannelId -> { topic, schemaName, encoding }

function cleanup() {
  availableChannels.clear()
  subscriptionCallbacks.clear()
  subscriptionTopics.clear()
  clientChannels.clear()
  nextClientChannelId = 1
  nextSubscriptionId = 1
  serverName.value = ''
  serverCapabilities.value = []
}

function toRos1Time() {
  const stamp = Date.now() / 1000
  const secs = Math.floor(stamp)
  const nsecs = Math.round((stamp - secs) * 1e9)
  return { secs, nsecs }
}

function normalizeFeedback(data) {
  if (!data || typeof data !== 'object') return null

  // ROS2 风格（兼容旧配置）
  if (typeof data.distance_remaining === 'number' || data.estimated_time_remaining) {
    return data
  }

  // ROS1 move_base/feedback: move_base_msgs/MoveBaseActionFeedback
  // 该消息不带 distance_remaining，仅保留姿态供上层扩展。
  if (data.feedback && data.feedback.base_position) {
    return {
      base_position: data.feedback.base_position,
      estimated_time_remaining: null,
      distance_remaining: null
    }
  }

  return null
}

function connect(url) {
  if (ws) disconnect()

  connectionState.value = 'connecting'
  errorMessage.value = ''

  try {
    ws = new WebSocket(url)

    ws.onopen = () => {
      connectionState.value = 'connected'
      serverName.value = 'ROS1 rosbridge'
      serverCapabilities.value = ['subscribe', 'publish']

      window.dispatchEvent(new CustomEvent('foxglove:connected', { detail: { name: serverName.value } }))
      // 为保持上层逻辑，连接成功后触发一次 channels 事件
      window.dispatchEvent(new CustomEvent('foxglove:channels', { detail: [] }))
      window.dispatchEvent(new CustomEvent('foxglove:channels_update', { detail: [] }))
    }

    ws.onclose = () => {
      connectionState.value = 'disconnected'
      cleanup()
    }

    ws.onerror = (e) => {
      console.error('[rosbridge] WebSocket 错误:', e)
      connectionState.value = 'error'
      errorMessage.value = '连接失败，请检查 rosbridge_websocket 是否运行'
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.op !== 'publish') return

        // 根据 topic 分发
        for (const [subId, topic] of subscriptionTopics.entries()) {
          if (topic !== msg.topic) continue
          const cb = subscriptionCallbacks.get(subId)
          if (!cb) continue

          if (topic.includes('/feedback')) {
            cb(normalizeFeedback(msg.msg))
          } else {
            cb(msg.msg)
          }
        }
      } catch (err) {
        console.error('[rosbridge] 消息解析失败:', err)
      }
    }
  } catch (err) {
    connectionState.value = 'error'
    errorMessage.value = err.message
  }
}

function disconnect() {
  if (ws) {
    ws.close()
    ws = null
  }
  cleanup()
  connectionState.value = 'disconnected'
}

function subscribe(topicName, callback) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn('[rosbridge] 未连接，无法订阅:', topicName)
    return null
  }

  const subId = nextSubscriptionId++
  const rid = `sub_${subId}`

  subscriptionCallbacks.set(subId, callback)
  subscriptionTopics.set(subId, topicName)

  ws.send(JSON.stringify({
    op: 'subscribe',
    id: rid,
    topic: topicName,
    queue_length: 10
  }))

  return subId
}

function unsubscribe(subscriptionId) {
  const topic = subscriptionTopics.get(subscriptionId)
  subscriptionCallbacks.delete(subscriptionId)
  subscriptionTopics.delete(subscriptionId)

  if (topic && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      op: 'unsubscribe',
      id: `sub_${subscriptionId}`,
      topic
    }))
  }
}

function clientAdvertise(topic, schemaName, encoding = 'json') {
  // rosbridge 不要求显式 advertise，保留 channel 概念兼容上层。
  const channelId = nextClientChannelId++
  clientChannels.set(channelId, { topic, schemaName, encoding })
  return channelId
}

function publishMessage(channelId, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  const ch = clientChannels.get(channelId)
  if (!ch) return

  ws.send(JSON.stringify({
    op: 'publish',
    topic: ch.topic,
    msg: data
  }))
}

function sendTwist(channelId, linearX, angularZ) {
  const twist = {
    linear: { x: linearX, y: 0.0, z: 0.0 },
    angular: { x: 0.0, y: 0.0, z: angularZ }
  }
  publishMessage(channelId, twist)
}

function sendGoalPose(channelId, x, y, yaw = 0) {
  const halfYaw = yaw / 2
  const qz = Math.sin(halfYaw)
  const qw = Math.cos(halfYaw)
  const stamp = toRos1Time()

  const msg = {
    header: {
      stamp,
      frame_id: 'map'
    },
    pose: {
      position: { x, y, z: 0.0 },
      orientation: { x: 0.0, y: 0.0, z: qz, w: qw }
    }
  }

  publishMessage(channelId, msg)
}

function sendInitialPose(channelId, x, y, yaw = 0) {
  const halfYaw = yaw / 2
  const qz = Math.sin(halfYaw)
  const qw = Math.cos(halfYaw)
  const stamp = toRos1Time()

  const cov = [
    0.25, 0, 0, 0, 0, 0,
    0, 0.25, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0.0685
  ]

  const msg = {
    header: { stamp, frame_id: 'map' },
    pose: {
      pose: {
        position: { x, y, z: 0.0 },
        orientation: { x: 0.0, y: 0.0, z: qz, w: qw }
      },
      covariance: cov
    }
  }

  publishMessage(channelId, msg)
}

function findChannelByTopic(topicName) {
  for (const [id, ch] of clientChannels.entries()) {
    if (ch.topic === topicName) return id
  }
  return null
}

export function useFoxglove() {
  return {
    connectionState: readonly(connectionState),
    serverName: readonly(serverName),
    serverCapabilities: readonly(serverCapabilities),
    errorMessage: readonly(errorMessage),
    availableChannels,

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
