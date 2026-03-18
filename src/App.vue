<template>
  <div class="console-layout">
    <!-- 顶部导航栏 -->
    <header class="console-header">
      <h1>机器人中控台</h1>
      <div class="status-indicator">
        <span class="status-dot" :class="connectionState"></span>
        <span>{{ statusText }}</span>
      </div>
    </header>

    <!-- 主体三栏布局 -->
    <main class="console-body">
      <!-- 左栏: 摇杆 -->
      <section class="left-panel">
        <JoystickControl
          :connected="isConnected"
          @velocity-change="onVelocityChange"
        />
      </section>

      <!-- 中栏: 地图 -->
      <section class="center-panel">
        <SlamMap
          ref="slamMapRef"
          :connected="isConnected"
          :mapData="mapData"
          :scanData="scanData"
          :lidarData="lidarData"
          :tfData="tfData"
          :planData="planData"
          :layers="mapLayers"
          :isMapping="mappingActive"
          :isNavigating="navigationActive"
          v-model:isSettingPose="isSettingPose"
          :multiPointMode="multiPointMode"
          :waypoints="waypointQueue"
          :activeWaypoint="activeWaypoint"
          :navFeedback="navFeedback"
          @goal-set="onGoalSet"
          @waypoint-add="onWaypointAdd"
          @waypoint-reached="onWaypointReached"
          @initial-pose-set="onInitialPoseSet"
        />
      </section>

      <!-- 右栏: 连接 + 电量 + 话题 -->
      <section class="right-panel">
        <ConnectionPanel
          :connectionState="connectionState"
          :errorMessage="errorMessage"
          @connect="handleConnect"
          @disconnect="handleDisconnect"
        />

        <BatteryStatus
          :percentage="batteryPercentage"
          :voltage="batteryVoltage"
          :connected="isConnected"
        />

        <TelemetryPanel
          v-if="isConnected"
          :odomData="odomData"
        />

        <MappingControl 
          :connected="isConnected" 
          v-model:isMapping="mappingActive"
          @mappingStarted="onMappingStarted"
        />

        <NavigationControl
          :connected="isConnected"
          v-model:isNavigating="navigationActive"
          v-model:isSettingPose="isSettingPose"
          v-model:multiPointMode="multiPointMode"
          :waypointCount="waypointQueue.length + (activeWaypoint ? 1 : 0)"
          @clear-waypoints="clearWaypoints"
        />

        <div class="card" v-if="isConnected">
          <div class="card-header">
            图层控制
          </div>
          <div class="card-body">
            <div class="layer-controls">
              <div class="layer-item">
                <span>显示地图</span>
                <label class="switch">
                  <input type="checkbox" v-model="mapLayers.map">
                  <span class="slider"></span>
                </label>
              </div>
              <div class="layer-item">
                <span>显示激光</span>
                <label class="switch">
                  <input type="checkbox" v-model="mapLayers.scan">
                  <span class="slider"></span>
                </label>
              </div>
              <div class="layer-item">
                <span>显示3D点云</span>
                <label class="switch">
                  <input type="checkbox" v-model="mapLayers.lidar">
                  <span class="slider"></span>
                </label>
              </div>
              <div class="layer-item">
                <span>显示机器人</span>
                <label class="switch">
                  <input type="checkbox" v-model="mapLayers.robot">
                  <span class="slider"></span>
                </label>
              </div>
              <div class="layer-item">
                <span>显示路径</span>
                <label class="switch">
                  <input type="checkbox" v-model="mapLayers.path">
                  <span class="slider"></span>
                </label>
              </div>
              <div class="layer-item">
                <span>显示目标点</span>
                <label class="switch">
                  <input type="checkbox" v-model="mapLayers.goal">
                  <span class="slider"></span>
                </label>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useFoxglove } from './composables/useFoxglove.js'
import JoystickControl from './components/JoystickControl.vue'
import BatteryStatus from './components/BatteryStatus.vue'
import SlamMap from './components/SlamMap.vue'
import ConnectionPanel from './components/ConnectionPanel.vue'
import TelemetryPanel from './components/TelemetryPanel.vue'
import MappingControl from './components/MappingControl.vue'
import NavigationControl from './components/NavigationControl.vue'

const foxglove = useFoxglove()
const slamMapRef = ref(null)
const BACKEND_PORT = import.meta.env.VITE_BACKEND_PORT || '3000'
const API_BASE = `http://${window.location.hostname}:${BACKEND_PORT}/api`
const DEFAULT_WS_URL = `ws://${window.location.hostname}:8765`

const TOPIC_DEFAULTS = {
  cmd_vel: '/cmd_vel',
  battery: '/battery',
  map: '/map',
  scan: '/scan',
  tf: '/tf',
  odom: '/odom',
  plan: '/plan',
  goal_pose: '/goal_pose',
  initial_pose: '/initialpose',
  navigate_feedback: '/navigate_to_pose/_action/feedback',
  imu: '/imu',
  lidar: '/livox/lidar'
}

// ---- 建图状态 (跨组件共享) ----
const mappingActive = ref(false)

// ---- 导航状态 ----
const navigationActive = ref(false)
const isSettingPose = ref(false)
const multiPointMode = ref(false)
const waypointQueue = ref([])
const activeWaypoint = ref(null)
const waypointAdvancing = ref(false)
const FEEDBACK_REACHED_THRESHOLD = 0.10

// ---- 状态 ----
const topics = ref([])
const batteryPercentage = ref(-1)
const batteryVoltage = ref(0)
const mapData = ref(null)
const scanData = ref(null)
const tfData = ref(null)
const odomData = ref(null)
const planData = ref(null)
const lidarData = ref(null)

// 导航反馈数据
const navFeedback = ref(null)
const imuData = ref(null)
const runtimeTopics = ref({ ...TOPIC_DEFAULTS })

// ---- 图层控制 ----
const mapLayers = ref({
  map: true,
  scan: true,
  lidar: true,
  robot: true,
  path: true,
  goal: true
})
const sensorAutoLocked = ref(false)

// ================= Foxglove 频道 ID ==================
let cmdVelChannelId = null
let goalPoseChannelId = null
let initialPoseChannelId = null

// 订阅 ID
let batterySubId = null
let mapSubId = null
let scanSubId = null
let tfSubId = null
let odomSubId = null
let planSubId = null
let feedbackSubId = null // 导航反馈订阅 ID
let imuSubId = null
let lidarSubId = null

// ---- 计算属性 ----
const connectionState = computed(() => foxglove.connectionState.value)
const errorMessage = computed(() => foxglove.errorMessage.value)
const isConnected = computed(() => connectionState.value === 'connected')

const statusText = computed(() => {
  switch (connectionState.value) {
    case 'connected': return '已连接'
    case 'connecting': return '连接中...'
    case 'error': return '连接错误'
    default: return '未连接'
  }
})

// ---- 事件处理 ----
function handleConnect(url = DEFAULT_WS_URL) {
  if (connectionState.value === 'connected' || connectionState.value === 'connecting') return
  foxglove.connect(url)
}

function onMappingStarted() {
  // 建图开始时自动重置地图视图
  slamMapRef.value?.resetView()
}

// 清空所有订阅数据
function clearAllData() {
  batteryPercentage.value = -1
  batteryVoltage.value = 0
  mapData.value = null
  scanData.value = null
  tfData.value = null
  odomData.value = null
  planData.value = null
  lidarData.value = null
  navFeedback.value = null // 清除导航反馈数据
  imuData.value = null
  waypointQueue.value = []
  activeWaypoint.value = null
  topics.value = []
}

function handleDisconnect() {
  foxglove.disconnect()
  cmdVelChannelId = null
  goalPoseChannelId = null
  initialPoseChannelId = null
  batterySubId = null
  mapSubId = null
  scanSubId = null
  tfSubId = null
  odomSubId = null
  planSubId = null
  feedbackSubId = null // 清除订阅 ID
  imuSubId = null
  lidarSubId = null
  clearAllData()
}

async function loadRuntimeConfig() {
  try {
    const res = await fetch(`${API_BASE}/runtime_config`)
    const data = await res.json()
    runtimeTopics.value = { ...TOPIC_DEFAULTS, ...(data.topics || {}) }
  } catch (err) {
    console.warn('加载运行时配置失败，使用默认话题:', err)
    runtimeTopics.value = { ...TOPIC_DEFAULTS }
  }
}

/**
 * 当服务器广播可用频道后，自动:
 * 1. Advertise /cmd_vel (用于发布摇杆指令)
 * 2. Subscribe /battery_state (电量)
 * 3. Subscribe /map (SLAM 地图)
 */
function onChannelsReady(event) {
  const channels = event.detail
  topics.value = channels

  // 1. 声明 /cmd_vel 发布频道
  if (!cmdVelChannelId) {
    cmdVelChannelId = foxglove.clientAdvertise(runtimeTopics.value.cmd_vel, 'geometry_msgs/Twist', 'json')
  }

  // 2. 订阅 /battery (电压值，单位可能是 0.1V)
  if (!batterySubId) {
    batterySubId = foxglove.subscribe(runtimeTopics.value.battery, (data) => {
      // std_msgs/msg/UInt16 → data 字段
      if (data.data !== undefined) {
        batteryVoltage.value = (data.data / 10).toFixed(1)
        
        // 自动推算百分比 (根据常见的 2S 或 3S 锂电池范围)
        const raw = data.data
        if (raw > 90) { // 可能是 3S (9.6V - 12.6V)
          batteryPercentage.value = Math.max(0, Math.min(100, Math.round((raw - 96) / (126 - 96) * 100)))
        } else { // 可能是 2S (6.4V - 8.4V)
          batteryPercentage.value = Math.max(0, Math.min(100, Math.round((raw - 64) / (84 - 64) * 100)))
        }
      }
    })
  }

  // 3. 订阅 /map
  if (!mapSubId) {
    mapSubId = foxglove.subscribe(runtimeTopics.value.map, (data) => {
      mapData.value = data
    })
  }

  // 4. 订阅 /scan
  if (!scanSubId) {
    scanSubId = foxglove.subscribe(runtimeTopics.value.scan, (data) => {
      scanData.value = data
    })
  }

  // 5. 订阅 /tf
  if (!tfSubId) {
    tfSubId = foxglove.subscribe(runtimeTopics.value.tf, (data) => {
      tfData.value = data
    })
  }

  // 6. 订阅 /odom
  if (!odomSubId) {
    odomSubId = foxglove.subscribe(runtimeTopics.value.odom, (data) => {
      odomData.value = data
    })
  }

  // 7. 声明 /goal_pose 发布频道
  if (!goalPoseChannelId) {
    goalPoseChannelId = foxglove.clientAdvertise(runtimeTopics.value.goal_pose, 'geometry_msgs/PoseStamped', 'json')
  }

  // 8. 订阅 /plan (导航路径)
  if (!planSubId) {
    planSubId = foxglove.subscribe(runtimeTopics.value.plan, (data) => {
      planData.value = data
    })
  }

  // 9. 声明 /initialpose 发布频道
  if (!initialPoseChannelId) {
    initialPoseChannelId = foxglove.clientAdvertise(runtimeTopics.value.initial_pose, 'geometry_msgs/PoseWithCovarianceStamped', 'json')
  }

  // 10. 订阅导航反馈 (距离与预计时间)
  if (!feedbackSubId) {
    feedbackSubId = foxglove.subscribe(runtimeTopics.value.navigate_feedback, (data) => {
      navFeedback.value = normalizeNavFeedback(data)
    })
  }

  // 11. 订阅 IMU（可配置，当前仅缓存数据）
  if (!imuSubId) {
    imuSubId = foxglove.subscribe(runtimeTopics.value.imu, (data) => {
      imuData.value = data
    })
  }

  // 12. 订阅 点云 (Livox)
  if (!lidarSubId) {
    lidarSubId = foxglove.subscribe(runtimeTopics.value.lidar, (data) => {
      lidarData.value = data
    })
  }
}

function normalizeNavFeedback(data) {
  if (!data || typeof data !== 'object') return null

  // 已解析扁平结构
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

  // action 标准结构: { feedback: { distance_remaining, estimated_time_remaining } }
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

// 监听频道就绪事件
window.addEventListener('foxglove:channels', onChannelsReady)
window.addEventListener('foxglove:channels_update', onChannelsReady)
onUnmounted(() => {
  window.removeEventListener('foxglove:channels', onChannelsReady)
  window.removeEventListener('foxglove:channels_update', onChannelsReady)
  handleDisconnect()
})

// ---- 摇杆速度变化 → 发送 Twist ----
function onVelocityChange({ linearX, angularZ }) {
  if (cmdVelChannelId && isConnected.value) {
    foxglove.sendTwist(cmdVelChannelId, linearX, angularZ)
  }
}

// ---- 导航目标点设定 ----
function onGoalSet({ x, y }) {
  if (multiPointMode.value) return
  if (goalPoseChannelId && isConnected.value) {
    foxglove.sendGoalPose(goalPoseChannelId, x, y, 0)
  }
}

function sendGoalPose(x, y) {
  if (goalPoseChannelId && isConnected.value) {
    foxglove.sendGoalPose(goalPoseChannelId, x, y, 0)
  }
}

function dispatchNextWaypoint() {
  if (!multiPointMode.value) return
  if (waypointQueue.value.length === 0) {
    activeWaypoint.value = null
    return
  }
  const next = waypointQueue.value.shift()
  activeWaypoint.value = next
  sendGoalPose(next.x, next.y)
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
  if (!activeWaypoint.value) {
    dispatchNextWaypoint()
  }
}

function clearWaypoints() {
  waypointQueue.value = []
  activeWaypoint.value = null
  waypointAdvancing.value = false
}

function onWaypointReached() {
  advanceWaypoint()
}

// ---- 初始位置设定 ----
function onInitialPoseSet({ x, y, yaw }) {
  if (initialPoseChannelId && isConnected.value) {
    foxglove.sendInitialPose(initialPoseChannelId, x, y, yaw)
  }
  // 自动退出初始位置模式
  isSettingPose.value = false
}

watch(multiPointMode, (enabled) => {
  if (!enabled) clearWaypoints()
})

// 自动选择唯一可用传感器：只有 scan 或只有 lidar 时，自动显示对应图层
watch([scanData, lidarData], ([scan, lidar]) => {
  if (sensorAutoLocked.value) return
  if (scan && !lidar) {
    mapLayers.value.scan = true
    mapLayers.value.lidar = false
    sensorAutoLocked.value = true
  } else if (lidar && !scan) {
    mapLayers.value.lidar = true
    mapLayers.value.scan = false
    sensorAutoLocked.value = true
  }
})

watch(navigationActive, (running) => {
  if (running) {
    slamMapRef.value?.resetView()
  } else {
    clearWaypoints()
  }
})

watch(() => navFeedback.value?.distance_remaining, (distance) => {
  if (!multiPointMode.value || !activeWaypoint.value) return
  if (typeof distance !== 'number' || !Number.isFinite(distance)) return
  if (distance <= FEEDBACK_REACHED_THRESHOLD) {
    advanceWaypoint()
  }
})

// ======================== WASD 键盘控制 ========================
const keyboardState = {
  w: false,
  a: false,
  s: false,
  d: false
}
let keyboardInterval = null

// 线速度上限与角速度上限 (可根据情况修改)
const MAX_LINEAR_VEL = 0.5
const MAX_ANGULAR_VEL = 1.0

function updateKeyboardControl() {
  if (!cmdVelChannelId || !isConnected.value) return

  let linearX = 0
  let angularZ = 0

  if (keyboardState.w) linearX += MAX_LINEAR_VEL
  if (keyboardState.s) linearX -= MAX_LINEAR_VEL
  if (keyboardState.a) angularZ += MAX_ANGULAR_VEL
  if (keyboardState.d) angularZ -= MAX_ANGULAR_VEL

  foxglove.sendTwist(cmdVelChannelId, linearX, angularZ)
}

function handleKeyDown(e) {
  // 防止在输入框内打字时触发移动
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return

  const key = e.key.toLowerCase()
  if (['w', 'a', 's', 'd'].includes(key)) {
    if (!keyboardState[key]) {
      keyboardState[key] = true
      
      // 按第一下键时，开启 20Hz 的控制循环
      if (!keyboardInterval) {
        updateKeyboardControl() // 立即发一次
        keyboardInterval = setInterval(updateKeyboardControl, 50)
      }
    }
  }
}

function handleKeyUp(e) {
  const key = e.key.toLowerCase()
  if (['w', 'a', 's', 'd'].includes(key)) {
    keyboardState[key] = false
    
    // 如果所有键都松开了，停止循环并发送一次 0 速度
    if (!keyboardState.w && !keyboardState.a && !keyboardState.s && !keyboardState.d) {
      if (keyboardInterval) {
        clearInterval(keyboardInterval)
        keyboardInterval = null
      }
      if (cmdVelChannelId && isConnected.value) {
        foxglove.sendTwist(cmdVelChannelId, 0, 0)
      }
    }
  }
}

onMounted(() => {
  loadRuntimeConfig()
  handleConnect()
  window.addEventListener('keydown', handleKeyDown)
  window.addEventListener('keyup', handleKeyUp)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown)
  window.removeEventListener('keyup', handleKeyUp)
  if (keyboardInterval) clearInterval(keyboardInterval)
})

</script>
