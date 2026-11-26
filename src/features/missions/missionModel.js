export const MISSION_STATUSES = [
  { value: 'pending', label: '待执行' },
  { value: 'running', label: '执行中' },
  { value: 'paused', label: '已暂停' },
  { value: 'completed', label: '已完成' },
  { value: 'aborted', label: '已终止' }
]

export const ACTION_DEFINITIONS = [
  { value: 'photo', label: '拍照', description: '采集可见光图像' },
  { value: 'thermal', label: '热成像', description: '采集热成像并检查温度' },
  { value: 'meter', label: '仪表读数', description: '记录仪表图像与读数' },
  { value: 'gas', label: '气体检测', description: '采集气体浓度并检查阈值' }
]

export const FAILURE_POLICIES = [
  { value: 'stop', label: '停止任务', description: '任一巡检点失败后终止任务' },
  { value: 'skip', label: '跳过并继续', description: '记录异常，继续下一个巡检点' },
  { value: 'retry', label: '重试当前点', description: '按设定次数重试，仍失败则停止' }
]

export const ACTIVE_MISSION_STATUSES = ['running', 'paused']

export function cloneData(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

export function createId(prefix = 'mission') {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${id}`
}

function numberOr(value, fallback = 0) {
  if (value === '' || value == null) return fallback
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function nullableNumber(value) {
  if (value === '' || value == null) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function createActionSettings(settings = {}) {
  return {
    thermal: {
      alarmAbove: nullableNumber(settings.thermal?.alarmAbove) ?? 80
    },
    meter: {
      unit: settings.meter?.unit || '',
      min: nullableNumber(settings.meter?.min),
      max: nullableNumber(settings.meter?.max)
    },
    gas: {
      gasType: settings.gas?.gasType || '可燃气体',
      alarmAbove: nullableNumber(settings.gas?.alarmAbove) ?? 50,
      unit: settings.gas?.unit || '%LEL'
    }
  }
}

export function createNavigationSettings(settings = {}) {
  return {
    maxLinearSpeed: Math.max(0.1, Math.min(2.0, numberOr(settings.maxLinearSpeed, 0.5))),
    maxAngularSpeed: Math.max(0.1, Math.min(3.0, numberOr(settings.maxAngularSpeed, 1.0))),
    goalTolerance: Math.max(0.05, Math.min(1.0, numberOr(settings.goalTolerance, 0.15))),
    navigationTimeoutSeconds: Math.max(5, Math.min(600, Math.round(numberOr(settings.navigationTimeoutSeconds, 60))))
  }
}

export function createWaypoint(input = {}, index = 0) {
  const validActions = ACTION_DEFINITIONS.map((action) => action.value)
  const actions = Array.isArray(input.actions)
    ? input.actions.filter((action, position) => validActions.includes(action) && input.actions.indexOf(action) === position)
    : ['photo']

  return {
    id: input.id || createId('point'),
    name: input.name || `巡检点 ${index + 1}`,
    pose: {
      x: nullableNumber(input.pose?.x ?? input.x),
      y: nullableNumber(input.pose?.y ?? input.y),
      yaw: nullableNumber(input.pose?.yaw ?? input.yaw)
    },
    actions,
    actionSettings: createActionSettings(input.actionSettings),
    dwellSeconds: Math.max(1, Math.min(600, Math.round(numberOr(input.dwellSeconds, 8)))),
    note: input.note || ''
  }
}

export function createRunState(input = {}) {
  return {
    currentCycle: Math.max(0, Math.round(numberOr(input.currentCycle))),
    currentWaypointIndex: Math.round(numberOr(input.currentWaypointIndex, -1)),
    completedVisits: Math.max(0, Math.round(numberOr(input.completedVisits))),
    phase: input.phase || 'idle',
    elapsedSeconds: Math.max(0, Math.round(numberOr(input.elapsedSeconds))),
    retryCount: Math.max(0, Math.round(numberOr(input.retryCount))),
    startedAt: input.startedAt || null,
    pausedAt: input.pausedAt || null,
    completedAt: input.completedAt || null,
    abortedAt: input.abortedAt || null,
    logs: Array.isArray(input.logs) ? input.logs.slice(-80) : []
  }
}

export function createEmptyMission() {
  const now = new Date().toISOString()
  return {
    id: '',
    name: '',
    description: '',
    robotId: '',
    robotName: '',
    map: { id: '', name: '', path: '', source: '', isDemo: false },
    waypoints: [],
    dwellSeconds: 8,
    loopCount: 1,
    onFailure: 'stop',
    retryLimit: 2,
    navigation: createNavigationSettings(),
    status: 'pending',
    isDemo: false,
    createdAt: now,
    updatedAt: now,
    run: createRunState()
  }
}

export function normalizeMission(input = {}) {
  const defaults = createEmptyMission()
  const validStatus = MISSION_STATUSES.some((status) => status.value === input.status)
  const validPolicy = FAILURE_POLICIES.some((policy) => policy.value === input.onFailure)
  return {
    ...defaults,
    ...input,
    id: input.id || createId('mission'),
    name: input.name || '',
    description: input.description || '',
    robotId: input.robotId || '',
    robotName: input.robotName || '',
    map: {
      ...defaults.map,
      ...(input.map || {})
    },
    waypoints: Array.isArray(input.waypoints)
      ? input.waypoints.map((point, index) => createWaypoint(point, index))
      : [],
    dwellSeconds: Math.max(1, Math.min(600, Math.round(numberOr(input.dwellSeconds, 8)))),
    loopCount: Math.max(1, Math.min(99, Math.round(numberOr(input.loopCount, 1)))),
    onFailure: validPolicy ? input.onFailure : 'stop',
    retryLimit: Math.max(1, Math.min(5, Math.round(numberOr(input.retryLimit, 2)))),
    navigation: createNavigationSettings(input.navigation),
    status: validStatus ? input.status : 'pending',
    isDemo: Boolean(input.isDemo),
    run: createRunState(input.run)
  }
}

export function validateMission(mission) {
  const errors = []
  if (!mission.name?.trim()) errors.push('请填写任务名称。')
  if (!mission.robotId) errors.push('请选择执行任务的机器狗。')
  if (!mission.map?.path) errors.push('请选择地图场景。')
  if (!mission.waypoints?.length) errors.push('请至少添加一个巡检点。')

  mission.waypoints?.forEach((point, index) => {
    const label = point.name?.trim() || `巡检点 ${index + 1}`
    if (!point.name?.trim()) errors.push(`第 ${index + 1} 个巡检点需要名称。`)
    const invalidPoseKeys = ['x', 'y', 'yaw'].filter((key) => {
      const value = point.pose?.[key]
      return value === '' || value == null || !Number.isFinite(Number(value))
    })
    if (invalidPoseKeys.length) {
      errors.push(`${label} 的坐标/朝向缺失或不是有效数字（${invalidPoseKeys.join('、')}），请补充完整。`)
    }
    if (!Number.isInteger(Number(point.dwellSeconds)) || point.dwellSeconds < 1 || point.dwellSeconds > 600) {
      errors.push(`${label} 的停留时间应为 1～600 秒的整数。`)
    }
    if (!point.actions?.length) errors.push(`${label} 至少需要选择一种巡检动作。`)
    const min = point.actionSettings?.meter?.min
    const max = point.actionSettings?.meter?.max
    if (min != null && max != null && Number(min) > Number(max)) {
      errors.push(`${label} 的仪表读数下限不能大于上限。`)
    }
  })

  if (!Number.isFinite(Number(mission.dwellSeconds)) || mission.dwellSeconds < 1 || mission.dwellSeconds > 600) {
    errors.push('默认停留时间应为 1～600 秒。')
  }
  if (!Number.isInteger(Number(mission.loopCount)) || mission.loopCount < 1 || mission.loopCount > 99) {
    errors.push('循环次数应为 1～99 的整数。')
  }
  const navigation = mission.navigation || {}
  if (!Number.isFinite(Number(navigation.maxLinearSpeed)) || navigation.maxLinearSpeed < 0.1 || navigation.maxLinearSpeed > 2.0) {
    errors.push('最大线速度应为 0.1～2.0 m/s。')
  }
  if (!Number.isFinite(Number(navigation.maxAngularSpeed)) || navigation.maxAngularSpeed < 0.1 || navigation.maxAngularSpeed > 3.0) {
    errors.push('最大角速度应为 0.1～3.0 rad/s。')
  }
  if (!Number.isFinite(Number(navigation.goalTolerance)) || navigation.goalTolerance < 0.05 || navigation.goalTolerance > 1.0) {
    errors.push('目标容差应为 0.05～1.0 m。')
  }
  if (!Number.isInteger(Number(navigation.navigationTimeoutSeconds)) || navigation.navigationTimeoutSeconds < 5 || navigation.navigationTimeoutSeconds > 600) {
    errors.push('单点导航超时应为 5～600 秒的整数。')
  }
  return errors
}

export function getMissionProgress(mission) {
  const total = Math.max(1, (mission.waypoints?.length || 0) * (mission.loopCount || 1))
  const completed = mission.status === 'completed'
    ? total
    : Math.min(total, Math.max(0, mission.run?.completedVisits || 0))
  return {
    completed,
    total,
    percent: Math.round((completed / total) * 100)
  }
}

export function getStatusLabel(status) {
  return MISSION_STATUSES.find((item) => item.value === status)?.label || status
}

export function getActionLabel(action) {
  return ACTION_DEFINITIONS.find((item) => item.value === action)?.label || action
}

export function getFailureLabel(policy) {
  return FAILURE_POLICIES.find((item) => item.value === policy)?.label || policy
}

export function getMapKey(map) {
  return map?.path ? `${map.source || 'unknown'}:${map.path}` : ''
}

export function isActiveMission(mission) {
  return ACTIVE_MISSION_STATUSES.includes(mission?.status)
}
