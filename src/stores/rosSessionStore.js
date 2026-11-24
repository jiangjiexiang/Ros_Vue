import { computed, nextTick, reactive, ref, watch } from 'vue'
import { useRosTransport } from '../composables/useRosTransport.js'
import { API_BASE, DEFAULT_WS_URL } from '../config.js'
import { useRobotStore } from './robotStore.js'
import { TOPIC_DEFAULTS, useRuntimeConfigStore } from './runtimeConfigStore.js'
import { useInspectionStore } from './inspectionStore.js'
import { showToast } from './toastStore.js'

const transport = useRosTransport()
const { activeRobot, activeRobotId, selectActiveRobot } = useRobotStore()
const { runtimeTopics, controlConfig } = useRuntimeConfigStore()
const { pushRuntimeAlert } = useInspectionStore()

const layerOptions = [
  { key: 'map', label: '地图' },
  { key: 'scan', label: '激光' },
  { key: 'robot', label: '机器狗' },
  { key: 'path', label: '路径' },
  { key: 'goal', label: '目标' }
]

const activeOperation = ref('maps')
const mapsRevision = ref(0)
const selectedScenePath = ref('')

const mappingActive = ref(false)
const navigationActive = ref(false)
const isSettingPose = ref(false)
const multiPointMode = ref(false)
const waypointQueue = ref([])
const activeWaypoint = ref(null)
const waypointAdvancing = ref(false)
const FEEDBACK_REACHED_THRESHOLD = 0.10

const topics = ref([])
const batteryPercentage = ref(-1)
const batteryVoltage = ref(0)
const mapData = ref(null)
const scanData = ref(null)
const tfData = ref(null)
const odomData = ref(null)
const planData = ref(null)
const cameraPrimary = ref(null)
const cameraSecondary = ref(null)
const navFeedback = ref(null)
const imuData = ref(null)

const mapLayers = ref({
  map: true,
  scan: true,
  robot: true,
  path: true,
  goal: true
})

const keyboardEnabled = ref(false)
const keyboardState = reactive({
  w: false,
  a: false,
  s: false,
  d: false
})

let cmdVelChannelId = null
let goalPoseChannelId = null
let initialPoseChannelId = null

let batterySubId = null
let mapSubId = null
let scanSubId = null
let tfSubId = null
let odomSubId = null
let planSubId = null
let feedbackSubId = null
let imuSubId = null
let cameraPrimarySubId = null
let cameraSecondarySubId = null

let keyboardInterval = null
let initialized = false
let intentionalDisconnect = false

const robotTopics = computed(() => {
  const namespace = activeRobot.value?.namespace?.replace(/^\/+|\/+$/g, '')
  const merged = { ...runtimeTopics.value }
  const usesFastLio = ['fast_lio', 'fast_lio_localization'].includes(activeRobot.value?.slamAlgorithm) ||
    activeRobot.value?.localizationAlgorithm === 'fast_lio_localization'
  if (usesFastLio && merged.odom === TOPIC_DEFAULTS.odom) {
    merged.odom = merged.fastlio_odom || '/Odometry'
  }
  return Object.fromEntries(Object.entries(merged).map(([key, topic]) => {
    if (!namespace || !topic) return [key, topic]
    return [key, `/${namespace}/${topic.replace(/^\/+/, '')}`]
  }))
})

const connectionState = computed(() => transport.connectionState.value)
const errorMessage = computed(() => transport.errorMessage.value)
const isConnected = computed(() => connectionState.value === 'connected')

const modeText = computed(() => {
  if (!isConnected.value) return '离线'
  if (isSettingPose.value) return '初始定位'
  if (mappingActive.value) return '建图作业'
  if (navigationActive.value) return multiPointMode.value ? '多点导航' : '自主导航'
  return '待机监控'
})

const mapSize = computed(() => {
  const info = mapData.value?.info
  return info ? `${info.width} × ${info.height}` : '--'
})

const linearSpeed = computed(() => {
  const speed = odomData.value?.twist?.twist?.linear?.x
  return Number.isFinite(speed) ? Math.abs(speed).toFixed(2) : '0.00'
})

const statusText = computed(() => {
  switch (connectionState.value) {
    case 'connected': return '已连接'
    case 'connecting': return '连接中...'
    case 'error': return '连接错误'
    default: return '未连接'
  }
})

const waypointCount = computed(() => waypointQueue.value.length + (activeWaypoint.value ? 1 : 0))

function clearAllData() {
  batteryPercentage.value = -1
  batteryVoltage.value = 0
  mapData.value = null
  scanData.value = null
  tfData.value = null
  odomData.value = null
  planData.value = null
  cameraPrimary.value = null
  cameraSecondary.value = null
  navFeedback.value = null
  imuData.value = null
  waypointQueue.value = []
  activeWaypoint.value = null
  topics.value = []
}

function clearConnectionState() {
  cmdVelChannelId = null
  goalPoseChannelId = null
  initialPoseChannelId = null
  batterySubId = null
  mapSubId = null
  scanSubId = null
  tfSubId = null
  odomSubId = null
  planSubId = null
  feedbackSubId = null
  imuSubId = null
  cameraPrimarySubId = null
  cameraSecondarySubId = null
  clearAllData()
}

function handleConnect(url) {
  if (connectionState.value === 'connected' || connectionState.value === 'connecting') return
  intentionalDisconnect = false
  const targetUrl = url || activeRobot.value?.url || DEFAULT_WS_URL
  if (activeRobot.value && url) {
    activeRobot.value.url = targetUrl
  }
  transport.connect(targetUrl, activeRobot.value?.transport || 'foxglove')
}

function handleDisconnect() {
  intentionalDisconnect = true
  onStopMotion()
  transport.disconnect()
  clearConnectionState()
}

function switchRobot(robot, { reconnect = true } = {}) {
  if (!robot) return
  if (robot.id === activeRobotId.value) {
    if (reconnect && !isConnected.value && connectionState.value !== 'connecting') {
      handleConnect(robot.url)
    }
    return
  }
  handleDisconnect()
  selectActiveRobot(robot.id)
  if (reconnect) {
    nextTick(() => handleConnect(robot.url))
  }
}

function connectRobot(robot) {
  if (!robot) return
  if (robot.id !== activeRobotId.value) {
    switchRobot(robot, { reconnect: true })
  } else {
    handleConnect(robot.url)
  }
}

function normalizeNavFeedback(data) {
  if (!data || typeof data !== 'object') return null

  if (typeof data.distance_remaining === 'number' || data.estimated_time_remaining) {
    const eta = data.estimated_time_remaining || {}
    return {
      distance_remaining: Number.isFinite(data.distance_remaining) ? data.distance_remaining : null,
      estimated_time_remaining: {
        sec: Number.isFinite(eta.sec) ? eta.sec : 0,
        nanosec: Number.isFinite(eta.nanosec) ? eta.nanosec : (Number.isFinite(eta.nsec) ? eta.nsec : 0)
      }
    }
  }

  if (data.feedback && typeof data.feedback === 'object') {
    const eta = data.feedback.estimated_time_remaining || {}
    return {
      distance_remaining: Number.isFinite(data.feedback.distance_remaining) ? data.feedback.distance_remaining : null,
      estimated_time_remaining: {
        sec: Number.isFinite(eta.sec) ? eta.sec : 0,
        nanosec: Number.isFinite(eta.nanosec) ? eta.nanosec : (Number.isFinite(eta.nsec) ? eta.nsec : 0)
      }
    }
  }

  return null
}

function onChannelsReady(event) {
  const channels = event.detail
  topics.value = channels

  if (!cmdVelChannelId) {
    cmdVelChannelId = transport.clientAdvertise(robotTopics.value.cmd_vel, 'geometry_msgs/Twist', 'json')
  }

  if (!batterySubId) {
    batterySubId = transport.subscribe(robotTopics.value.battery, (data) => {
      if (data.data !== undefined) {
        batteryVoltage.value = (data.data / 10).toFixed(1)
        const raw = data.data
        if (raw > 90) {
          batteryPercentage.value = Math.max(0, Math.min(100, Math.round((raw - 96) / (126 - 96) * 100)))
        } else {
          batteryPercentage.value = Math.max(0, Math.min(100, Math.round((raw - 64) / (84 - 64) * 100)))
        }
      }
    })
  }

  if (!mapSubId) {
    mapSubId = transport.subscribe(robotTopics.value.map, (data) => {
      mapData.value = data
    })
  }

  if (!scanSubId) {
    scanSubId = transport.subscribe(robotTopics.value.scan, (data) => {
      scanData.value = data
    })
  }

  if (!tfSubId) {
    tfSubId = transport.subscribe(robotTopics.value.tf, (data) => {
      tfData.value = data
    })
  }

  if (!odomSubId) {
    odomSubId = transport.subscribe(robotTopics.value.odom, (data) => {
      odomData.value = data
    })
  }

  if (!goalPoseChannelId) {
    goalPoseChannelId = transport.clientAdvertise(robotTopics.value.goal_pose, 'geometry_msgs/PoseStamped', 'json')
  }

  if (!planSubId) {
    planSubId = transport.subscribe(robotTopics.value.plan, (data) => {
      planData.value = data
    })
  }

  if (!initialPoseChannelId) {
    initialPoseChannelId = transport.clientAdvertise(robotTopics.value.initial_pose, 'geometry_msgs/PoseWithCovarianceStamped', 'json')
  }

  if (!feedbackSubId) {
    feedbackSubId = transport.subscribe(robotTopics.value.navigate_feedback, (data) => {
      navFeedback.value = normalizeNavFeedback(data)
    })
  }

  if (!imuSubId) {
    imuSubId = transport.subscribe(robotTopics.value.imu, (data) => {
      imuData.value = data
    })
  }

  if (!cameraPrimarySubId && robotTopics.value.camera_primary) {
    cameraPrimarySubId = transport.subscribe(robotTopics.value.camera_primary, (data) => {
      cameraPrimary.value = data
    })
  }

  if (!cameraSecondarySubId && robotTopics.value.camera_secondary) {
    cameraSecondarySubId = transport.subscribe(robotTopics.value.camera_secondary, (data) => {
      cameraSecondary.value = data
    })
  }
}

function onVelocityChange({ linearX, angularZ }) {
  if (cmdVelChannelId && isConnected.value) {
    transport.sendTwist(cmdVelChannelId, linearX, angularZ)
  }
}

function sendGoalPose(x, y, yaw = 0) {
  if (goalPoseChannelId && isConnected.value) {
    transport.sendGoalPose(goalPoseChannelId, x, y, yaw)
  }
}

function onGoalSet({ x, y }) {
  if (multiPointMode.value) return
  sendGoalPose(x, y, 0)
}

function dispatchNextWaypoint() {
  if (!multiPointMode.value || !navigationActive.value) return
  if (waypointQueue.value.length === 0) {
    activeWaypoint.value = null
    return
  }
  const next = waypointQueue.value.shift()
  activeWaypoint.value = next
  sendGoalPose(next.x, next.y, 0)
}

function advanceWaypoint() {
  if (!multiPointMode.value || !activeWaypoint.value) return
  if (waypointAdvancing.value) return
  waypointAdvancing.value = true
  setTimeout(() => {
    dispatchNextWaypoint()
    waypointAdvancing.value = false
  }, 200)
}

function onWaypointAdd({ x, y }) {
  if (!multiPointMode.value) return
  waypointQueue.value.push({ x, y })
  if (navigationActive.value && !activeWaypoint.value) {
    dispatchNextWaypoint()
  }
}

function onWaypointReached() {
  advanceWaypoint()
}

function clearWaypoints() {
  waypointQueue.value = []
  activeWaypoint.value = null
  waypointAdvancing.value = false
}

function onInitialPoseSet({ x, y, yaw }) {
  if (initialPoseChannelId && isConnected.value) {
    transport.sendInitialPose(initialPoseChannelId, x, y, yaw)
  }
  isSettingPose.value = false
}

function onStopMotion() {
  keyboardState.w = false
  keyboardState.a = false
  keyboardState.s = false
  keyboardState.d = false
  if (keyboardInterval) {
    clearInterval(keyboardInterval)
    keyboardInterval = null
  }
  if (cmdVelChannelId && isConnected.value) {
    transport.sendTwist(cmdVelChannelId, 0, 0)
  }
}

async function emergencyStop() {
  onStopMotion()
  isSettingPose.value = false
  clearWaypoints()
  try {
    await fetch(`${API_BASE}/simulation/velocity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ linearX: 0, angularZ: 0 })
    })
  } catch {}
  showToast('已触发急停，已下发零速度指令', 'warning')
}

function setKeyboardEnabled(enabled) {
  keyboardEnabled.value = Boolean(enabled)
  if (!keyboardEnabled.value) {
    onStopMotion()
  }
}

function updateKeyboardControl() {
  if (!cmdVelChannelId || !isConnected.value || !keyboardEnabled.value) return

  let linearX = 0
  let angularZ = 0

  if (keyboardState.w) linearX += controlConfig.value.max_linear_speed
  if (keyboardState.s) linearX -= controlConfig.value.max_linear_speed
  if (keyboardState.a) angularZ += controlConfig.value.max_angular_speed
  if (keyboardState.d) angularZ -= controlConfig.value.max_angular_speed

  transport.sendTwist(cmdVelChannelId, linearX, angularZ)
}

function handleKeyDown(e) {
  if (!keyboardEnabled.value || !isConnected.value) return
  if (e.ctrlKey || e.metaKey || e.altKey) return
  const tag = e.target?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return

  const key = e.key.toLowerCase()
  if (['w', 'a', 's', 'd'].includes(key)) {
    if (!keyboardState[key]) {
      keyboardState[key] = true
      if (!keyboardInterval) {
        updateKeyboardControl()
        keyboardInterval = setInterval(updateKeyboardControl, 1000 / controlConfig.value.command_rate_hz)
      }
    }
  }
}

function handleKeyUp(e) {
  const key = e.key.toLowerCase()
  if (['w', 'a', 's', 'd'].includes(key)) {
    if (!keyboardState[key]) return
    keyboardState[key] = false
    if (!keyboardState.w && !keyboardState.a && !keyboardState.s && !keyboardState.d) {
      onStopMotion()
    }
  }
}

watch(multiPointMode, (enabled) => {
  if (!enabled) clearWaypoints()
})

watch(connectionState, (current, previous) => {
  if (previous === 'connected' && current !== 'connected' && current !== 'connecting') {
    if (!intentionalDisconnect) {
      const robot = activeRobot.value
      pushRuntimeAlert({
        dedupeKey: `disconnect-${robot?.id || 'default'}`,
        robotId: robot?.id || 'runtime',
        robotName: robot?.name || '当前机器狗',
        level: 'critical',
        title: '机器狗通信连接中断',
        description: errorMessage.value || 'WebSocket 连接意外断开，实时遥测与运动控制已停止。',
        recommendation: '请检查机载网络、电源以及 Foxglove / rosbridge 桥接服务是否正常运行。',
        reading: '连接中断',
        threshold: '在线会话异常断开'
      })
    }
    clearConnectionState()
  }
})

watch(batteryPercentage, (current, previous) => {
  if (!isConnected.value || current < 0 || current >= 20) return
  if (previous < 0 || previous >= 20) {
    const robot = activeRobot.value
    pushRuntimeAlert({
      dedupeKey: `low-battery-${robot?.id || 'default'}`,
      robotId: robot?.id || 'runtime',
      robotName: robot?.name || '当前机器狗',
      level: 'warning',
      title: '机器狗电量偏低',
      description: `当前电量已降至 ${current}%（${batteryVoltage.value} V），请注意返航补能。`,
      recommendation: '建议尽快停止长距离巡检并引导机器狗返回充电区域。',
      reading: `${current}%`,
      threshold: '电量 < 20% 触发',
      cooldownMs: 180000
    })
  }
})

watch(() => navFeedback.value?.distance_remaining, (distance) => {
  if (!multiPointMode.value || !activeWaypoint.value) return
  if (typeof distance !== 'number' || !Number.isFinite(distance)) return
  if (distance <= FEEDBACK_REACHED_THRESHOLD) {
    advanceWaypoint()
  }
})

function initRosSession() {
  if (initialized) return
  initialized = true
  window.addEventListener('foxglove:channels', onChannelsReady)
  window.addEventListener('foxglove:channels_update', onChannelsReady)
  window.addEventListener('keydown', handleKeyDown)
  window.addEventListener('keyup', handleKeyUp)
  window.addEventListener('blur', onStopMotion)
  handleConnect()
}

function disposeRosSession() {
  if (!initialized) return
  initialized = false
  window.removeEventListener('foxglove:channels', onChannelsReady)
  window.removeEventListener('foxglove:channels_update', onChannelsReady)
  window.removeEventListener('keydown', handleKeyDown)
  window.removeEventListener('keyup', handleKeyUp)
  window.removeEventListener('blur', onStopMotion)
  handleDisconnect()
}

export function useRosSessionStore() {
  return {
    transport,
    layerOptions,
    activeOperation,
    mapsRevision,
    selectedScenePath,
    mappingActive,
    navigationActive,
    isSettingPose,
    multiPointMode,
    waypointQueue,
    activeWaypoint,
    waypointCount,
    topics,
    robotTopics,
    batteryPercentage,
    batteryVoltage,
    mapData,
    scanData,
    tfData,
    odomData,
    planData,
    cameraPrimary,
    cameraSecondary,
    navFeedback,
    imuData,
    mapLayers,
    connectionState,
    errorMessage,
    isConnected,
    modeText,
    mapSize,
    linearSpeed,
    statusText,
    keyboardEnabled,
    keyboardState,
    setKeyboardEnabled,
    connectRobot,
    handleConnect,
    handleDisconnect,
    switchRobot,
    onVelocityChange,
    sendGoalPose,
    onGoalSet,
    onWaypointAdd,
    onWaypointReached,
    clearWaypoints,
    onInitialPoseSet,
    onStopMotion,
    emergencyStop,
    initRosSession,
    disposeRosSession
  }
}
