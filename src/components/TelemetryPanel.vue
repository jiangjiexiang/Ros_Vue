<template>
  <section class="card">
    <div class="card-header">
      <span><UiIcon name="activity" :size="17" />底盘与姿态遥测</span>
      <small>{{ connected ? '/odom · /imu' : '离线' }}</small>
    </div>
    <div class="card-body">
      <div v-if="!odomData && !imuData" class="empty-text">
        {{ connected ? '等待 /odom /imu 数据' : '连接机器狗后显示遥测' }}
      </div>
      <div v-else class="telemetry-grid">
        <div v-for="item in telemetry" :key="item.label" class="data-group">
          <span class="data-label">{{ item.label }}</span>
          <span class="data-value">{{ item.value }}<small v-if="item.unit">{{ item.unit }}</small></span>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import UiIcon from './UiIcon.vue'

const props = defineProps({
  odomData: { type: Object, default: null },
  imuData: { type: Object, default: null },
  connected: { type: Boolean, default: false }
})

const eulerDeg = computed(() => {
  const q = props.imuData?.orientation || props.odomData?.pose?.pose?.orientation
  if (!q) return null
  const { x = 0, y = 0, z = 0, w = 1 } = q
  if (![x, y, z, w].every(Number.isFinite)) return null
  const sinr = 2 * (w * x + y * z)
  const cosr = 1 - 2 * (x * x + y * y)
  const roll = Math.atan2(sinr, cosr) * (180 / Math.PI)

  const sinp = 2 * (w * y - z * x)
  const pitch = (Math.abs(sinp) >= 1 ? Math.sign(sinp) * 90 : Math.asin(sinp) * (180 / Math.PI))

  const siny = 2 * (w * z + x * y)
  const cosy = 1 - 2 * (y * y + z * z)
  const yaw = Math.atan2(siny, cosy) * (180 / Math.PI)
  return { roll, pitch, yaw }
})

const telemetry = computed(() => {
  const pose = props.odomData?.pose?.pose?.position
  const twist = props.odomData?.twist?.twist
  const rpy = eulerDeg.value
  return [
    { label: '位置 X', value: format(pose?.x), unit: 'm' },
    { label: '位置 Y', value: format(pose?.y), unit: 'm' },
    { label: '线速度', value: format(twist?.linear?.x), unit: 'm/s' },
    { label: '角速度', value: format(twist?.angular?.z), unit: 'rad/s' },
    { label: '横滚 / 俯仰', value: rpy ? `${rpy.roll.toFixed(1)}° / ${rpy.pitch.toFixed(1)}°` : '--', unit: '' },
    { label: '航向 Yaw', value: rpy ? rpy.yaw.toFixed(1) : '--', unit: rpy ? '°' : '' }
  ]
})

function format(value) {
  return Number.isFinite(value) ? value.toFixed(3) : '--'
}
</script>

<style scoped>
.telemetry-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.data-group {
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--bg-soft);
}
.data-label { display: block; margin-bottom: 5px; color: var(--text-muted); font-size: var(--text-xs); }
.data-value { display: block; overflow: hidden; color: var(--text-primary); font-family: var(--font-mono); font-size: 0.84rem; text-overflow: ellipsis; white-space: nowrap; }
.data-value small { margin-left: 3px; color: var(--text-muted); font-size: var(--text-xs); }
</style>
