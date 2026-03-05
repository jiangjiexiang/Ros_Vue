<template>
  <div class="card" id="battery-status">
    <div class="card-header">
      <span class="icon">🔋</span> 电池状态
    </div>
    <div class="card-body">
      <div class="battery-gauge">
        <div
          class="battery-gauge-fill"
          :class="batteryClass"
          :style="{ width: displayPercentage + '%' }"
        ></div>
        <span class="battery-text">
          {{ connected && percentage >= 0 ? displayPercentage + '%' : '--' }}
        </span>
      </div>
      <div class="battery-voltage" v-if="connected && voltage > 0">
        ⚡ {{ voltage }} V
      </div>
      <div class="battery-voltage" v-else>
        等待电池数据...
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  percentage: {
    type: Number,
    default: -1
  },
  voltage: {
    type: [Number, String],
    default: 0
  },
  connected: {
    type: Boolean,
    default: false
  }
})

const displayPercentage = computed(() => {
  if (props.percentage < 0) return 0
  return Math.min(100, Math.max(0, props.percentage))
})

const batteryClass = computed(() => {
  const p = displayPercentage.value
  if (p <= 20) return 'low'
  if (p <= 50) return 'medium'
  return 'high'
})
</script>
