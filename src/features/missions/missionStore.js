import { ref } from 'vue'
import { API_BASE } from '../../config.js'
import { useInspectionStore } from '../../stores/inspectionStore.js'
import { showToast } from '../../stores/toastStore.js'
import {
  ACTIVE_MISSION_STATUSES,
  cloneData,
  createId,
  createRunState,
  getActionLabel,
  normalizeMission
} from './missionModel.js'

export const MISSION_STORAGE_KEY = 'robot-console-inspection-missions-v1'

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

const missions = ref(loadMissions())
const storageError = ref('')
const serverSynced = ref(false)

async function syncMissionsToServer() {
  try {
    await fetch(`${API_BASE}/missions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: missions.value })
    })
  } catch {}
}

function persistMissions() {
  try {
    if (globalThis.localStorage) {
      globalThis.localStorage.setItem(MISSION_STORAGE_KEY, JSON.stringify(missions.value))
    }
    storageError.value = ''
  } catch (error) {
    console.warn('保存本地巡检任务失败。', error)
    storageError.value = '浏览器本地存储不可用，本次修改仅在当前页面有效。'
  }
  syncMissionsToServer()
}

async function initMissionsFromServer() {
  if (serverSynced.value) return
  try {
    const res = await fetch(`${API_BASE}/missions`)
    if (!res.ok) return
    const data = await res.json()
    if (data.hasData && Array.isArray(data.items)) {
      missions.value = normalizeStoredMissions(data.items)
      try {
        globalThis.localStorage?.setItem(MISSION_STORAGE_KEY, JSON.stringify(missions.value))
      } catch {}
      serverSynced.value = true
      return
    }
    if (!data.hasData && missions.value.length > 0) {
      await syncMissionsToServer()
      serverSynced.value = true
    }
  } catch {}
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

function saveMission(input) {
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
  persistMissions()
  return cloneData(mission)
}

function duplicateMission(id) {
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
  persistMissions()
  return cloneData(copy)
}

function deleteMission(id) {
  const mission = requireMission(id)
  if (ACTIVE_MISSION_STATUSES.includes(mission.status)) {
    throw new Error('执行中或已暂停的任务不能删除，请先终止任务。')
  }
  missions.value = missions.value.filter((item) => item.id !== id)
  persistMissions()
}

function startMission(id) {
  const mission = requireMission(id)
  if (!mission.waypoints.length) throw new Error('任务没有巡检点，无法开始执行。')
  if (mission.status === 'running') return

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
  persistMissions()
}

function pauseMission(id) {
  const mission = requireMission(id)
  if (mission.status !== 'running') return
  mission.status = 'paused'
  mission.run.pausedAt = new Date().toISOString()
  mission.updatedAt = mission.run.pausedAt
  appendRunLog(mission, '任务已暂停。', 'warning')
  persistMissions()
}

function abortMission(id, reason = '任务已由用户终止。') {
  const mission = requireMission(id)
  if (!ACTIVE_MISSION_STATUSES.includes(mission.status)) return
  mission.status = 'aborted'
  mission.run.phase = 'aborted'
  mission.run.abortedAt = new Date().toISOString()
  mission.updatedAt = mission.run.abortedAt
  appendRunLog(mission, reason, 'warning')
  persistMissions()
  const { archiveMissionRecord } = useInspectionStore()
  const record = archiveMissionRecord(mission)
  if (record) {
    showToast(`任务已终止，并归档至巡检记录（${record.id}）`, 'warning')
  }
}

function completeCurrentWaypointNavigation(id, detail = '已到达目标点，开始执行巡检动作。') {
  const mission = findMission(id)
  if (!mission || mission.status !== 'running' || mission.run.phase !== 'navigating') return false
  const waypoint = mission.waypoints[mission.run.currentWaypointIndex]
  if (!waypoint) return false
  mission.run.phase = 'inspecting'
  mission.run.elapsedSeconds = 0
  appendRunLog(mission, `“${waypoint.name}”${detail}`)
  persistMissions()
  return true
}

function tickMission(id, { onTimeout } = {}) {
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
      else abortMission(id, `前往“${waypoint.name}”导航超时（>${timeoutSeconds}s），任务已中止。`)
      return
    }
    persistMissions()
    return
  }

  if (run.phase !== 'inspecting') return
  const dwellSeconds = Math.max(1, waypoint.dwellSeconds || mission.dwellSeconds)
  if (run.elapsedSeconds < dwellSeconds) {
    persistMissions()
    return
  }

  run.completedVisits += 1
  const actions = waypoint.actions.map((action) => getActionLabel(action)).join('、')
  appendRunLog(mission, `完成“${waypoint.name}”的 ${actions}。`, 'success')

  const nextIndex = run.currentWaypointIndex + 1
  if (nextIndex < mission.waypoints.length) {
    run.currentWaypointIndex = nextIndex
    run.phase = 'navigating'
    run.elapsedSeconds = 0
  } else if (run.currentCycle < mission.loopCount) {
    run.currentCycle += 1
    run.currentWaypointIndex = 0
    run.phase = 'navigating'
    run.elapsedSeconds = 0
    appendRunLog(mission, `开始第 ${run.currentCycle} / ${mission.loopCount} 轮巡检。`)
  } else {
    mission.status = 'completed'
    run.phase = 'completed'
    run.currentWaypointIndex = -1
    run.elapsedSeconds = 0
    run.completedAt = new Date().toISOString()
    mission.updatedAt = run.completedAt
    appendRunLog(mission, '全部巡检点和循环已完成。', 'success')
    persistMissions()
    const { archiveMissionRecord } = useInspectionStore()
    const record = archiveMissionRecord(mission)
    if (record) {
      showToast(`巡检任务已完成，已生成记录 ${record.id}`, 'success')
    }
    return
  }
  persistMissions()
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
