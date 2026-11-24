import { computed, ref } from 'vue'
import { API_BASE, DEFAULT_WS_URL } from '../config.js'

export const ROBOT_STORAGE_KEY = 'robot-console-robots'
export const ACTIVE_ROBOT_STORAGE_KEY = 'robot-console-active-robot'

function defaultRobot() {
  return {
    id: 'robot-1',
    name: '机器狗 1',
    url: DEFAULT_WS_URL,
    namespace: '',
    transport: 'foxglove',
    lidarType: '2d',
    slamAlgorithm: 'slam_toolbox',
    localizationAlgorithm: 'amcl',
    algorithmPackage: '',
    algorithmLaunch: ''
  }
}

function normalizeRobotItem(robot) {
  if (!robot || typeof robot !== 'object') return null
  if (!robot.id || !robot.name || !robot.url) return null
  const transport = robot.transport === 'rosbridge'
    ? 'rosbridge'
    : robot.transport === 'doglink'
      ? 'doglink'
      : 'foxglove'
  return {
    id: String(robot.id),
    name: String(robot.name),
    url: String(robot.url),
    namespace: typeof robot.namespace === 'string' ? robot.namespace : '',
    transport,
    lidarType: robot.lidarType === '3d' ? '3d' : '2d',
    slamAlgorithm: typeof robot.slamAlgorithm === 'string' && robot.slamAlgorithm ? robot.slamAlgorithm : 'slam_toolbox',
    localizationAlgorithm: typeof robot.localizationAlgorithm === 'string' && robot.localizationAlgorithm ? robot.localizationAlgorithm : 'amcl',
    algorithmPackage: typeof robot.algorithmPackage === 'string' ? robot.algorithmPackage : '',
    algorithmLaunch: typeof robot.algorithmLaunch === 'string' ? robot.algorithmLaunch : ''
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
  return [defaultRobot()]
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
    algorithmLaunch: config.algorithmLaunch || ''
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

function ensureSimulationRobot() {
  const simHost = typeof window !== 'undefined' && window.location?.hostname
    ? window.location.hostname
    : 'localhost'
  const simUrl = `ws://${simHost}:8765`
  const existing = robots.value.find((robot) => (
    robot.id === 'robot-isaac-sim' ||
    robot.name.includes('Isaac') ||
    robot.name.includes('仿真') ||
    robot.url === simUrl
  ))
  if (existing) return existing

  const created = normalizeRobotItem({
    id: 'robot-isaac-sim',
    name: 'Isaac 仿真机器狗',
    url: simUrl,
    namespace: '',
    transport: 'foxglove',
    lidarType: '2d',
    slamAlgorithm: 'slam_toolbox',
    localizationAlgorithm: 'amcl',
    algorithmPackage: '',
    algorithmLaunch: ''
  })
  robots.value.push(created)
  persistRobots()
  return created
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
