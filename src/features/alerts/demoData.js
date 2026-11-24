import { demoRecords } from '../records/demoData.js'

function createAlert(config) {
  const record = demoRecords.find((item) => item.id === config.recordId)
  const anomaly = record?.anomalies.find((item) => item.id === config.id)
  if (!record || !anomaly) throw new Error(`演示告警 ${config.id} 缺少关联记录`)
  return {
    id: config.id,
    recordId: record.id,
    recordName: record.name,
    pointId: anomaly.pointId,
    pointName: anomaly.pointName,
    robotId: record.robotId,
    robotName: record.robotName,
    scene: record.scene,
    level: anomaly.level,
    title: anomaly.title,
    description: anomaly.description,
    recommendation: anomaly.recommendation,
    occurredAt: anomaly.occurredAt,
    reading: config.reading,
    threshold: config.threshold,
    status: config.status,
    acknowledgedAt: config.acknowledgedAt || '',
    acknowledgedBy: config.acknowledgedBy || '',
    resolution: config.resolution || '',
    resolutionNote: config.resolutionNote || '',
    handledAt: config.handledAt || '',
    handledBy: config.handledBy || ''
  }
}

export const demoAlerts = [
  createAlert({
    id: 'AL-20261124-001', recordId: 'RW-20261124-001', status: 'pending',
    reading: '68.4 °C', threshold: '温度 > 60 °C 触发'
  }),
  createAlert({
    id: 'AL-20261124-002', recordId: 'RW-20261124-001', status: 'acknowledged',
    reading: '0.6 m', threshold: '通道宽度 < 1.0 m 触发',
    acknowledgedAt: '2026-11-24T08:52:00', acknowledgedBy: '值班员 · 王工'
  }),
  createAlert({
    id: 'AL-20261123-003', recordId: 'RW-20261123-003', status: 'pending',
    reading: '2 次规划失败', threshold: '巡检点路径不可达'
  }),
  createAlert({
    id: 'AL-20261123-004', recordId: 'RW-20261123-004', status: 'resolved',
    reading: '120 lx', threshold: '光照 < 200 lx 触发', resolution: 'fixed',
    resolutionNote: '已检查通道照明并恢复两组灯具，后续巡检继续观察。',
    handledAt: '2026-11-23T19:20:00', handledBy: '运维员 · 李工'
  }),
  createAlert({
    id: 'AL-20261122-005', recordId: 'RW-20261122-005', status: 'resolved',
    reading: '15 %', threshold: '电量 < 20 % 触发', resolution: 'fixed',
    resolutionNote: '电池已充电并通过检查，未完成任务已重新排期。',
    handledAt: '2026-11-22T15:05:00', handledBy: '运维员 · 李工'
  }),
  createAlert({
    id: 'AL-20261121-006', recordId: 'RW-20261121-006', status: 'acknowledged',
    reading: '72 %RH', threshold: '湿度 > 65 %RH 触发',
    acknowledgedAt: '2026-11-21T09:20:00', acknowledgedBy: '值班员 · 王工'
  })
]

export function createDemoAlerts() {
  return demoAlerts.map((alert) => ({ ...alert }))
}
