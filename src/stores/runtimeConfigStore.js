import { ref } from 'vue'
import { API_BASE } from '../config.js'

export const CONTROL_DEFAULTS = {
  max_linear_speed: 0.5,
  max_angular_speed: 1.0,
  command_rate_hz: 10,
  command_timeout_ms: 600
}

export const TOPIC_DEFAULTS = {
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

const runtimeTopics = ref({ ...TOPIC_DEFAULTS })
const controlConfig = ref({ ...CONTROL_DEFAULTS })
const workspace = ref('..')
const mapsDir = ref('maps')
const tasks = ref({ mapping: [], navigation: [] })
const diagnostics = ref({
  workspaceExists: false,
  setupBashExists: false,
  mapsDirExists: false
})
const loading = ref(false)
const loaded = ref(false)
const loadError = ref('')

function applyRuntimeConfig(data) {
  if (!data || typeof data !== 'object') return
  runtimeTopics.value = { ...TOPIC_DEFAULTS, ...(data.topics || {}) }
  controlConfig.value = { ...CONTROL_DEFAULTS, ...(data.control || {}) }
  workspace.value = typeof data.workspace === 'string' && data.workspace ? data.workspace : '..'
  mapsDir.value = typeof data.maps_dir === 'string' && data.maps_dir ? data.maps_dir : 'maps'
  tasks.value = {
    mapping: Array.isArray(data.tasks?.mapping) ? data.tasks.mapping : [],
    navigation: Array.isArray(data.tasks?.navigation) ? data.tasks.navigation : []
  }
  if (data.diagnostics && typeof data.diagnostics === 'object') {
    diagnostics.value = {
      workspaceExists: Boolean(data.diagnostics.workspaceExists),
      setupBashExists: Boolean(data.diagnostics.setupBashExists),
      mapsDirExists: Boolean(data.diagnostics.mapsDirExists)
    }
  }
}

async function loadRuntimeConfig() {
  loading.value = true
  loadError.value = ''
  try {
    const res = await fetch(`${API_BASE}/runtime_config`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    applyRuntimeConfig(data)
    loaded.value = true
    return data
  } catch (err) {
    console.warn('加载运行时配置失败，使用默认话题和运动控制参数:', err)
    loadError.value = err.message || '加载运行时配置失败'
    runtimeTopics.value = { ...TOPIC_DEFAULTS }
    controlConfig.value = { ...CONTROL_DEFAULTS }
    return null
  } finally {
    loading.value = false
  }
}

export function useRuntimeConfigStore() {
  return {
    runtimeTopics,
    controlConfig,
    workspace,
    mapsDir,
    tasks,
    diagnostics,
    loading,
    loaded,
    loadError,
    applyRuntimeConfig,
    loadRuntimeConfig
  }
}
