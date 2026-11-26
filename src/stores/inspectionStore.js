import { computed, ref } from 'vue'
import { API_BASE, apiFetch } from '../config.js'
import { currentDateTime } from '../features/alerts/utils.js'
import { cloneCollection, collectionConflictError, collectionsEqual, mergeCollectionById } from './collectionSync.js'
import { showToast } from './toastStore.js'

const alerts = ref([])
const records = ref([])
const alertsLoaded = ref(false)
const recordsLoaded = ref(false)
const alertsVersion = ref(0)
const recordsVersion = ref(0)
const storageError = ref('')
const recentRuntimeAlertTimes = new Map()

const unhandledAlertCount = computed(() => (
  alerts.value.filter((alert) => alert.status !== 'resolved').length
))

const collections = {
  alerts: { items: alerts, loaded: alertsLoaded, version: alertsVersion, base: null, revision: 0, saveQueue: Promise.resolve(), label: '告警' },
  records: { items: records, loaded: recordsLoaded, version: recordsVersion, base: null, revision: 0, saveQueue: Promise.resolve(), label: '巡检记录' }
}

function reportStorageError(error) {
  storageError.value = error.message || '巡检数据保存失败'
  showToast(storageError.value, 'error')
}

async function readJsonResponse(res, action) {
  try {
    return await res.json()
  } catch {
    throw new Error(`${action}返回了无效 JSON（HTTP ${res.status}）`)
  }
}

async function putCollection(collection, items, version) {
  const res = await apiFetch(`${API_BASE}/${collection}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, version })
  })
  const data = await readJsonResponse(res, '保存巡检数据')
  return { res, data }
}

async function saveCollectionNow(collection) {
  const state = collections[collection]
  if (!state.loaded.value || !state.base) throw new Error(`${state.label}尚未完成服务器加载，已取消保存以避免覆盖`)
  const localSnapshot = cloneCollection(state.items.value)
  const baseSnapshot = cloneCollection(state.base)
  const revision = state.revision
  let payload = localSnapshot
  let version = state.version.value
  let merged = null

  for (let attempt = 0; attempt < 3; attempt++) {
    const { res, data } = await putCollection(collection, payload, version)
    if (res.status === 409) {
      if (!Array.isArray(data.items)) throw new Error('409 响应缺少服务器集合，本地修改已保留')
      const serverItems = cloneCollection(data.items)
      version = Number.isFinite(Number(data.version)) ? Number(data.version) : version
      merged = mergeCollectionById(baseSnapshot, localSnapshot, serverItems)
      if (collectionsEqual(merged.items, serverItems)) {
        state.base = cloneCollection(serverItems)
        state.version.value = version
        if (state.revision === revision) state.items.value = cloneCollection(merged.localItems)
        if (merged.conflicts.length) throw collectionConflictError(state.label, merged.conflicts)
        storageError.value = ''
        return { success: true, version }
      }
      payload = merged.items
      continue
    }
    if (!res.ok || data.success === false) {
      throw new Error(data.error || data.message || `保存${state.label}失败（HTTP ${res.status}）`)
    }
    state.base = cloneCollection(payload)
    if (Number.isFinite(Number(data.version))) state.version.value = Number(data.version)
    if (merged && state.revision === revision) state.items.value = cloneCollection(merged.localItems)
    if (merged?.conflicts.length) throw collectionConflictError(state.label, merged.conflicts)
    storageError.value = ''
    return data
  }
  throw new Error(`${state.label}连续发生版本冲突，本地修改已保留，请稍后重试`)
}

function persistCollection(collection) {
  const state = collections[collection]
  const result = state.saveQueue.catch(() => {}).then(() => saveCollectionNow(collection))
  state.saveQueue = result
  return result
}

async function persistAlerts() {
  return await persistCollection('alerts')
}

async function persistRecords() {
  return await persistCollection('records')
}

function markCollectionDirty(collection) {
  collections[collection].revision++
}

async function loadCollection(collection) {
  const state = collections[collection]
  if (state.loaded.value) return
  try {
    const res = await apiFetch(`${API_BASE}/${collection}`)
    const data = await readJsonResponse(res, '加载巡检数据')
    if (!res.ok) throw new Error(data.error || data.message || `加载巡检数据失败（HTTP ${res.status}）`)
    if (data.hasData && !Array.isArray(data.items)) throw new Error('服务器巡检数据格式无效')
    const serverItems = cloneCollection(data.items)
    const hasDirty = state.base ? !collectionsEqual(state.items.value, state.base) : state.revision > 0
    if (!hasDirty) {
      state.items.value = cloneCollection(serverItems)
      state.base = cloneCollection(serverItems)
    } else {
      const merged = mergeCollectionById(state.base || [], state.items.value, serverItems)
      state.items.value = cloneCollection(merged.localItems)
      state.base = cloneCollection(serverItems)
      if (merged.conflicts.length) {
        storageError.value = collectionConflictError(state.label, merged.conflicts).message
        showToast(storageError.value, 'error')
      }
    }
    if (Number.isFinite(Number(data.version))) state.version.value = Number(data.version)
    state.loaded.value = true
    if (!storageError.value) storageError.value = ''
  } catch (error) {
    storageError.value = error.message || '巡检数据加载失败'
    showToast(storageError.value, 'error')
  }
}

async function initInspectionStore() {
  if (alertsLoaded.value && recordsLoaded.value) return
  await Promise.all([
    loadCollection('alerts'),
    loadCollection('records')
  ])
}

function acknowledgeAlert(id) {
  const alert = alerts.value.find((item) => item.id === id)
  if (!alert || alert.status !== 'pending') return null
  Object.assign(alert, {
    status: 'acknowledged',
    acknowledgedAt: currentDateTime(),
    acknowledgedBy: '值班员'
  })
  markCollectionDirty('alerts')
  void persistAlerts().catch(reportStorageError)
  return alert
}

function bulkAcknowledgeAlerts() {
  const now = currentDateTime()
  let count = 0
  for (const alert of alerts.value) {
    if (alert.status === 'pending') {
      Object.assign(alert, {
        status: 'acknowledged',
        acknowledgedAt: now,
        acknowledgedBy: '值班员'
      })
      count += 1
    }
  }
  if (count > 0) {
    markCollectionDirty('alerts')
    void persistAlerts().catch(reportStorageError)
  }
  return count
}

function resolveAlert(id, resolution, note) {
  const alert = alerts.value.find((item) => item.id === id)
  if (!alert || alert.status !== 'acknowledged') return null
  Object.assign(alert, {
    status: 'resolved',
    resolution,
    resolutionNote: note,
    handledAt: currentDateTime(),
    handledBy: '值班员'
  })
  markCollectionDirty('alerts')
  void persistAlerts().catch(reportStorageError)
  return alert
}

function pushRuntimeAlert({
  dedupeKey = '',
  robotId = 'runtime',
  robotName = '当前机器狗',
  scene = '实时监控',
  level = 'warning',
  title = '运行异常告警',
  description = '',
  recommendation = '请检查设备连接与运行状态。',
  reading = '--',
  threshold = '运行态监控触发',
  cooldownMs = 60000
} = {}) {
  const nowMs = Date.now()
  if (dedupeKey) {
    const lastMs = recentRuntimeAlertTimes.get(dedupeKey) || 0
    if (nowMs - lastMs < cooldownMs) return null
    recentRuntimeAlertTimes.set(dedupeKey, nowMs)
  }

  const stamp = currentDateTime()
  const alert = {
    id: `AL-RT-${nowMs}`,
    recordId: '',
    recordName: '实时运行监控',
    pointId: 'RUNTIME',
    pointName: '实时工作台',
    robotId,
    robotName,
    scene,
    level,
    title,
    description,
    recommendation,
    occurredAt: stamp,
    reading,
    threshold,
    status: 'pending',
    acknowledgedAt: '',
    acknowledgedBy: '',
    resolution: '',
    resolutionNote: '',
    handledAt: '',
    handledBy: ''
  }
  alerts.value.unshift(alert)
  if (alerts.value.length > 500) {
    alerts.value = alerts.value.slice(0, 500)
  }
  markCollectionDirty('alerts')
  void persistAlerts().catch(reportStorageError)
  return alert
}

function formatLocalIso(value) {
  const date = value ? new Date(value) : new Date()
  if (Number.isNaN(date.getTime())) return currentDateTime()
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function archiveMissionRecord(mission) {
  if (!mission) return null
  const startedIso = mission.run?.startedAt || mission.updatedAt || new Date().toISOString()
  const endedIso = mission.run?.completedAt || mission.run?.abortedAt || new Date().toISOString()
  const startMs = new Date(startedIso).getTime()
  const endMs = new Date(endedIso).getTime()
  const duration = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
    ? Math.max(1, Math.round((endMs - startMs) / 1000))
    : 1

  const waypoints = Array.isArray(mission.waypoints) ? mission.waypoints : []
  const completedVisits = Number(mission.run?.completedVisits || 0)
  const completedInCycle = mission.status === 'completed'
    ? waypoints.length
    : Math.min(waypoints.length, completedVisits)

  const scene = mission.map?.name || '未指定场景'
  const points = waypoints.map((wp, index) => {
    const inspected = index < completedInCycle
    const pid = `P${String(index + 1).padStart(2, '0')}`
    return {
      id: pid,
      name: wp.name || `巡检点 ${index + 1}`,
      location: `${scene} · X ${Number(wp.pose?.x || 0).toFixed(2)}, Y ${Number(wp.pose?.y || 0).toFixed(2)}`,
      status: inspected ? 'normal' : 'skipped',
      inspectedAt: inspected ? formatLocalIso(endedIso) : '',
      duration: inspected ? Math.max(1, Number(wp.dwellSeconds || mission.dwellSeconds || 8)) : 0,
      summary: inspected ? '巡检任务已到达该点位并完成预定动作。' : '任务提前终止，该巡检点未执行。',
      media: inspected ? [{ type: 'image', label: '巡检抓拍占位' }] : [],
      sensors: []
    }
  })

  const logs = Array.isArray(mission.run?.logs) ? mission.run.logs : []
  const timeline = logs.map((entry) => ({
    time: formatLocalIso(entry.time),
    type: entry.type === 'warning' ? 'alert' : entry.type === 'success' ? 'success' : 'progress',
    title: entry.type === 'warning' ? '任务告警/中断' : entry.type === 'success' ? '阶段完成' : '任务事件',
    description: entry.message
  }))

  const recordId = `RW-${Date.now()}`
  const record = {
    id: recordId,
    name: mission.name || '巡检任务',
    robotId: mission.robotId || 'robot-1',
    robotName: mission.robotName || '机器狗',
    scene,
    startedAt: formatLocalIso(startedIso),
    endedAt: formatLocalIso(endedIso),
    duration,
    result: mission.status === 'completed' ? 'completed' : (completedInCycle > 0 ? 'partial' : 'failed'),
    points,
    anomalies: [],
    timeline
  }

  records.value.unshift(record)
  if (records.value.length > 500) {
    records.value = records.value.slice(0, 500)
  }
  markCollectionDirty('records')
  void persistRecords().catch(reportStorageError)
  return record
}

export function useInspectionStore() {
  return {
    alerts,
    records,
    alertsLoaded,
    recordsLoaded,
    alertsVersion,
    recordsVersion,
    storageError,
    unhandledAlertCount,
    initInspectionStore,
    acknowledgeAlert,
    bulkAcknowledgeAlerts,
    resolveAlert,
    pushRuntimeAlert,
    archiveMissionRecord,
    persistAlerts,
    persistRecords
  }
}
