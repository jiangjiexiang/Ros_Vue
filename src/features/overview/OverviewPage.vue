<template>
  <div class="overview-page">
    <header class="overview-header">
      <div>
        <div class="title-row">
          <h1>巡检总览</h1>
        </div>
        <p>核对实际接入方案，集中查看任务进展与待处理告警。</p>
      </div>
      <span class="overview-date">{{ todayLabel }}</span>
    </header>

    <AccessOverviewCard />

    <div class="activity-grid">
      <section class="activity-panel">
        <div class="section-heading compact">
          <div>
            <h2>最近任务</h2>
            <p>按任务开始或计划时间排序</p>
          </div>
          <span>{{ recentTasks.length }} 项</span>
        </div>
        <div v-if="recentTasks.length" class="activity-list">
          <button
            v-for="(task, index) in recentTasks"
            :key="task.id || task.name || index"
            type="button"
            class="activity-row"
            @click="selectTask(task)"
          >
            <span class="row-marker task"><UiIcon name="route" :size="16" /></span>
            <span class="row-main">
              <span class="row-title">
                <strong>{{ textOrPlaceholder(task.name) }}</strong>
                <span class="status-tag" :class="taskStatusClass(task.status)">{{ taskStatusText(task.status) }}</span>
              </span>
              <small>{{ textOrPlaceholder(task.dogName) }} · {{ formatDateTime(taskActivityTime(task)) }}</small>
            </span>
          </button>
        </div>
        <div v-else class="empty-state">暂无任务数据</div>
      </section>

      <section class="activity-panel">
        <div class="section-heading compact">
          <div>
            <h2>最新告警</h2>
            <p>优先跟进未处理事件</p>
          </div>
          <span :class="{ 'has-alerts': unhandledCount > 0 }">{{ unhandledCountText }}</span>
        </div>
        <div v-if="latestAlerts.length" class="activity-list">
          <button
            v-for="(alert, index) in latestAlerts"
            :key="alert.id || alert.title || index"
            type="button"
            class="activity-row alert-row"
            :class="alertLevelClass(alert.level)"
            @click="selectAlert(alert)"
          >
            <span class="row-marker"><UiIcon name="activity" :size="16" /></span>
            <span class="row-main">
              <span class="row-title">
                <strong>{{ textOrPlaceholder(alert.title) }}</strong>
                <span class="handled-tag" :class="{ handled: alert.handled === true }">
                  {{ alert.handled === true ? '已处理' : '未处理' }}
                </span>
              </span>
              <small>{{ textOrPlaceholder(alert.dogName) }} · {{ formatDateTime(alert.timestamp) }}</small>
              <p>{{ textOrPlaceholder(alert.message) }}</p>
            </span>
          </button>
        </div>
        <div v-else class="empty-state">暂无告警数据</div>
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import UiIcon from '../../components/UiIcon.vue'
import AccessOverviewCard from './AccessOverviewCard.vue'
import { DEMO_ALERTS, DEMO_TASKS } from './demoData.js'

/**
 * 数据字段：
 * tasks: [{ id, name, dogName, status, scheduledAt, startedAt?, completedAt?, route? }]
 * alerts: [{ id, title, message, dogName, level, handled, timestamp, route? }]
 * 时间使用 ISO 字符串或 Date 可解析值；任务状态支持 running/completed/failed/pending/cancelled。
 * 告警级别支持 critical/warning/info，handled !== true 时按未处理统计。
 * route 可为 vue-router 的 RouteLocationRaw，存在时优先于对应的路由模板 prop。
 * 路由模板字符串中的 :id 会被记录 ID 替换；不含 :id 时直接跳转该地址。
 */
const props = defineProps({
  demoMode: { type: Boolean, default: true },
  tasks: { type: Array, default: null },
  alerts: { type: Array, default: null },
  taskRoute: { type: [String, Object], default: '/missions/:id/run' },
  alertRoute: { type: [String, Object], default: '/alerts' }
})

const emit = defineEmits(['task-select', 'alert-select'])
const appRouter = useRouter()

const taskList = computed(() => props.demoMode ? DEMO_TASKS : props.tasks)
const alertList = computed(() => props.demoMode ? DEMO_ALERTS : props.alerts)
const todayLabel = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: 'long', day: 'numeric', weekday: 'short'
}).format(new Date())

const unhandledCount = computed(() => {
  if (!Array.isArray(alertList.value)) return null
  return alertList.value.filter((alert) => alert.handled !== true).length
})
const unhandledCountText = computed(() => {
  return unhandledCount.value === null ? '等待告警数据' : `${unhandledCount.value} 条未处理`
})
const recentTasks = computed(() => {
  if (!Array.isArray(taskList.value)) return []
  return [...taskList.value]
    .sort((a, b) => timeValue(taskActivityTime(b)) - timeValue(taskActivityTime(a)))
    .slice(0, 5)
})
const latestAlerts = computed(() => {
  if (!Array.isArray(alertList.value)) return []
  return [...alertList.value]
    .sort((a, b) => timeValue(b.timestamp) - timeValue(a.timestamp))
    .slice(0, 5)
})

function textOrPlaceholder(value) {
  return typeof value === 'string' && value.trim() ? value : '--'
}

function taskActivityTime(task) {
  return task.startedAt || task.completedAt || task.scheduledAt
}

function timeValue(value) {
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}

function isToday(value) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return false
  const now = new Date()
  return date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
}

function formatDateTime(value) {
  if (!value) return '--'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '--'
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return isToday(value) ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`
}

function taskStatusText(status) {
  const labels = {
    running: '执行中', completed: '已完成', failed: '失败', pending: '待执行', cancelled: '已取消'
  }
  return labels[status] || textOrPlaceholder(status)
}

function taskStatusClass(status) {
  return ['running', 'completed', 'failed', 'pending', 'cancelled'].includes(status) ? status : 'unknown'
}

function alertLevelClass(level) {
  return ['critical', 'warning', 'info'].includes(level) ? level : 'unknown'
}

function routeWithId(baseRoute, id) {
  if (!baseRoute) return null
  const hasId = id !== null && id !== undefined && id !== ''
  const encodedId = hasId ? encodeURIComponent(String(id)) : ''
  if (typeof baseRoute === 'string') {
    if (!baseRoute.includes(':id')) return baseRoute
    return hasId ? baseRoute.replace(':id', encodedId) : null
  }
  if (baseRoute.path) {
    if (!baseRoute.path.includes(':id')) return { ...baseRoute }
    if (!hasId) return null
    return { ...baseRoute, path: baseRoute.path.replace(':id', encodedId) }
  }
  if (baseRoute.params && Object.prototype.hasOwnProperty.call(baseRoute.params, 'id')) {
    if (!hasId) return null
    return { ...baseRoute, params: { ...baseRoute.params, id: String(id) } }
  }
  return { ...baseRoute }
}

function navigate(target) {
  if (!target || !appRouter) return
  try {
    const navigation = appRouter.push(target)
    navigation?.catch?.((error) => console.warn('[OverviewPage] 页面跳转失败：', error))
  } catch (error) {
    console.warn('[OverviewPage] 页面跳转失败：', error)
  }
}

function selectTask(task) {
  emit('task-select', task)
  navigate(task.route || routeWithId(props.taskRoute, task.id))
}

function selectAlert(alert) {
  emit('alert-select', alert)
  navigate(alert.route || routeWithId(props.alertRoute, alert.id))
}
</script>

<style scoped>
.overview-page {
  width: min(1440px, 100%);
  min-height: 100%;
  margin: 0 auto;
  padding: 24px;
  overflow: visible;
  color: var(--text-primary);
}
.overview-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.title-row { display: flex; align-items: center; gap: 10px; }
.overview-header h1 { font-size: 1.35rem; font-weight: 650; letter-spacing: 0.02em; }
.overview-header p { margin-top: 7px; color: var(--text-muted); font-size: 0.75rem; }
.overview-date { padding-top: 4px; color: var(--text-secondary); font-family: var(--font-mono); font-size: 0.7rem; white-space: nowrap; }
.activity-panel { margin-top: 18px; padding: 18px; border: 1px solid var(--border-color); border-radius: var(--radius-lg); background: rgba(15, 28, 46, 0.78); box-shadow: var(--shadow-card); }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 15px; }
.section-heading h2 { font-size: 0.88rem; font-weight: 600; }
.section-heading p { margin-top: 5px; color: var(--text-muted); font-size: 0.65rem; }
.section-heading > span { color: var(--text-muted); font-size: 0.67rem; white-space: nowrap; }
.section-heading > span.has-alerts { color: var(--danger); }
.activity-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
.activity-panel { min-width: 0; }
.section-heading.compact { padding-bottom: 13px; border-bottom: 1px solid var(--border-color); }
.activity-list { display: flex; flex-direction: column; }
.activity-row { display: flex; align-items: flex-start; gap: 10px; width: 100%; padding: 12px 7px; border: 0; border-bottom: 1px solid var(--border-color); border-radius: 5px; color: var(--text-primary); background: transparent; text-align: left; cursor: pointer; transition: var(--transition); }
.activity-row:last-child { border-bottom-color: transparent; }
.activity-row:hover { background: var(--bg-soft); }
.row-marker { display: grid; place-items: center; width: 29px; height: 29px; flex: 0 0 auto; border-radius: 8px; color: var(--warning); background: rgba(251, 191, 36, 0.06); }
.row-marker.task { color: var(--accent-primary); background: rgba(34, 211, 238, 0.06); }
.alert-row.critical .row-marker { color: var(--danger); background: rgba(251, 113, 133, 0.07); }
.alert-row.info .row-marker { color: var(--accent-secondary); background: rgba(59, 130, 246, 0.07); }
.row-main { display: block; min-width: 0; flex: 1; }
.row-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.row-title > strong { overflow: hidden; font-size: 0.73rem; font-weight: 550; text-overflow: ellipsis; white-space: nowrap; }
.row-main > small { display: block; margin-top: 5px; color: var(--text-muted); font-size: 0.61rem; }
.row-main > p { margin-top: 6px; color: var(--text-secondary); font-size: 0.65rem; line-height: 1.5; }
.status-tag, .handled-tag { flex: 0 0 auto; padding: 3px 6px; border-radius: 5px; color: var(--text-muted); background: var(--bg-soft); font-size: 0.57rem; }
.status-tag.running { color: var(--accent-primary); background: rgba(34, 211, 238, 0.07); }
.status-tag.completed { color: var(--success); background: rgba(52, 211, 153, 0.07); }
.status-tag.failed { color: var(--danger); background: rgba(251, 113, 133, 0.07); }
.status-tag.pending { color: var(--warning); background: rgba(251, 191, 36, 0.07); }
.handled-tag { color: var(--danger); background: rgba(251, 113, 133, 0.07); }
.handled-tag.handled { color: var(--text-muted); background: var(--bg-soft); }
.empty-state { display: grid; place-items: center; min-height: 110px; border: 1px dashed var(--border-color); border-radius: var(--radius-md); color: var(--text-muted); font-size: 0.7rem; }
@media (max-width: 1100px) {
  .activity-grid { grid-template-columns: 1fr; gap: 0; }
}
@media (max-width: 640px) {
  .overview-page { padding: 14px; }
  .overview-header { flex-direction: column; gap: 8px; }
  .overview-date { padding-top: 0; }
  .activity-panel { padding: 14px; }
}
</style>
