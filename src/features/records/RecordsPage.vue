<template>
  <section class="records-page" aria-labelledby="records-title">
    <header class="page-header">
      <div>
        <div class="title-line">
          <h1 id="records-title">巡检记录</h1>
        </div>
        <p>查询已归档任务，核对巡检覆盖情况与异常记录。</p>
      </div>
    </header>

    <section class="summary-grid" aria-label="筛选结果汇总">
      <article class="summary-card">
        <span>任务数量</span>
        <strong>{{ filteredRecords.length }}<small> 次</small></strong>
        <p>当前筛选范围内</p>
      </article>
      <article class="summary-card">
        <span>累计任务耗时</span>
        <strong class="duration-value">{{ formatDuration(summary.totalDuration) }}</strong>
        <p>按任务起止时间统计</p>
      </article>
      <article class="summary-card">
        <span>巡检点完成率</span>
        <strong>{{ summary.completionRate }}<small>%</small></strong>
        <p>{{ summary.completedPoints }} / {{ summary.totalPoints }} 个巡检点</p>
      </article>
      <article class="summary-card" :class="{ 'has-anomalies': summary.anomalyCount }">
        <span>异常数量</span>
        <strong>{{ summary.anomalyCount }}<small> 条</small></strong>
        <p>需要关注的巡检异常</p>
      </article>
    </section>

    <form class="filter-panel" @submit.prevent>
      <label>
        <span>机器狗</span>
        <select v-model="filters.robotId">
          <option value="">全部机器狗</option>
          <option v-for="robot in robots" :key="robot.id" :value="robot.id">{{ robot.name }}</option>
        </select>
      </label>
      <label>
        <span>巡检场景</span>
        <select v-model="filters.scene">
          <option value="">全部场景</option>
          <option v-for="scene in scenes" :key="scene" :value="scene">{{ scene }}</option>
        </select>
      </label>
      <label>
        <span>开始日期</span>
        <input v-model="filters.startDate" type="date" aria-label="开始日期">
      </label>
      <label>
        <span>结束日期</span>
        <input v-model="filters.endDate" type="date" aria-label="结束日期">
      </label>
      <label>
        <span>任务结果</span>
        <select v-model="filters.result">
          <option value="">全部结果</option>
          <option v-for="option in recordResultOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
      </label>
      <button class="reset-button" type="button" :disabled="!hasActiveFilters" @click="resetFilters">重置筛选</button>
      <p v-if="dateRangeInvalid" class="filter-error" role="alert">开始日期不能晚于结束日期。</p>
    </form>

    <section class="record-panel" aria-label="巡检任务列表">
      <div class="panel-heading">
        <div>
          <h2>任务列表</h2>
          <p aria-live="polite">共 {{ filteredRecords.length }} 条记录</p>
        </div>
        <span>按任务开始时间倒序</span>
      </div>

      <div v-if="filteredRecords.length" class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>任务</th>
              <th>机器狗</th>
              <th>场景</th>
              <th>开始时间</th>
              <th>任务耗时</th>
              <th>巡检点完成率</th>
              <th>异常</th>
              <th>结果</th>
              <th><span class="sr-only">操作</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="record in filteredRecords" :key="record.id">
              <td>
                <button class="task-link" type="button" @click="openRecord(record)">{{ record.name }}</button>
                <span class="task-id">{{ record.id }}</span>
              </td>
              <td>{{ record.robotName }}</td>
              <td>{{ record.scene }}</td>
              <td class="time-cell">{{ formatDateTime(record.startedAt) }}</td>
              <td class="mono-cell">{{ formatDuration(record.duration) }}</td>
              <td>
                <div class="completion-cell">
                  <div><span>{{ completedPoints(record) }}/{{ record.points.length }}</span><strong>{{ getCompletionRate(record) }}%</strong></div>
                  <div class="progress-track"><i :style="{ width: `${getCompletionRate(record)}%` }"></i></div>
                </div>
              </td>
              <td><span class="anomaly-count" :class="{ active: record.anomalies.length }">{{ record.anomalies.length }}</span></td>
              <td><span class="status-badge" :class="`tone-${getRecordResult(record.result).tone}`">{{ getRecordResult(record.result).label }}</span></td>
              <td><button class="detail-button" type="button" @click="openRecord(record)">查看详情 <span aria-hidden="true">→</span></button></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-else class="empty-state">
        <strong>没有符合条件的巡检记录</strong>
        <p>{{ dateRangeInvalid ? '请调整开始与结束日期。' : '可放宽筛选条件后重新查看。' }}</p>
        <button type="button" @click="resetFilters">清空筛选</button>
      </div>
    </section>
  </section>
</template>

<script setup>
import { computed, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { demoRecords } from './demoData.js'
import {
  filterRecords,
  formatDateTime,
  formatDuration,
  getCompletionRate,
  getRecordResult,
  recordResultOptions
} from './utils.js'

const router = useRouter()
const filters = reactive({ robotId: '', scene: '', startDate: '', endDate: '', result: '' })
const robots = [...new Map(demoRecords.map((record) => [record.robotId, { id: record.robotId, name: record.robotName }])).values()]
const scenes = [...new Set(demoRecords.map((record) => record.scene))]
const dateRangeInvalid = computed(() => Boolean(filters.startDate && filters.endDate && filters.startDate > filters.endDate))
const filteredRecords = computed(() => dateRangeInvalid.value ? [] : filterRecords(demoRecords, filters))
const hasActiveFilters = computed(() => Object.values(filters).some(Boolean))
const summary = computed(() => {
  const allPoints = filteredRecords.value.flatMap((record) => record.points)
  const completedPoints = allPoints.filter((point) => point.status !== 'skipped').length
  return {
    totalDuration: filteredRecords.value.reduce((total, record) => total + record.duration, 0),
    totalPoints: allPoints.length,
    completedPoints,
    completionRate: allPoints.length ? Math.round(completedPoints / allPoints.length * 100) : 0,
    anomalyCount: filteredRecords.value.reduce((total, record) => total + record.anomalies.length, 0)
  }
})

function completedPoints(record) {
  return record.points.filter((point) => point.status !== 'skipped').length
}

function resetFilters() {
  Object.assign(filters, { robotId: '', scene: '', startDate: '', endDate: '', result: '' })
}

function openRecord(record) {
  router.push({ path: `/records/${encodeURIComponent(record.id)}` })
}
</script>

<style scoped>
.records-page { display: flex; flex-direction: column; gap: 16px; width: 100%; height: 100%; min-height: 0; padding: 24px; overflow: auto; }
.page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; width: min(1440px, 100%); margin: 0 auto; }
.title-line { display: flex; align-items: center; gap: 10px; }
h1 { font-size: 1.3rem; font-weight: 650; letter-spacing: 0.02em; }
.page-header p { margin-top: 7px; color: var(--text-muted); font-size: 0.75rem; }
.demo-badge { padding: 4px 8px; border: 1px solid rgba(251, 191, 36, 0.24); border-radius: 6px; color: var(--warning); background: rgba(251, 191, 36, 0.07); font-size: 0.64rem; }
.data-note { padding-top: 5px; color: var(--text-muted); font-size: 0.68rem; }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; width: min(1440px, 100%); margin: 0 auto; }
.summary-card { min-width: 0; padding: 16px; border: 1px solid var(--border-color); border-radius: var(--radius-md); background: var(--bg-card); }
.summary-card > span { color: var(--text-muted); font-size: 0.68rem; }
.summary-card strong { display: block; margin-top: 9px; overflow: hidden; color: var(--text-primary); font-family: var(--font-mono); font-size: 1.35rem; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.summary-card strong.small, .summary-card small { color: var(--text-secondary); font-size: 0.7rem; font-weight: 400; }
.summary-card .duration-value { font-size: 1.08rem; line-height: 1.85rem; }
.summary-card p { margin-top: 5px; color: var(--text-muted); font-size: 0.64rem; }
.summary-card.has-anomalies strong { color: var(--warning); }
.filter-panel { display: grid; grid-template-columns: repeat(2, minmax(130px, 1fr)) repeat(2, minmax(145px, 0.85fr)) minmax(120px, 0.8fr) auto; gap: 10px; align-items: end; width: min(1440px, 100%); margin: 0 auto; padding: 14px; border: 1px solid var(--border-color); border-radius: var(--radius-md); background: var(--bg-card); }
.filter-panel label { min-width: 0; }
.filter-panel label > span { display: block; margin-bottom: 7px; color: var(--text-muted); font-size: 0.65rem; }
select, input { width: 100%; height: 36px; padding: 0 10px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); color: var(--text-primary); background: var(--bg-secondary); font-size: 0.7rem; }
select:focus, input:focus { border-color: rgba(34, 211, 238, 0.5); }
.reset-button, .empty-state button { height: 36px; padding: 0 13px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); color: var(--text-secondary); background: var(--bg-soft); font-size: 0.7rem; white-space: nowrap; cursor: pointer; }
.reset-button:hover:not(:disabled), .empty-state button:hover { border-color: var(--border-strong); color: var(--text-primary); }
.filter-error { grid-column: 1 / -1; color: var(--danger); font-size: 0.68rem; }
.record-panel { width: min(1440px, 100%); min-width: 0; margin: 0 auto; overflow: hidden; border: 1px solid var(--border-color); border-radius: var(--radius-lg); background: var(--bg-card); box-shadow: var(--shadow-card); }
.panel-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 58px; padding: 12px 16px; border-bottom: 1px solid var(--border-color); }
.panel-heading > div { display: flex; align-items: baseline; gap: 10px; }
.panel-heading h2 { font-size: 0.85rem; font-weight: 600; }
.panel-heading p, .panel-heading > span { color: var(--text-muted); font-size: 0.65rem; }
.table-scroll { overflow-x: auto; }
table { width: 100%; min-width: 1110px; border-collapse: collapse; text-align: left; }
th { padding: 12px 14px; border-bottom: 1px solid var(--border-color); color: var(--text-muted); background: var(--bg-soft); font-size: 0.64rem; font-weight: 500; white-space: nowrap; }
td { padding: 14px; border-bottom: 1px solid var(--border-color); color: var(--text-secondary); font-size: 0.7rem; vertical-align: middle; white-space: nowrap; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr { transition: var(--transition); }
tbody tr:hover { background: rgba(34, 211, 238, 0.025); }
.task-link { display: block; padding: 0; border: 0; color: var(--text-primary); background: transparent; font-size: 0.74rem; font-weight: 600; cursor: pointer; }
.task-link:hover { color: var(--accent-primary); }
.task-id { display: block; margin-top: 5px; color: var(--text-muted); font-family: var(--font-mono); font-size: 0.61rem; }
.time-cell, .mono-cell { font-family: var(--font-mono); font-size: 0.67rem; }
.completion-cell { width: 118px; }
.completion-cell > div:first-child { display: flex; justify-content: space-between; gap: 8px; }
.completion-cell strong { color: var(--text-primary); font-family: var(--font-mono); font-size: 0.67rem; font-weight: 500; }
.progress-track { height: 4px; margin-top: 7px; overflow: hidden; border-radius: 4px; background: var(--bg-soft); }
.progress-track i { display: block; height: 100%; border-radius: inherit; background: var(--accent-primary); }
.anomaly-count { display: inline-grid; place-items: center; min-width: 25px; height: 25px; border-radius: 7px; color: var(--text-muted); background: var(--bg-soft); font-family: var(--font-mono); }
.anomaly-count.active { color: var(--warning); background: rgba(251, 191, 36, 0.09); }
.status-badge { display: inline-flex; align-items: center; min-height: 24px; padding: 0 8px; border: 1px solid var(--border-color); border-radius: 20px; font-size: 0.64rem; }
.tone-success { border-color: rgba(52, 211, 153, 0.22); color: var(--success); background: rgba(52, 211, 153, 0.06); }
.tone-warning { border-color: rgba(251, 191, 36, 0.22); color: var(--warning); background: rgba(251, 191, 36, 0.06); }
.tone-danger { border-color: rgba(251, 113, 133, 0.24); color: var(--danger); background: rgba(251, 113, 133, 0.07); }
.detail-button { padding: 6px 0 6px 8px; border: 0; color: var(--accent-primary); background: transparent; font-size: 0.68rem; cursor: pointer; }
.detail-button:hover { color: var(--text-primary); }
.empty-state { padding: 54px 20px; color: var(--text-secondary); text-align: center; }
.empty-state strong { font-size: 0.85rem; font-weight: 550; }
.empty-state p { margin: 8px 0 16px; color: var(--text-muted); font-size: 0.7rem; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (max-width: 860px) {
  .records-page { height: auto; min-height: calc(100dvh - 115px); }
}
@media (max-width: 1120px) {
  .filter-panel { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .reset-button { width: 100%; }
}
@media (max-width: 760px) {
  .records-page { padding: 14px; }
  .page-header { flex-direction: column; gap: 8px; }
  .data-note { padding: 0; }
  .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .filter-panel { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .panel-heading > span { display: none; }
}
@media (max-width: 480px) {
  .summary-card { padding: 13px; }
  .summary-card strong { font-size: 1.15rem; }
  .summary-card .duration-value { font-size: 0.88rem; }
  .filter-panel { grid-template-columns: 1fr; }
  .panel-heading > div { flex-direction: column; gap: 5px; }
}
</style>
