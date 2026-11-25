<template>
  <section class="control-section localization-control">
    <label class="map-select-label">
      <span>用于定位的保存地图</span>
      <select v-model="selectedMap" :disabled="isLocalizing || loadingMaps">
        <option value="">请选择 PCD 地图</option>
        <option v-for="map in maps" :key="map.name" :value="map.path">{{ map.name }}</option>
      </select>
    </label>

    <button
      v-if="!isLocalizing"
      class="btn btn-connect"
      :disabled="!connected || !selectedMap || busy"
      @click="startLocalization"
    >
      <UiIcon name="play" :size="15" />{{ busy ? '正在启动…' : '开始纯定位' }}
    </button>
    <button v-else class="btn btn-disconnect" :disabled="busy" @click="stopLocalization">
      <UiIcon name="stop" :size="15" />{{ busy ? '正在停止…' : '停止定位' }}
    </button>

    <div class="process-status" :class="{ active: isLocalizing }">
      <i></i>
      <span>{{ !connected ? '等待机器人连接' : isLocalizing ? '纯定位运行中 · 不更新保存地图' : '定位未运行' }}</span>
    </div>

    <div v-if="message" class="localization-pose">
      <div><span>地图位置 X / Y / Z</span><strong>{{ pose.x }} / {{ pose.y }} / {{ pose.z }} m</strong></div>
      <div><span>地图航向</span><strong>{{ pose.yaw }}°</strong></div>
      <small>{{ namespacedTopic }}</small>
    </div>
    <p v-else class="localization-hint">启动后显示地图位姿、运动轨迹和静态点云。</p>
    <div v-if="errorMsg" class="error-message mt-2">{{ errorMsg }}</div>
  </section>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { API_BASE } from '../config.js'
import UiIcon from './UiIcon.vue'

const props = defineProps({
  connected: Boolean,
  isLocalizing: Boolean,
  simulationScene: { type: String, default: '' },
  message: { type: Object, default: null }
})
const emit = defineEmits(['update:isLocalizing'])
const maps = ref([])
const selectedMap = ref('')
const isLocalizing = ref(props.isLocalizing)
const loadingMaps = ref(false)
const busy = ref(false)
const errorMsg = ref('')
let statusTimer = null

const pose = computed(() => {
  const position = props.message?.pose?.pose?.position
  const orientation = props.message?.pose?.pose?.orientation
  if (!position || !orientation) return { x: '--', y: '--', z: '--', yaw: '--' }
  const format = (value) => Number.isFinite(value) ? value.toFixed(3) : '--'
  return {
    x: format(position.x),
    y: format(position.y),
    z: format(position.z),
    yaw: (Math.atan2(2 * orientation.w * orientation.z, 1 - 2 * orientation.z * orientation.z) * 180 / Math.PI).toFixed(1)
  }
})
const namespacedTopic = computed(() => props.simulationScene ? `/${props.simulationScene}/localization` : '/localization')

async function request(path, options) {
  const response = await fetch(`${API_BASE}${path}`, options)
  const data = await response.json()
  if (!response.ok || data.success === false) throw new Error(data.error || `HTTP ${response.status}`)
  return data
}

async function loadMaps() {
  loadingMaps.value = true
  try {
    const data = await request('/list_maps')
    maps.value = data.maps || []
    if (!selectedMap.value && maps.value.length) selectedMap.value = maps.value[0].path
  } catch (err) {
    errorMsg.value = err.message || '地图列表读取失败'
  } finally {
    loadingMaps.value = false
  }
}

async function checkStatus() {
  try {
    const query = props.simulationScene ? `?scene=${encodeURIComponent(props.simulationScene)}` : ''
    const data = await request(`/localization_status${query}`)
    isLocalizing.value = data.isRunning
    emit('update:isLocalizing', data.isRunning)
  } catch {}
}

async function startLocalization() {
  if (!selectedMap.value) return
  busy.value = true
  errorMsg.value = ''
  try {
    await request('/start_localization', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scene: props.simulationScene, mapPath: selectedMap.value })
    })
    isLocalizing.value = true
    emit('update:isLocalizing', true)
  } catch (err) {
    errorMsg.value = err.message || '定位启动失败'
  } finally {
    busy.value = false
  }
}

async function stopLocalization() {
  busy.value = true
  errorMsg.value = ''
  try {
    await request('/stop_localization', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scene: props.simulationScene })
    })
    isLocalizing.value = false
    emit('update:isLocalizing', false)
  } catch (err) {
    errorMsg.value = err.message || '定位停止失败'
  } finally {
    busy.value = false
  }
}

watch(() => props.isLocalizing, (value) => { isLocalizing.value = value })
onMounted(() => {
  loadMaps()
  checkStatus()
  statusTimer = setInterval(checkStatus, 3000)
})
onUnmounted(() => { if (statusTimer) clearInterval(statusTimer) })
</script>

<style scoped>
.localization-control { display: flex; flex-direction: column; gap: 10px; }
.map-select-label { display: flex; flex-direction: column; gap: 6px; color: var(--text-secondary); font-size: var(--text-xs); }
.map-select-label select { width: 100%; height: 36px; padding: 0 9px; border: 1px solid var(--border-color); border-radius: 7px; color: var(--text-primary); background: var(--bg-secondary); }
.process-status { display: flex; align-items: center; gap: 7px; color: var(--text-muted); font-size: var(--text-xs); }
.process-status i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.process-status.active { color: var(--success); }
.localization-pose { display: grid; gap: 8px; padding: 10px; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-soft); }
.localization-pose div { display: flex; flex-direction: column; gap: 4px; }
.localization-pose span, .localization-hint { color: var(--text-muted); font-size: var(--text-xs); }
.localization-pose strong { color: var(--text-primary); font-family: var(--font-mono); font-size: 0.75rem; }
.localization-pose small { overflow: hidden; color: var(--text-muted); font-family: var(--font-mono); font-size: 0.65rem; text-overflow: ellipsis; }
.localization-hint { margin: 0; line-height: 1.6; }
</style>
