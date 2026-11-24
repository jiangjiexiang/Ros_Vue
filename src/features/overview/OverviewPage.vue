<template>
  <div class="overview-page">
    <header class="overview-header">
      <div>
        <div class="title-row">
          <h1>巡检总览</h1>
          <span class="overview-date">{{ todayLabel }}</span>
        </div>
        <p>实时掌握机器狗在线状态、巡检任务进度与未闭环告警。</p>
      </div>

      <div class="overview-quick-actions">
        <RouterLink class="quick-btn primary" to="/inspection">
          <UiIcon name="activity" :size="15" />进入工作台
        </RouterLink>
        <RouterLink class="quick-btn" to="/missions/new">
          <UiIcon name="route" :size="15" />新建巡检任务
        </RouterLink>
        <RouterLink class="quick-btn" to="/simulation">
          <UiIcon name="cpu" :size="15" />启动仿真测试
        </RouterLink>
      </div>
    </header>

    <section class="runtime-kpi-grid" aria-label="实时运行指标">
      <article class="kpi-card" :class="{ online: isConnected }">
        <div class="kpi-icon"><UiIcon name="robot" :size="20" /></div>
        <div class="kpi-body">
          <span>在线机器狗</span>
          <strong>{{ isConnected ? 1 : 0 }} <small>/ {{ robots.length }} 台</small></strong>
          <p>{{ activeRobot.name }} · {{ isConnected ? '通信正常' : statusText }}</p>
        </div>
      </article>

      <article class="kpi-card">
        <div class="kpi-icon"><UiIcon name="battery" :size="20" /></div>
        <div class="kpi-body">
          <span>设备状态与电量</span>
          <strong>{{ batteryDisplay }}</strong>
          <p>{{ isConnected ? `${modeText} · 线速度 ${linearSpeed} m/s` : '等待机器狗接入' }}</p>
        </div>
      </article>

      <article class="kpi-card">
        <div class="kpi-icon"><UiIcon name="route" :size="20" /></div>
        <div class="kpi-body">
          <span>巡检任务</span>
          <strong>{{ missions.length }} <small>项</small></strong>
          <p>执行中 {{ runningMissionCount }} · 已完成 {{ completedMissionCount }}</p>
        </div>
      </article>

      <article class="kpi-card" :class="{ alert: unhandledAlertCount > 0 }">
        <div class="kpi-icon"><UiIcon name="alert" :size="20" /></div>
        <div class="kpi-body">
          <span>未闭环告警</span>
          <strong>{{ unhandledAlertCount }} <small>条</small></strong>
          <p>{{ criticalOpenCount > 0 ? `含 ${criticalOpenCount} 条严重告警待处理` : '暂无严重未闭环告警' }}</p>
        </div>
      </article>
    </section>

    <div class="activity-grid">
      <section class="activity-panel">
        <div class="section-heading compact">
          <div>
            <h2>最近巡检任务</h2>
            <p>同步任务编排与实时执行进度</p>
          </div>
          <RouterLink class="panel-more-link" to="/missions">全部任务 →</RouterLink>
        </div>
        <div v-if="recentTasks.length" class="activity-list">
          <button
            v-for="task in recentTasks"
            :key="task.id"
            type="button"
            class="activity-row"
            @click="openTask(task)"
          >
            <span class="row-marker task"><UiIcon name="route" :size="16" /></span>
            <span class="row-main">
              <span class="row-title">
                <strong>{{ task.name || '未命名任务' }}</strong>
                <span class="status-tag" :class="taskStatusClass(task.status)">{{ taskStatusText(task.status) }}</span>
              </span>
              <small>
                {{ task.robotName || '未指定机器狗' }} · {{ task.waypoints.length }} 个巡检点 · {{ formatDateTime(task.updatedAt || task.createdAt) }}
              </small>
            </span>
          </button>
        </div>
        <div v-else class="empty-state">暂无巡检任务，点击右上角“新建巡检任务”创建</div>
      </section>

      <section class="activity-panel">
        <div class="section-heading compact">
          <div>
            <h2>最新告警</h2>
            <p>优先关注待确认与严重告警</p>
          </div>
          <RouterLink class="panel-more-link" :class="{ 'has-alerts': unhandledAlertCount > 0 }" to="/alerts">
            {{ unhandledAlertCount }} 条未闭环 →
          </RouterLink>
        </div>
        <div v-if="latestAlerts.length" class="activity-list">
          <button
            v-for="alert in latestAlerts"
            :key="alert.id"
            type="button"
            class="activity-row alert-row"
            :class="alert.level"
            @click="openAlert(alert)"
          >
            <span class="row-marker"><UiIcon name="alert" :size="16" /></span>
            <span class="row-main">
              <span class="row-title">
                <strong>{{ alert.title }}</strong>
                <span class="handled-tag" :class="{ handled: alert.status === 'resolved' }">
                  {{ alert.status === 'resolved' ? '已处理' : alert.status === 'acknowledged' ? '已确认' : '待确认' }}
                </span>
              </span>
              <small>{{ alert.robotName }} · {{ formatDateTime(alert.occurredAt) }}</small>
              <p>{{ alert.description }}</p>
            </span>
          </button>
        </div>
        <div v-else class="empty-state">当前暂无告警记录</div>
      </section>
    </div>

    <AccessOverviewCard />
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import UiIcon from '../../components/UiIcon.vue'
import AccessOverviewCard from './AccessOverviewCard.vue'
import { useRobotStore } from '../../stores/robotStore.js'
import { useRosSessionStore } from '../../stores/rosSessionStore.js'
import { useInspectionStore } from '../../stores/inspectionStore.js'
import { useMissionStore } from '../missions/missionStore.js'

const router = useRouter()
const { robots, activeRobot } = useRobotStore()
const { isConnected, statusText, modeText, linearSpeed, batteryPercentage } = useRosSessionStore()
const { alerts, unhandledAlertCount, initInspectionStore } = useInspectionStore()
const { missions, initMissionsFromServer } = useMissionStore()

const todayLabel = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: 'long', day: 'numeric', weekday: 'short'
}).format(new Date())

const batteryDisplay = computed(() => {
  if (!isConnected.value) return '未连接'
  if (batteryPercentage.value >= 0) return `${batteryPercentage.value}%`
  return modeText.value
})

const runningMissionCount = computed(() => missions.value.filter((m) => m.status === 'running').length)
const completedMissionCount = computed(() => missions.value.filter((m) => m.status === 'completed').length)
const criticalOpenCount = computed(() => (
  alerts.value.filter((a) => a.level === 'critical' && a.status !== 'resolved').length
))

const recentTasks = computed(() => (
  [...missions.value]
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
    .slice(0, 5)
))

const latestAlerts = computed(() => (
  [...alerts.value]
    .sort((a, b) => {
      const aOpen = a.status !== 'resolved' ? 1 : 0
      const bOpen = b.status !== 'resolved' ? 1 : 0
      if (aOpen !== bOpen) return bOpen - aOpen
      return String(b.occurredAt || '').localeCompare(String(a.occurredAt || ''))
    })
    .slice(0, 5)
))

function formatDateTime(value) {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  const now = new Date()
  const sameDay = date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  const hhmm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return sameDay ? hhmm : `${date.getMonth() + 1}/${date.getDate()} ${hhmm}`
}

function taskStatusText(status) {
  return {
    pending: '待执行',
    running: '执行中',
    paused: '已暂停',
    completed: '已完成',
    aborted: '已终止'
  }[status] || status
}

function taskStatusClass(status) {
  return ['running', 'completed', 'aborted', 'pending', 'paused'].includes(status) ? status : 'unknown'
}

function openTask(task) {
  router.push(`/missions/${encodeURIComponent(task.id)}/run`)
}

function openAlert() {
  router.push('/alerts')
}

onMounted(() => {
  initMissionsFromServer()
  initInspectionStore()
})
</script>

<style scoped>
.overview-page {
  width: min(1440px, 100%);
  min-height: 100%;
  margin: 0 auto;
  padding: 24px;
  color: var(--text-primary);
}
.overview-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.title-row { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.overview-header h1 { font-size: 1.4rem; font-weight: 650; letter-spacing: 0.02em; }
.overview-header p { margin-top: 6px; color: var(--text-muted); font-size: var(--text-sm); }
.overview-date { color: var(--text-secondary); font-family: var(--font-mono); font-size: var(--text-xs); }
.overview-quick-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.quick-btn {
  display: inline-flex; align-items: center; gap: 7px; min-height: 38px; padding: 0 14px;
  border: 1px solid var(--border-color); border-radius: 9px; color: var(--text-secondary);
  background: var(--bg-card); font-size: var(--text-sm); font-weight: 500; text-decoration: none;
  transition: var(--transition);
}
.quick-btn:hover { border-color: var(--accent-primary); color: var(--accent-primary); }
.quick-btn.primary { border-color: transparent; color: #f0fdff; background: var(--accent-gradient); }

.runtime-kpi-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 20px; }
.kpi-card {
  display: flex; align-items: center; gap: 14px; min-width: 0; padding: 16px;
  border: 1px solid var(--border-color); border-radius: var(--radius-lg); background: var(--bg-card);
  box-shadow: var(--shadow-card);
}
.kpi-card.online { border-color: rgba(52, 211, 153, 0.3); }
.kpi-card.alert { border-color: rgba(251, 113, 133, 0.32); }
.kpi-icon {
  display: grid; place-items: center; width: 42px; height: 42px; flex: 0 0 auto; border-radius: 10px;
  color: var(--accent-primary); background: rgba(34, 211, 238, 0.08);
}
.kpi-card.online .kpi-icon { color: var(--success); background: rgba(52, 211, 153, 0.1); }
.kpi-card.alert .kpi-icon { color: var(--danger); background: rgba(251, 113, 133, 0.1); }
.kpi-body { min-width: 0; }
.kpi-body span { display: block; color: var(--text-muted); font-size: var(--text-xs); }
.kpi-body strong { display: block; margin-top: 6px; font-family: var(--font-mono); font-size: 1.32rem; font-weight: 600; }
.kpi-body strong small { color: var(--text-secondary); font-size: var(--text-xs); font-weight: 400; }
.kpi-body p { margin-top: 5px; overflow: hidden; color: var(--text-muted); font-size: var(--text-xs); text-overflow: ellipsis; white-space: nowrap; }

.activity-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-top: 18px; }
.activity-panel { min-width: 0; padding: 18px; border: 1px solid var(--border-color); border-radius: var(--radius-lg); background: rgba(15, 28, 46, 0.82); box-shadow: var(--shadow-card); }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.section-heading h2 { font-size: 0.98rem; font-weight: 600; }
.section-heading p { margin-top: 4px; color: var(--text-muted); font-size: var(--text-xs); }
.section-heading.compact { padding-bottom: 12px; border-bottom: 1px solid var(--border-color); }
.panel-more-link { color: var(--accent-primary); font-size: var(--text-xs); text-decoration: none; white-space: nowrap; }
.panel-more-link.has-alerts { color: var(--danger); }
.activity-list { display: flex; flex-direction: column; }
.activity-row { display: flex; align-items: flex-start; gap: 10px; width: 100%; padding: 12px 8px; border: 0; border-bottom: 1px solid var(--border-color); border-radius: 6px; color: var(--text-primary); background: transparent; text-align: left; cursor: pointer; transition: var(--transition); }
.activity-row:last-child { border-bottom-color: transparent; }
.activity-row:hover { background: var(--bg-soft); }
.row-marker { display: grid; place-items: center; width: 32px; height: 32px; flex: 0 0 auto; border-radius: 8px; color: var(--warning); background: rgba(251, 191, 36, 0.08); }
.row-marker.task { color: var(--accent-primary); background: rgba(34, 211, 238, 0.08); }
.alert-row.critical .row-marker { color: var(--danger); background: rgba(251, 113, 133, 0.09); }
.alert-row.info .row-marker { color: var(--accent-secondary); background: rgba(59, 130, 246, 0.09); }
.row-main { display: block; min-width: 0; flex: 1; }
.row-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.row-title > strong { overflow: hidden; font-size: var(--text-sm); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.row-main > small { display: block; margin-top: 5px; color: var(--text-muted); font-size: var(--text-xs); }
.row-main > p { margin-top: 5px; color: var(--text-secondary); font-size: var(--text-xs); line-height: 1.5; }
.status-tag, .handled-tag { flex: 0 0 auto; padding: 3px 8px; border-radius: 6px; color: var(--text-muted); background: var(--bg-soft); font-size: var(--text-xs); }
.status-tag.running { color: var(--accent-primary); background: rgba(34, 211, 238, 0.09); }
.status-tag.completed { color: var(--success); background: rgba(52, 211, 153, 0.09); }
.status-tag.aborted { color: var(--danger); background: rgba(251, 113, 133, 0.09); }
.status-tag.pending, .status-tag.paused { color: var(--warning); background: rgba(251, 191, 36, 0.09); }
.handled-tag { color: var(--danger); background: rgba(251, 113, 133, 0.09); }
.handled-tag.handled { color: var(--success); background: rgba(52, 211, 153, 0.08); }
.empty-state { display: grid; place-items: center; min-height: 120px; border: 1px dashed var(--border-color); border-radius: var(--radius-md); color: var(--text-muted); font-size: var(--text-sm); }

@media (max-width: 1120px) {
  .runtime-kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .activity-grid { grid-template-columns: 1fr; }
}
@media (max-width: 640px) {
  .overview-page { padding: 14px; }
  .runtime-kpi-grid { grid-template-columns: 1fr; }
}
</style>
