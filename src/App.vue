<template>
  <div class="console-layout">
    <header class="console-header">
      <div class="brand">
        <div class="brand-mark"><UiIcon name="robot" :size="25" /></div>
        <div>
          <div class="brand-title">机器人控制台</div>
          <div class="brand-subtitle">ROS 2 控制与监控</div>
        </div>
      </div>

      <div class="header-context">
        <span class="environment-badge">ROS 2 · HUMBLE</span>
        <span class="header-divider"></span>
        <div class="header-mode">
          <span>当前模式</span>
          <strong>{{ modeText }}</strong>
        </div>
      </div>

      <button
        class="header-connection"
        :class="connectionState"
        :disabled="connectionState === 'connecting'"
        @click="isConnected ? handleDisconnect() : handleConnect()"
      >
        <span class="status-dot" :class="connectionState"></span>
        <span>{{ statusText }}</span>
        <UiIcon name="link" :size="16" />
      </button>
    </header>

    <main class="console-body">
      <aside class="left-panel panel-scroll">
        <ConnectionPanel
          :connectionState="connectionState"
          :errorMessage="errorMessage"
          :defaultUrl="DEFAULT_WS_URL"
          @connect="handleConnect"
          @disconnect="handleDisconnect"
        />

        <JoystickControl
          :connected="isConnected"
          @velocity-change="onVelocityChange"
          @stop="onStopMotion"
        />

        <section class="card shortcut-card">
          <div class="shortcut-title">
            <UiIcon name="keyboard" :size="17" />
            <span>键盘控制</span>
          </div>
          <div class="key-grid" aria-label="WASD 控制说明">
            <span></span><kbd>W</kbd><span></span>
            <kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>
          </div>
          <p>页面前台运行时生效，松开按键立即停止。</p>
        </section>
      </aside>

      <section class="center-panel">
        <div class="metrics-grid">
          <article class="metric-item">
            <div class="metric-icon"><UiIcon name="activity" :size="18" /></div>
            <div><span>运行状态</span><strong>{{ modeText }}</strong></div>
          </article>
          <article class="metric-item">
            <div class="metric-icon"><UiIcon name="link" :size="18" /></div>
            <div><span>可用话题</span><strong>{{ topics.length }} <small>个</small></strong></div>
          </article>
          <article class="metric-item">
            <div class="metric-icon"><UiIcon name="map" :size="18" /></div>
            <div><span>地图尺寸</span><strong>{{ mapSize }}</strong></div>
          </article>
          <article class="metric-item">
            <div class="metric-icon"><UiIcon name="move" :size="18" /></div>
            <div><span>底盘速度</span><strong>{{ linearSpeed }} <small>m/s</small></strong></div>
          </article>
        </div>

        <SlamMap
          ref="slamMapRef"
          :connected="isConnected"
          :mapData="mapData"
          :scanData="scanData"
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

        <div class="workspace-footer">
          <span><i class="legend-dot robot"></i>机器人位置</span>
          <span><i class="legend-dot scan"></i>激光扫描</span>
          <span><i class="legend-dot path"></i>规划路径</span>
          <span class="workspace-tip">滚轮缩放 · 拖动平移 · 双击设置目标</span>
        </div>
      </section>

      <aside class="right-panel panel-scroll">
        <BatteryStatus
          :percentage="batteryPercentage"
          :voltage="batteryVoltage"
          :connected="isConnected"
        />

        <TelemetryPanel
          v-if="isConnected"
          :odomData="odomData"
        />

        <section class="card operations-card">
          <div class="operations-heading">
            <div>
              <h2>任务控制</h2>
            </div>
            <span class="operation-state" :class="{ active: mappingActive || navigationActive }">
              {{ mappingActive ? '建图中' : navigationActive ? '导航中' : '待机' }}
            </span>
          </div>

          <div class="operation-tabs" role="tablist">
            <button
              :class="{ active: activeOperation === 'mapping' }"
              role="tab"
              @click="activeOperation = 'mapping'"
            >
              <UiIcon name="map" :size="16" />建图
              <i v-if="mappingActive"></i>
            </button>
            <button
              :class="{ active: activeOperation === 'navigation' }"
              role="tab"
              @click="activeOperation = 'navigation'"
            >
              <UiIcon name="route" :size="16" />导航
              <i v-if="navigationActive"></i>
            </button>
          </div>

          <MappingControl
            v-show="activeOperation === 'mapping'"
            :connected="isConnected"
            v-model:isMapping="mappingActive"
            @mappingStarted="onMappingStarted"
          />
          <NavigationControl
            v-show="activeOperation === 'navigation'"
            :connected="isConnected"
            v-model:isNavigating="navigationActive"
            v-model:isSettingPose="isSettingPose"
            v-model:multiPointMode="multiPointMode"
            :waypointCount="waypointQueue.length + (activeWaypoint ? 1 : 0)"
            @navigationStarted="activeOperation = 'navigation'"
            @clear-waypoints="clearWaypoints"
          />
        </section>

        <section class="card layer-card">
          <div class="card-header">
            <span><UiIcon name="layers" :size="17" />地图图层</span>
            <small>{{ Object.values(mapLayers).filter(Boolean).length }}/5</small>
          </div>
          <div class="card-body">
            <div class="layer-controls">
              <label v-for="layer in layerOptions" :key="layer.key" class="layer-chip" :class="layer.key">
                <input type="checkbox" v-model="mapLayers[layer.key]">
                <span class="layer-check"></span>
                <span>{{ layer.label }}</span>
              </label>
            </div>
          </div>
        </section>
      </aside>
    </main>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useFoxglove } from './composables/useFoxglove.js'
import { API_BASE, DEFAULT_WS_URL } from './config.js'
import JoystickControl from './components/JoystickControl.vue'
import BatteryStatus from './components/BatteryStatus.vue'
import SlamMap from './components/SlamMap.vue'
import ConnectionPanel from './components/ConnectionPanel.vue'
import TelemetryPanel from './components/TelemetryPanel.vue'
import MappingControl from './components/MappingControl.vue'
import NavigationControl from './components/NavigationControl.vue'
import UiIcon from './components/UiIcon.vue'

const foxglove = useFoxglove()
const slamMapRef = ref(null)
const activeOperation = ref('mapping')
const layerOptions = [
  { key: 'map', label: '地图' },
  { key: 'scan', label: '激光' },
  { key: 'robot', label: '机器人' },
  { key: 'path', label: '路径' },
  { key: 'goal', label: '目标' }
]

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
  imu: '/imu'
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

// 导航反馈数据
const navFeedback = ref(null)
const imuData = ref(null)
const runtimeTopics = ref({ ...TOPIC_DEFAULTS })

// ---- 图层控制 ----
const mapLayers = ref({
  map: true,
  scan: true,
  robot: true,
  path: true,
  goal: true
})

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

// ---- 计算属性 ----
const connectionState = computed(() => foxglove.connectionState.value)
const errorMessage = computed(() => foxglove.errorMessage.value)
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

// ---- 事件处理 ----
function handleConnect(url = DEFAULT_WS_URL) {
  if (connectionState.value === 'connected' || connectionState.value === 'connecting') return
  foxglove.connect(url)
}

function onMappingStarted() {
  activeOperation.value = 'mapping'
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
  navFeedback.value = null // 清除导航反馈数据
  imuData.value = null
  waypointQueue.value = []
  activeWaypoint.value = null
  topics.value = []
}

function handleDisconnect() {
  onStopMotion()
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
    foxglove.sendTwist(cmdVelChannelId, 0, 0)
  }
}

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
      onStopMotion()
    }
  }
}

onMounted(() => {
  loadRuntimeConfig()
  handleConnect()
  window.addEventListener('keydown', handleKeyDown)
  window.addEventListener('keyup', handleKeyUp)
  window.addEventListener('blur', onStopMotion)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown)
  window.removeEventListener('keyup', handleKeyUp)
  window.removeEventListener('blur', onStopMotion)
  onStopMotion()
})

</script>
