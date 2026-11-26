/**
 * DogLink 自研轻量级 WebSocket 协议前端适配器
 * 文本帧：控制、话题发现、心跳 RTT、轻量结构化消息
 * 二进制帧（Magic 0x44）：PointCloud2 / CompressedImage / OccupancyGrid 零拷贝直出
 */
import { reactive, readonly, ref } from 'vue'

const MAGIC_BINARY = 0x44
const BIN_POINTCLOUD2 = 1
const BIN_COMPRESSED_IMAGE = 2
const BIN_OCCUPANCY_GRID = 3

const connectionState = ref('disconnected')
const serverName = ref('')
const serverCapabilities = ref([])
const availableChannels = reactive(new Map())
const errorMessage = ref('')
const rttMs = ref(null)

let ws = null
let connectionGeneration = 0
let nextChannelId = 1
let nextClientChannelId = 1
let nextSubscriptionId = 1
let pingTimer = null

const channelIdsByTopic = new Map()
const topicCallbacks = new Map() // topic -> Map(subId -> cb)
const subIdToTopic = new Map()
const clientChannels = new Map()
const textDecoder = new TextDecoder()

function connect(url) {
  disconnect()

  connectionState.value = 'connecting'
  errorMessage.value = ''
  rttMs.value = null
  const generation = ++connectionGeneration

  try {
    const socket = new WebSocket(url)
    socket.binaryType = 'arraybuffer'
    ws = socket

    const isCurrent = () => ws === socket && connectionGeneration === generation

    socket.onopen = () => {
      if (!isCurrent()) return
      connectionState.value = 'connected'
      serverName.value = 'DogLink/1.0'
      serverCapabilities.value = ['clientPublish', 'binaryStream']

      window.dispatchEvent(new CustomEvent('foxglove:connected', {
        detail: {
          name: serverName.value,
          capabilities: serverCapabilities.value,
          supportedEncodings: ['json', 'binary']
        }
      }))

      startPingLoop()
    }

    socket.onclose = () => {
      if (!isCurrent()) return
      ws = null
      stopPingLoop()
      cleanup()
      connectionState.value = 'disconnected'
    }

    socket.onerror = () => {
      if (!isCurrent()) return
      connectionState.value = 'error'
      errorMessage.value = 'DogLink 连接失败，请检查地址和 doglink_gateway 是否运行'
    }

    socket.onmessage = (event) => {
      if (!isCurrent()) return
      if (typeof event.data === 'string') {
        try {
          handleTextMessage(JSON.parse(event.data))
        } catch (err) {
          console.error('[DogLink] JSON 解析失败:', err)
        }
      } else if (event.data instanceof ArrayBuffer) {
        handleBinaryMessage(event.data)
      }
    }
  } catch (err) {
    connectionState.value = 'error'
    errorMessage.value = `DogLink 无效地址: ${err.message}`
  }
}

function disconnect() {
  connectionGeneration++
  stopPingLoop()
  if (ws) {
    ws.onopen = null
    ws.onclose = null
    ws.onerror = null
    ws.onmessage = null
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close()
    }
    ws = null
  }
  cleanup()
  connectionState.value = 'disconnected'
}

function cleanup() {
  availableChannels.clear()
  channelIdsByTopic.clear()
  topicCallbacks.clear()
  subIdToTopic.clear()
  clientChannels.clear()
  serverName.value = ''
  serverCapabilities.value = []
  rttMs.value = null
  nextChannelId = 1
  nextClientChannelId = 1
  nextSubscriptionId = 1
}

function startPingLoop() {
  stopPingLoop()
  const sendPing = () => sendJson({ op: 'ping', ts: Date.now() })
  sendPing()
  pingTimer = window.setInterval(sendPing, 3000)
}

function stopPingLoop() {
  if (pingTimer !== null) {
    clearInterval(pingTimer)
    pingTimer = null
  }
}

function sendJson(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  try {
    ws.send(JSON.stringify(obj))
    return true
  } catch {
    return false
  }
}

function syncChannels(topics) {
  if (!Array.isArray(topics)) return
  availableChannels.clear()
  channelIdsByTopic.clear()
  for (const item of topics) {
    if (!item?.topic) continue
    const id = nextChannelId++
    const ch = { id, topic: item.topic, encoding: 'doglink', schemaName: item.schemaName || '' }
    availableChannels.set(id, ch)
    channelIdsByTopic.set(item.topic, id)
  }
  window.dispatchEvent(new CustomEvent('foxglove:channels', {
    detail: Array.from(availableChannels.values())
  }))
}

function dispatchTopicMessage(topic, data) {
  const callbacks = topicCallbacks.get(topic)
  if (!callbacks) return
  for (const cb of callbacks.values()) {
    cb(data)
  }
}

function handleTextMessage(msg) {
  if (!msg || typeof msg !== 'object') return
  switch (msg.op) {
    case 'hello':
      if (msg.server) serverName.value = msg.server
      if (Array.isArray(msg.capabilities)) serverCapabilities.value = msg.capabilities
      syncChannels(msg.topics)
      break
    case 'topics':
      syncChannels(msg.topics)
      break
    case 'pong':
      if (typeof msg.ts === 'number') {
        rttMs.value = Math.max(1, Date.now() - msg.ts)
      }
      break
    case 'msg':
      if (msg.topic && msg.msg !== undefined) {
        dispatchTopicMessage(msg.topic, msg.msg)
      }
      break
  }
}

function handleBinaryMessage(buffer) {
  if (buffer.byteLength < 8) return
  const view = new DataView(buffer)
  const magic = view.getUint8(0)
  if (magic !== MAGIC_BINARY) return

  const msgType = view.getUint8(1)
  const topicLen = view.getUint16(2, true)
  const metaLen = view.getUint32(4, true)
  const headerEnd = 8 + topicLen + metaLen
  if (headerEnd > buffer.byteLength) return

  const topic = textDecoder.decode(new Uint8Array(buffer, 8, topicLen))
  const metaText = textDecoder.decode(new Uint8Array(buffer, 8 + topicLen, metaLen))
  let meta = {}
  try {
    meta = JSON.parse(metaText)
  } catch {
    return
  }

  const payloadLen = buffer.byteLength - headerEnd
  if (msgType === BIN_POINTCLOUD2) {
    const count = Number(meta.count) || 0
    const aligned = buffer.slice(headerEnd, headerEnd + count * 12)
    dispatchTopicMessage(topic, {
      header: { frame_id: meta.frame_id || 'base_scan' },
      count,
      positions: new Float32Array(aligned)
    })
  } else if (msgType === BIN_COMPRESSED_IMAGE) {
    dispatchTopicMessage(topic, {
      header: { frame_id: meta.frame_id || '' },
      format: meta.format || 'jpeg',
      data: new Uint8Array(buffer, headerEnd, payloadLen)
    })
  } else if (msgType === BIN_OCCUPANCY_GRID) {
    const gridCopy = buffer.slice(headerEnd)
    dispatchTopicMessage(topic, {
      info: meta.info,
      data: new Int8Array(gridCopy)
    })
  }
}

function findChannelByTopic(topicName) {
  return channelIdsByTopic.get(topicName) || null
}

function subscribe(topicName, callback) {
  const subId = nextSubscriptionId++
  let map = topicCallbacks.get(topicName)
  const isFirst = !map
  if (!map) {
    map = new Map()
    topicCallbacks.set(topicName, map)
  }
  map.set(subId, callback)
  subIdToTopic.set(subId, topicName)

  if (isFirst) {
    sendJson({ op: 'sub', topic: topicName })
  }
  return subId
}

function unsubscribe(subscriptionId) {
  const topic = subIdToTopic.get(subscriptionId)
  if (!topic) return
  subIdToTopic.delete(subscriptionId)
  const map = topicCallbacks.get(topic)
  if (map) {
    map.delete(subscriptionId)
    if (map.size === 0) {
      topicCallbacks.delete(topic)
      sendJson({ op: 'unsub', topic })
    }
  }
}

function clientAdvertise(topic, schemaName, encoding = 'json') {
  const id = nextClientChannelId++
  clientChannels.set(id, { id, topic, schemaName, encoding })
  return id
}

function publishMessage(clientChannelId, messageObj) {
  const ch = clientChannels.get(clientChannelId)
  if (!ch) return
  return sendJson({ op: 'pub', topic: ch.topic, type: ch.schemaName, msg: messageObj })
}

function sendTwist(clientChannelId, linearX, angularZ) {
  return publishMessage(clientChannelId, {
    linear: { x: linearX, y: 0, z: 0 },
    angular: { x: 0, y: 0, z: angularZ }
  })
}

function sendGoalPose(clientChannelId, x, y, yaw = 0) {
  publishMessage(clientChannelId, {
    header: { frame_id: 'map' },
    pose: {
      position: { x, y, z: 0 },
      orientation: { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) }
    }
  })
}

function sendInitialPose(clientChannelId, x, y, yaw = 0) {
  const covariance = new Array(36).fill(0)
  covariance[0] = 0.25
  covariance[7] = 0.25
  covariance[35] = 0.06853891945200942

  publishMessage(clientChannelId, {
    header: { frame_id: 'map' },
    pose: {
      pose: {
        position: { x, y, z: 0 },
        orientation: { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) }
      },
      covariance
    }
  })
}

export function useDoglink() {
  return {
    connectionState: readonly(connectionState),
    serverName: readonly(serverName),
    serverCapabilities: readonly(serverCapabilities),
    availableChannels: readonly(availableChannels),
    errorMessage: readonly(errorMessage),
    rttMs: readonly(rttMs),
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
