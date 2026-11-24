<template>
  <section class="dog-status-panel" aria-label="机器狗详细状态">
    <header class="panel-header">
      <div>
        <h2>{{ title }}</h2>
        <p v-if="statusData.name">{{ statusData.name }}</p>
      </div>
      <span class="data-indicator" :class="{ available: hasTelemetry }">
        <i></i>{{ hasTelemetry ? '已接收遥测' : '暂无遥测' }}
      </span>
    </header>

    <div class="panel-content">
      <div class="power-layout">
        <section class="battery-section" aria-label="电池状态">
          <div class="section-title">
            <span><UiIcon name="battery" :size="16" />电池状态</span>
            <small>电源</small>
          </div>
          <div class="battery-content">
            <div class="battery-value">
              <strong :class="[batteryTone, { missing: !hasBatteryPercentage }]">
                {{ batteryPercentage.value }}<small v-if="hasBatteryPercentage">%</small>
              </strong>
              <span>剩余电量</span>
            </div>
            <div class="voltage-value">
              <strong :class="{ missing: batteryVoltage.value === '--' }">
                {{ batteryVoltage.value }}<small v-if="batteryVoltage.unit">{{ batteryVoltage.unit }}</small>
              </strong>
              <span>电池电压</span>
            </div>
          </div>
          <div
            class="battery-track"
            :class="{ empty: !hasBatteryPercentage }"
            role="progressbar"
            aria-label="剩余电量"
            :aria-valuenow="hasBatteryPercentage ? statusData.battery.percentage : undefined"
            :aria-valuemin="hasBatteryPercentage ? 0 : undefined"
            :aria-valuemax="hasBatteryPercentage ? 100 : undefined"
          >
            <span :class="batteryTone" :style="{ width: batteryWidth }"></span>
          </div>
        </section>

        <dl class="quick-metrics">
          <div v-for="item in quickMetrics" :key="item.label">
            <dt>{{ item.label }}</dt>
            <dd :class="{ missing: item.value === '--' }">
              {{ item.value }}<small v-if="item.unit">{{ item.unit }}</small>
            </dd>
          </div>
        </dl>
      </div>

      <div class="telemetry-groups">
        <section class="telemetry-section">
          <div class="section-title">
            <span><UiIcon name="compass" :size="16" />IMU 姿态</span>
            <small>欧拉角</small>
          </div>
          <dl class="metric-grid three-columns">
            <div v-for="item in imuMetrics" :key="item.label" class="metric-item">
              <dt>{{ item.label }}</dt>
              <dd :class="{ missing: item.value === '--' }">
                {{ item.value }}<small v-if="item.unit">{{ item.unit }}</small>
              </dd>
            </div>
          </dl>
        </section>

        <section class="telemetry-section">
          <div class="section-title">
            <span><UiIcon name="move" :size="16" />运动速度</span>
            <small>机体系</small>
          </div>
          <dl class="metric-grid three-columns">
            <div v-for="item in velocityMetrics" :key="item.label" class="metric-item">
              <dt>{{ item.label }}</dt>
              <dd :class="{ missing: item.value === '--' }">
                {{ item.value }}<small v-if="item.unit">{{ item.unit }}</small>
              </dd>
            </div>
          </dl>
        </section>
      </div>

      <section class="telemetry-section feet-section">
        <div class="section-title">
          <span><UiIcon name="activity" :size="16" />足端状态</span>
          <small>触地状态 / 温度</small>
        </div>
        <div class="feet-grid">
          <article v-for="foot in feet" :key="foot.id" class="foot-card">
            <div class="foot-heading">
              <strong>{{ foot.label }}</strong>
              <span class="foot-state" :class="foot.stateClass">{{ foot.status }}</span>
            </div>
            <div class="foot-temperature">
              <span>足端温度</span>
              <strong :class="{ missing: foot.temperature.value === '--' }">
                {{ foot.temperature.value }}<small v-if="foot.temperature.unit">{{ foot.temperature.unit }}</small>
              </strong>
            </div>
          </article>
        </div>
      </section>

      <section class="telemetry-section temperature-section">
        <div class="section-title">
          <span><UiIcon name="activity" :size="16" />机体温度</span>
          <small>摄氏温度</small>
        </div>
        <dl class="metric-grid two-columns">
          <div v-for="item in temperatureMetrics" :key="item.label" class="metric-item">
            <dt>{{ item.label }}</dt>
            <dd :class="{ missing: item.value === '--' }">
              {{ item.value }}<small v-if="item.unit">{{ item.unit }}</small>
            </dd>
          </div>
        </dl>
      </section>
    </div>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import UiIcon from '../../components/UiIcon.vue'

/**
 * data 支持的字段及单位：
 * {
 *   name?: string,
 *   battery?: { percentage?: number, voltage?: number }, // 百分比（0–100）、V
 *   imu?: { roll?: number, pitch?: number, yaw?: number }, // 均为角度 °
 *   velocity?: { linearX?: number, linearY?: number, angularZ?: number }, // m/s、m/s、rad/s
 *   bodyHeight?: number, // m
 *   gait?: string, // stand/walk/trot/pace/bound/crawl/idle，或直接传中文名称
 *   feet?: Array<{
 *     id: 'lf' | 'rf' | 'lh' | 'rh', // 左前、右前、左后、右后
 *     label?: string,
 *     status?: string, // contact/stance/swing/flight/error/fault/offline，或直接传状态文本
 *     temperature?: number // °C
 *   }>,
 *   temperature?: { body?: number, motor?: number } // °C
 * }
 * 数值字段仅接受有限 number；null、undefined、NaN、Infinity 和数值字符串均显示 --。
 */
const props = defineProps({
  data: { type: Object, default: () => ({}) },
  title: { type: String, default: '机器狗状态' }
})

const FOOT_DEFINITIONS = [
  { id: 'lf', label: '左前足' },
  { id: 'rf', label: '右前足' },
  { id: 'lh', label: '左后足' },
  { id: 'rh', label: '右后足' }
]
const statusData = computed(() => props.data || {})
const batteryPercentage = computed(() => metric(statusData.value.battery?.percentage, '%', 0))
const batteryVoltage = computed(() => metric(statusData.value.battery?.voltage, 'V', 1))
const hasBatteryPercentage = computed(() => Number.isFinite(statusData.value.battery?.percentage))
const batteryWidth = computed(() => {
  if (!hasBatteryPercentage.value) return '0%'
  return `${Math.max(0, Math.min(100, statusData.value.battery.percentage))}%`
})
const batteryTone = computed(() => {
  const value = statusData.value.battery?.percentage
  if (!Number.isFinite(value)) return 'unknown'
  if (value <= 20) return 'low'
  if (value <= 50) return 'medium'
  return 'high'
})

const quickMetrics = computed(() => [
  { label: '机体高度', ...metric(statusData.value.bodyHeight, 'm', 2) },
  { label: '当前步态', ...metricText(gaitText(statusData.value.gait)) }
])
const imuMetrics = computed(() => [
  { label: '横滚 Roll', ...metric(statusData.value.imu?.roll, '°', 1) },
  { label: '俯仰 Pitch', ...metric(statusData.value.imu?.pitch, '°', 1) },
  { label: '偏航 Yaw', ...metric(statusData.value.imu?.yaw, '°', 1) }
])
const velocityMetrics = computed(() => [
  { label: '前后速度 X', ...metric(statusData.value.velocity?.linearX, 'm/s', 2) },
  { label: '横向速度 Y', ...metric(statusData.value.velocity?.linearY, 'm/s', 2) },
  { label: '转向角速度 Z', ...metric(statusData.value.velocity?.angularZ, 'rad/s', 2) }
])
const temperatureMetrics = computed(() => [
  { label: '机体温度', ...metric(statusData.value.temperature?.body, '°C', 1) },
  { label: '电机温度', ...metric(statusData.value.temperature?.motor, '°C', 1) }
])
const feet = computed(() => {
  const source = Array.isArray(statusData.value.feet) ? statusData.value.feet : []
  return FOOT_DEFINITIONS.map((definition) => {
    const foot = source.find((item) => item?.id === definition.id) || {}
    return {
      ...definition,
      label: nonEmptyText(foot.label) || definition.label,
      status: footStatusText(foot.status),
      stateClass: footStatusClass(foot.status),
      temperature: metric(foot.temperature, '°C', 1)
    }
  })
})
const hasTelemetry = computed(() => {
  const metrics = [
    batteryPercentage.value,
    batteryVoltage.value,
    ...quickMetrics.value,
    ...imuMetrics.value,
    ...velocityMetrics.value,
    ...temperatureMetrics.value,
    ...feet.value.map((foot) => foot.temperature)
  ]
  return metrics.some((item) => item.value !== '--')
    || feet.value.some((foot) => foot.status !== '--')
})

function metric(value, unit, precision) {
  if (!Number.isFinite(value)) return { value: '--', unit: '' }
  return { value: value.toFixed(precision), unit }
}

function metricText(value) {
  return { value: value || '--', unit: '' }
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim() ? value : ''
}

function gaitText(gait) {
  if (!nonEmptyText(gait) || gait === 'unknown') return '--'
  const labels = {
    stand: '站立', walk: '步行', trot: '对角小跑', pace: '同侧步态',
    bound: '跳跃', crawl: '爬行', idle: '空闲'
  }
  return labels[gait] || gait
}

function footStatusText(status) {
  if (!nonEmptyText(status) || status === 'unknown') return '--'
  const labels = {
    contact: '支撑', stance: '支撑', swing: '摆动', flight: '腾空',
    error: '异常', fault: '异常', offline: '离线'
  }
  return labels[status] || status
}

function footStatusClass(status) {
  if (status === 'contact' || status === 'stance') return 'contact'
  if (status === 'swing' || status === 'flight') return 'swing'
  if (status === 'error' || status === 'fault') return 'fault'
  if (status === 'offline') return 'offline'
  return 'unknown'
}
</script>

<style scoped>
.dog-status-panel {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  color: var(--text-primary);
  background: linear-gradient(155deg, var(--bg-card), var(--bg-secondary));
  box-shadow: var(--shadow-card);
}
.panel-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 60px; padding: 13px 16px; border-bottom: 1px solid var(--border-color); }
.panel-header h2 { font-size: 0.88rem; font-weight: 600; }
.panel-header p { margin-top: 5px; color: var(--text-muted); font-size: 0.64rem; }
.data-indicator { display: inline-flex; align-items: center; gap: 6px; color: var(--text-muted); font-size: 0.63rem; white-space: nowrap; }
.data-indicator i { width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); }
.data-indicator.available { color: var(--success); }
.data-indicator.available i { background: var(--success); box-shadow: 0 0 0 3px rgba(52, 211, 153, 0.08); }
.panel-content { padding: 15px; }
.power-layout { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(180px, 1fr); gap: 11px; }
.battery-section, .telemetry-section { padding: 13px; border: 1px solid var(--border-color); border-radius: var(--radius-md); background: var(--bg-soft); }
.section-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
.section-title > span { display: flex; align-items: center; gap: 7px; color: var(--text-secondary); font-size: 0.7rem; font-weight: 600; }
.section-title svg { color: var(--accent-primary); }
.section-title > small { color: var(--text-muted); font-size: 0.58rem; font-weight: 400; }
.battery-content { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; }
.battery-value, .voltage-value { display: flex; flex-direction: column; }
.battery-value strong { color: var(--success); font-family: var(--font-mono); font-size: 1.65rem; font-weight: 600; line-height: 1; }
.battery-value strong.medium { color: var(--warning); }
.battery-value strong.low { color: var(--danger); }
.battery-value strong small, .voltage-value strong small { margin-left: 3px; color: var(--text-secondary); font-size: 0.65rem; font-weight: 400; }
.battery-value > span, .voltage-value > span { margin-top: 7px; color: var(--text-muted); font-size: 0.59rem; }
.voltage-value { text-align: right; }
.voltage-value strong { font-family: var(--font-mono); font-size: 0.95rem; font-weight: 600; }
.missing { color: var(--text-muted) !important; }
.battery-track { height: 5px; margin-top: 13px; overflow: hidden; border-radius: 5px; background: rgba(148, 163, 184, 0.1); }
.battery-track > span { display: block; height: 100%; border-radius: inherit; background: var(--success); transition: width 300ms ease; }
.battery-track > span.medium { background: var(--warning); }
.battery-track > span.low { background: var(--danger); }
.battery-track.empty > span { background: transparent; }
.quick-metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 11px; }
.quick-metrics > div { display: flex; flex-direction: column; justify-content: center; min-width: 0; padding: 13px; border: 1px solid var(--border-color); border-radius: var(--radius-md); background: var(--bg-soft); }
.quick-metrics dt, .metric-item dt { color: var(--text-muted); font-size: 0.61rem; }
.quick-metrics dd { margin-top: 9px; overflow: hidden; font-size: 0.85rem; font-weight: 550; text-overflow: ellipsis; white-space: nowrap; }
.quick-metrics dd small, .metric-item dd small { margin-left: 4px; color: var(--text-muted); font-size: 0.56rem; font-weight: 400; }
.telemetry-groups { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 11px; margin-top: 11px; }
.metric-grid { display: grid; gap: 8px; }
.three-columns { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.two-columns { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.metric-item { min-width: 0; padding: 10px; border-radius: var(--radius-sm); background: rgba(2, 8, 18, 0.24); }
.metric-item dd { margin-top: 7px; overflow: hidden; font-family: var(--font-mono); font-size: 0.76rem; font-weight: 550; text-overflow: ellipsis; white-space: nowrap; }
.feet-section, .temperature-section { margin-top: 11px; }
.feet-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.foot-card { min-width: 0; padding: 10px; border-radius: var(--radius-sm); background: rgba(2, 8, 18, 0.24); }
.foot-heading { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.foot-heading > strong { color: var(--text-secondary); font-size: 0.64rem; font-weight: 550; white-space: nowrap; }
.foot-state { padding: 3px 5px; border-radius: 5px; color: var(--text-muted); background: var(--bg-soft); font-size: 0.55rem; white-space: nowrap; }
.foot-state.contact { color: var(--success); background: rgba(52, 211, 153, 0.07); }
.foot-state.swing { color: var(--accent-primary); background: rgba(34, 211, 238, 0.07); }
.foot-state.fault { color: var(--danger); background: rgba(251, 113, 133, 0.07); }
.foot-temperature { display: flex; align-items: baseline; justify-content: space-between; gap: 5px; margin-top: 12px; }
.foot-temperature > span { color: var(--text-muted); font-size: 0.56rem; }
.foot-temperature > strong { font-family: var(--font-mono); font-size: 0.7rem; font-weight: 550; white-space: nowrap; }
.foot-temperature small { margin-left: 3px; color: var(--text-muted); font-size: 0.51rem; font-weight: 400; }
@media (max-width: 760px) {
  .power-layout, .telemetry-groups { grid-template-columns: 1fr; }
  .quick-metrics { gap: 8px; }
  .feet-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 390px) {
  .panel-content { padding: 11px; }
  .panel-header { padding: 12px; }
  .three-columns { grid-template-columns: 1fr; }
  .metric-item { display: flex; align-items: center; justify-content: space-between; }
  .metric-item dd { margin-top: 0; }
}
</style>
