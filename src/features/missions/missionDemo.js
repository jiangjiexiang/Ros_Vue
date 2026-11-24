import { createRunState, normalizeMission } from './missionModel.js'

export const DEMO_ROBOTS = [
  {
    id: 'demo-dog-01',
    name: '四足机器狗 01',
    model: '四足机器人',
    namespace: 'demo_dog_01',
    isDemo: true
  },
  {
    id: 'demo-dog-02',
    name: '四足机器狗 02',
    model: '四足机器人',
    namespace: 'demo_dog_02',
    isDemo: true
  },
  {
    id: 'fishbot-sim',
    name: 'Fishbot 机器人',
    model: 'ROS 2 机器人',
    namespace: 'fishbot',
    isDemo: true
  }
]

export const DEMO_MAPS = [
  {
    id: 'demo-map-warehouse',
    name: '仓库场景',
    path: 'demo://warehouse',
    source: 'demo',
    isDemo: true
  },
  {
    id: 'demo-map-power',
    name: '配电间',
    path: 'demo://power-room',
    source: 'demo',
    isDemo: true
  },
  {
    id: 'demo-map-tunnel',
    name: '综合管廊',
    path: 'demo://utility-tunnel',
    source: 'demo',
    isDemo: true
  }
]

function point(id, name, x, y, yaw, actions, dwellSeconds = 8, actionSettings = {}) {
  return { id, name, pose: { x, y, yaw }, actions, dwellSeconds, actionSettings }
}

function log(id, minutesAgo, message, type = 'info') {
  return {
    id,
    time: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    type,
    message
  }
}

function demoMission(config) {
  const robot = DEMO_ROBOTS.find((item) => item.id === config.robotId) || DEMO_ROBOTS[0]
  const map = DEMO_MAPS.find((item) => item.id === config.mapId) || DEMO_MAPS[0]
  const updatedAt = new Date(Date.now() - (config.updatedMinutesAgo || 30) * 60_000).toISOString()
  return normalizeMission({
    description: '按既定路线完成设备巡检与状态采集。',
    loopCount: 1,
    dwellSeconds: 8,
    onFailure: 'stop',
    retryLimit: 2,
    status: 'pending',
    ...config,
    robotName: robot.name,
    map: { ...map },
    isDemo: true,
    createdAt: new Date(Date.now() - (config.createdDaysAgo || 2) * 86_400_000).toISOString(),
    updatedAt
  })
}

export function createDemoMissions() {
  return [
    demoMission({
      id: 'demo-mission-warehouse',
      name: '仓库例行巡检',
      robotId: 'demo-dog-01',
      mapId: 'demo-map-warehouse',
      loopCount: 2,
      onFailure: 'retry',
      waypoints: [
        point('demo-point-warehouse-1', '东门仪表', 1.2, 0.8, 0, ['photo', 'meter'], 8, {
          meter: { unit: 'bar', min: 0.35, max: 0.65 }
        }),
        point('demo-point-warehouse-2', '货架通道', 3.6, 1.4, 1.57, ['photo', 'gas'], 6, {
          gas: { gasType: '可燃气体', alarmAbove: 50, unit: '%LEL' }
        }),
        point('demo-point-warehouse-3', '配电柜', 4.2, -1.1, 3.14, ['photo', 'thermal'], 10, {
          thermal: { alarmAbove: 75 }
        })
      ],
      updatedMinutesAgo: 18
    }),
    demoMission({
      id: 'demo-mission-power-running',
      name: '配电间热成像巡检',
      robotId: 'demo-dog-02',
      mapId: 'demo-map-power',
      status: 'running',
      onFailure: 'skip',
      waypoints: [
        point('demo-point-power-1', '一号进线柜', 0.8, 1.1, 0, ['photo', 'thermal', 'meter'], 7),
        point('demo-point-power-2', '二号进线柜', 2.4, 1.1, 0, ['photo', 'thermal'], 7),
        point('demo-point-power-3', '变压器北侧', 3.2, -0.6, -1.57, ['thermal', 'gas'], 9)
      ],
      run: createRunState({
        currentCycle: 1,
        currentWaypointIndex: 1,
        completedVisits: 1,
        phase: 'inspecting',
        elapsedSeconds: 2,
        startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        logs: [
          log('demo-log-power-1', 5, '任务已开始。'),
          log('demo-log-power-2', 3, '已完成“一号进线柜”的巡检动作。', 'success')
        ]
      }),
      updatedMinutesAgo: 5
    }),
    demoMission({
      id: 'demo-mission-gas-paused',
      name: '管廊气体检测',
      robotId: 'demo-dog-01',
      mapId: 'demo-map-tunnel',
      status: 'paused',
      onFailure: 'stop',
      waypoints: [
        point('demo-point-gas-1', '管廊入口', -1.5, 0.5, 0, ['photo', 'gas'], 6),
        point('demo-point-gas-2', '阀门组', 0.5, 2.2, 1.57, ['photo', 'gas', 'meter'], 12)
      ],
      run: createRunState({
        currentCycle: 1,
        currentWaypointIndex: 1,
        completedVisits: 1,
        phase: 'navigating',
        elapsedSeconds: 1,
        startedAt: new Date(Date.now() - 42 * 60_000).toISOString(),
        pausedAt: new Date(Date.now() - 35 * 60_000).toISOString(),
        logs: [
          log('demo-log-gas-1', 42, '任务已开始。'),
          log('demo-log-gas-2', 35, '任务已暂停。', 'warning')
        ]
      }),
      updatedMinutesAgo: 35
    }),
    demoMission({
      id: 'demo-mission-completed',
      name: '仓库收班复检',
      robotId: 'demo-dog-02',
      mapId: 'demo-map-warehouse',
      status: 'completed',
      waypoints: [
        point('demo-point-complete-1', '西门', -2.2, 0.4, 3.14, ['photo'], 5),
        point('demo-point-complete-2', '消防器材', -1.2, -1.8, -1.57, ['photo', 'meter'], 6)
      ],
      run: createRunState({
        currentCycle: 1,
        currentWaypointIndex: -1,
        completedVisits: 2,
        phase: 'completed',
        startedAt: new Date(Date.now() - 26 * 60_000).toISOString(),
        completedAt: new Date(Date.now() - 22 * 60_000).toISOString(),
        logs: [
          log('demo-log-complete-1', 26, '任务已开始。'),
          log('demo-log-complete-2', 22, '全部巡检点和循环已完成。', 'success')
        ]
      }),
      updatedMinutesAgo: 22
    }),
    demoMission({
      id: 'demo-mission-aborted',
      name: '配电间临时巡检',
      robotId: 'fishbot-sim',
      mapId: 'demo-map-power',
      status: 'aborted',
      waypoints: [
        point('demo-point-abort-1', '低压柜', 1.1, 0.4, 0, ['photo', 'meter'], 5),
        point('demo-point-abort-2', '电容补偿柜', 2.5, 0.4, 0, ['photo', 'thermal'], 5)
      ],
      run: createRunState({
        currentCycle: 1,
        currentWaypointIndex: 0,
        completedVisits: 0,
        phase: 'aborted',
        startedAt: new Date(Date.now() - 90 * 60_000).toISOString(),
        abortedAt: new Date(Date.now() - 88 * 60_000).toISOString(),
        logs: [
          log('demo-log-abort-1', 90, '任务已开始。'),
          log('demo-log-abort-2', 88, '任务已由用户终止。', 'warning')
        ]
      }),
      updatedMinutesAgo: 88
    })
  ]
}
