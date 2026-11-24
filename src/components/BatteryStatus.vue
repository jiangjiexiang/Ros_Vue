<template>
  <section class="card">
    <div class="card-header">
      <span><UiIcon name="battery" :size="17" />电源状态</span>
      <small>{{ hasData ? '实时数据' : '暂无数据' }}</small>
    </div>
    <div class="card-body">
      <div class="battery-summary">
        <div>
          <strong>{{ hasData ? displayPercentage : '--' }}<small v-if="hasData">%</small></strong>
          <span>剩余电量</span>
        </div>
        <div class="battery-voltage-value">
          <strong>{{ hasVoltage ? voltage : '--' }}<small v-if="hasVoltage"> V</small></strong>
          <span>电池电压</span>
        </div>
      </div>
      <div class="battery-track">
        <div class="battery-track-fill" :class="batteryClass" :style="{ width: `${displayPercentage}%` }"></div>
      </div>
      <div class="battery-footer">
        <span>{{ connected ? '数据链路正常' : '等待机器人连接' }}</span>
        <span :class="{ low: hasData && displayPercentage <= 20 }">{{ hasData ? batteryHint : '暂无遥测' }}</span>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import UiIcon from './UiIcon.vue'

const props = defineProps({
  percentage: { type: Number, default: -1 },
  voltage: { type: [Number, String], default: 0 },
  connected: { type: Boolean, default: false }
})

const hasData = computed(() => props.connected && props.percentage >= 0)
const hasVoltage = computed(() => props.connected && Number(props.voltage) > 0)
const displayPercentage = computed(() => Math.min(100, Math.max(0, props.percentage)))
const batteryClass = computed(() => {
  if (displayPercentage.value <= 20) return 'low'
  if (displayPercentage.value <= 50) return 'medium'
  return 'high'
})
const batteryHint = computed(() => {
  if (displayPercentage.value <= 20) return '请及时充电'
  if (displayPercentage.value <= 50) return '电量适中'
  return '电量充足'
})
</script>

<style scoped>
.battery-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}
.battery-summary > div { display: flex; flex-direction: column; }
.battery-summary strong {
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 1.55rem;
  font-weight: 600;
  line-height: 1;
}
.battery-summary strong small { color: var(--text-secondary); font-size: 0.78rem; }
.battery-summary span { margin-top: 7px; color: var(--text-muted); font-size: 0.64rem; }
.battery-voltage-value { text-align: right; }
.battery-voltage-value strong { font-size: 1rem; }
.battery-track {
  height: 6px;
  overflow: hidden;
  border-radius: 10px;
  background: rgba(148, 163, 184, 0.1);
}
.battery-track-fill { height: 100%; border-radius: inherit; transition: width 500ms ease; }
.battery-track-fill.high { background: var(--success); }
.battery-track-fill.medium { background: var(--warning); }
.battery-track-fill.low { background: var(--danger); }
.battery-footer {
  display: flex;
  justify-content: space-between;
  margin-top: 9px;
  color: var(--text-muted);
  font-size: 0.62rem;
}
.battery-footer .low { color: var(--danger); }
</style>
