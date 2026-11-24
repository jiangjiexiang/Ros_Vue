<template>
  <section class="card">
    <div class="card-header">
      <span><UiIcon name="activity" :size="17" />底盘遥测</span>
      <small>{{ connected ? '/odom' : '暂无数据' }}</small>
    </div>
    <div class="card-body">
      <div v-if="!odomData" class="empty-text">等待 /odom 数据</div>
      <div v-else class="telemetry-grid">
        <div v-for="item in telemetry" :key="item.label" class="data-group">
          <span class="data-label">{{ item.label }}</span>
          <span class="data-value">{{ item.value }}<small>{{ item.unit }}</small></span>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import UiIcon from './UiIcon.vue'

const props = defineProps({ odomData: Object })
const telemetry = computed(() => {
  const pose = props.odomData?.pose?.pose?.position
  const twist = props.odomData?.twist?.twist
  return [
    { label: '位置 X', value: format(pose?.x), unit: 'm' },
    { label: '位置 Y', value: format(pose?.y), unit: 'm' },
    { label: '线速度', value: format(twist?.linear?.x), unit: 'm/s' },
    { label: '角速度', value: format(twist?.angular?.z), unit: 'rad/s' }
  ]
})

function format(value) {
  return Number.isFinite(value) ? value.toFixed(3) : '--'
}
</script>

<style scoped>
.telemetry-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.data-group {
  padding: 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--bg-soft);
}
.data-label { display: block; margin-bottom: 6px; color: var(--text-muted); font-size: 0.62rem; }
.data-value { color: var(--text-primary); font-family: var(--font-mono); font-size: 0.82rem; }
.data-value small { margin-left: 4px; color: var(--text-muted); font-size: 0.58rem; }
</style>
