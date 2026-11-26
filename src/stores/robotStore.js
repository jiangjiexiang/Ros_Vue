import { computed, ref } from 'vue'
import { API_BASE, apiFetch } from '../config.js'
import { cloneCollection, collectionConflictError, collectionsEqual, mergeCollectionById } from './collectionSync.js'
import { showToast } from './toastStore.js'

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
  const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1'
  if (!isLocal && scene) {
    return `${wsProto}//${window.location.host}/ws/doglink-${scene}`
  }
  return `${wsProto}//${hostname}:${port}`
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
  const lidarType = robot.lidarType === '2d' ? '2d' : '3d'
  return {
    id: String(robot.id),
    name: String(robot.name),
    url: String(robot.url),
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

function normalizeRobots(items) {
  return cloneCollection(items).map(normalizeRobotItem).filter(Boolean)
}

function loadLocalRobots() {
  try {
    const saved = JSON.parse(localStorage.getItem(ROBOT_STORAGE_KEY))
    if (Array.isArray(saved) && saved.length) {
      const items = normalizeRobots(saved)
      if (items.length) return { items, base: null, version: 0 }
    }
    if (saved && !Array.isArray(saved) && Array.isArray(saved.items)) {
      const items = normalizeRobots(saved.items)
      const base = Array.isArray(saved.base) ? normalizeRobots(saved.base) : null
      return {
        items,
        base,
        version: Number.isFinite(Number(saved.version)) ? Number(saved.version) : 0
      }
    }
  } catch {}
  return { items: createSimulationRobots(), base: null, version: 0 }
}

function loadActiveRobotId(list) {
  try {
    const savedId = localStorage.getItem(ACTIVE_ROBOT_STORAGE_KEY)
    if (savedId && list.some((robot) => robot.id === savedId)) return savedId
  } catch {}
  return list[0]?.id || ''
}

const cachedRobots = loadLocalRobots()
const robots = ref(cachedRobots.items)
const activeRobotId = ref(loadActiveRobotId(robots.value))
const activeRobot = computed(() => robots.value.find((robot) => robot.id === activeRobotId.value) || robots.value[0])
const synced = ref(false)
const serverLoaded = ref(false)
const robotsVersion = ref(cachedRobots.version)
const storageError = ref('')
const robotSync = { base: cachedRobots.base, revision: 0, saveQueue: Promise.resolve() }

function hasUnsyncedChanges() {
  return Boolean(robotSync.base) && !collectionsEqual(robots.value, robotSync.base)
}

function persistLocal() {
  try {
    localStorage.setItem(ROBOT_STORAGE_KEY, JSON.stringify({
      items: robots.value,
      base: robotSync.base,
      version: robotsVersion.value,
      dirty: hasUnsyncedChanges()
    }))
    if (activeRobotId.value) {
      localStorage.setItem(ACTIVE_ROBOT_STORAGE_KEY, activeRobotId.value)
    }
  } catch {}
}

function applyLocalRobots(items) {
  robots.value = normalizeRobots(items)
  if (!robots.value.some((robot) => robot.id === activeRobotId.value)) {
    activeRobotId.value = robots.value[0]?.id || ''
  }
  persistLocal()
}

async function readJsonResponse(res, action) {
  try {
    return await res.json()
  } catch {
    throw new Error(`${action}返回了无效 JSON（HTTP ${res.status}）`)
  }
}

async function putRobots(items, version) {
  const res = await apiFetch(`${API_BASE}/robots`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, version })
  })
  const data = await readJsonResponse(res, '保存机器狗配置')
  return { res, data }
}

async function saveRobotsNow() {
  if (!serverLoaded.value || !robotSync.base) throw new Error('机器狗配置尚未完成服务器加载，已取消保存以避免覆盖')
  const localSnapshot = normalizeRobots(robots.value)
  const baseSnapshot = cloneCollection(robotSync.base)
  const revision = robotSync.revision
  let payload = localSnapshot
  let version = robotsVersion.value
  let merged = null

  for (let attempt = 0; attempt < 3; attempt++) {
    const { res, data } = await putRobots(payload, version)
    if (res.status === 409) {
      if (!Array.isArray(data.items)) throw new Error('409 响应缺少服务器集合，本地修改已保留')
      const serverItems = normalizeRobots(data.items)
      version = Number.isFinite(Number(data.version)) ? Number(data.version) : version
      merged = mergeCollectionById(baseSnapshot, localSnapshot, serverItems)
      if (collectionsEqual(merged.items, serverItems)) {
        robotSync.base = cloneCollection(serverItems)
        robotsVersion.value = version
        if (robotSync.revision === revision) applyLocalRobots(merged.localItems)
        persistLocal()
        synced.value = true
        if (merged.conflicts.length) throw collectionConflictError('机器狗配置', merged.conflicts)
        storageError.value = ''
        return { success: true, version }
      }
      payload = merged.items
      continue
    }
    if (!res.ok || data.success === false) {
      throw new Error(data.error || data.message || `保存机器狗配置失败（HTTP ${res.status}）`)
    }
    robotSync.base = cloneCollection(payload)
    if (Number.isFinite(Number(data.version))) robotsVersion.value = Number(data.version)
    if (merged && robotSync.revision === revision) applyLocalRobots(merged.localItems)
    persistLocal()
    synced.value = true
    if (merged?.conflicts.length) throw collectionConflictError('机器狗配置', merged.conflicts)
    storageError.value = ''
    return data
  }
  throw new Error('机器狗配置连续发生版本冲突，本地修改已保留，请稍后重试')
}

function persistRobots() {
  persistLocal()
  const result = robotSync.saveQueue.catch(() => {}).then(() => saveRobotsNow())
  robotSync.saveQueue = result
  return result.catch((error) => {
    storageError.value = error.message || '机器狗配置保存失败'
    throw error
  })
}

async function loadRobotsFromServer() {
  try {
    const res = await apiFetch(`${API_BASE}/robots`)
    const data = await readJsonResponse(res, '加载机器狗配置')
    if (!res.ok) throw new Error(data.error || data.message || `加载机器狗配置失败（HTTP ${res.status}）`)
    const serverItems = normalizeRobots(data.items)
    if (Number.isFinite(Number(data.version))) robotsVersion.value = Number(data.version)
    serverLoaded.value = true

    if (!data.hasData) {
      robotSync.base = []
      await persistRobots()
      return data
    }

    if (!hasUnsyncedChanges()) {
      robotSync.base = cloneCollection(serverItems)
      applyLocalRobots(serverItems)
      synced.value = true
      storageError.value = ''
      return data
    }

    const merged = mergeCollectionById(robotSync.base, robots.value, serverItems)
    robotSync.base = cloneCollection(serverItems)
    applyLocalRobots(merged.localItems)
    if (merged.conflicts.length) throw collectionConflictError('机器狗配置', merged.conflicts)
    if (!collectionsEqual(merged.items, serverItems)) {
      await persistRobots()
    } else {
      synced.value = true
      storageError.value = ''
      persistLocal()
    }
    return data
  } catch (error) {
    storageError.value = error.message || '机器狗配置加载失败'
    showToast(storageError.value, 'error')
    return null
  }
}

function prepareRobotMutation() {
  if (!robotSync.base) robotSync.base = normalizeRobots(robots.value)
}

function markRobotsDirty(update) {
  prepareRobotMutation()
  if (typeof update === 'function') update()
  robotSync.revision++
  persistLocal()
}

function selectActiveRobot(id) {
  if (!robots.value.some((robot) => robot.id === id)) return null
  activeRobotId.value = id
  persistLocal()
  return activeRobot.value
}

async function addRobot(config) {
  const robot = normalizeRobotItem({
    ...config,
    id: config.id || globalThis.crypto?.randomUUID?.() || `robot-${Date.now()}`
  })
  if (!robot) throw new Error('机器狗配置无效')
  prepareRobotMutation()
  const index = robots.value.findIndex((item) => item.id === robot.id)
  if (index >= 0) robots.value[index] = robot
  else robots.value.push(robot)
  robotSync.revision++
  await persistRobots()
  return robots.value.find((item) => item.id === robot.id) || robot
}

async function updateRobot(config) {
  const robot = robots.value.find((item) => item.id === config.id)
  if (!robot) throw new Error('未找到要修改的机器狗配置')
  prepareRobotMutation()
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
  robotSync.revision++
  await persistRobots()
  return robot
}

async function removeRobot(id) {
  if (robots.value.length <= 1 || !robots.value.some((robot) => robot.id === id)) return false
  prepareRobotMutation()
  const wasActive = id === activeRobotId.value
  robots.value = robots.value.filter((robot) => robot.id !== id)
  if (wasActive) activeRobotId.value = robots.value[0]?.id || ''
  robotSync.revision++
  await persistRobots()
  return true
}

async function ensureSimulationRobot(scene = 'indoor') {
  const defaults = createSimulationRobots()
  prepareRobotMutation()
  let changed = false
  for (const robot of defaults) {
    if (!robots.value.some((item) => item.id === robot.id)) {
      robots.value.push(robot)
      changed = true
    }
  }
  if (changed) {
    robotSync.revision++
    await persistRobots()
  }
  return robots.value.find((robot) => robot.simulationScene === scene) || defaults[0]
}

export function useRobotStore() {
  return {
    robots,
    activeRobotId,
    activeRobot,
    synced,
    storageError,
    robotsVersion,
    loadRobotsFromServer,
    persistRobots,
    markRobotsDirty,
    selectActiveRobot,
    addRobot,
    updateRobot,
    removeRobot,
    ensureSimulationRobot
  }
}
