import { ref } from 'vue'
import { API_BASE, apiFetch } from '../../config.js'
import { useInspectionStore } from '../../stores/inspectionStore.js'
import { showToast } from '../../stores/toastStore.js'
import {
  cloneCollection,
  collectionConflictError,
  mergeCollectionById
} from '../../stores/collectionSync.js'
import {
  ACTIVE_MISSION_STATUSES,
  cloneData,
  createId,
  createRunState,
  getActionLabel,
  normalizeMission
} from './missionModel.js'

export const MISSION_STORAGE_KEY = 'robot-console-inspection-missions-v1'
export const MISSION_SYNC_STATE_KEY = 'robot-console-inspection-missions-sync-v1'

function normalizeStoredMissions(items) {
  return items
    .filter((mission) => !mission?.isDemo && !String(mission?.id || '').startsWith('demo-'))
    .map((mission) => normalizeMission(mission))
}

function loadMissions() {
  try {
    const stored = globalThis.localStorage?.getItem(MISSION_STORAGE_KEY)
    if (stored != null) {
      const parsed = JSON.parse(stored)
      if (Array.isArray(parsed)) return normalizeStoredMissions(parsed)
    }
  } catch (error) {
    console.warn('读取本地巡检任务失败，已使用空任务列表。', error)
  }
  return []
}

function loadSyncState() {
  try {
    const raw = globalThis.localStorage?.getItem(MISSION_SYNC_STATE_KEY)
    if (!raw) return { version: null, base: null, dirty: false }
    const parsed = JSON.parse(raw)
    return {
      version: Number.isFinite(parsed?.version) ? parsed.version : null,
      base: Array.isArray(parsed?.base) ? normalizeStoredMissions(parsed.base) : null,
      dirty: parsed?.dirty === true
    }
  } catch {
    return { version: null, base: null, dirty: false }
  }
}

const persistedSync = loadSyncState()

const missions = ref(loadMissions())
const storageError = ref('')
const serverSynced = ref(false)
const serverVersion = ref(persistedSync.version)
let serverBase = persistedSync.base
let syncDirty = persistedSync.dirty
let syncHalted = false
let localRevision = 0

function saveSyncState() {
  try {
    globalThis.localStorage?.setItem(MISSION_SYNC_STATE_KEY, JSON.stringify({
      version: serverVersion.value,
      base: serverBase,
      dirty: syncDirty
    }))
  } catch {}
}

function writeLocalMissions() {
  try {
    if (globalThis.localStorage) {
      globalThis.localStorage.setItem(MISSION_STORAGE_KEY, JSON.stringify(missions.value))
    }
    return true
  } catch (error) {
    console.warn('保存本地巡检任务失败。', error)
    storageError.value = '浏览器本地存储不可用，本次修改仅在当前页面有效。'
    return false
  }
}

async function readJsonSafe(res) {
  try {
    return await res.json()
  } catch {
    return null
  }
}

async function putMissions() {
  const items = cloneCollection(missions.value)
  let res
  try {
    res = await apiFetch(`${API_BASE}/missions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, version: serverVersion.value })
    })
  } catch (error) {
    throw new Error(`巡检任务同步到服务器失败：${error.message || '网络错误'}。`)
  }
  return { res, items }
}

function adoptServerSnapshot(items, version) {
  serverBase = normalizeStoredMissions(items)
  if (Number.isFinite(version)) serverVersion.value = version
}

function applyMergedItems(items) {
  missions.value = items.map((item) => normalizeMission(item))
  writeLocalMissions()
}

function haltOnConflict(conflicts) {
  syncHalted = true
  syncDirty = true
  saveSyncState()
  const error = collectionConflictError('巡检任务', conflicts)
  error.code = 'MISSION_SYNC_CONFLICT'
  return error
}

async function syncMissionsToServer(revision) {
  if (!serverSynced.value && missions.value.length === 0) return
  let { res, items: sentItems } = await putMissions()
  if (res.status === 409) {
    const conflict = await readJsonSafe(res)
    const serverItems = normalizeStoredMissions(conflict?.items || [])
    const merged = mergeCollectionById(serverBase || [], missions.value, serverItems)
    adoptServerSnapshot(serverItems, conflict?.version)
    if (merged.conflicts.length) {
      throw haltOnConflict(merged.conflicts)
    }
    applyMergedItems(merged.items)
    const retry = await putMissions()
    res = retry.res
    sentItems = retry.items
    if (res.status === 409) {
      const again = await readJsonSafe(res)
      const againItems = normalizeStoredMissions(again?.items || [])
      const againMerged = mergeCollectionById(serverBase || [], missions.value, againItems)
      adoptServerSnapshot(againItems, again?.version)
      if (againMerged.conflicts.length) {
        throw haltOnConflict(againMerged.conflicts)
      }
      applyMergedItems(againMerged.items)
      saveSyncState()
      const error = new Error('服务器巡检任务持续被修改：已按最新版本三方合并并保留本地修改，请再次保存以完成同步。')
      error.code = 'MISSION_SYNC_CONFLICT'
      throw error
    }
  }
  if (!res.ok) {
    throw new Error(`巡检任务同步到服务器失败（HTTP ${res.status}）。`)
  }
  const data = await readJsonSafe(res)
  if (data && data.success === false) {
    throw new Error(data.error || '巡检任务同步到服务器失败。')
  }
  serverBase = sentItems
  if (data && Number.isFinite(data.version)) {
    serverVersion.value = data.version
  }
  if (revision >= localRevision) {
    syncDirty = false
    syncHalted = false
    if (storageError.value) storageError.value = ''
  }
  saveSyncState()
}

let syncQueue = Promise.resolve()

function queueServerSync(revision) {
  const run = syncQueue.then(() => syncMissionsToServer(revision))
  syncQueue = run.catch(() => {})
  return run
}

function persistMissions({ automatic = false } = {}) {
  writeLocalMissions()
  localRevision += 1
  syncDirty = true
  saveSyncState()
  const revision = localRevision
  if (syncHalted && automatic) {
    const error = new Error('存在未解决的服务器冲突，自动同步已暂停；请人工核对后重新保存。')
    error.code = 'MISSION_SYNC_CONFLICT'
    return Promise.reject(error)
  }
  if (!automatic) syncHalted = false
  return queueServerSync(revision).catch((error) => {
    storageError.value = error.message
    throw error
  })
}

function persistMissionsQuietly() {
  persistMissions({ automatic: true }).catch(() => {})
}

async function initMissionsFromServer() {
  if (serverSynced.value) return true
  let res
  try {
    res = await apiFetch(`${API_BASE}/missions`)
  } catch {
    storageError.value = '无法连接服务器加载巡检任务，当前显示本地缓存数据。'
    return false
  }
  if (!res.ok) {
    storageError.value = `服务器加载巡检任务失败（HTTP ${res.status}），当前显示本地缓存数据。`
    return false
  }
  let data
  try {
    data = await res.json()
  } catch {
    storageError.value = '服务器返回的巡检任务数据无法解析，当前显示本地缓存数据。'
    return false
  }
  if (data.hasData && Array.isArray(data.items)) {
    serverSynced.value = true
    if (syncDirty) {
      const serverItems = normalizeStoredMissions(data.items)
      const merged = mergeCollectionById(serverBase || [], missions.value, serverItems)
      adoptServerSnapshot(serverItems, data.version)
      if (merged.conflicts.length) {
        storageError.value = haltOnConflict(merged.conflicts).message
        return true
      }
      applyMergedItems(merged.items)
      localRevision += 1
      syncDirty = true
      saveSyncState()
      const revision = localRevision
      storageError.value = '检测到未同步的本地修改：已按服务器版本三方合并，正在重新同步…'
      queueServerSync(revision).catch((error) => {
        storageError.value = error.message
      })
      return true
    }
    missions.value = normalizeStoredMissions(data.items)
    adoptServerSnapshot(data.items, data.version)
    syncHalted = false
    saveSyncState()
    writeLocalMissions()
    storageError.value = ''
    return true
  }
  if (!data.hasData) {
    serverSynced.value = true
    if (Number.isFinite(data.version)) serverVersion.value = data.version
    serverBase = []
    saveSyncState()
    if (missions.value.length > 0) {
      localRevision += 1
      syncDirty = true
      saveSyncState()
      await queueServerSync(localRevision)
    }
    return true
  }
  return false
}

function findMission(id) {
  return missions.value.find((mission) => mission.id === id)
}

function appendRunLog(mission, message, type = 'info') {
  mission.run.logs.push({
    id: createId('log'),
    time: new Date().toISOString(),
    type,
    message
  })
  mission.run.logs = mission.run.logs.slice(-80)
}

function requireMission(id) {
  const mission = findMission(id)
  if (!mission) throw new Error('未找到该巡检任务，可能已被删除。')
  return mission
}

async function saveMission(input) {
  const existing = input.id ? findMission(input.id) : null
  if (existing && ACTIVE_MISSION_STATUSES.includes(existing.status)) {
    throw new Error('执行中或已暂停的任务不能修改，请先终止任务。')
  }

  const now = new Date().toISOString()
  const mission = normalizeMission({
    ...cloneData(input),
    id: existing?.id || input.id || createId('mission'),
    status: 'pending',
    isDemo: existing ? existing.isDemo : Boolean(input.isDemo),
    createdAt: existing?.createdAt || input.createdAt || now,
    updatedAt: now,
    run: createRunState()
  })

  if (existing) {
    const index = missions.value.findIndex((item) => item.id === existing.id)
    missions.value[index] = mission
  } else {
    missions.value.unshift(mission)
  }
  await persistMissions()
  return cloneData(mission)
}

async function duplicateMission(id) {
  const source = requireMission(id)
  const now = new Date().toISOString()
  const copy = normalizeMission({
    ...cloneData(source),
    id: createId('mission'),
    name: `${source.name} 副本`.slice(0, 80),
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    waypoints: source.waypoints.map((point) => ({ ...cloneData(point), id: createId('point') })),
    run: createRunState()
  })
  missions.value.unshift(copy)
  await persistMissions()
  return cloneData(copy)
}

async function deleteMission(id) {
  const mission = requireMission(id)
  if (ACTIVE_MISSION_STATUSES.includes(mission.status)) {
    throw new Error('执行中或已暂停的任务不能删除，请先终止任务。')
  }
  missions.value = missions.value.filter((item) => item.id !== id)
  await persistMissions()
}

async function startMission(id) {
  const mission = requireMission(id)
  if (!mission.waypoints.length) throw new Error('任务没有巡检点，无法开始执行。')
  if (mission.status === 'running') return

  const previous = {
    status: mission.status,
    run: cloneData(mission.run),
    updatedAt: mission.updatedAt
  }
  const now = new Date().toISOString()
  if (mission.status === 'paused') {
    mission.status = 'running'
    mission.run.pausedAt = null
    appendRunLog(mission, '任务已继续。')
  } else {
    mission.status = 'running'
    mission.run = createRunState({
      currentCycle: 1,
      currentWaypointIndex: 0,
      phase: 'navigating',
      startedAt: now
    })
    appendRunLog(mission, '任务已开始。')
  }
  mission.updatedAt = now
  try {
    await persistMissions()
  } catch (error) {
    mission.status = previous.status
    mission.run = previous.run
    mission.updatedAt = previous.updatedAt
    writeLocalMissions()
    throw new Error(`任务启动状态保存失败，已回滚为未启动：${error.message}`)
  }
}

async function pauseMission(id) {
  const mission = requireMission(id)
  if (mission.status !== 'running') return
  mission.status = 'paused'
  mission.run.pausedAt = new Date().toISOString()
  mission.updatedAt = mission.run.pausedAt
  appendRunLog(mission, '任务已暂停。', 'warning')
  await persistMissions()
}

async function abortMission(id, reason = '任务已由用户终止。', { automatic = false } = {}) {
  const mission = requireMission(id)
  if (!ACTIVE_MISSION_STATUSES.includes(mission.status)) return
  mission.status = 'aborted'
  mission.run.phase = 'aborted'
  mission.run.abortedAt = new Date().toISOString()
  mission.updatedAt = mission.run.abortedAt
  appendRunLog(mission, reason, 'warning')
  let persistError = null
  try {
    await persistMissions({ automatic })
  } catch (error) {
    persistError = error
  }
  const { archiveMissionRecord } = useInspectionStore()
  const record = archiveMissionRecord(mission)
  if (record) {
    showToast(`任务已终止，并归档至巡检记录（${record.id}）`, 'warning')
  }
  if (persistError) throw persistError
}

function archiveMissionCompletion(mission) {
  const { archiveMissionRecord } = useInspectionStore()
  const record = archiveMissionRecord(mission)
  if (record) {
    showToast(`巡检任务已完成，已生成记录 ${record.id}`, 'success')
  }
}

function completeCurrentWaypointNavigation(id, detail = '已到达目标点，开始执行巡检动作。') {
  const mission = findMission(id)
  if (!mission || mission.status !== 'running' || mission.run.phase !== 'navigating') return false
  const waypoint = mission.waypoints[mission.run.currentWaypointIndex]
  if (!waypoint) return false
  mission.run.phase = 'inspecting'
  mission.run.elapsedSeconds = 0
  mission.run.retryCount = 0
  appendRunLog(mission, `“${waypoint.name}”${detail}`)
  persistMissionsQuietly()
  return true
}

function advanceToNextWaypoint(mission) {
  const run = mission.run
  const nextIndex = run.currentWaypointIndex + 1
  run.retryCount = 0
  if (nextIndex < mission.waypoints.length) {
    run.currentWaypointIndex = nextIndex
    run.phase = 'navigating'
    run.elapsedSeconds = 0
    return false
  }
  if (run.currentCycle < mission.loopCount) {
    run.currentCycle += 1
    run.currentWaypointIndex = 0
    run.phase = 'navigating'
    run.elapsedSeconds = 0
    appendRunLog(mission, `开始第 ${run.currentCycle} / ${mission.loopCount} 轮巡检。`)
    return false
  }
  mission.status = 'completed'
  run.phase = 'completed'
  run.currentWaypointIndex = -1
  run.elapsedSeconds = 0
  run.completedAt = new Date().toISOString()
  mission.updatedAt = run.completedAt
  appendRunLog(mission, '全部巡检点和循环已完成。', 'success')
  return true
}

async function handleNavigationTimeout(mission, waypoint, timeoutSeconds) {
  const policy = mission.onFailure || 'stop'
  if (policy === 'skip') {
    appendRunLog(mission, `前往“${waypoint.name}”导航超时（>${timeoutSeconds}s），按策略跳过该巡检点。`, 'warning')
    showToast(`导航超时：已跳过“${waypoint.name}”并继续任务`, 'warning')
    const finished = advanceToNextWaypoint(mission)
    await persistMissions({ automatic: true })
    if (finished) archiveMissionCompletion(mission)
    return
  }
  if (policy === 'retry' && mission.run.retryCount < mission.retryLimit) {
    mission.run.retryCount += 1
    mission.run.phase = 'navigating'
    mission.run.elapsedSeconds = 0
    appendRunLog(mission, `前往“${waypoint.name}”导航超时，正在重试（第 ${mission.run.retryCount} / ${mission.retryLimit} 次）。`, 'warning')
    showToast(`导航超时：重试“${waypoint.name}”（${mission.run.retryCount}/${mission.retryLimit}）`, 'warning')
    await persistMissions({ automatic: true })
    return
  }
  const reason = policy === 'retry'
    ? `前往“${waypoint.name}”导航超时，已达 ${mission.retryLimit} 次重试上限，任务已自动中止。`
    : `前往“${waypoint.name}”导航超时（>${timeoutSeconds}s），任务已中止。`
  await abortMission(mission.id, reason, { automatic: true })
}

async function tickMission(id, { onTimeout } = {}) {
  const mission = findMission(id)
  if (!mission || mission.status !== 'running' || !mission.waypoints.length) return

  const run = mission.run
  if (run.currentCycle < 1) run.currentCycle = 1
  if (run.currentWaypointIndex < 0 || run.currentWaypointIndex >= mission.waypoints.length) {
    run.currentWaypointIndex = 0
    run.phase = 'navigating'
    run.elapsedSeconds = 0
  }

  const waypoint = mission.waypoints[run.currentWaypointIndex]
  run.elapsedSeconds += 1

  if (run.phase === 'navigating') {
    const timeoutSeconds = Math.max(5, Number(mission.navigation?.navigationTimeoutSeconds || 90))
    if (run.elapsedSeconds >= timeoutSeconds) {
      if (onTimeout) onTimeout(mission, waypoint)
      await handleNavigationTimeout(mission, waypoint, timeoutSeconds)
      return
    }
    await persistMissions({ automatic: true })
    return
  }

  if (run.phase !== 'inspecting') return
  const dwellSeconds = Math.max(1, waypoint.dwellSeconds || mission.dwellSeconds)
  if (run.elapsedSeconds < dwellSeconds) {
    await persistMissions({ automatic: true })
    return
  }

  run.completedVisits += 1
  run.retryCount = 0
  const actions = waypoint.actions.map((action) => getActionLabel(action)).join('、')
  appendRunLog(mission, `完成“${waypoint.name}”的 ${actions}。`, 'success')

  const finished = advanceToNextWaypoint(mission)
  await persistMissions({ automatic: true })
  if (finished) archiveMissionCompletion(mission)
}

export function useMissionStore() {
  return {
    missions,
    storageError,
    initMissionsFromServer,
    saveMission,
    duplicateMission,
    deleteMission,
    startMission,
    pauseMission,
    abortMission,
    tickMission,
    completeCurrentWaypointNavigation,
    appendRunLog
  }
}
