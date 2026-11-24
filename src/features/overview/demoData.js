function atToday(hour, minute) {
  const date = new Date()
  date.setHours(hour, minute, 0, 0)
  return date.toISOString()
}

export const DEMO_DOGS = [
  {
    id: 'dog-01',
    name: '巡检犬 01',
    online: true,
    battery: { percentage: 82, voltage: 25.1 },
    location: 'A 区 · 1 号配电室',
    currentTask: '配电柜例行巡检'
  },
  {
    id: 'dog-02',
    name: '巡检犬 02',
    online: true,
    battery: { percentage: 64, voltage: 24.3 },
    location: 'B 区 · 管廊入口',
    currentTask: '管廊热成像巡检'
  },
  {
    id: 'dog-03',
    name: '巡检犬 03',
    online: false,
    battery: { percentage: null, voltage: null },
    location: 'C 区 · 充电点',
    currentTask: null
  }
]

export const DEMO_TASKS = [
  {
    id: 'task-001',
    name: '配电柜例行巡检',
    dogName: '巡检犬 01',
    status: 'running',
    scheduledAt: atToday(10, 0),
    startedAt: atToday(10, 10),
    completedAt: null
  },
  {
    id: 'task-002',
    name: '管廊热成像巡检',
    dogName: '巡检犬 02',
    status: 'running',
    scheduledAt: atToday(9, 30),
    startedAt: atToday(9, 50),
    completedAt: null
  },
  {
    id: 'task-003',
    name: '水泵房仪表抄读',
    dogName: '巡检犬 01',
    status: 'completed',
    scheduledAt: atToday(8, 50),
    startedAt: atToday(9, 0),
    completedAt: atToday(9, 26)
  },
  {
    id: 'task-004',
    name: '仓库安全巡查',
    dogName: '巡检犬 03',
    status: 'completed',
    scheduledAt: atToday(8, 10),
    startedAt: atToday(8, 20),
    completedAt: atToday(8, 44)
  },
  {
    id: 'task-005',
    name: '管廊入口复查',
    dogName: '巡检犬 02',
    status: 'failed',
    scheduledAt: atToday(7, 30),
    startedAt: atToday(7, 40),
    completedAt: atToday(8, 2)
  },
  {
    id: 'task-006',
    name: '配电室首轮巡检',
    dogName: '巡检犬 01',
    status: 'completed',
    scheduledAt: atToday(6, 50),
    startedAt: atToday(7, 0),
    completedAt: atToday(7, 22)
  }
]

export const DEMO_ALERTS = [
  {
    id: 'alert-001',
    title: '足端温度偏高',
    message: '右后足端温度 58.4 °C，请安排现场复查。',
    dogName: '巡检犬 02',
    level: 'critical',
    handled: false,
    timestamp: atToday(10, 18)
  },
  {
    id: 'alert-002',
    title: '设备连接中断',
    message: '设备心跳已中断，请检查网络与电源。',
    dogName: '巡检犬 03',
    level: 'warning',
    handled: false,
    timestamp: atToday(10, 5)
  },
  {
    id: 'alert-003',
    title: '巡检路线偏离',
    message: '设备已恢复至规划路线，事件已确认。',
    dogName: '巡检犬 01',
    level: 'info',
    handled: true,
    timestamp: atToday(9, 42)
  },
  {
    id: 'alert-004',
    title: '低电量提醒',
    message: '任务结束后已返回充电点，告警已确认。',
    dogName: '巡检犬 03',
    level: 'warning',
    handled: true,
    timestamp: atToday(8, 48)
  }
]
