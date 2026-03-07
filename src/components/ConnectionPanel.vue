<template>
  <div class="card">
    <div class="card-header">
      连接
    </div>
    <div class="card-body connection-controls">
      <div class="url-input-group">
        <input
          class="url-input"
          type="text"
          v-model="url"
          :disabled="isConnected"
          placeholder="ws://localhost:8765"
          @keyup.enter="onConnect"
        />
      </div>

      <button
        v-if="!isConnected"
        class="btn btn-connect"
        @click="onConnect"
        :disabled="connectionState === 'connecting'"
      >
        {{ connectionState === 'connecting' ? '连接中...' : '连接' }}
      </button>

      <button
        v-else
        class="btn btn-disconnect"
        @click="$emit('disconnect')"
      >
        断开连接
      </button>

      <!-- 状态显示 -->
      <div class="status-indicator" v-if="isConnected">
        <span class="status-dot connected"></span>
        <span>{{ serverName }}</span>
      </div>

      <!-- 错误信息 -->
      <div class="error-message" v-if="errorMessage">
        {{ errorMessage }}
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'

const props = defineProps({
  connectionState: String,
  serverName: String,
  errorMessage: String
})

const emit = defineEmits(['connect', 'disconnect'])

const url = ref('ws://localhost:8765')

const isConnected = computed(() => props.connectionState === 'connected')

function onConnect() {
  if (url.value.trim()) {
    emit('connect', url.value.trim())
  }
}
</script>
