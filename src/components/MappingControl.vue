<template>
  <div class="card" v-if="connected">
    <div class="card-header">
      建图控制
    </div>
    <div class="card-body">
      <div class="mapping-controls">
        <button 
          v-if="!isMapping"
          class="btn btn-connect mapping-btn" 
          @click="startMapping"
          :disabled="isLoading"
        >
          {{ isLoading ? '正在启动...' : '▶ 开始建图' }}
        </button>
        <button 
          v-else
          class="btn btn-disconnect mapping-btn" 
          @click="stopMapping"
          :disabled="isLoading"
        >
          {{ isLoading ? '正在停止...' : '⏹ 停止建图' }}
        </button>
      </div>
      
      <div class="mapping-status mt-2 text-sm text-gray-400">
        <span v-if="isMapping" class="text-green-400">● 建图节点运行中</span>
        <span v-else>○ 建图节点未运行</span>
      </div>
      
      <div v-if="errorMsg" class="error-message mt-2">
        ⚠️ {{ errorMsg }}
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'

const props = defineProps({
  connected: Boolean
})

const isMapping = ref(false)
const isLoading = ref(false)
const errorMsg = ref('')

const API_BASE = `http://${window.location.hostname}:3000/api`
let statusTimer = null

async function checkStatus() {
  try {
    const res = await fetch(`${API_BASE}/mapping_status`)
    const data = await res.json()
    isMapping.value = data.isRunning
    errorMsg.value = ''
  } catch (err) {
    console.error('获取建图状态失败:', err)
  }
}

async function startMapping() {
  isLoading.value = true
  errorMsg.value = ''
  try {
    const res = await fetch(`${API_BASE}/start_mapping`, { method: 'POST' })
    const data = await res.json()
    if (data.success) {
      isMapping.value = true
    } else {
      errorMsg.value = data.error || '启动失败'
    }
  } catch (err) {
    errorMsg.value = '无法连接到本地控制服务'
  } finally {
    isLoading.value = false
  }
}

async function stopMapping() {
  isLoading.value = true
  errorMsg.value = ''
  try {
    const res = await fetch(`${API_BASE}/stop_mapping`, { method: 'POST' })
    const data = await res.json()
    if (data.success) {
      isMapping.value = false
    } else {
      errorMsg.value = data.error || '停止失败'
    }
  } catch (err) {
    errorMsg.value = '无法连接到本地控制服务'
  } finally {
    isLoading.value = false
  }
}

onMounted(() => {
  checkStatus()
  statusTimer = setInterval(checkStatus, 3000) // 每3秒检查一次状态
})

onUnmounted(() => {
  if (statusTimer) clearInterval(statusTimer)
})
</script>

<style scoped>
.mapping-controls {
  display: flex;
  justify-content: center;
}
.mapping-btn {
  width: 100%;
  font-weight: 600;
  padding: 12px;
}
.mt-2 { margin-top: 8px; }
.text-sm { font-size: 0.85rem; }
.text-gray-400 { color: #9ca3af; }
.text-green-400 { color: #34d399; }
</style>
