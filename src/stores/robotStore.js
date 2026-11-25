import { computed, ref } from 'vue'
import { API_BASE } from '../config.js'

export const ROBOT_STORAGE_KEY = 'robot-console-robots'
export const ACTIVE_ROBOT_STORAGE_KEY = 'robot-console-active-robot'

export const SIMULATION_ROBOT_CONFIGS = [
  { id: 'robot-isaac-indoor', scene: 'indoor', name: '室内巡检狗 · 3D', port: 8770 },
  { id: 'robot-isaac-warehouse', scene: 'warehouse', name: '仓库巡检狗 · 3D', port: 8771 },
  { id: 'robot-isaac-outdoor', scene: 'outdoor', name: '户外巡检狗 · 3D', port: 8772 }
]

function simulationUrl(port, scene = '') {
  if (typeof window === 'undefined') return `ws://localhost:${port}`
  const hostname = window.location?.hostname || 'localhost'
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1'
  if (!isLocal && scene) {
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${wsProto}//${window.location.host}/ws/doglink-${scene}`
  }
  return `ws://${hostname}:${port}`
}

function createSimulationRobots() {
  return SIMULATION_ROBOT_CONFIGS.map((config) => ({
    id: config.id,
    name: config.name,
    url: simulationUrl(config.port, config.scene),
    namespace: config.scene,
    transport: 'doglink',
    lidarType: '3d',
    slamAlgorithm: 'fast_lio',
    localizationAlgorithm: 'none',
    algorithmPackage: 'fast_lio',
    algorithmLaunch: '',
    simulationScene: config.scene
  }))
}

function normalizeRobotItem(robot) {
  if (!robot || typeof robot !== 'object') return null
  if (!robot.id || !robot.name || !robot.url) return null
  const transport = robot.transport === 'rosbridge'
    ? 'rosbridge'
    : robot.transport === 'doglink'
      ? 'doglink'
      : 'foxglove'
  const simulationScene = SIMULATION_ROBOT_CONFIGS.some((config) => config.scene === robot.simulationScene)
    ? robot.simulationScene
    : ''
  const simulationConfig = SIMULATION_ROBOT_CONFIGS.find((config) => config.scene === simulationScene)
  const lidarType = robot.lidarType === '2d' ? '2d' : '3d'
  return {
    id: String(robot.id),
    name: String(robot.name),
    url: simulationConfig ? simulationUrl(simulationConfig.port, simulationConfig.scene) : String(robot.url),
    namespace: typeof robot.namespace === 'string' ? robot.namespace : '',
    transport,
    lidarType,
    slamAlgorithm: typeof robot.slamAlgorithm === 'string' && robot.slamAlgorithm ? robot.slamAlgorithm : (lidarType === '3d' ? 'fast_lio' : 'slam_toolbox'),
    localizationAlgorithm: typeof robot.localizationAlgorithm === 'string' && robot.localizationAlgorithm ? robot.localizationAlgorithm : (lidarType === '3d' ? 'none' : 'amcl'),
    algorithmPackage: typeof robot.algorithmPackage === 'string' ? robot.algorithmPackage : '',
    algorithmLaunch: typeof robot.algorithmLaunch === 'string' ? robot.algorithmLaunch : '',
    simulationScene
  }
}

function loadLocalRobots() {
  try {
    const saved = JSON.parse(localStorage.getItem(ROBOT_STORAGE_KEY))
    if (Array.isArray(saved) && saved.length) {
      const valid = saved.map(normalizeRobotItem).filter(Boolean)
      if (valid.length) return valid
    }
  } catch {}
  return createSimulationRobots()
}

function loadActiveRobotId(list) {
  try {
    const savedId = localStorage.getItem(ACTIVE_ROBOT_STORAGE_KEY)
    if (savedId && list.some((robot) => robot.id === savedId)) return savedId
  } catch {}
  return list[0].id
}

const robots = ref(loadLocalRobots())
const activeRobotId = ref(loadActiveRobotId(robots.value))
const activeRobot = computed(() => robots.value.find((robot) => robot.id === activeRobotId.value) || robots.value[0])
const synced = ref(false)

function persistLocal() {
  try {
    localStorage.setItem(ROBOT_STORAGE_KEY, JSON.stringify(robots.value))
    if (activeRobotId.value) {
      localStorage.setItem(ACTIVE_ROBOT_STORAGE_KEY, activeRobotId.value)
    }
  } catch {}
}

async function syncRobotsToServer() {
  try {
    const res = await fetch(`${API_BASE}/robots`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: robots.value })
    })
    if (res.ok) synced.value = true
  } catch {}
}

function persistRobots() {
  persistLocal()
  syncRobotsToServer()
}

async function loadRobotsFromServer() {
  try {
    const res = await fetch(`${API_BASE}/robots`)
    if (!res.ok) return
    const data = await res.json()
    if (data.hasData && Array.isArray(data.items) && data.items.length > 0) {
      const valid = data.items.map(normalizeRobotItem).filter(Boolean)
      if (valid.length) {
        robots.value = valid
        if (!valid.some((robot) => robot.id === activeRobotId.value)) {
          activeRobotId.value = valid[0].id
        }
        persistLocal()
        synced.value = true
        return
      }
    }
    if (!data.hasData && robots.value.length > 0) {
      await syncRobotsToServer()
    }
  } catch {}
}

function selectActiveRobot(id) {
  if (!robots.value.some((robot) => robot.id === id)) return null
  activeRobotId.value = id
  persistLocal()
  return activeRobot.value
}

function addRobot(config) {
  const robot = normalizeRobotItem({
    ...config,
    id: globalThis.crypto?.randomUUID?.() || `robot-${Date.now()}`
  })
  if (!robot) return null
  robots.value.push(robot)
  persistRobots()
  return robot
}

function updateRobot(config) {
  const robot = robots.value.find((item) => item.id === config.id)
  if (!robot) return null
  Object.assign(robot, {
    name: config.name,
    url: config.url,
    namespace: config.namespace || '',
    transport: config.transport || 'foxglove',
    lidarType: config.lidarType || '2d',
    slamAlgorithm: config.slamAlgorithm || 'slam_toolbox',
    localizationAlgorithm: config.localizationAlgorithm || 'amcl',
    algorithmPackage: config.algorithmPackage || '',
    algorithmLaunch: config.algorithmLaunch || '',
    simulationScene: robot.simulationScene || ''
  })
  persistRobots()
  return robot
}

function removeRobot(id) {
  if (robots.value.length <= 1) return false
  const wasActive = id === activeRobotId.value
  robots.value = robots.value.filter((robot) => robot.id !== id)
  if (wasActive) {
    activeRobotId.value = robots.value[0].id
  }
  persistRobots()
  return wasActive
}

function ensureSimulationRobot(scene = 'indoor') {
  const defaults = createSimulationRobots()
  let changed = false
  for (const robot of defaults) {
    if (!robots.value.some((item) => item.id === robot.id)) {
      robots.value.push(robot)
      changed = true
    }
  }
  if (changed) persistRobots()
  return robots.value.find((robot) => robot.simulationScene === scene) || defaults[0]
}

export function useRobotStore() {
  return {
    robots,
    activeRobotId,
    activeRobot,
    synced,
    loadRobotsFromServer,
    persistRobots,
    selectActiveRobot,
    addRobot,
    updateRobot,
    removeRobot,
    ensureSimulationRobot
  }
}
