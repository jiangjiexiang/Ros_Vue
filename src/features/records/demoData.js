const robotDirectory = {
  'dog-01': '机器狗 01',
  'dog-02': '机器狗 02',
  'dog-03': '机器狗 03'
}

function addSeconds(value, seconds) {
  const date = new Date(new Date(value).getTime() + seconds * 1000)
  const pad = (number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function defaultSensors(kind, index) {
  const sensors = {
    substation: [
      { name: '设备温度', value: (42.6 + index * 1.7).toFixed(1), unit: '°C', reference: '0–60 °C' },
      { name: '环境湿度', value: 48 + index, unit: '%RH', reference: '20–70 %RH' },
      { name: '噪声', value: 52 + index, unit: 'dB', reference: '< 75 dB' }
    ],
    parking: [
      { name: '一氧化碳', value: 7 + index, unit: 'ppm', reference: '< 30 ppm' },
      { name: '环境温度', value: (21.2 + index * 0.4).toFixed(1), unit: '°C', reference: '5–35 °C' },
      { name: '环境湿度', value: 55 + index, unit: '%RH', reference: '20–80 %RH' }
    ],
    perimeter: [
      { name: '环境温度', value: (16.4 + index * 0.5).toFixed(1), unit: '°C', reference: '-10–45 °C' },
      { name: '光照强度', value: 680 + index * 45, unit: 'lx', reference: '≥ 200 lx' },
      { name: '风速', value: (2.1 + index * 0.3).toFixed(1), unit: 'm/s', reference: '< 10 m/s' }
    ],
    warehouse: [
      { name: '环境温度', value: (23.1 + index * 0.3).toFixed(1), unit: '°C', reference: '5–30 °C' },
      { name: '环境湿度', value: 45 + index, unit: '%RH', reference: '20–65 %RH' },
      { name: '烟雾浓度', value: (0.01 + index * 0.002).toFixed(3), unit: '%obs/m', reference: '< 0.1 %obs/m' }
    ]
  }
  return sensors[kind].map((sensor) => ({ ...sensor, status: 'normal' }))
}

function createRecord(config) {
  const startedAt = config.startedAt
  const endedAt = addSeconds(startedAt, config.duration)
  const issuesByPoint = Object.fromEntries(config.issues.map((issue) => [issue.pointId, issue]))
  let executedCount = 0
  const points = config.pointNames.map((name, index) => {
    const id = `P${String(index + 1).padStart(2, '0')}`
    const issue = issuesByPoint[id]
    const status = issue?.status || (executedCount < config.completedCount ? 'normal' : 'skipped')
    if (status !== 'skipped') executedCount += 1
    const inspected = status !== 'skipped'
    const inspectedAt = inspected ? addSeconds(startedAt, Math.round(config.duration * (index + 1) / (config.pointNames.length + 1))) : ''
    return {
      id,
      name,
      location: `${config.scene} · ${String(index + 1).padStart(2, '0')} 号位`,
      status,
      inspectedAt,
      duration: inspected ? 72 + index * 9 : 0,
      summary: issue?.summary || (inspected ? '图像与传感器读数正常，未发现需要处理的问题。' : '任务提前结束，该巡检点未执行。'),
      media: inspected ? (issue?.media || [
        { type: 'image', label: '可见光照片' },
        { type: 'video', label: '巡检短视频', duration: '00:08' }
      ]) : [],
      sensors: inspected ? (issue?.sensors || defaultSensors(config.sensorKind, index)) : []
    }
  })
  const anomalies = config.issues.map((issue) => {
    const point = points.find((item) => item.id === issue.pointId)
    return {
      id: issue.alertId,
      pointId: issue.pointId,
      pointName: point.name,
      level: issue.level,
      title: issue.title,
      description: issue.description,
      recommendation: issue.recommendation,
      occurredAt: point.inspectedAt || endedAt
    }
  })
  const resultText = {
    completed: '全部计划巡检点已执行，任务数据已归档。',
    partial: '存在未完成的巡检点，任务按部分完成归档。',
    failed: '任务因异常中止，保留已采集的巡检数据。'
  }[config.result]
  const timeline = [
    { time: startedAt, type: 'start', title: '任务开始', description: `${config.robotName} 已接收任务并前往首个巡检点。` },
    ...anomalies.map((item) => ({
      time: item.occurredAt,
      type: 'alert',
      title: item.title,
      description: `${item.pointName} · ${item.description}`
    })),
    {
      time: addSeconds(startedAt, Math.max(1, config.duration - 45)),
      type: 'progress',
      title: '巡检数据汇总',
      description: `已执行 ${points.filter((point) => point.status !== 'skipped').length}/${points.length} 个巡检点，记录 ${anomalies.length} 条异常。`
    },
    { time: endedAt, type: config.result === 'completed' ? 'success' : 'alert', title: config.result === 'completed' ? '任务完成' : '任务结束', description: resultText }
  ].sort((a, b) => a.time.localeCompare(b.time))

  return {
    id: config.id,
    name: config.name,
    robotId: config.robotId,
    robotName: config.robotName,
    scene: config.scene,
    startedAt,
    endedAt,
    duration: config.duration,
    result: config.result,
    points,
    anomalies,
    timeline
  }
}

export const demoRecords = [
  createRecord({
    id: 'RW-20261124-001',
    name: '变电站早间巡检',
    robotId: 'dog-01',
    robotName: robotDirectory['dog-01'],
    scene: '110kV 变电站',
    startedAt: '2026-11-24T08:30:00',
    duration: 1338,
    result: 'completed',
    completedCount: 6,
    sensorKind: 'substation',
    pointNames: ['1 号进线柜', '2 号进线柜', '主变压器', '无功补偿装置', '北侧电缆沟', '出站控制柜'],
    issues: [
      {
        pointId: 'P03', alertId: 'AL-20261124-001', level: 'critical', title: '主变压器温度超过阈值',
        summary: '红外测温显示设备表面温度偏高，已保留热成像占位记录。',
        description: '设备温度 68.4 °C，超过 60 °C 告警阈值。',
        recommendation: '安排运维人员复测温度并检查散热系统。',
        sensors: [
          { name: '设备温度', value: '68.4', unit: '°C', reference: '0–60 °C', status: 'danger' },
          { name: '环境湿度', value: '50', unit: '%RH', reference: '20–70 %RH', status: 'normal' },
          { name: '噪声', value: '55', unit: 'dB', reference: '< 75 dB', status: 'normal' }
        ],
        media: [{ type: 'thermal', label: '红外热成像' }, { type: 'image', label: '可见光照片' }]
      },
      {
        pointId: 'P05', alertId: 'AL-20261124-002', level: 'warning', title: '电缆沟通道狭窄',
        summary: '视觉检测发现通道内有临时物料，机器狗已减速通过。',
        description: '可通行宽度约 0.6 m，低于 1.0 m 建议值。',
        recommendation: '清理通道物料，保持巡检与应急通道畅通。',
        sensors: [
          { name: '可通行宽度', value: '0.6', unit: 'm', reference: '≥ 1.0 m', status: 'warning' },
          { name: '环境温度', value: '25.3', unit: '°C', reference: '5–35 °C', status: 'normal' },
          { name: '环境湿度', value: '52', unit: '%RH', reference: '20–70 %RH', status: 'normal' }
        ]
      }
    ]
  }),
  createRecord({
    id: 'RW-20261124-002', name: '停车场环境巡检', robotId: 'dog-02', robotName: robotDirectory['dog-02'],
    scene: '地下停车场', startedAt: '2026-11-24T10:15:00', duration: 1002, result: 'completed', completedCount: 5,
    sensorKind: 'parking', pointNames: ['B1 入口', '充电车位', '北侧配电间', '排风机房', 'B2 出口'], issues: []
  }),
  createRecord({
    id: 'RW-20261123-003', name: '变电站夜间复核', robotId: 'dog-01', robotName: robotDirectory['dog-01'],
    scene: '110kV 变电站', startedAt: '2026-11-23T21:05:00', duration: 1085, result: 'partial', completedCount: 5,
    sensorKind: 'substation', pointNames: ['1 号进线柜', '2 号进线柜', '主变压器', '西侧检修区', '北侧电缆沟', '出站控制柜'],
    issues: [{
      pointId: 'P04', alertId: 'AL-20261123-003', level: 'warning', status: 'skipped', title: '西侧检修区未到达',
      summary: '临时围栏阻断规划路径，机器狗绕行失败后跳过该点。',
      description: '连续两次路径规划失败，该点未采集图像与传感器数据。',
      recommendation: '确认检修围栏范围，恢复通道后补巡该点。'
    }]
  }),
  createRecord({
    id: 'RW-20261123-004', name: '厂区周界巡查', robotId: 'dog-03', robotName: robotDirectory['dog-03'],
    scene: '厂区周界', startedAt: '2026-11-23T18:40:00', duration: 1530, result: 'completed', completedCount: 4,
    sensorKind: 'perimeter', pointNames: ['东门', '北侧围墙', '物流通道', '西门'],
    issues: [{
      pointId: 'P03', alertId: 'AL-20261123-004', level: 'info', title: '物流通道光照偏低',
      summary: '现场光照低于补光建议值，机器狗已自动开启补光。',
      description: '测得光照强度 120 lx，低于 200 lx 建议值。',
      recommendation: '检查通道照明，夜间巡检时保持补光可用。',
      sensors: [
        { name: '环境温度', value: '17.4', unit: '°C', reference: '-10–45 °C', status: 'normal' },
        { name: '光照强度', value: '120', unit: 'lx', reference: '≥ 200 lx', status: 'warning' },
        { name: '风速', value: '2.7', unit: 'm/s', reference: '< 10 m/s', status: 'normal' }
      ]
    }]
  }),
  createRecord({
    id: 'RW-20261122-005', name: '停车场设备复查', robotId: 'dog-02', robotName: robotDirectory['dog-02'],
    scene: '地下停车场', startedAt: '2026-11-22T14:20:00', duration: 440, result: 'failed', completedCount: 2,
    sensorKind: 'parking', pointNames: ['B1 入口', '充电车位', '北侧配电间', '排风机房', 'B2 充电区', 'B2 出口'],
    issues: [{
      pointId: 'P02', alertId: 'AL-20261122-005', level: 'critical', title: '机器狗电量过低',
      summary: '电量降至 15%，安全策略触发返航，后续巡检点未执行。',
      description: '任务执行中电量低于 20% 安全阈值，无法继续巡检。',
      recommendation: '检查电池与充电桩，恢复后重新下发未完成任务。',
      sensors: [
        { name: '剩余电量', value: '15', unit: '%', reference: '≥ 20 %', status: 'danger' },
        { name: '电池电压', value: '22.1', unit: 'V', reference: '23–29 V', status: 'warning' },
        { name: '一氧化碳', value: '8', unit: 'ppm', reference: '< 30 ppm', status: 'normal' }
      ]
    }]
  }),
  createRecord({
    id: 'RW-20261121-006', name: '成品仓库安全巡检', robotId: 'dog-01', robotName: robotDirectory['dog-01'],
    scene: '成品仓库', startedAt: '2026-11-21T09:00:00', duration: 876, result: 'completed', completedCount: 5,
    sensorKind: 'warehouse', pointNames: ['仓库入口', 'A 区货架', 'B 区货架', '消防设施', '发货缓冲区'],
    issues: [{
      pointId: 'P02', alertId: 'AL-20261121-006', level: 'warning', title: 'A 区货架湿度偏高',
      summary: '局部湿度达到 72 %RH，其他读数正常。',
      description: '环境湿度 72 %RH，超过 65 %RH 告警阈值。',
      recommendation: '检查除湿设备与货物堆放间距，持续关注湿度变化。',
      sensors: [
        { name: '环境温度', value: '23.4', unit: '°C', reference: '5–30 °C', status: 'normal' },
        { name: '环境湿度', value: '72', unit: '%RH', reference: '20–65 %RH', status: 'warning' },
        { name: '烟雾浓度', value: '0.013', unit: '%obs/m', reference: '< 0.1 %obs/m', status: 'normal' }
      ]
    }]
  })
]
