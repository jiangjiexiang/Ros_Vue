<template>
  <section class="card">
    <div class="card-body connection-controls">
      <div class="connection-heading">
        <div>
          <UiIcon name="link" :size="18" />
          <div>
            <h2>机器人连接</h2>
            <p>选择已配置机器人</p>
          </div>
        </div>
        <span class="connection-badge" :class="connectionState">
          <i class="status-dot" :class="connectionState"></i>{{ statusLabel }}
        </span>
      </div>

      <label>
        <span class="field-label">控制对象</span>
        <select
          v-model="selectedRobotId"
          class="robot-select"
          :disabled="connectionState === 'connecting'"
          @change="selectRobot"
        >
          <option v-for="robot in robots" :key="robot.id" :value="robot.id">{{ robot.name }}</option>
        </select>
      </label>

      <div v-if="selectedRobot" class="selected-details">
        <span>{{ displayAddress(selectedRobot.url) }}</span>
        <span v-if="selectedRobot.namespace">命名空间 {{ selectedRobot.namespace }}</span>
      </div>

      <div v-if="errorMessage" class="error-message">{{ errorMessage }}</div>
    </div>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import UiIcon from './UiIcon.vue'

const props = defineProps({
  robots: { type: Array, required: true },
  activeRobotId: { type: String, required: true },
  connectionState: String,
  errorMessage: String
})
const emit = defineEmits(['connect'])
const selectedRobotId = ref(props.activeRobotId)
const selectedRobot = computed(() => props.robots.find((robot) => robot.id === selectedRobotId.value))
const statusLabel = computed(() => ({
  connected: '在线', connecting: '连接中', error: '连接异常'
}[props.connectionState] || '未连接'))

watch(() => props.activeRobotId, (value) => { selectedRobotId.value = value }, { immediate: true })

function displayAddress(value) {
  try {
    const url = new URL(value)
    return `${url.hostname}:${url.port || '8765'}`
  } catch {
    return value
  }
}

function selectRobot() {
  if (selectedRobot.value) emit('connect', selectedRobot.value)
}
</script>

<style scoped>
.robot-select { width: 100%; height: 38px; padding: 0 10px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); color: var(--text-primary); background: rgba(2, 8, 18, 0.42); font-size: 0.72rem; cursor: pointer; }
.robot-select option { background: var(--bg-elevated); }
.selected-details { display: flex; flex-direction: column; gap: 5px; color: var(--text-muted); font-family: var(--font-mono); font-size: 0.62rem; }
</style>
