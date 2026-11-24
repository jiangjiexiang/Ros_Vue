<template>
  <section class="control-section">
    <p class="control-description">启动配置的建图任务，在地图区域实时查看环境扫描结果。</p>
    <button
      v-if="!isMapping"
      class="btn btn-connect"
      :disabled="!connected || isLoading"
      @click="startMapping"
    >
      <UiIcon name="play" :size="15" />
      {{ isLoading ? '正在启动…' : '开始建图' }}
    </button>
    <button v-else class="btn btn-disconnect" :disabled="isLoading" @click="stopMapping">
      <UiIcon name="stop" :size="15" />
      {{ isLoading ? '正在停止…' : '停止建图' }}
    </button>

    <div class="process-status" :class="{ active: isMapping }">
      <i></i>
      <span>{{ !connected ? '等待机器人连接' : isMapping ? '建图节点运行中' : '建图节点未运行' }}</span>
    </div>
    <div v-if="errorMsg" class="error-message mt-2">{{ errorMsg }}</div>
  </section>
</template>

<script setup>
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { API_BASE } from '../config.js'
import UiIcon from './UiIcon.vue'

const props = defineProps({ connected: Boolean, isMapping: Boolean })
const emit = defineEmits(['mappingStarted', 'update:isMapping'])
const isMapping = ref(props.isMapping)
const isLoading = ref(false)
const errorMsg = ref('')
let statusTimer = null

async function checkStatus() {
  try {
    const res = await fetch(`${API_BASE}/mapping_status`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    isMapping.value = data.isRunning
    emit('update:isMapping', data.isRunning)
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
    if (!data.success) throw new Error(data.error || '启动失败')
    isMapping.value = true
    emit('update:isMapping', true)
    emit('mappingStarted')
  } catch (err) {
    errorMsg.value = err.message || '无法连接到本地控制服务'
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
    if (!data.success) throw new Error(data.error || '停止失败')
    isMapping.value = false
    emit('update:isMapping', false)
  } catch (err) {
    errorMsg.value = err.message || '无法连接到本地控制服务'
  } finally {
    isLoading.value = false
  }
}

watch(() => props.isMapping, (value) => { isMapping.value = value })

onMounted(() => {
  checkStatus()
  statusTimer = setInterval(checkStatus, 3000)
})

onUnmounted(() => {
  if (statusTimer) clearInterval(statusTimer)
})
</script>
