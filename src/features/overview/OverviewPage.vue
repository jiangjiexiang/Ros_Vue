<template>
  <div class="overview-page">
    <header class="overview-header">
      <div>
        <div class="title-row">
          <h1>巡检总览</h1>
        </div>
        <p>集中查看机器狗在线状态、任务进展与待处理告警。</p>
      </div>
      <span class="overview-date">{{ todayLabel }}</span>
    </header>

    <section class="summary-grid" aria-label="巡检关键指标">
      <article v-for="metric in summaryItems" :key="metric.label" class="summary-card" :class="metric.tone">
        <div class="summary-icon"><UiIcon :name="metric.icon" :size="20" /></div>
        <div class="summary-content">
          <span>{{ metric.label }}</span>
          <strong>{{ metric.value }}<small v-if="metric.unit">{{ metric.unit }}</small></strong>
          <p>{{ metric.detail }}</p>
        </div>
      </article>
    </section>

    <section class="overview-section">
      <div class="section-heading">
        <div>
          <h2>机器狗状态</h2>
          <p>选择设备可进入对应详情页</p>
        </div>
        <span>{{ dogCountText }}</span>
      </div>

      <div v-if="dogList.length" class="dog-grid">
        <button
          v-for="(dog, index) in dogList"
          :key="dog.id || dog.name || index"
          type="button"
          class="dog-card"
          :aria-label="`查看${dog.name || '机器狗'}详情`"
          @click="selectDog(dog)"
        >
          <span class="dog-card-header">
            <span class="dog-identity">
              <span class="dog-icon"><UiIcon name="robot" :size="21" /></span>
              <span>
                <strong>{{ textOrPlaceholder(dog.name) }}</strong>
                <small>ID：{{ textOrPlaceholder(dog.id) }}</small>
              </span>
            </span>
            <span class="online-state" :class="onlineClass(dog.online)">
              <i></i>{{ onlineText(dog.online) }}
            </span>
          </span>

          <span class="dog-battery">
            <span>剩余电量</span>
            <strong :class="batteryClass(dog.battery?.percentage)">
              {{ batteryText(dog.battery?.percentage) }}
              <small v-if="hasNumber(dog.battery?.percentage)">%</small>
            </strong>
          </span>
          <span class="battery-track" aria-hidden="true">
            <span :style="{ width: batteryWidth(dog.battery?.percentage) }"></span>
          </span>

          <span class="dog-detail-row">
            <span><UiIcon name="compass" :size="15" />当前位置</span>
            <strong>{{ textOrPlaceholder(dog.location) }}</strong>
          </span>
          <span class="dog-detail-row task-row">
            <span><UiIcon name="route" :size="15" />当前任务</span>
            <strong>{{ textOrPlaceholder(dog.currentTask) }}</strong>
          </span>
        </button>
      </div>
      <div v-else class="empty-state">暂无机器狗数据</div>
    </section>

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
import { DEMO_ALERTS, DEMO_DOGS, DEMO_TASKS } from './demoData.js'

/**
 * 数据字段：
 * dogs: [{ id, name, online, battery: { percentage, voltage }, location, currentTask, route? }]
 * tasks: [{ id, name, dogName, status, scheduledAt, startedAt?, completedAt?, route? }]
 * alerts: [{ id, title, message, dogName, level, handled, timestamp, route? }]
 * 时间使用 ISO 字符串或 Date 可解析值；任务状态支持 running/completed/failed/pending/cancelled。
 * 告警级别支持 critical/warning/info，handled !== true 时按未处理统计。
 * route 可为 vue-router 的 RouteLocationRaw，存在时优先于对应的路由模板 prop。
 * 路由模板字符串中的 :id 会被记录 ID 替换；不含 :id 时直接跳转该地址。
 */
const props = defineProps({
  demoMode: { type: Boolean, default: true },
  dogs: { type: Array, default: null },
  tasks: { type: Array, default: null },
  alerts: { type: Array, default: null },
  dogRoute: { type: [String, Object], default: '/robots' },
  taskRoute: { type: [String, Object], default: '/missions/:id/run' },
  alertRoute: { type: [String, Object], default: '/alerts' }
})

const emit = defineEmits(['dog-select', 'task-select', 'alert-select'])
const appRouter = useRouter()

const dogList = computed(() => props.demoMode ? DEMO_DOGS : (props.dogs || []))
const taskList = computed(() => props.demoMode ? DEMO_TASKS : props.tasks)
const alertList = computed(() => props.demoMode ? DEMO_ALERTS : props.alerts)
const todayLabel = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: 'long', day: 'numeric', weekday: 'short'
}).format(new Date())

const onlineCount = computed(() => {
  if (props.demoMode || Array.isArray(props.dogs)) {
    return dogList.value.filter((dog) => dog.online === true).length
  }
  return null
})
const runningCount = computed(() => {
  if (!Array.isArray(taskList.value)) return null
  return taskList.value.filter((task) => task.status === 'running').length
})
const unhandledCount = computed(() => {
  if (!Array.isArray(alertList.value)) return null
  return alertList.value.filter((alert) => alert.handled !== true).length
})
const todayStats = computed(() => {
  if (!Array.isArray(taskList.value)) return { total: null, completed: null, rate: null }
  const todayTasks = taskList.value.filter((task) => isToday(task.scheduledAt))
  const completed = todayTasks.filter((task) => task.status === 'completed').length
  return {
    total: todayTasks.length,
    completed,
    rate: todayTasks.length ? Math.round((completed / todayTasks.length) * 100) : null
  }
})

const summaryItems = computed(() => [
  {
    label: '在线机器狗',
    value: countText(onlineCount.value),
    unit: onlineCount.value === null ? '' : '台',
    detail: dogCountText.value,
    icon: 'robot',
    tone: 'success'
  },
  {
    label: '执行任务',
    value: countText(runningCount.value),
    unit: runningCount.value === null ? '' : '项',
    detail: '正在执行的巡检任务',
    icon: 'route',
    tone: 'accent'
  },
  {
    label: '未处理告警',
    value: countText(unhandledCount.value),
    unit: unhandledCount.value === null ? '' : '条',
    detail: unhandledCount.value === null
      ? '等待告警数据'
      : unhandledCount.value > 0 ? '需要跟进处理' : '暂无待处理事件',
    icon: 'activity',
    tone: unhandledCount.value > 0 ? 'danger' : 'success'
  },
  {
    label: '今日完成率',
    value: todayStats.value.rate ?? '--',
    unit: todayStats.value.rate === null ? '' : '%',
    detail: todayStats.value.total === null
      ? '等待任务数据'
      : todayStats.value.total
        ? `今日完成 ${todayStats.value.completed}/${todayStats.value.total} 项`
        : '今日暂无计划任务',
    icon: 'refresh',
    tone: 'warning'
  }
])

const dogCountText = computed(() => {
  if (onlineCount.value === null) return '等待设备数据'
  return `${onlineCount.value} 在线 / 共 ${dogList.value.length} 台`
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

function hasNumber(value) {
  return Number.isFinite(value)
}

function countText(value) {
  return value === null ? '--' : String(value)
}

function textOrPlaceholder(value) {
  return typeof value === 'string' && value.trim() ? value : '--'
}

function batteryText(value) {
  return hasNumber(value) ? String(Math.round(value)) : '--'
}

function batteryWidth(value) {
  return hasNumber(value) ? `${Math.max(0, Math.min(100, value))}%` : '0%'
}

function batteryClass(value) {
  if (!hasNumber(value)) return 'unknown'
  if (value <= 20) return 'low'
  if (value <= 50) return 'medium'
  return 'high'
}

function onlineText(online) {
  return typeof online === 'boolean' ? (online ? '在线' : '离线') : '--'
}

function onlineClass(online) {
  return typeof online === 'boolean' ? (online ? 'online' : 'offline') : 'unknown'
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

function selectDog(dog) {
  emit('dog-select', dog)
  navigate(dog.route || routeWithId(props.dogRoute, dog.id))
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
  overflow: auto;
  color: var(--text-primary);
}
.overview-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.title-row { display: flex; align-items: center; gap: 10px; }
.overview-header h1 { font-size: 1.35rem; font-weight: 650; letter-spacing: 0.02em; }
.overview-header p { margin-top: 7px; color: var(--text-muted); font-size: 0.75rem; }
.overview-date { padding-top: 4px; color: var(--text-secondary); font-family: var(--font-mono); font-size: 0.7rem; white-space: nowrap; }
.demo-badge { padding: 4px 8px; border: 1px solid rgba(251, 191, 36, 0.25); border-radius: 6px; color: var(--warning); background: rgba(251, 191, 36, 0.07); font-size: 0.64rem; }
.demo-notice { margin-top: 15px; padding: 10px 12px; border: 1px solid rgba(251, 191, 36, 0.18); border-radius: var(--radius-sm); color: var(--text-secondary); background: rgba(251, 191, 36, 0.045); font-size: 0.7rem; line-height: 1.6; }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 20px; }
.summary-card { display: flex; align-items: center; gap: 13px; min-width: 0; padding: 17px; border: 1px solid var(--border-color); border-radius: var(--radius-lg); background: linear-gradient(145deg, var(--bg-card), var(--bg-secondary)); box-shadow: var(--shadow-card); }
.summary-icon { display: grid; place-items: center; width: 40px; height: 40px; flex: 0 0 auto; border-radius: 10px; color: var(--accent-primary); background: rgba(34, 211, 238, 0.07); }
.summary-card.success .summary-icon { color: var(--success); background: rgba(52, 211, 153, 0.07); }
.summary-card.warning .summary-icon { color: var(--warning); background: rgba(251, 191, 36, 0.07); }
.summary-card.danger .summary-icon { color: var(--danger); background: rgba(251, 113, 133, 0.07); }
.summary-content { min-width: 0; }
.summary-content > span { display: block; color: var(--text-muted); font-size: 0.68rem; }
.summary-content strong { display: block; margin-top: 5px; font-family: var(--font-mono); font-size: 1.55rem; font-weight: 600; line-height: 1.15; }
.summary-content strong small { margin-left: 5px; color: var(--text-secondary); font-size: 0.7rem; font-weight: 400; }
.summary-content p { margin-top: 6px; overflow: hidden; color: var(--text-muted); font-size: 0.64rem; text-overflow: ellipsis; white-space: nowrap; }
.overview-section, .activity-panel { margin-top: 18px; padding: 18px; border: 1px solid var(--border-color); border-radius: var(--radius-lg); background: rgba(15, 28, 46, 0.78); box-shadow: var(--shadow-card); }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 15px; }
.section-heading h2 { font-size: 0.88rem; font-weight: 600; }
.section-heading p { margin-top: 5px; color: var(--text-muted); font-size: 0.65rem; }
.section-heading > span { color: var(--text-muted); font-size: 0.67rem; white-space: nowrap; }
.section-heading > span.has-alerts { color: var(--danger); }
.dog-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(245px, 1fr)); gap: 12px; }
.dog-card { min-width: 0; padding: 15px; border: 1px solid var(--border-color); border-radius: var(--radius-md); color: var(--text-primary); background: var(--bg-soft); text-align: left; cursor: pointer; transition: var(--transition); }
.dog-card:hover { border-color: rgba(34, 211, 238, 0.32); background: rgba(34, 211, 238, 0.035); transform: translateY(-1px); }
.dog-card-header, .dog-identity { display: flex; align-items: center; }
.dog-card-header { justify-content: space-between; gap: 10px; }
.dog-identity { min-width: 0; gap: 10px; }
.dog-identity > span:last-child { min-width: 0; }
.dog-icon { display: grid; place-items: center; width: 38px; height: 38px; flex: 0 0 auto; border-radius: 10px; color: var(--accent-primary); background: rgba(34, 211, 238, 0.07); }
.dog-identity strong { display: block; overflow: hidden; font-size: 0.82rem; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.dog-identity small { display: block; margin-top: 5px; overflow: hidden; color: var(--text-muted); font-family: var(--font-mono); font-size: 0.58rem; text-overflow: ellipsis; white-space: nowrap; }
.online-state { display: inline-flex; align-items: center; gap: 5px; flex: 0 0 auto; color: var(--text-muted); font-size: 0.63rem; }
.online-state i { width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); }
.online-state.online { color: var(--success); }
.online-state.online i { background: var(--success); box-shadow: 0 0 0 3px rgba(52, 211, 153, 0.08); }
.online-state.offline i { background: var(--text-muted); }
.dog-battery { display: flex; align-items: flex-end; justify-content: space-between; margin-top: 18px; }
.dog-battery > span { color: var(--text-muted); font-size: 0.65rem; }
.dog-battery strong { color: var(--success); font-family: var(--font-mono); font-size: 1rem; font-weight: 600; }
.dog-battery strong.medium { color: var(--warning); }
.dog-battery strong.low { color: var(--danger); }
.dog-battery strong.unknown { color: var(--text-muted); }
.dog-battery strong small { margin-left: 2px; font-size: 0.62rem; }
.battery-track { display: block; height: 4px; margin-top: 7px; overflow: hidden; border-radius: 4px; background: rgba(148, 163, 184, 0.1); }
.battery-track > span { display: block; height: 100%; border-radius: inherit; background: var(--accent-primary); }
.dog-detail-row { display: grid; grid-template-columns: 82px minmax(0, 1fr); align-items: center; gap: 8px; margin-top: 14px; font-size: 0.66rem; }
.dog-detail-row > span { display: flex; align-items: center; gap: 6px; color: var(--text-muted); }
.dog-detail-row > span svg { flex: 0 0 auto; }
.dog-detail-row strong { overflow: hidden; color: var(--text-secondary); font-size: 0.67rem; font-weight: 500; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
.task-row { margin-top: 9px; }
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
  .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .activity-grid { grid-template-columns: 1fr; gap: 0; }
}
@media (max-width: 640px) {
  .overview-page { padding: 14px; }
  .overview-header { flex-direction: column; gap: 8px; }
  .overview-date { padding-top: 0; }
  .summary-grid { gap: 9px; margin-top: 15px; }
  .summary-card { gap: 9px; padding: 13px; }
  .summary-icon { width: 32px; height: 32px; }
  .summary-content strong { font-size: 1.25rem; }
  .overview-section, .activity-panel { padding: 14px; }
  .dog-grid { grid-template-columns: 1fr; }
}
@media (max-width: 390px) {
  .summary-grid { grid-template-columns: 1fr; }
}
</style>
