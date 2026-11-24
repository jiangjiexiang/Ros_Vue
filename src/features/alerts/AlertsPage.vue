<template>
  <section class="alerts-page" aria-labelledby="alerts-title">
    <header class="page-header">
      <div>
        <div class="title-line">
          <h1 id="alerts-title">巡检告警</h1>
        </div>
        <p>确认异常、记录处理结果，并回溯关联任务与巡检点。</p>
      </div>
    </header>

    <section class="alert-summary" aria-label="告警状态汇总">
      <article><span>待确认</span><strong class="danger-text">{{ counts.pending }}</strong><small>需要值班员确认</small></article>
      <article><span>已确认</span><strong class="warning-text">{{ counts.acknowledged }}</strong><small>等待填写处理结果</small></article>
      <article><span>已处理</span><strong class="success-text">{{ counts.resolved }}</strong><small>处理记录已归档</small></article>
      <article><span>未闭环严重告警</span><strong :class="{ 'danger-text': counts.criticalOpen }">{{ counts.criticalOpen }}</strong><small>待确认或已确认</small></article>
    </section>

    <form class="filter-panel" @submit.prevent>
      <label><span>告警等级</span><select v-model="filters.level"><option value="">全部等级</option><option v-for="option in alertLevelOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
      <label><span>处理状态</span><select v-model="filters.status"><option value="">全部状态</option><option v-for="option in alertStatusOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
      <label><span>机器狗</span><select v-model="filters.robotId"><option value="">全部机器狗</option><option v-for="robot in robots" :key="robot.id" :value="robot.id">{{ robot.name }}</option></select></label>
      <button type="button" :disabled="!hasActiveFilters" @click="resetFilters">重置筛选</button>
    </form>

    <div v-if="feedback" class="feedback" role="status"><span>{{ feedback }}</span><button type="button" aria-label="关闭提示" @click="feedback = ''">×</button></div>

    <section class="alert-list-section" aria-label="告警列表">
      <div class="list-heading">
        <div><h2>告警列表</h2><p aria-live="polite">{{ filteredAlerts.length }} / {{ alertSession.length }} 条</p></div>
        <span>按发生时间倒序</span>
      </div>

      <div v-if="filteredAlerts.length" class="alert-list">
        <article v-for="alert in filteredAlerts" :key="alert.id" class="alert-card" :class="`level-${alert.level}`">
          <header class="alert-card-header">
            <div class="alert-title-line">
              <span class="level-badge" :class="`tone-${getAlertLevel(alert.level).tone}`">{{ getAlertLevel(alert.level).label }}</span>
              <div><h2>{{ alert.title }}</h2><span>{{ alert.id }}</span></div>
            </div>
            <div class="alert-state"><span class="status-badge" :class="`tone-${getAlertStatus(alert.status).tone}`">{{ getAlertStatus(alert.status).label }}</span><time>{{ formatDateTime(alert.occurredAt, true) }}</time></div>
          </header>

          <div class="alert-content">
            <div class="alert-main">
              <p class="alert-description">{{ alert.description }}</p>
              <dl>
                <div><dt>机器狗</dt><dd>{{ alert.robotName }}</dd></div>
                <div><dt>巡检场景</dt><dd>{{ alert.scene }}</dd></div>
                <div><dt>巡检点</dt><dd><button type="button" @click="openPoint(alert)">{{ alert.pointName }} · {{ alert.pointId }}</button></dd></div>
                <div><dt>关联任务</dt><dd><button type="button" @click="openRecord(alert)">{{ alert.recordName }}</button></dd></div>
              </dl>
              <div class="recommendation"><strong>处理建议</strong><p>{{ alert.recommendation }}</p></div>
            </div>
            <aside class="alert-reading">
              <span>触发读数</span>
              <strong>{{ alert.reading }}</strong>
              <small>{{ alert.threshold }}</small>
            </aside>
          </div>

          <div v-if="alert.status === 'acknowledged'" class="handling-info acknowledged-info">
            <strong>已确认</strong><span>{{ alert.acknowledgedBy }} · {{ formatDateTime(alert.acknowledgedAt, true) }}</span><small>请在现场核查后填写处理结果。</small>
          </div>
          <div v-else-if="alert.status === 'resolved'" class="handling-info resolved-info">
            <div><strong>{{ getResolutionLabel(alert.resolution) }}</strong><span>{{ alert.handledBy }} · {{ formatDateTime(alert.handledAt, true) }}</span></div>
            <p>{{ alert.resolutionNote }}</p>
          </div>

          <footer class="alert-actions">
            <button v-if="alert.status === 'pending'" class="action-primary" type="button" @click="confirmAlert(alert)">确认告警</button>
            <button v-if="alert.status === 'acknowledged'" class="action-primary" type="button" @click="openProcess(alert)">填写处理结果</button>
            <button type="button" @click="openRecord(alert)">任务详情</button>
            <button type="button" @click="openPoint(alert)">定位巡检点 <span aria-hidden="true">→</span></button>
          </footer>
        </article>
      </div>

      <div v-else class="empty-state"><strong>没有符合条件的告警</strong><p>可调整等级、状态或机器狗筛选条件。</p><button type="button" @click="resetFilters">清空筛选</button></div>
    </section>

    <div v-if="processingAlert" class="modal-backdrop" @click.self="closeProcess" @keydown.esc="closeProcess">
      <section class="process-dialog" role="dialog" aria-modal="true" aria-labelledby="process-dialog-title" aria-describedby="process-dialog-description">
        <header><div><span>{{ processingAlert.id }}</span><h2 id="process-dialog-title">填写处理结果</h2></div><button type="button" aria-label="关闭处理窗口" @click="closeProcess">×</button></header>
        <p id="process-dialog-description" class="dialog-alert-title">{{ processingAlert.title }} · {{ processingAlert.pointName }}</p>
        <form @submit.prevent="submitResolution">
          <label><span>处理结果</span><select v-model="resolution"><option v-for="option in resolutionOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
          <label><span>处理说明 <em>必填</em></span><textarea ref="noteInputRef" v-model="resolutionNote" rows="4" maxlength="300" required placeholder="简要说明核查情况和处理措施"></textarea><small>{{ resolutionNote.length }}/300</small></label>
          <p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
          <footer><button type="button" @click="closeProcess">取消</button><button class="dialog-submit" type="submit">确认处理</button></footer>
        </form>
      </section>
    </div>
  </section>
</template>

<script setup>
import { computed, nextTick, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { formatDateTime } from '../records/utils.js'
import { alertSession, acknowledgeAlert, resolveAlert } from './demoAlertStore.js'
import {
  alertLevelOptions,
  alertStatusOptions,
  filterAlerts,
  getAlertLevel,
  getAlertStatus,
  getResolutionLabel,
  resolutionOptions
} from './utils.js'

const router = useRouter()
const filters = reactive({ level: '', status: '', robotId: '' })
const feedback = ref('')
const processingAlert = ref(null)
const resolution = ref('fixed')
const resolutionNote = ref('')
const formError = ref('')
const noteInputRef = ref(null)
const robots = [...new Map(alertSession.value.map((alert) => [alert.robotId, { id: alert.robotId, name: alert.robotName }])).values()]
const filteredAlerts = computed(() => filterAlerts(alertSession.value, filters))
const hasActiveFilters = computed(() => Object.values(filters).some(Boolean))
const counts = computed(() => ({
  pending: alertSession.value.filter((alert) => alert.status === 'pending').length,
  acknowledged: alertSession.value.filter((alert) => alert.status === 'acknowledged').length,
  resolved: alertSession.value.filter((alert) => alert.status === 'resolved').length,
  criticalOpen: alertSession.value.filter((alert) => alert.level === 'critical' && alert.status !== 'resolved').length
}))

function resetFilters() {
  Object.assign(filters, { level: '', status: '', robotId: '' })
}

function confirmAlert(alert) {
  if (acknowledgeAlert(alert.id)) feedback.value = `告警 ${alert.id} 已确认，请继续填写处理结果。`
}

function openProcess(alert) {
  processingAlert.value = alert
  resolution.value = 'fixed'
  resolutionNote.value = ''
  formError.value = ''
  nextTick(() => noteInputRef.value?.focus())
}

function closeProcess() {
  processingAlert.value = null
  formError.value = ''
}

function submitResolution() {
  const note = resolutionNote.value.trim()
  if (!note) {
    formError.value = '请填写处理说明。'
    noteInputRef.value?.focus()
    return
  }
  const alert = processingAlert.value
  if (alert && resolveAlert(alert.id, resolution.value, note)) {
    feedback.value = `告警 ${alert.id} 已标记为已处理。`
    closeProcess()
  }
}

function openRecord(alert) {
  router.push({ path: `/records/${encodeURIComponent(alert.recordId)}`, query: { alertId: alert.id } })
}

function openPoint(alert) {
  router.push({
    path: `/records/${encodeURIComponent(alert.recordId)}`,
    query: { alertId: alert.id, pointId: alert.pointId }
  })
}
</script>

<style scoped>
.alerts-page { display: flex; flex-direction: column; gap: 16px; width: 100%; height: 100%; min-height: 0; padding: 24px; overflow: auto; }
.page-header, .alert-summary, .filter-panel, .alert-list-section, .feedback, .demo-footnote { width: min(1280px, 100%); margin-right: auto; margin-left: auto; }
.page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.title-line { display: flex; align-items: center; gap: 10px; }
h1 { font-size: 1.3rem; font-weight: 650; }
.page-header p { margin-top: 7px; color: var(--text-muted); font-size: 0.75rem; }
.demo-badge { padding: 4px 8px; border: 1px solid rgba(251, 191, 36, 0.24); border-radius: 6px; color: var(--warning); background: rgba(251, 191, 36, 0.07); font-size: 0.64rem; }
.data-note { padding-top: 5px; color: var(--text-muted); font-size: 0.68rem; }
.alert-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.alert-summary article { padding: 15px 16px; border: 1px solid var(--border-color); border-radius: var(--radius-md); background: var(--bg-card); }
.alert-summary article > span { color: var(--text-muted); font-size: 0.67rem; }
.alert-summary strong { display: block; margin-top: 7px; color: var(--text-primary); font-family: var(--font-mono); font-size: 1.4rem; font-weight: 600; }
.alert-summary small { display: block; margin-top: 4px; color: var(--text-muted); font-size: 0.62rem; }
.danger-text { color: var(--danger) !important; }
.warning-text { color: var(--warning) !important; }
.success-text { color: var(--success) !important; }
.filter-panel { display: grid; grid-template-columns: repeat(3, minmax(150px, 1fr)) auto; gap: 12px; align-items: end; padding: 14px; border: 1px solid var(--border-color); border-radius: var(--radius-md); background: var(--bg-card); }
.filter-panel label > span, .process-dialog label > span { display: block; margin-bottom: 7px; color: var(--text-muted); font-size: 0.65rem; }
select, textarea { width: 100%; border: 1px solid var(--border-color); border-radius: var(--radius-sm); color: var(--text-primary); background: var(--bg-secondary); font-size: 0.7rem; }
select { height: 36px; padding: 0 10px; }
.filter-panel > button, .empty-state button { height: 36px; padding: 0 14px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); color: var(--text-secondary); background: var(--bg-soft); font-size: 0.7rem; cursor: pointer; }
.filter-panel > button:hover:not(:disabled), .empty-state button:hover { border-color: var(--border-strong); color: var(--text-primary); }
.feedback { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 13px; border: 1px solid rgba(52, 211, 153, 0.22); border-radius: var(--radius-sm); color: var(--success); background: rgba(52, 211, 153, 0.06); font-size: 0.7rem; }
.feedback button { padding: 0 3px; border: 0; color: inherit; background: transparent; font-size: 1rem; cursor: pointer; }
.alert-list-section { min-width: 0; }
.list-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; padding: 0 2px; }
.list-heading > div { display: flex; align-items: baseline; gap: 10px; }
.list-heading h2 { font-size: 0.85rem; font-weight: 600; }
.list-heading p, .list-heading > span { color: var(--text-muted); font-size: 0.65rem; }
.alert-list { display: flex; flex-direction: column; gap: 12px; }
.alert-card { overflow: hidden; border: 1px solid var(--border-color); border-left: 2px solid var(--accent-secondary); border-radius: var(--radius-lg); background: var(--bg-card); box-shadow: var(--shadow-card); }
.alert-card.level-critical { border-left-color: var(--danger); }
.alert-card.level-warning { border-left-color: var(--warning); }
.alert-card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 15px 16px 12px; }
.alert-title-line { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
.alert-title-line h2 { font-size: 0.85rem; font-weight: 600; line-height: 1.5; }
.alert-title-line > div > span { display: block; margin-top: 4px; color: var(--text-muted); font-family: var(--font-mono); font-size: 0.59rem; }
.level-badge { flex: 0 0 auto; min-width: 34px; margin-top: 1px; padding: 3px 6px; border-radius: 5px; font-size: 0.61rem; text-align: center; }
.alert-state { display: flex; align-items: center; gap: 12px; flex: 0 0 auto; }
.alert-state time { color: var(--text-muted); font-family: var(--font-mono); font-size: 0.62rem; }
.status-badge { display: inline-flex; align-items: center; min-height: 24px; padding: 0 8px; border: 1px solid var(--border-color); border-radius: 20px; font-size: 0.64rem; white-space: nowrap; }
.tone-danger { border-color: rgba(251, 113, 133, 0.24); color: var(--danger); background: rgba(251, 113, 133, 0.07); }
.tone-warning { border-color: rgba(251, 191, 36, 0.24); color: var(--warning); background: rgba(251, 191, 36, 0.07); }
.tone-success { border-color: rgba(52, 211, 153, 0.22); color: var(--success); background: rgba(52, 211, 153, 0.06); }
.tone-info { color: var(--accent-secondary); background: rgba(59, 130, 246, 0.08); }
.tone-muted { color: var(--text-muted); background: var(--bg-soft); }
.alert-content { display: grid; grid-template-columns: minmax(0, 1fr) 185px; gap: 16px; padding: 0 16px 14px; }
.alert-description { color: var(--text-secondary); font-size: 0.7rem; line-height: 1.65; }
dl { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 13px; }
dl > div { min-width: 0; }
dt { color: var(--text-muted); font-size: 0.61rem; }
dd { margin-top: 5px; overflow: hidden; color: var(--text-secondary); font-size: 0.67rem; text-overflow: ellipsis; white-space: nowrap; }
dd button { max-width: 100%; padding: 0; overflow: hidden; border: 0; color: var(--accent-primary); background: transparent; font-size: inherit; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.recommendation { display: flex; gap: 8px; margin-top: 13px; padding: 9px 10px; border-radius: var(--radius-sm); background: var(--bg-soft); font-size: 0.65rem; line-height: 1.6; }
.recommendation strong { flex: 0 0 auto; color: var(--text-secondary); font-weight: 500; }
.recommendation p { color: var(--text-muted); }
.alert-reading { display: flex; flex-direction: column; justify-content: center; min-width: 0; padding: 13px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-soft); }
.alert-reading > span { color: var(--text-muted); font-size: 0.62rem; }
.alert-reading strong { margin-top: 8px; overflow: hidden; color: var(--warning); font-family: var(--font-mono); font-size: 1rem; font-weight: 550; text-overflow: ellipsis; white-space: nowrap; }
.level-critical .alert-reading strong { color: var(--danger); }
.level-info .alert-reading strong { color: var(--accent-secondary); }
.alert-reading small { margin-top: 7px; color: var(--text-muted); font-size: 0.59rem; line-height: 1.5; }
.handling-info { margin: 0 16px 13px; padding: 10px 12px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); font-size: 0.64rem; }
.acknowledged-info { display: flex; align-items: center; flex-wrap: wrap; gap: 7px 12px; color: var(--warning); background: rgba(251, 191, 36, 0.04); }
.handling-info strong { font-weight: 550; }
.handling-info span { color: var(--text-secondary); }
.handling-info small { margin-left: auto; color: var(--text-muted); font-size: 0.61rem; }
.resolved-info { background: rgba(52, 211, 153, 0.035); }
.resolved-info > div { display: flex; align-items: center; gap: 12px; }
.resolved-info strong { color: var(--success); }
.resolved-info p { margin-top: 6px; color: var(--text-muted); line-height: 1.6; }
.alert-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; padding: 11px 16px; border-top: 1px solid var(--border-color); background: rgba(2, 8, 18, 0.12); }
.alert-actions button { min-height: 31px; padding: 0 11px; border: 1px solid var(--border-color); border-radius: 7px; color: var(--text-secondary); background: var(--bg-soft); font-size: 0.65rem; cursor: pointer; }
.alert-actions button:hover { border-color: var(--border-strong); color: var(--text-primary); }
.alert-actions .action-primary { border-color: rgba(34, 211, 238, 0.24); color: var(--accent-primary); background: rgba(34, 211, 238, 0.07); }
.empty-state { padding: 54px 20px; border: 1px solid var(--border-color); border-radius: var(--radius-lg); background: var(--bg-card); text-align: center; }
.empty-state strong { font-size: 0.85rem; font-weight: 550; }
.empty-state p { margin: 8px 0 16px; color: var(--text-muted); font-size: 0.7rem; }
.demo-footnote { color: var(--text-muted); font-size: 0.63rem; text-align: center; }
.modal-backdrop { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; padding: 20px; background: rgba(2, 8, 18, 0.76); backdrop-filter: blur(5px); }
.process-dialog { width: min(480px, 100%); overflow: hidden; border: 1px solid var(--border-strong); border-radius: var(--radius-lg); background: var(--bg-card); box-shadow: 0 24px 70px rgba(0, 0, 0, 0.42); }
.process-dialog > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 17px 18px 13px; border-bottom: 1px solid var(--border-color); }
.process-dialog > header span { color: var(--text-muted); font-family: var(--font-mono); font-size: 0.6rem; }
.process-dialog > header h2 { margin-top: 5px; font-size: 0.95rem; font-weight: 600; }
.process-dialog > header button { padding: 0 2px; border: 0; color: var(--text-muted); background: transparent; font-size: 1.2rem; cursor: pointer; }
.dialog-alert-title { padding: 13px 18px 0; color: var(--text-secondary); font-size: 0.7rem; line-height: 1.6; }
.process-dialog form { padding: 15px 18px 18px; }
.process-dialog form label { position: relative; display: block; margin-top: 13px; }
.process-dialog label em { margin-left: 4px; color: var(--danger); font-size: 0.6rem; font-style: normal; }
.process-dialog textarea { min-height: 104px; padding: 10px; resize: vertical; font-family: var(--font-main); line-height: 1.6; }
.process-dialog textarea:focus, .process-dialog select:focus { border-color: rgba(34, 211, 238, 0.5); outline: 2px solid rgba(34, 211, 238, 0.1); outline-offset: 1px; }
.process-dialog label > small { position: absolute; right: 8px; bottom: 7px; color: var(--text-muted); font-family: var(--font-mono); font-size: 0.56rem; }
.form-error { margin-top: 9px; color: var(--danger); font-size: 0.65rem; }
.dialog-note { margin-top: 12px; color: var(--text-muted); font-size: 0.62rem; line-height: 1.6; }
.process-dialog form footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 17px; }
.process-dialog form footer button { min-height: 34px; padding: 0 14px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); color: var(--text-secondary); background: var(--bg-soft); font-size: 0.68rem; cursor: pointer; }
.process-dialog form footer .dialog-submit { border-color: transparent; color: #f0fdff; background: var(--accent-gradient); }
@media (max-width: 860px) {
  .alerts-page { height: auto; min-height: calc(100dvh - 115px); }
}
@media (max-width: 900px) {
  .alert-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  dl { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .handling-info small { width: 100%; margin-left: 0; }
}
@media (max-width: 680px) {
  .alerts-page { padding: 14px; }
  .page-header { flex-direction: column; gap: 8px; }
  .data-note { padding: 0; }
  .filter-panel { grid-template-columns: 1fr; }
  .alert-card-header { flex-direction: column; }
  .alert-state { width: 100%; justify-content: space-between; }
  .alert-content { grid-template-columns: 1fr; }
  .alert-reading { min-height: 100px; }
  .alert-actions { justify-content: flex-start; }
}
@media (max-width: 440px) {
  .alert-summary { gap: 8px; }
  .alert-summary article { padding: 13px; }
  .alert-summary strong { font-size: 1.2rem; }
  .alert-title-line { gap: 7px; }
  .alert-state { align-items: flex-start; flex-direction: column; gap: 7px; }
  dl { grid-template-columns: 1fr; }
  .recommendation { flex-direction: column; gap: 3px; }
  .resolved-info > div { align-items: flex-start; flex-direction: column; gap: 5px; }
}
</style>
