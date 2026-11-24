export const alertLevelOptions = [
  { value: 'critical', label: '严重', tone: 'danger' },
  { value: 'warning', label: '警告', tone: 'warning' },
  { value: 'info', label: '提示', tone: 'info' }
]

export const alertStatusOptions = [
  { value: 'pending', label: '待确认', tone: 'danger' },
  { value: 'acknowledged', label: '已确认', tone: 'warning' },
  { value: 'resolved', label: '已处理', tone: 'success' }
]

export const resolutionOptions = [
  { value: 'fixed', label: '问题已消除' },
  { value: 'false-alarm', label: '误报关闭' },
  { value: 'follow-up', label: '已转交跟进' }
]

export function getAlertLevel(value) {
  return alertLevelOptions.find((item) => item.value === value) || { label: '未知', tone: 'muted' }
}

export function getAlertStatus(value) {
  return alertStatusOptions.find((item) => item.value === value) || { label: '未知', tone: 'muted' }
}

export function getResolutionLabel(value) {
  return resolutionOptions.find((item) => item.value === value)?.label || '已处理'
}

export function filterAlerts(alerts, filters) {
  return alerts
    .filter((alert) => (!filters.level || alert.level === filters.level)
      && (!filters.status || alert.status === filters.status)
      && (!filters.robotId || alert.robotId === filters.robotId))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
}

export function currentDateTime() {
  const date = new Date()
  const pad = (number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
