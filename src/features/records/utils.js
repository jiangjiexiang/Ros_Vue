export const recordResultOptions = [
  { value: 'completed', label: '已完成', tone: 'success' },
  { value: 'partial', label: '部分完成', tone: 'warning' },
  { value: 'failed', label: '执行失败', tone: 'danger' }
]

export const pointStatusOptions = [
  { value: 'normal', label: '正常', tone: 'success' },
  { value: 'abnormal', label: '异常', tone: 'danger' },
  { value: 'skipped', label: '未巡检', tone: 'muted' }
]

export function getRecordResult(value) {
  return recordResultOptions.find((item) => item.value === value) || { label: '未知', tone: 'muted' }
}

export function getPointStatus(value) {
  return pointStatusOptions.find((item) => item.value === value) || { label: '未知', tone: 'muted' }
}

export function formatDateTime(value, withSeconds = false) {
  if (!value) return '--'
  const [date, time = ''] = value.split('T')
  return `${date} ${time.slice(0, withSeconds ? 8 : 5)}`
}

export function formatTime(value) {
  return value?.split('T')[1]?.slice(0, 8) || '--:--:--'
}

export function formatDuration(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds < 0) return '--'
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const remainder = total % 60
  if (hours) return `${hours} 小时 ${minutes} 分`
  if (minutes) return `${minutes} 分 ${remainder} 秒`
  return `${remainder} 秒`
}

export function getCompletionRate(record) {
  if (!record?.points?.length) return 0
  const completed = record.points.filter((point) => point.status !== 'skipped').length
  return Math.round((completed / record.points.length) * 100)
}

export function filterRecords(records, filters) {
  return records.filter((record) => {
    const date = record.startedAt.slice(0, 10)
    return (!filters.robotId || record.robotId === filters.robotId)
      && (!filters.scene || record.scene === filters.scene)
      && (!filters.result || record.result === filters.result)
      && (!filters.startDate || date >= filters.startDate)
      && (!filters.endDate || date <= filters.endDate)
  })
}
