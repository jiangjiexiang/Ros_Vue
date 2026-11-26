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

const layerOptions = computed(() => [
  { key: 'map', label: '地图' },
  { key: 'scan', label: '激光' },
  { key: 'robot', label: '机器狗' },
  { key: 'path', label: '路径' },
  { key: 'goal', label: '目标' }
].filter((layer) => layer.key !== 'scan' || activeRobot.value?.lidarType !== '3d'))

const activeOperation = ref('maps')
const mapsRevision = ref(0)
const selectedScenePath = ref('')

const mappingActive = ref(false)
const localizationActive = ref(false)
const navigationActive = ref(false)
const isSettingPose = ref(false)
const multiPointMode = ref(false)
const waypointQueue = ref([])
const activeWaypoint = ref(null)
const waypointAdvancing = ref(false)
let waypointDispatchedAt = 0
let waypointGoalSeenActive = false
let waypointInitialStatusGoalId = ''
let waypointRetryCount = 0
const FEEDBACK_REACHED_THRESHOLD = 0.22
const POSE_REACHED_THRESHOLD = 0.24
const SETTLED_REACHED_THRESHOLD = 0.40

const topics = ref([])
const batteryPercentage = ref(-1)
const batteryVoltage = ref(0)
const mapData = ref(null)
const scanData = ref(null)
const tfData = ref(null)
const odomData = ref(null)
const planData = ref(null)
const cameraPrimary = ref(null)
const navFeedback = ref(null)
const navStatus = ref(null)
const imuData = ref(null)
const pointCloudData = ref(null)
const registeredCloudData = ref(null)
const fastlioPathData = ref(null)
const localizationData = ref(null)
const localizationPathData = ref(null)
const globalMapData = ref(null)

const mapLayers = ref({
  map: true,
  scan: activeRobot.value?.lidarType !== '3d',
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
let manualCmdVelChannelId = null
let goalPoseChannelId = null
let initialPoseChannelId = null

let batterySubId = null
let mapSubId = null
let scanSubId = null
let tfSubId = null
let odomSubId = null
let planSubId = null
let feedbackSubId = null
let statusSubId = null
let imuSubId = null
let cameraPrimarySubId = null
let pointCloudSubId = null
let registeredCloudSubId = null
let fastlioPathSubId = null
let localizationSubId = null
let localizationPathSubId = null
let globalMapSubId = null

let keyboardInterval = null
let initialized = false
let intentionalDisconnect = false

watch(() => activeRobot.value?.lidarType, (lidarType) => {
  mapLayers.value.scan = lidarType !== '3d'
  if (lidarType === '3d') {
    scanData.value = null
    if (scanSubId) {
      transport.unsubscribe(scanSubId)
      scanSubId = null
    }
  }
}, { immediate: true })

const robotTopics = computed(() => {
  const namespace = activeRobot.value?.namespace?.replace(/^\/+|\/+$/g, '')
  const merged = { ...runtimeTopics.value }
  return Object.fromEntries(Object.entries(merged).map(([key, topic]) => {
    if (!namespace || !topic) return [key, topic]
    return [key, `/${namespace}/${topic.replace(/^\/+/, '')}`]
  }))
})

const connectionState = computed(() => transport.connectionState.value)
const errorMessage = computed(() => transport.errorMessage.value)
const isConnected = computed(() => connectionState.value === 'connected')
const hasRobotTopics = computed(() => {
  if (!isConnected.value) return false
  const ns = activeRobot.value?.namespace?.replace(/^\/+|\/+$/g, '')
  for (const ch of transport.availableChannels.values()) {
    if (ns) {
      if (ch.topic?.startsWith(`/${ns}/`)) return true
    } else if (
      ch.topic === robotTopics.value.odom ||
      ch.topic === robotTopics.value.pointcloud ||
      ch.topic === robotTopics.value.camera_primary
    ) {
      return true
    }
  }
  return false
})

const modeText = computed(() => {
  if (!isConnected.value) return '离线'
  if (isSettingPose.value) return '初始定位'
  if (localizationActive.value) return '地图定位'
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
  navFeedback.value = null
  navStatus.value = null
  imuData.value = null
  pointCloudData.value = null
  registeredCloudData.value = null
  fastlioPathData.value = null
  localizationData.value = null
  localizationPathData.value = null
  globalMapData.value = null
  waypointQueue.value = []
  activeWaypoint.value = null
  topics.value = []
}

function clearConnectionState() {
  cmdVelChannelId = null
  manualCmdVelChannelId = null
  goalPoseChannelId = null
  initialPoseChannelId = null
  batterySubId = null
  mapSubId = null
  scanSubId = null
  tfSubId = null
  odomSubId = null
  planSubId = null
  feedbackSubId = null
  statusSubId = null
  imuSubId = null
  cameraPrimarySubId = null
  pointCloudSubId = null
  registeredCloudSubId = null
  fastlioPathSubId = null
  localizationSubId = null
  localizationPathSubId = null
  globalMapSubId = null
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

function normalizeNavStatus(data) {
  if (!data || typeof data !== 'object') return null
  if (data.latest && typeof data.latest === 'object') {
    return {
      goal_id: String(data.latest.goal_id || ''),
      status: Number(data.latest.status)
    }
  }
  const list = Array.isArray(data.status_list) ? data.status_list : []
  if (list.length === 0) return null
  const last = list[list.length - 1]
  const rawUuid = last?.goal_info?.goal_id?.uuid
  let goalId = ''
  if (typeof last?.goal_id === 'string') {
    goalId = last.goal_id
  } else if (Array.isArray(rawUuid) || rawUuid instanceof Uint8Array) {
    goalId = Array.from(rawUuid).map((b) => Number(b).toString(16).padStart(2, '0')).join('')
  }
  return {
    goal_id: goalId,
    status: Number(last?.status)
  }
}

function onChannelsReady(event) {
  const channels = event.detail
  topics.value = channels

  if (!cmdVelChannelId) {
    cmdVelChannelId = transport.clientAdvertise(robotTopics.value.cmd_vel, 'geometry_msgs/Twist', 'json')
  }

  if (!manualCmdVelChannelId) {
    manualCmdVelChannelId = transport.clientAdvertise(robotTopics.value.manual_cmd_vel, 'geometry_msgs/Twist', 'json')
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

  if (!scanSubId && activeRobot.value?.lidarType !== '3d') {
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

  if (!statusSubId && robotTopics.value.navigate_status) {
    statusSubId = transport.subscribe(robotTopics.value.navigate_status, (data) => {
      navStatus.value = normalizeNavStatus(data)
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

  if (!pointCloudSubId && robotTopics.value.pointcloud) {
    pointCloudSubId = transport.subscribe(robotTopics.value.pointcloud, (data) => {
      pointCloudData.value = data
    })
  }

  if (!registeredCloudSubId && robotTopics.value.registered_cloud) {
    registeredCloudSubId = transport.subscribe(robotTopics.value.registered_cloud, (data) => {
      registeredCloudData.value = data
    })
  }

  if (!fastlioPathSubId && robotTopics.value.fastlio_path) {
    fastlioPathSubId = transport.subscribe(robotTopics.value.fastlio_path, (data) => {
      fastlioPathData.value = data
    })
  }

  if (!localizationSubId && robotTopics.value.localization) {
    localizationSubId = transport.subscribe(robotTopics.value.localization, (data) => {
      localizationData.value = data
    })
  }

  if (!localizationPathSubId && robotTopics.value.localization_path) {
    localizationPathSubId = transport.subscribe(robotTopics.value.localization_path, (data) => {
      localizationPathData.value = data
    })
  }

  if (!globalMapSubId && robotTopics.value.global_map) {
    globalMapSubId = transport.subscribe(robotTopics.value.global_map, (data) => {
      globalMapData.value = data
    })
  }
}

function publishVelocity(linearX, angularZ) {
  if (!isConnected.value) return
  if (cmdVelChannelId) transport.sendTwist(cmdVelChannelId, linearX, angularZ)
  if (manualCmdVelChannelId) transport.sendTwist(manualCmdVelChannelId, linearX, angularZ)
}

function onVelocityChange({ linearX, angularZ }) {
  publishVelocity(linearX, angularZ)
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
  if (!multiPointMode.value || !(navigationActive.value || localizationActive.value)) return
  if (waypointQueue.value.length === 0) {
    activeWaypoint.value = null
    waypointGoalSeenActive = false
    waypointInitialStatusGoalId = ''
    waypointRetryCount = 0
    return
  }
  const next = waypointQueue.value.shift()
  activeWaypoint.value = next
  waypointDispatchedAt = Date.now()
  waypointGoalSeenActive = false
  waypointInitialStatusGoalId = navStatus.value?.goal_id || ''
  waypointRetryCount = 0
  navFeedback.value = null
  sendGoalPose(next.x, next.y, 0)
}

function advanceWaypoint() {
  if (!multiPointMode.value || !activeWaypoint.value) return
  if (waypointAdvancing.value) return
  if (Date.now() - waypointDispatchedAt < 900) return
  waypointAdvancing.value = true
  setTimeout(() => {
    dispatchNextWaypoint()
    waypointAdvancing.value = false
  }, 400)
}

function onWaypointAdd({ x, y }) {
  if (!multiPointMode.value) return
  waypointQueue.value.push({ x, y })
  if ((navigationActive.value || localizationActive.value) && !activeWaypoint.value) {
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
  waypointGoalSeenActive = false
  waypointInitialStatusGoalId = ''
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
  publishVelocity(0, 0)
}

async function emergencyStop() {
  onStopMotion()
  isSettingPose.value = false
  clearWaypoints()
  const scene = activeRobot.value?.simulationScene
  const query = scene ? `?scene=${encodeURIComponent(scene)}` : ''
  try {
    await fetch(`${API_BASE}/simulation/velocity${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ linearX: 0, angularZ: 0 })
    })
  } catch {}
  showToast('已触发急停，已下发零速度指令', 'warning')
}

function isKeyboardDriving() {
  return keyboardState.w || keyboardState.a || keyboardState.s || keyboardState.d || keyboardInterval !== null
}

function stopKeyboardMotion() {
  if (!isKeyboardDriving()) return
  onStopMotion()
}

function setKeyboardEnabled(enabled) {
  keyboardEnabled.value = Boolean(enabled)
  if (!keyboardEnabled.value) {
    stopKeyboardMotion()
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

  publishVelocity(linearX, angularZ)
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

watch([navigationActive, localizationActive], ([nav, loc]) => {
  if ((nav || loc) && multiPointMode.value && !activeWaypoint.value && waypointQueue.value.length > 0) {
    dispatchNextWaypoint()
  }
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
  if (typeof distance !== 'number' || !Number.isFinite(distance) || distance <= 0.001) return
  if (navStatus.value?.status === 2) return
  if (distance <= FEEDBACK_REACHED_THRESHOLD) {
    advanceWaypoint()
  }
})

watch(navStatus, (st) => {
  if (!multiPointMode.value || !(navigationActive.value || localizationActive.value) || !activeWaypoint.value) return
  if (!st || !Number.isFinite(st.status)) return
  const isNewGoal = Boolean(st.goal_id) && st.goal_id !== waypointInitialStatusGoalId
  if ((st.status === 1 || st.status === 2) && (isNewGoal || Date.now() - waypointDispatchedAt >= 200)) {
    waypointGoalSeenActive = true
    return
  }
  if (!waypointGoalSeenActive && !isNewGoal) return
  const elapsed = Date.now() - waypointDispatchedAt
  if (st.status === 4) {
    // SUCCEEDED: check if robot is actually near activeWaypoint (guard against premature preemption success)
    const pos = localizationData.value?.pose?.pose?.position || odomData.value?.pose?.pose?.position
    const dist = pos ? Math.hypot(pos.x - activeWaypoint.value.x, pos.y - activeWaypoint.value.y) : 0
    if (dist > 0.55 && waypointRetryCount < 2) {
      waypointRetryCount += 1
      waypointDispatchedAt = Date.now()
      waypointGoalSeenActive = false
      waypointInitialStatusGoalId = st.goal_id || ''
      setTimeout(() => {
        if (multiPointMode.value && activeWaypoint.value) {
          sendGoalPose(activeWaypoint.value.x, activeWaypoint.value.y, 0)
        }
      }, 300)
      return
    }
    if (elapsed >= 400) {
      advanceWaypoint()
    }
  } else if (st.status === 6 && elapsed >= 1000) {
    // ABORTED
    showToast('当前航点路径受阻，已自动切换至下一航点', 'warning')
    advanceWaypoint()
  }
})

watch([localizationData, odomData], () => {
  if (!multiPointMode.value || !(navigationActive.value || localizationActive.value) || !activeWaypoint.value) return
  if (Date.now() - waypointDispatchedAt < 1500) return
  // Wait for Nav2 to finish active execution so we never preempt mid-arrival
  if (navStatus.value?.status === 1 || navStatus.value?.status === 2) return
  const pos = localizationData.value?.pose?.pose?.position || odomData.value?.pose?.pose?.position
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return
  const dist = Math.hypot(pos.x - activeWaypoint.value.x, pos.y - activeWaypoint.value.y)
  const spd = Math.abs(odomData.value?.twist?.twist?.linear?.x || 0)
  if (dist <= POSE_REACHED_THRESHOLD || (dist <= SETTLED_REACHED_THRESHOLD && spd < 0.05)) {
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
  window.addEventListener('blur', stopKeyboardMotion)
  handleConnect()
}

function disposeRosSession() {
  if (!initialized) return
  initialized = false
  window.removeEventListener('foxglove:channels', onChannelsReady)
  window.removeEventListener('foxglove:channels_update', onChannelsReady)
  window.removeEventListener('keydown', handleKeyDown)
  window.removeEventListener('keyup', handleKeyUp)
  window.removeEventListener('blur', stopKeyboardMotion)
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
    localizationActive,
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
    navFeedback,
    navStatus,
    imuData,
    pointCloudData,
    registeredCloudData,
    fastlioPathData,
    localizationData,
    localizationPathData,
    globalMapData,
    mapLayers,
    connectionState,
    errorMessage,
    isConnected,
    hasRobotTopics,
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
