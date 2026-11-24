<template>
  <section class="card">
    <div class="card-body connection-controls">
      <div class="connection-heading">
        <div>
          <UiIcon name="link" :size="18" />
          <div>
            <h2>机器人连接</h2>
            <p>Foxglove WebSocket</p>
          </div>
        </div>
        <span class="connection-badge" :class="connectionState">
          <i class="status-dot" :class="connectionState"></i>{{ statusLabel }}
        </span>
      </div>

      <label>
        <span class="field-label">服务地址</span>
        <input
          v-model="wsUrl"
          class="url-input"
          type="text"
          spellcheck="false"
          :disabled="isConnected || connectionState === 'connecting'"
          @keydown.enter="connect"
        >
      </label>

      <button
        v-if="!isConnected"
        class="btn btn-connect"
        :disabled="connectionState === 'connecting' || !wsUrl.trim()"
        @click="connect"
      >
        <UiIcon name="link" :size="16" />
        {{ connectionState === 'connecting' ? '正在连接…' : '连接机器人' }}
      </button>
      <button v-else class="btn btn-disconnect" @click="$emit('disconnect')">
        <UiIcon name="link" :size="16" />断开连接
      </button>

      <div v-if="errorMessage" class="error-message">{{ errorMessage }}</div>
    </div>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import UiIcon from './UiIcon.vue'

const props = defineProps({
  connectionState: String,
  errorMessage: String,
  defaultUrl: {
    type: String,
    required: true
  }
})

const emit = defineEmits(['connect', 'disconnect'])
const wsUrl = ref(props.defaultUrl)
const isConnected = computed(() => props.connectionState === 'connected')
const statusLabel = computed(() => ({
  connected: '在线',
  connecting: '连接中',
  error: '连接异常'
}[props.connectionState] || '未连接'))

watch(() => props.defaultUrl, (value) => {
  if (!isConnected.value) wsUrl.value = value
})

function connect() {
  if (wsUrl.value.trim()) emit('connect', wsUrl.value.trim())
}
</script>
