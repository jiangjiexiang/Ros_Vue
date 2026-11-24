<template>
  <section class="record-detail-page" aria-labelledby="record-detail-title">
    <div v-if="!record" class="not-found">
      <span>记录不存在</span>
      <h1 id="record-detail-title">未找到巡检记录</h1>
      <p>未找到任务 {{ route.params.id }} 对应的巡检记录，可能已被移除。</p>
      <button type="button" @click="backToRecords">返回巡检记录</button>
    </div>

    <template v-else>
      <header class="detail-header">
        <button class="back-button" type="button" @click="backToRecords"><span aria-hidden="true">←</span> 返回记录</button>
        <div class="record-heading">
          <div>
            <div class="title-line">
              <h1 id="record-detail-title">{{ record.name }}</h1>
              <span class="status-badge" :class="`tone-${getRecordResult(record.result).tone}`">{{ getRecordResult(record.result).label }}</span>
            </div>
            <p>{{ record.id }} · {{ record.scene }} · {{ record.robotName }}</p>
          </div>
          <span class="archive-label">已归档任务</span>
        </div>
      </header>

      <section class="record-summary" aria-label="任务汇总">
        <article><span>开始时间</span><strong>{{ formatDateTime(record.startedAt) }}</strong><small>结束 {{ formatDateTime(record.endedAt) }}</small></article>
        <article><span>任务耗时</span><strong>{{ formatDuration(record.duration) }}</strong><small>任务起止时间之差</small></article>
        <article><span>巡检点完成率</span><strong>{{ completionRate }}<em>%</em></strong><small>{{ completedCount }}/{{ record.points.length }} 个巡检点已执行</small></article>
        <article :class="{ abnormal: record.anomalies.length }"><span>异常数量</span><strong>{{ record.anomalies.length }}<em> 条</em></strong><small>查看下方异常明细</small></article>
      </section>

      <div v-if="linkedAnomaly" class="linked-alert" role="status">
        已打开告警 {{ linkedAnomaly.id }} 的关联任务<template v-if="route.query.pointId">，并定位到“{{ linkedAnomaly.pointName }}”</template>。
      </div>

      <section class="point-workspace" aria-label="巡检点结果">
        <div class="point-list-panel">
          <div class="section-heading">
            <div><h2>巡检点</h2><p>{{ completedCount }}/{{ record.points.length }} 已执行</p></div>
            <span>{{ record.points.length }} 个</span>
          </div>
          <div class="point-list">
            <button
              v-for="(point, index) in record.points"
              :key="point.id"
              type="button"
              :class="['point-list-item', { active: point.id === selectedPointId, abnormal: point.status === 'abnormal' }]"
              :aria-pressed="point.id === selectedPointId"
              @click="selectPoint(point.id)"
            >
              <span class="point-index">{{ String(index + 1).padStart(2, '0') }}</span>
              <span class="point-item-content">
                <strong>{{ point.name }}</strong>
                <small>{{ point.inspectedAt ? formatTime(point.inspectedAt) : '未执行' }} · {{ point.id }}</small>
              </span>
              <span class="point-status" :class="`text-${getPointStatus(point.status).tone}`">{{ getPointStatus(point.status).label }}</span>
            </button>
          </div>
        </div>

        <article v-if="selectedPoint" ref="pointPanelRef" class="point-detail-panel">
          <div class="point-detail-heading">
            <div>
              <span class="point-kicker">{{ selectedPoint.id }} · {{ selectedPoint.location }}</span>
              <h2>{{ selectedPoint.name }}</h2>
            </div>
            <span class="status-badge" :class="`tone-${getPointStatus(selectedPoint.status).tone}`">{{ getPointStatus(selectedPoint.status).label }}</span>
          </div>
          <div class="point-meta">
            <span>巡检时间 <strong>{{ formatDateTime(selectedPoint.inspectedAt, true) }}</strong></span>
            <span>点位耗时 <strong>{{ selectedPoint.inspectedAt ? formatDuration(selectedPoint.duration) : '--' }}</strong></span>
          </div>
          <p class="point-summary">{{ selectedPoint.summary }}</p>

          <section class="content-section">
            <div class="content-heading"><h3>图像与媒体</h3><span>媒体占位 · 未接入真实文件</span></div>
            <div v-if="selectedPoint.media.length" class="media-grid">
              <figure v-for="media in selectedPoint.media" :key="media.label">
                <div class="media-placeholder" :class="`media-${media.type}`">
                  <svg v-if="media.type === 'video'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3V9Z"/></svg>
                  <svg v-else-if="media.type === 'thermal'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0Z"/><path d="M12 9v7"/><circle cx="12" cy="18" r="1"/></svg>
                  <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m3 17 5-5 4 4 3-3 6 6"/></svg>
                  <span v-if="media.duration">{{ media.duration }}</span>
                </div>
                <figcaption><strong>{{ media.label }}</strong><span>{{ media.type === 'thermal' ? '红外画面占位' : media.type === 'video' ? '视频文件占位' : '图片文件占位' }}</span></figcaption>
              </figure>
            </div>
            <div v-else class="inline-empty">该巡检点未执行，无媒体记录。</div>
          </section>

          <section class="content-section sensor-section">
            <div class="content-heading"><h3>传感器读数</h3><span>采集时刻的数据快照</span></div>
            <div v-if="selectedPoint.sensors.length" class="sensor-grid">
              <article v-for="sensor in selectedPoint.sensors" :key="sensor.name" :class="sensor.status">
                <span>{{ sensor.name }}</span>
                <strong>{{ sensor.value }} <small>{{ sensor.unit }}</small></strong>
                <p>参考范围 {{ sensor.reference }}</p>
              </article>
            </div>
            <div v-else class="inline-empty">该巡检点未执行，无传感器读数。</div>
          </section>
        </article>
      </section>

      <div class="bottom-grid">
        <section class="timeline-panel">
          <div class="section-heading"><div><h2>任务时间线</h2><p>按事件发生顺序排列</p></div></div>
          <ol class="timeline">
            <li v-for="(event, index) in record.timeline" :key="`${event.time}-${index}`" :class="event.type">
              <time>{{ formatTime(event.time) }}</time>
              <span class="timeline-dot"></span>
              <div><strong>{{ event.title }}</strong><p>{{ event.description }}</p></div>
            </li>
          </ol>
        </section>

        <section class="anomaly-panel">
          <div class="section-heading"><div><h2>异常明细</h2><p>{{ record.anomalies.length }} 条任务异常</p></div></div>
          <div v-if="record.anomalies.length" class="anomaly-list">
            <article v-for="anomaly in record.anomalies" :key="anomaly.id" :class="[`level-${anomaly.level}`, { highlighted: anomaly.id === route.query.alertId }]">
              <div class="anomaly-title"><span>{{ anomalyLevels[anomaly.level] }}</span><small>{{ formatTime(anomaly.occurredAt) }}</small></div>
              <h3>{{ anomaly.title }}</h3>
              <p>{{ anomaly.description }}</p>
              <div class="recommendation"><strong>处理建议</strong>{{ anomaly.recommendation }}</div>
              <div class="anomaly-footer"><span>{{ anomaly.id }}</span><button type="button" @click="selectPoint(anomaly.pointId)">查看 {{ anomaly.pointName }} <span aria-hidden="true">→</span></button></div>
            </article>
          </div>
          <div v-else class="no-anomalies"><strong>未发现异常</strong><p>本次任务的图像与传感器读数均在设定范围内。</p></div>
        </section>
      </div>
    </template>
  </section>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { demoRecords } from './demoData.js'
import { formatDateTime, formatDuration, formatTime, getCompletionRate, getPointStatus, getRecordResult } from './utils.js'

const route = useRoute()
const router = useRouter()
const pointPanelRef = ref(null)
const selectedPointId = ref('')
const anomalyLevels = { critical: '严重', warning: '警告', info: '提示' }
const record = computed(() => demoRecords.find((item) => item.id === route.params.id))
const selectedPoint = computed(() => record.value?.points.find((point) => point.id === selectedPointId.value))
const completionRate = computed(() => getCompletionRate(record.value))
const completedCount = computed(() => record.value?.points.filter((point) => point.status !== 'skipped').length || 0)
const linkedAnomaly = computed(() => record.value?.anomalies.find((item) => item.id === route.query.alertId))

watch([() => route.params.id, () => route.query.pointId], async () => {
  const points = record.value?.points || []
  const requestedPoint = points.find((point) => point.id === route.query.pointId)
  selectedPointId.value = (requestedPoint || points[0])?.id || ''
  await nextTick()
  if (requestedPoint) pointPanelRef.value?.scrollIntoView({ block: 'start' })
}, { immediate: true })

function backToRecords() {
  router.push({ path: '/records' })
}

function selectPoint(pointId) {
  selectedPointId.value = pointId
  if (route.query.pointId !== pointId) {
    router.replace({ query: { ...route.query, pointId } })
  } else {
    nextTick(() => pointPanelRef.value?.scrollIntoView({ block: 'start' }))
  }
}
</script>

<style scoped>
.record-detail-page { display: flex; flex-direction: column; gap: 16px; width: 100%; height: 100%; min-height: 0; padding: 24px; overflow: auto; }
.detail-header, .record-summary, .point-workspace, .bottom-grid, .linked-alert, .demo-footnote { width: min(1440px, 100%); margin-right: auto; margin-left: auto; }
.back-button { margin-bottom: 14px; padding: 0; border: 0; color: var(--text-secondary); background: transparent; font-size: 0.7rem; cursor: pointer; }
.back-button:hover { color: var(--accent-primary); }
.back-button span { margin-right: 5px; }
.record-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.title-line { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; }
h1 { font-size: 1.3rem; font-weight: 650; }
.record-heading p { margin-top: 8px; color: var(--text-muted); font-family: var(--font-mono); font-size: 0.68rem; }
.archive-label { padding: 5px 9px; border: 1px solid var(--border-color); border-radius: 6px; color: var(--text-muted); font-size: 0.65rem; white-space: nowrap; }
.demo-badge { padding: 3px 7px; border: 1px solid rgba(251, 191, 36, 0.24); border-radius: 6px; color: var(--warning); background: rgba(251, 191, 36, 0.07); font-size: 0.62rem; }
.status-badge { display: inline-flex; align-items: center; min-height: 24px; padding: 0 8px; border: 1px solid var(--border-color); border-radius: 20px; font-size: 0.64rem; white-space: nowrap; }
.tone-success { border-color: rgba(52, 211, 153, 0.22); color: var(--success); background: rgba(52, 211, 153, 0.06); }
.tone-warning { border-color: rgba(251, 191, 36, 0.22); color: var(--warning); background: rgba(251, 191, 36, 0.06); }
.tone-danger { border-color: rgba(251, 113, 133, 0.24); color: var(--danger); background: rgba(251, 113, 133, 0.07); }
.tone-muted { color: var(--text-muted); background: var(--bg-soft); }
.text-success { color: var(--success); }
.text-danger { color: var(--danger); }
.text-muted { color: var(--text-muted); }
.record-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.record-summary article { min-width: 0; padding: 15px 16px; border: 1px solid var(--border-color); border-radius: var(--radius-md); background: var(--bg-card); }
.record-summary span { color: var(--text-muted); font-size: 0.66rem; }
.record-summary strong { display: block; margin-top: 8px; overflow: hidden; color: var(--text-primary); font-family: var(--font-mono); font-size: 1rem; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.record-summary strong em { color: var(--text-secondary); font-size: 0.68rem; font-style: normal; font-weight: 400; }
.record-summary small { display: block; margin-top: 6px; overflow: hidden; color: var(--text-muted); font-size: 0.62rem; text-overflow: ellipsis; white-space: nowrap; }
.record-summary article.abnormal strong { color: var(--warning); }
.linked-alert { padding: 11px 14px; border: 1px solid rgba(34, 211, 238, 0.2); border-radius: var(--radius-sm); color: var(--accent-primary); background: rgba(34, 211, 238, 0.05); font-size: 0.7rem; line-height: 1.6; }
.point-workspace { display: grid; grid-template-columns: 310px minmax(0, 1fr); gap: 16px; align-items: start; }
.point-list-panel, .point-detail-panel, .timeline-panel, .anomaly-panel { overflow: hidden; border: 1px solid var(--border-color); border-radius: var(--radius-lg); background: var(--bg-card); box-shadow: var(--shadow-card); }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 60px; padding: 13px 15px; border-bottom: 1px solid var(--border-color); }
.section-heading > div { display: flex; align-items: baseline; gap: 9px; }
.section-heading h2 { font-size: 0.84rem; font-weight: 600; }
.section-heading p, .section-heading > span { color: var(--text-muted); font-size: 0.64rem; }
.point-list { padding: 7px; }
.point-list-item { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 62px; padding: 9px; border: 1px solid transparent; border-radius: var(--radius-sm); color: var(--text-secondary); background: transparent; text-align: left; cursor: pointer; transition: var(--transition); }
.point-list-item + .point-list-item { margin-top: 3px; }
.point-list-item:hover { background: var(--bg-soft); }
.point-list-item.active { border-color: rgba(34, 211, 238, 0.24); background: rgba(34, 211, 238, 0.06); }
.point-list-item.abnormal:not(.active) { background: rgba(251, 113, 133, 0.025); }
.point-index { display: grid; place-items: center; width: 30px; height: 30px; flex: 0 0 auto; border-radius: 7px; color: var(--text-muted); background: var(--bg-soft); font-family: var(--font-mono); font-size: 0.66rem; }
.point-list-item.active .point-index { color: var(--accent-primary); background: rgba(34, 211, 238, 0.09); }
.point-item-content { min-width: 0; flex: 1; }
.point-item-content strong { display: block; overflow: hidden; color: var(--text-primary); font-size: 0.71rem; font-weight: 550; text-overflow: ellipsis; white-space: nowrap; }
.point-item-content small { display: block; margin-top: 5px; color: var(--text-muted); font-family: var(--font-mono); font-size: 0.59rem; }
.point-status { flex: 0 0 auto; font-size: 0.62rem; }
.point-detail-panel { min-width: 0; padding: 18px; scroll-margin-top: 16px; }
.point-detail-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.point-kicker { color: var(--text-muted); font-size: 0.62rem; }
.point-detail-heading h2 { margin-top: 7px; font-size: 1.02rem; font-weight: 600; }
.point-meta { display: flex; flex-wrap: wrap; gap: 10px 24px; margin-top: 14px; color: var(--text-muted); font-size: 0.66rem; }
.point-meta strong { margin-left: 6px; color: var(--text-secondary); font-family: var(--font-mono); font-weight: 400; }
.point-summary { margin-top: 14px; padding: 11px 12px; border-left: 2px solid var(--accent-primary); color: var(--text-secondary); background: var(--bg-soft); font-size: 0.7rem; line-height: 1.7; }
.content-section { margin-top: 20px; }
.content-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 11px; }
.content-heading h3 { font-size: 0.76rem; font-weight: 600; }
.content-heading span { color: var(--text-muted); font-size: 0.61rem; }
.media-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.media-grid figure { min-width: 0; overflow: hidden; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-secondary); }
.media-placeholder { position: relative; display: grid; place-items: center; aspect-ratio: 16 / 8; color: var(--text-muted); background: radial-gradient(circle at center, rgba(148, 163, 184, 0.08), transparent 55%), repeating-linear-gradient(135deg, transparent, transparent 12px, rgba(148, 163, 184, 0.018) 12px, rgba(148, 163, 184, 0.018) 13px); }
.media-placeholder svg { width: 34px; height: 34px; }
.media-placeholder > span { position: absolute; right: 8px; bottom: 7px; padding: 2px 5px; border-radius: 4px; color: var(--text-secondary); background: rgba(7, 17, 31, 0.8); font-family: var(--font-mono); font-size: 0.58rem; }
.media-placeholder.media-thermal { color: var(--warning); background: radial-gradient(circle at 62% 45%, rgba(251, 113, 133, 0.16), transparent 25%), radial-gradient(circle at center, rgba(251, 191, 36, 0.08), transparent 60%); }
.media-grid figcaption { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 9px 10px; }
.media-grid figcaption strong { color: var(--text-secondary); font-size: 0.66rem; font-weight: 500; }
.media-grid figcaption span { color: var(--text-muted); font-size: 0.58rem; }
.sensor-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.sensor-grid article { min-width: 0; padding: 12px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-soft); }
.sensor-grid article > span { color: var(--text-muted); font-size: 0.63rem; }
.sensor-grid article > strong { display: block; margin-top: 8px; color: var(--success); font-family: var(--font-mono); font-size: 1.05rem; font-weight: 550; white-space: nowrap; }
.sensor-grid article.warning > strong { color: var(--warning); }
.sensor-grid article.danger > strong { color: var(--danger); }
.sensor-grid article small { color: var(--text-secondary); font-size: 0.61rem; font-weight: 400; }
.sensor-grid article p { margin-top: 6px; overflow: hidden; color: var(--text-muted); font-size: 0.58rem; text-overflow: ellipsis; white-space: nowrap; }
.inline-empty { padding: 25px 12px; border: 1px dashed var(--border-color); border-radius: var(--radius-sm); color: var(--text-muted); font-size: 0.68rem; text-align: center; }
.bottom-grid { display: grid; grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr); gap: 16px; align-items: start; }
.timeline { padding: 16px; list-style: none; }
.timeline li { display: grid; grid-template-columns: 62px 14px minmax(0, 1fr); gap: 9px; min-height: 72px; }
.timeline time { padding-top: 1px; color: var(--text-muted); font-family: var(--font-mono); font-size: 0.62rem; }
.timeline-dot { position: relative; width: 8px; height: 8px; margin-top: 3px; border: 2px solid var(--bg-card); border-radius: 50%; background: var(--accent-primary); box-shadow: 0 0 0 1px rgba(34, 211, 238, 0.35); }
.timeline-dot::after { position: absolute; top: 10px; left: 2px; width: 1px; height: calc(100% + 43px); background: var(--border-color); content: ''; }
.timeline li:last-child .timeline-dot::after { display: none; }
.timeline li.alert .timeline-dot { background: var(--danger); box-shadow: 0 0 0 1px rgba(251, 113, 133, 0.35); }
.timeline li.success .timeline-dot { background: var(--success); box-shadow: 0 0 0 1px rgba(52, 211, 153, 0.35); }
.timeline li strong { color: var(--text-primary); font-size: 0.7rem; font-weight: 550; }
.timeline li p { margin-top: 6px; color: var(--text-muted); font-size: 0.65rem; line-height: 1.6; }
.anomaly-list { display: flex; flex-direction: column; gap: 10px; padding: 13px; }
.anomaly-list article { padding: 13px; border: 1px solid var(--border-color); border-left: 2px solid var(--warning); border-radius: var(--radius-sm); background: var(--bg-soft); }
.anomaly-list article.level-critical { border-left-color: var(--danger); }
.anomaly-list article.level-info { border-left-color: var(--accent-secondary); }
.anomaly-list article.highlighted { border-color: rgba(34, 211, 238, 0.4); }
.anomaly-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.anomaly-title > span { color: var(--warning); font-size: 0.62rem; }
.level-critical .anomaly-title > span { color: var(--danger); }
.level-info .anomaly-title > span { color: var(--accent-secondary); }
.anomaly-title small { color: var(--text-muted); font-family: var(--font-mono); font-size: 0.6rem; }
.anomaly-list h3 { margin-top: 7px; font-size: 0.76rem; font-weight: 600; }
.anomaly-list article > p { margin-top: 7px; color: var(--text-secondary); font-size: 0.66rem; line-height: 1.6; }
.recommendation { margin-top: 9px; color: var(--text-muted); font-size: 0.63rem; line-height: 1.6; }
.recommendation strong { margin-right: 7px; color: var(--text-secondary); font-weight: 500; }
.anomaly-footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 11px; padding-top: 9px; border-top: 1px solid var(--border-color); }
.anomaly-footer > span { color: var(--text-muted); font-family: var(--font-mono); font-size: 0.58rem; }
.anomaly-footer button { padding: 0; border: 0; color: var(--accent-primary); background: transparent; font-size: 0.63rem; cursor: pointer; }
.no-anomalies { padding: 44px 20px; text-align: center; }
.no-anomalies strong { color: var(--success); font-size: 0.8rem; font-weight: 550; }
.no-anomalies p { margin-top: 8px; color: var(--text-muted); font-size: 0.66rem; }
.demo-footnote { color: var(--text-muted); font-size: 0.63rem; text-align: center; }
.not-found { width: min(520px, 100%); margin: auto; padding: 40px; border: 1px solid var(--border-color); border-radius: var(--radius-lg); background: var(--bg-card); text-align: center; }
.not-found > span { color: var(--text-muted); font-family: var(--font-mono); font-size: 0.62rem; letter-spacing: 0.12em; }
.not-found h1 { margin-top: 12px; }
.not-found p { margin-top: 10px; color: var(--text-muted); font-size: 0.72rem; line-height: 1.7; }
.not-found button { margin-top: 20px; min-height: 36px; padding: 0 15px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); color: var(--accent-primary); background: var(--bg-soft); font-size: 0.7rem; cursor: pointer; }
@media (max-width: 860px) {
  .record-detail-page { height: auto; min-height: calc(100dvh - 115px); }
}
@media (max-width: 1080px) {
  .point-workspace { grid-template-columns: 270px minmax(0, 1fr); }
  .bottom-grid { grid-template-columns: 1fr; }
}
@media (max-width: 800px) {
  .record-detail-page { padding: 14px; }
  .record-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .point-workspace { grid-template-columns: 1fr; }
  .point-list { display: flex; gap: 6px; overflow-x: auto; }
  .point-list-item { min-width: 235px; }
  .point-list-item + .point-list-item { margin-top: 0; }
}
@media (max-width: 520px) {
  .record-heading { flex-direction: column; gap: 10px; }
  .archive-label { display: none; }
  .record-summary article { padding: 13px; }
  .record-summary strong { font-size: 0.82rem; }
  .point-detail-panel { padding: 14px; }
  .point-detail-heading { flex-direction: column; }
  .media-grid, .sensor-grid { grid-template-columns: 1fr; }
  .content-heading { align-items: flex-start; flex-direction: column; gap: 5px; }
  .timeline li { grid-template-columns: 52px 12px minmax(0, 1fr); gap: 7px; }
  .anomaly-footer { align-items: flex-start; flex-direction: column; }
}
</style>
