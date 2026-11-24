import { ref } from 'vue'
import { createDemoMissions } from './missionDemo.js'
import {
  ACTIVE_MISSION_STATUSES,
  DEMO_NAVIGATION_SECONDS,
  cloneData,
  createId,
  createRunState,
  getActionLabel,
  normalizeMission
} from './missionModel.js'

export const MISSION_STORAGE_KEY = 'robot-console-inspection-missions-v1'

function loadMissions() {
  try {
    const stored = globalThis.localStorage?.getItem(MISSION_STORAGE_KEY)
    if (stored != null) {
      const parsed = JSON.parse(stored)
      if (Array.isArray(parsed)) return parsed.map((mission) => normalizeMission(mission))
    }
  } catch (error) {
    console.warn('读取本地巡检任务失败，已加载内置任务。', error)
  }
  return createDemoMissions()
}

const missions = ref(loadMissions())
const storageError = ref('')

function persistMissions() {
  try {
    if (!globalThis.localStorage) return
    globalThis.localStorage.setItem(MISSION_STORAGE_KEY, JSON.stringify(missions.value))
    storageError.value = ''
  } catch (error) {
    console.warn('保存本地巡检任务失败。', error)
    storageError.value = '浏览器本地存储不可用，本次修改仅在当前页面有效。'
  }
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

function abortMission(id) {
  const mission = requireMission(id)
  if (!ACTIVE_MISSION_STATUSES.includes(mission.status)) return
  mission.status = 'aborted'
  mission.run.phase = 'aborted'
  mission.run.abortedAt = new Date().toISOString()
  mission.updatedAt = mission.run.abortedAt
  appendRunLog(mission, '任务已由用户终止。', 'warning')
  persistMissions()
}

function tickMission(id) {
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
    if (run.elapsedSeconds < DEMO_NAVIGATION_SECONDS) {
      persistMissions()
      return
    }
    run.phase = 'inspecting'
    run.elapsedSeconds = 0
    appendRunLog(mission, `已到达“${waypoint.name}”，开始执行巡检动作。`)
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
  }
  persistMissions()
}

export function useMissionStore() {
  return {
    missions,
    storageError,
    saveMission,
    duplicateMission,
    deleteMission,
    startMission,
    pauseMission,
    abortMission,
    tickMission
  }
}
