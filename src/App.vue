<template>
  <AppShell
    :robot-name="activeRobot.name"
    :mode-text="modeText"
    :connection-state="connectionState"
    :status-text="statusText"
  >
    <section v-if="legacyView === 'inspection'" class="inspection-page">
      <InspectionWorkspace
        :robots="robots"
        :robotConfig="activeRobot"
        :activeRobotId="activeRobotId"
        :connectionState="connectionState"
        :errorMessage="errorMessage"
        :connected="isConnected"
        :controlConfig="controlConfig"
        :mapData="mapData"
        :scanData="scanData"
        :tfData="tfData"
        :planData="planData"
        :odomData="odomData"
        :navFeedback="navFeedback"
        :batteryPercentage="batteryPercentage"
        :batteryVoltage="batteryVoltage"
        :mapLayers="mapLayers"
        :layerOptions="layerOptions"
        :cameraPrimary="cameraPrimary"
        :cameraPrimaryTopic="robotTopics.camera_primary"
        :mapsRevision="mapsRevision"
        :waypoints="waypointQueue"
        :activeWaypoint="activeWaypoint"
        :waypointCount="waypointQueue.length + (activeWaypoint ? 1 : 0)"
        v-model:isMapping="mappingActive"
        v-model:isNavigating="navigationActive"
        v-model:isSettingPose="isSettingPose"
        v-model:selectedMap="selectedScenePath"
        v-model:multiPointMode="multiPointMode"
        @connect="connectRobot"
        @velocity-change="onVelocityChange"
        @stop-motion="onStopMotion"
        @goal-set="onGoalSet"
        @waypoint-add="onWaypointAdd"
        @waypoint-reached="onWaypointReached"
        @initial-pose-set="onInitialPoseSet"
        @clear-waypoints="clearWaypoints"
        @save-mission="saveWorkspaceMission"
        @mapping-started="onMappingStarted"
      />
    </section>

    <main v-else-if="legacyView === 'monitor'" class="console-body">
      <aside class="left-panel panel-scroll">
        <ConnectionPanel
          :robots="robots"
          :activeRobotId="activeRobotId"
          :connectionState="connectionState"
          :errorMessage="errorMessage"
          @connect="connectRobot"
        />

        <JoystickControl
          :connected="isConnected"
          :maxLinearSpeed="controlConfig.max_linear_speed"
          :maxAngularSpeed="controlConfig.max_angular_speed"
          :commandRateHz="controlConfig.command_rate_hz"
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
          <span><i class="legend-dot robot"></i>机器狗位置</span>
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

    <main v-else-if="legacyView === 'maps'" class="task-page">
      <nav class="task-tabs">
        <button :class="{ active: activeOperation === 'mapping' }" @click="activeOperation = 'mapping'">
          <UiIcon name="map" :size="19" />
          <span><strong>建图任务</strong><small>启动 SLAM 并保存环境地图</small></span>
          <i v-if="mappingActive"></i>
        </button>
        <button :class="{ active: activeOperation === 'navigation' }" @click="activeOperation = 'navigation'">
          <UiIcon name="route" :size="19" />
          <span><strong>导航任务</strong><small>选择场景、定位并设置目标</small></span>
          <i v-if="navigationActive"></i>
        </button>
        <button :class="{ active: activeOperation === 'maps' }" @click="activeOperation = 'maps'">
          <UiIcon name="layers" :size="19" />
          <span><strong>地图与场景</strong><small>编辑栅格、切换和管理场景</small></span>
        </button>
        <button :class="{ active: activeOperation === 'simulation' }" @click="activeOperation = 'simulation'">
          <UiIcon name="robot" :size="19" />
          <span><strong>仿真测试</strong><small>启动三个 GPU 物理仿真场景</small></span>
        </button>
      </nav>

      <section v-if="activeOperation === 'simulation'" class="card task-map-manager">
        <SimulationControl :controlConfig="controlConfig" />
      </section>

      <div v-else-if="activeOperation !== 'maps'" class="task-layout">
        <section class="card task-control-panel">
          <div class="operations-heading">
            <h2>{{ activeOperation === 'mapping' ? '建图任务' : '导航任务' }}</h2>
            <span class="operation-state" :class="{ active: mappingActive || navigationActive }">
              {{ mappingActive ? '建图中' : navigationActive ? '导航中' : '待机' }}
            </span>
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
            :mapsRevision="mapsRevision"
            v-model:selectedMap="selectedScenePath"
            v-model:isNavigating="navigationActive"
            v-model:isSettingPose="isSettingPose"
            v-model:multiPointMode="multiPointMode"
            :waypointCount="waypointQueue.length + (activeWaypoint ? 1 : 0)"
            @navigationStarted="activeOperation = 'navigation'"
            @clear-waypoints="clearWaypoints"
          />
        </section>

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
      </div>

      <section v-else class="card task-map-manager">
        <MapManager @changed="mapsRevision++" @select="selectScene" />
      </section>
    </main>

    <main v-else-if="legacyView === 'robots'" class="robots-page">
      <RobotManager
        :robots="robots"
        :activeRobotId="activeRobotId"
        :connectionState="connectionState"
        @add="addRobot"
        @update="updateRobot"
        @remove="removeRobot"
        @switch="switchRobot"
      />
    </main>

    <main v-else-if="legacyView === 'settings'" class="settings-page">
      <RuntimeSettings @saved="loadRuntimeConfig" />
    </main>

    <RouterView v-else />
  </AppShell>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppShell from './layout/AppShell.vue'
import { useRosTransport } from './composables/useRosTransport.js'
import { API_BASE, DEFAULT_WS_URL } from './config.js'
import JoystickControl from './components/JoystickControl.vue'
import BatteryStatus from './components/BatteryStatus.vue'
import SlamMap from './components/SlamMap.vue'
import ConnectionPanel from './components/ConnectionPanel.vue'
import TelemetryPanel from './components/TelemetryPanel.vue'
import InspectionWorkspace from './components/InspectionWorkspace.vue'
import MappingControl from './components/MappingControl.vue'
import NavigationControl from './components/NavigationControl.vue'
import SimulationControl from './components/SimulationControl.vue'
import MapManager from './components/MapManager.vue'
import RobotManager from './components/RobotManager.vue'
import RuntimeSettings from './components/RuntimeSettings.vue'
import UiIcon from './components/UiIcon.vue'

function loadRobots() {
  try {
    const saved = JSON.parse(localStorage.getItem('robot-console-robots'))
    if (Array.isArray(saved) && saved.length && saved.every((robot) => robot.id && robot.name && robot.url)) return saved
  } catch {}
  return [{
    id: 'robot-1', name: '机器狗 1', url: DEFAULT_WS_URL, namespace: '', transport: 'foxglove',
    lidarType: '2d', slamAlgorithm: 'slam_toolbox', localizationAlgorithm: 'amcl', algorithmPackage: '', algorithmLaunch: ''
  }]
}

const route = useRoute()
const router = useRouter()
const legacyView = computed(() => route.meta.legacyView || '')
const robots = ref(loadRobots())
const activeRobotId = ref(robots.value[0].id)
const activeRobot = computed(() => robots.value.find((robot) => robot.id === activeRobotId.value) || robots.value[0])
const foxglove = useRosTransport()
const slamMapRef = ref(null)
const activeOperation = ref('maps')
const mapsRevision = ref(0)
const selectedScenePath = ref('')
const layerOptions = [
  { key: 'map', label: '地图' },
  { key: 'scan', label: '激光' },
  { key: 'robot', label: '机器狗' },
  { key: 'path', label: '路径' },
  { key: 'goal', label: '目标' }
]

const CONTROL_DEFAULTS = {
  max_linear_speed: 0.5,
  max_angular_speed: 1.0,
  command_rate_hz: 10,
  command_timeout_ms: 600
}

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
  camera_primary: '/camera1/preview/compressed',
  camera_secondary: '/camera2/preview/compressed',
  pointcloud: '/points',
  registered_cloud: '/cloud_registered',
  fastlio_odom: '/Odometry',
  fastlio_path: '/path'
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
const cameraPrimary = ref(null)

// 导航反馈数据
const navFeedback = ref(null)
const imuData = ref(null)
const runtimeTopics = ref({ ...TOPIC_DEFAULTS })
const controlConfig = ref({ ...CONTROL_DEFAULTS })
const robotTopics = computed(() => {
  const namespace = activeRobot.value?.namespace?.replace(/^\/+|\/+$/g, '')
  const topics = { ...runtimeTopics.value }
  const usesFastLio = ['fast_lio', 'fast_lio_localization'].includes(activeRobot.value?.slamAlgorithm) ||
    activeRobot.value?.localizationAlgorithm === 'fast_lio_localization'
  if (usesFastLio && topics.odom === TOPIC_DEFAULTS.odom) topics.odom = topics.fastlio_odom || '/Odometry'
  return Object.fromEntries(Object.entries(topics).map(([key, topic]) => {
    if (!namespace || !topic) return [key, topic]
    return [key, `/${namespace}/${topic.replace(/^\/+/, '')}`]
  }))
})

// ---- 图层控制 ----
const mapLayers = ref({
  map: true,
  scan: true,
  robot: true,
  path: true,
  goal: true
})

// ================= ROS 通信频道 ID ==================
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
let cameraPrimarySubId = null

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
function connectRobot(robot) {
  if (robot.id !== activeRobotId.value) switchRobot(robot)
  else handleConnect(robot.url)
}

function handleConnect(url) {
  if (connectionState.value === 'connected' || connectionState.value === 'connecting') return
  const targetUrl = url || activeRobot.value?.url || DEFAULT_WS_URL
  if (activeRobot.value) {
    activeRobot.value.url = targetUrl
    persistRobots()
  }
  foxglove.connect(targetUrl, activeRobot.value?.transport || 'foxglove')
}

function persistRobots() {
  localStorage.setItem('robot-console-robots', JSON.stringify(robots.value))
}

function switchRobot(robot) {
  if (robot.id === activeRobotId.value) {
    router.push('/inspection')
    return
  }
  handleDisconnect()
  activeRobotId.value = robot.id
  persistRobots()
  router.push('/inspection')
  nextTick(() => handleConnect(robot.url))
}

function addRobot(config) {
  const robot = {
    ...config,
    id: globalThis.crypto?.randomUUID?.() || `robot-${Date.now()}`
  }
  robots.value.push(robot)
  persistRobots()
  switchRobot(robot)
}

function updateRobot(config) {
  const robot = robots.value.find((item) => item.id === config.id)
  if (!robot) return
  Object.assign(robot, {
    name: config.name,
    url: config.url,
    namespace: config.namespace,
    transport: config.transport || 'foxglove',
    lidarType: config.lidarType || '2d',
    slamAlgorithm: config.slamAlgorithm || 'slam_toolbox',
    localizationAlgorithm: config.localizationAlgorithm || 'amcl',
    algorithmPackage: config.algorithmPackage || '',
    algorithmLaunch: config.algorithmLaunch || ''
  })
  persistRobots()
  if (robot.id === activeRobotId.value && isConnected.value) {
    handleDisconnect()
    nextTick(() => handleConnect(robot.url))
  }
}

function removeRobot(id) {
  if (robots.value.length <= 1) return
  const wasActive = id === activeRobotId.value
  robots.value = robots.value.filter((robot) => robot.id !== id)
  if (wasActive) {
    handleDisconnect()
    activeRobotId.value = robots.value[0].id
    nextTick(() => handleConnect(activeRobot.value.url))
  }
  persistRobots()
}

function selectScene(map) {
  selectedScenePath.value = map.path
  activeOperation.value = 'navigation'
  router.push('/maps')
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
  cameraPrimary.value = null
  navFeedback.value = null // 清除导航反馈数据
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
  clearAllData()
}

function handleDisconnect() {
  onStopMotion()
  foxglove.disconnect()
  clearConnectionState()
}

async function loadRuntimeConfig() {
  try {
    const res = await fetch(`${API_BASE}/runtime_config`)
    const data = await res.json()
    runtimeTopics.value = { ...TOPIC_DEFAULTS, ...(data.topics || {}) }
    controlConfig.value = { ...CONTROL_DEFAULTS, ...(data.control || {}) }
  } catch (err) {
    console.warn('加载运行时配置失败，使用默认话题和运动控制参数:', err)
    runtimeTopics.value = { ...TOPIC_DEFAULTS }
    controlConfig.value = { ...CONTROL_DEFAULTS }
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
    cmdVelChannelId = foxglove.clientAdvertise(robotTopics.value.cmd_vel, 'geometry_msgs/Twist', 'json')
  }

  // 2. 订阅 /battery (电压值，单位可能是 0.1V)
  if (!batterySubId) {
    batterySubId = foxglove.subscribe(robotTopics.value.battery, (data) => {
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
    mapSubId = foxglove.subscribe(robotTopics.value.map, (data) => {
      mapData.value = data
    })
  }

  // 4. 订阅 /scan
  if (!scanSubId) {
    scanSubId = foxglove.subscribe(robotTopics.value.scan, (data) => {
      scanData.value = data
    })
  }

  // 5. 订阅 /tf
  if (!tfSubId) {
    tfSubId = foxglove.subscribe(robotTopics.value.tf, (data) => {
      tfData.value = data
    })
  }

  // 6. 订阅 /odom
  if (!odomSubId) {
    odomSubId = foxglove.subscribe(robotTopics.value.odom, (data) => {
      odomData.value = data
    })
  }

  // 7. 声明 /goal_pose 发布频道
  if (!goalPoseChannelId) {
    goalPoseChannelId = foxglove.clientAdvertise(robotTopics.value.goal_pose, 'geometry_msgs/PoseStamped', 'json')
  }

  // 8. 订阅 /plan (导航路径)
  if (!planSubId) {
    planSubId = foxglove.subscribe(robotTopics.value.plan, (data) => {
      planData.value = data
    })
  }

  // 9. 声明 /initialpose 发布频道
  if (!initialPoseChannelId) {
    initialPoseChannelId = foxglove.clientAdvertise(robotTopics.value.initial_pose, 'geometry_msgs/PoseWithCovarianceStamped', 'json')
  }

  // 10. 订阅导航反馈 (距离与预计时间)
  if (!feedbackSubId) {
    feedbackSubId = foxglove.subscribe(robotTopics.value.navigate_feedback, (data) => {
      navFeedback.value = normalizeNavFeedback(data)
    })
  }

  // 11. 订阅 IMU（可配置，当前仅缓存数据）
  if (!imuSubId) {
    imuSubId = foxglove.subscribe(robotTopics.value.imu, (data) => {
      imuData.value = data
    })
  }

  if (!cameraPrimarySubId) {
    cameraPrimarySubId = foxglove.subscribe(robotTopics.value.camera_primary, (data) => {
      cameraPrimary.value = data
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
  if (!multiPointMode.value || !navigationActive.value) return
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
  if (navigationActive.value && !activeWaypoint.value) {
    dispatchNextWaypoint()
  }
}

function clearWaypoints() {
  waypointQueue.value = []
  activeWaypoint.value = null
  waypointAdvancing.value = false
}

function saveWorkspaceMission() {
  const points = [...(activeWaypoint.value ? [activeWaypoint.value] : []), ...waypointQueue.value]
  if (!points.length) return
  const mapPath = selectedScenePath.value
  const mapName = mapPath ? mapPath.split('/').pop().replace(/\.ya?ml$/i, '') : ''
  const draft = {
    name: mapName ? `${mapName}巡检任务` : '新建巡检任务',
    robotId: activeRobot.value?.id || '',
    robotName: activeRobot.value?.name || '',
    map: { id: mapPath, name: mapName, path: mapPath, source: mapPath ? 'api' : '', isDemo: false },
    waypoints: points.map((point, index) => ({
      name: `巡检点 ${index + 1}`,
      pose: { x: point.x, y: point.y, yaw: 0 },
      actions: ['photo'],
      dwellSeconds: 8
    }))
  }
  localStorage.setItem('robot-console-inspection-draft-v1', JSON.stringify(draft))
  router.push('/missions/new')
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

watch(connectionState, (current, previous) => {
  if (previous === 'connected' && current !== 'connected' && current !== 'connecting') {
    clearConnectionState()
  }
})

watch(() => route.path, (current, previous) => {
  if (previous === '/monitor' && current !== '/monitor') onStopMotion()
})

watch(navigationActive, (running) => {
  if (running) {
    slamMapRef.value?.resetView()
    if (multiPointMode.value && !activeWaypoint.value) dispatchNextWaypoint()
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

function updateKeyboardControl() {
  if (!cmdVelChannelId || !isConnected.value) return

  let linearX = 0
  let angularZ = 0

  if (keyboardState.w) linearX += controlConfig.value.max_linear_speed
  if (keyboardState.s) linearX -= controlConfig.value.max_linear_speed
  if (keyboardState.a) angularZ += controlConfig.value.max_angular_speed
  if (keyboardState.d) angularZ -= controlConfig.value.max_angular_speed

  foxglove.sendTwist(cmdVelChannelId, linearX, angularZ)
}

function handleKeyDown(e) {
  // 防止在输入框内打字时触发移动
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return

  const key = e.key.toLowerCase()
  if (['w', 'a', 's', 'd'].includes(key)) {
    if (!keyboardState[key]) {
      keyboardState[key] = true
      
      // 按第一下键时，按运行时配置开启控制循环
      if (!keyboardInterval) {
        updateKeyboardControl() // 立即发一次
        keyboardInterval = setInterval(updateKeyboardControl, 1000 / controlConfig.value.command_rate_hz)
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
