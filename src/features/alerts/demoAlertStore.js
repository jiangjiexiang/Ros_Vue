import { ref } from 'vue'
import { createDemoAlerts } from './demoData.js'
import { currentDateTime } from './utils.js'

export const alertSession = ref(createDemoAlerts())

export function acknowledgeAlert(id) {
  const alert = alertSession.value.find((item) => item.id === id)
  if (!alert || alert.status !== 'pending') return null
  Object.assign(alert, {
    status: 'acknowledged',
    acknowledgedAt: currentDateTime(),
    acknowledgedBy: '值班员'
  })
  return alert
}

export function resolveAlert(id, resolution, note) {
  const alert = alertSession.value.find((item) => item.id === id)
  if (!alert || alert.status !== 'acknowledged') return null
  Object.assign(alert, {
    status: 'resolved',
    resolution,
    resolutionNote: note,
    handledAt: currentDateTime(),
    handledBy: '值班员'
  })
  return alert
}
