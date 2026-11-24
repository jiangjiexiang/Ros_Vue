<template>
  <section class="card">
    <div class="card-body connection-controls">
      <div class="connection-heading">
        <div>
          <UiIcon name="link" :size="18" />
          <div>
            <h2>机器人连接</h2>
            <p>局域网 · Foxglove WebSocket</p>
          </div>
        </div>
        <span class="connection-badge" :class="connectionState">
          <i class="status-dot" :class="connectionState"></i>{{ statusLabel }}
        </span>
      </div>

      <div class="endpoint-fields">
        <label class="host-field">
          <span class="field-label">机器人 IP / 主机名</span>
          <input
            v-model.trim="host"
            class="url-input"
            type="text"
            placeholder="192.168.1.100"
            spellcheck="false"
            :disabled="locked"
            @keydown.enter="connect"
          >
        </label>
        <label class="port-field">
          <span class="field-label">端口</span>
          <input
            v-model.trim="port"
            class="url-input"
            type="number"
            min="1"
            max="65535"
            :disabled="locked"
            @keydown.enter="connect"
          >
        </label>
      </div>

      <div class="generated-url">{{ displayUrl }}</div>

      <button
        v-if="!isConnected"
        class="btn btn-connect"
        :disabled="locked || !host"
        @click="connect"
      >
        <UiIcon name="link" :size="16" />
        {{ connectionState === 'connecting' ? '正在连接…' : '连接机器人' }}
      </button>
      <button v-else class="btn btn-disconnect" @click="$emit('disconnect')">
        <UiIcon name="link" :size="16" />断开连接
      </button>

      <div v-if="localError || errorMessage" class="error-message">{{ localError || errorMessage }}</div>
    </div>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import UiIcon from './UiIcon.vue'

const props = defineProps({
  connectionState: String,
  errorMessage: String,
  defaultUrl: { type: String, required: true }
})
const emit = defineEmits(['connect', 'disconnect'])
const protocol = ref('ws')
const host = ref('')
const port = ref('8765')
const localError = ref('')
const isConnected = computed(() => props.connectionState === 'connected')
const locked = computed(() => isConnected.value || props.connectionState === 'connecting')
const statusLabel = computed(() => ({
  connected: '在线', connecting: '连接中', error: '连接异常'
}[props.connectionState] || '未连接'))
const displayUrl = computed(() => {
  const value = host.value.includes(':') && !host.value.startsWith('[') ? `[${host.value}]` : host.value
  return `${protocol.value}://${value || '机器人IP'}:${port.value || '8765'}`
})

function applyUrl(value) {
  try {
    const url = new URL(value)
    protocol.value = url.protocol.replace(':', '') || 'ws'
    host.value = url.hostname.replace(/^\[|\]$/g, '')
    port.value = url.port || '8765'
  } catch {
    host.value = value
  }
}

watch(() => props.defaultUrl, (value) => {
  if (!isConnected.value) applyUrl(value)
}, { immediate: true })

function connect() {
  localError.value = ''
  const portNumber = Number(port.value)
  if (!host.value.trim()) {
    localError.value = '请输入机器人 IP 或主机名'
    return
  }
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    localError.value = '端口应为 1–65535 之间的数字'
    return
  }
  emit('connect', displayUrl.value)
}
</script>

<style scoped>
.endpoint-fields { display: grid; grid-template-columns: minmax(0, 1fr) 74px; gap: 8px; }
.endpoint-fields label { min-width: 0; }
.port-field input { padding: 0 7px; }
.generated-url { overflow: hidden; color: var(--text-muted); font-family: var(--font-mono); font-size: 0.62rem; text-overflow: ellipsis; white-space: nowrap; }
</style>
