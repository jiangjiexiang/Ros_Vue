<template>
  <section class="control-section">
    <div class="mapping-actions">
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

      <button
        type="button"
        class="btn btn-secondary"
        :disabled="!connected || isLoading"
        title="清空当前点云并重新启动建图节点"
        @click="restartMapping"
      >
        <UiIcon name="refresh" :size="14" />
        重新建图
      </button>
    </div>

    <div class="process-status" :class="{ active: isMapping }">
      <i></i>
      <span>{{ !connected ? '等待机器人连接' : isMapping ? '建图节点运行中' : '建图节点未运行' }}</span>
    </div>

    <div class="save-map-box">
      <label class="save-map-label">保存建图结果（支持 3D 点云 + 2D 导航栅格）</label>
      <div class="save-map-row">
        <input
          v-model="mapName"
          type="text"
          class="save-map-input"
          placeholder="输入地图名称，如 lab_floor1"
          :disabled="isSaving"
        >
        <button
          type="button"
          class="btn btn-primary-sm"
          :disabled="!connected || isSaving"
          @click="saveMap"
        >
          {{ isSaving ? '保存中…' : '保存地图' }}
        </button>
      </div>
    </div>

    <div v-if="saveNotice" class="save-notice">{{ saveNotice }}</div>
    <div v-if="errorMsg" class="error-message mt-2">{{ errorMsg }}</div>
  </section>
</template>

<script setup>
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { API_BASE } from '../config.js'
import UiIcon from './UiIcon.vue'

const props = defineProps({
  connected: Boolean,
  isMapping: Boolean,
  simulationScene: { type: String, default: '' },
  getMapPoints: { type: Function, default: null }
})
const emit = defineEmits(['mappingStarted', 'mappingRestarted', 'mapSaved', 'update:isMapping'])
const isMapping = ref(props.isMapping)
const isLoading = ref(false)
const isSaving = ref(false)
const errorMsg = ref('')
const saveNotice = ref('')
const mapName = ref(`slam_${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`)
let statusTimer = null

async function checkStatus() {
  try {
    const qs = props.simulationScene ? `?scene=${encodeURIComponent(props.simulationScene)}` : ''
    const res = await fetch(`${API_BASE}/mapping_status${qs}`)
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
  saveNotice.value = ''
  try {
    const res = await fetch(`${API_BASE}/start_mapping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scene: props.simulationScene || '' })
    })
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
    const res = await fetch(`${API_BASE}/stop_mapping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scene: props.simulationScene || '' })
    })
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

async function restartMapping() {
  isLoading.value = true
  errorMsg.value = ''
  saveNotice.value = ''
  try {
    emit('mappingRestarted')
    const res = await fetch(`${API_BASE}/restart_mapping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scene: props.simulationScene || '' })
    })
    const data = await res.json()
    if (!data.success) throw new Error(data.error || '重启建图失败')
    isMapping.value = true
    emit('update:isMapping', true)
    emit('mappingStarted')
    saveNotice.value = '已清空点云并重启建图节点'
  } catch (err) {
    errorMsg.value = err.message || '重新建图失败'
  } finally {
    isLoading.value = false
  }
}

async function saveMap() {
  const name = mapName.value.trim()
  if (!name) {
    errorMsg.value = '请输入地图名称'
    return
  }
  isSaving.value = true
  errorMsg.value = ''
  saveNotice.value = ''
  try {
    const pts = props.getMapPoints ? props.getMapPoints() : []
    let res
    if (pts.length >= 9) {
      res = await fetch(`${API_BASE}/save_slam_map`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mapName: name, points: pts })
      })
    } else {
      res = await fetch(`${API_BASE}/save_map`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mapName: name })
      })
    }
    const data = await res.json()
    if (!data.success) throw new Error(data.error || '保存地图失败')
    saveNotice.value = data.pointCount
      ? `已保存地图「${data.name}」（${data.pointCount.toLocaleString()} 点 · 含 .pgm/.yaml/.pcd）`
      : `已保存地图「${name}」`
    emit('mapSaved', data)
  } catch (err) {
    errorMsg.value = err.message || '保存地图失败'
  } finally {
    isSaving.value = false
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

<style scoped>
.mapping-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.btn-secondary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 9px 12px;
  border-radius: 8px;
  border: 1px solid rgba(56, 189, 248, 0.25);
  background: rgba(15, 23, 42, 0.72);
  color: #cbd5e1;
  font-size: 0.84rem;
  font-weight: 600;
  cursor: pointer;
}

.btn-secondary:hover:not(:disabled) {
  border-color: rgba(56, 189, 248, 0.55);
  color: #f8fafc;
}

.btn-secondary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.save-map-box {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid rgba(148, 163, 184, 0.14);
}

.save-map-label {
  display: block;
  margin-bottom: 6px;
  font-size: 0.76rem;
  color: #94a3b8;
}

.save-map-row {
  display: flex;
  gap: 8px;
}

.save-map-input {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  border-radius: 7px;
  border: 1px solid rgba(148, 163, 184, 0.22);
  background: rgba(15, 23, 42, 0.75);
  color: #e2e8f0;
  font-size: 0.82rem;
}

.btn-primary-sm {
  padding: 7px 12px;
  border-radius: 7px;
  border: 1px solid rgba(16, 185, 129, 0.45);
  background: rgba(16, 185, 129, 0.18);
  color: #34d399;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.btn-primary-sm:hover:not(:disabled) {
  background: rgba(16, 185, 129, 0.28);
}

.btn-primary-sm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.save-notice {
  margin-top: 8px;
  padding: 6px 9px;
  border-radius: 6px;
  background: rgba(16, 185, 129, 0.12);
  border: 1px solid rgba(16, 185, 129, 0.28);
  color: #6ee7b7;
  font-size: 0.78rem;
}
</style>
