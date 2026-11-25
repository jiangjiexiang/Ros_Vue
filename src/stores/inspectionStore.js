import { computed, ref } from 'vue'
import { API_BASE } from '../config.js'
import { currentDateTime } from '../features/alerts/utils.js'

const alerts = ref([])
const records = ref([])
const alertsLoaded = ref(false)
const recordsLoaded = ref(false)
const recentRuntimeAlertTimes = new Map()

const unhandledAlertCount = computed(() => (
  alerts.value.filter((alert) => alert.status !== 'resolved').length
))

async function persistCollection(collection, items) {
  try {
    await fetch(`${API_BASE}/${collection}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items })
    })
  } catch {}
}

function persistAlerts() {
  return persistCollection('alerts', alerts.value)
}

function persistRecords() {
  return persistCollection('records', records.value)
}

async function initInspectionStore() {
  if (alertsLoaded.value && recordsLoaded.value) return
  await Promise.all([
    (async () => {
      if (alertsLoaded.value) return
      try {
        const res = await fetch(`${API_BASE}/alerts`)
        if (res.ok) {
          const data = await res.json()
          if (data.hasData && Array.isArray(data.items)) {
            alerts.value = data.items
            alertsLoaded.value = true
            return
          }
        }
      } catch {}
      alerts.value = []
      alertsLoaded.value = true
    })(),
    (async () => {
      if (recordsLoaded.value) return
      try {
        const res = await fetch(`${API_BASE}/records`)
        if (res.ok) {
          const data = await res.json()
          if (data.hasData && Array.isArray(data.items)) {
            records.value = data.items
            recordsLoaded.value = true
            return
          }
        }
      } catch {}
      records.value = []
      recordsLoaded.value = true
    })()
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
  persistAlerts()
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
  if (count > 0) persistAlerts()
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
  persistAlerts()
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
  persistAlerts()
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
  persistRecords()
  return record
}

export function useInspectionStore() {
  return {
    alerts,
    records,
    alertsLoaded,
    recordsLoaded,
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
