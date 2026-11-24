<template>
  <section class="control-section">
    <p class="control-description">选择已保存的地图并启动配置的导航任务，然后在地图中设置初始位置与目标。</p>

    <div class="nav-section">
      <label class="nav-label" for="navigation-map">导航地图</label>
      <div class="map-select-group">
        <select
          id="navigation-map"
          v-model="selectedMap"
          class="map-select"
          :disabled="!connected || isNavigating || isLoading"
        >
          <option value="" disabled>请选择地图</option>
          <option v-for="map in maps" :key="map.path" :value="map.path">{{ map.name }}</option>
        </select>
        <button class="btn-icon" :disabled="isLoading" title="刷新地图列表" @click="loadMaps">
          <UiIcon name="refresh" :size="16" :class="{ spinning: isLoading }" />
        </button>
      </div>
      <div v-if="maps.length === 0 && !isLoading" class="nav-hint">暂无地图，请先完成建图并保存。</div>
    </div>

    <button
      v-if="!isNavigating"
      class="btn btn-connect nav-btn"
      :disabled="!connected || isLoading || !selectedMap"
      @click="startNavigation"
    >
      <UiIcon name="play" :size="15" />{{ isLoading ? '正在启动…' : '开始导航' }}
    </button>
    <button v-else class="btn btn-disconnect nav-btn" :disabled="isLoading" @click="stopNavigation">
      <UiIcon name="stop" :size="15" />{{ isLoading ? '正在停止…' : '停止导航' }}
    </button>

    <button
      v-if="!isNavigating"
      class="btn btn-secondary nav-btn"
      :disabled="!connected || isLoading"
      @click="toggleMultiPointMode"
    >
      <UiIcon name="route" :size="15" />{{ multiPointMode ? '退出并清空巡检点' : '编辑巡检点' }}
    </button>

    <div class="process-status" :class="{ active: isNavigating || multiPointMode }">
      <i></i>
      <span>{{ !connected ? '等待机器人连接' : isNavigating ? '导航节点运行中' : multiPointMode ? '巡检点编辑中' : '导航节点未运行' }}</span>
    </div>

    <template v-if="isNavigating || multiPointMode">
      <div class="navigation-modes">
        <button v-if="isNavigating" :class="{ active: isSettingPose }" @click="togglePoseMode">
          <UiIcon name="crosshair" :size="16" />初始定位
        </button>
        <button :class="{ active: multiPointMode }" :disabled="isSettingPose" @click="toggleMultiPointMode">
          <UiIcon name="route" :size="16" />{{ multiPointMode && !isNavigating ? '巡检点编辑' : '多点导航' }}
        </button>
      </div>

      <div v-if="multiPointMode && !isSettingPose" class="waypoint-row">
        <span>巡检点 <strong>{{ waypointCount }}</strong></span>
        <button :disabled="waypointCount === 0" @click="clearWaypoints">清空</button>
      </div>
      <button
        v-if="multiPointMode && !isNavigating"
        class="btn btn-connect save-mission-button"
        :disabled="waypointCount === 0"
        @click="emit('save-mission')"
      >
        <UiIcon name="save" :size="15" />保存为巡检任务并设置参数
      </button>

      <div class="navigation-hint" :class="{ pose: isSettingPose }">
        <UiIcon :name="isSettingPose ? 'crosshair' : 'route'" :size="15" />
        <span>{{ hintText }}</span>
      </div>
    </template>

    <div v-if="errorMsg" class="error-message mt-2">{{ errorMsg }}</div>
  </section>
</template>

<script setup>
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import { API_BASE } from '../config.js'
import UiIcon from './UiIcon.vue'

const props = defineProps({
  connected: Boolean,
  isNavigating: Boolean,
  isSettingPose: Boolean,
  selectedMap: { type: String, default: '' },
  multiPointMode: { type: Boolean, default: false },
  waypointCount: { type: Number, default: 0 },
  mapsRevision: { type: Number, default: 0 }
})

const emit = defineEmits(['update:isNavigating', 'update:isSettingPose', 'update:multiPointMode', 'update:selectedMap', 'navigationStarted', 'clear-waypoints', 'save-mission'])
const isNavigating = ref(props.isNavigating)
const isLoading = ref(false)
const errorMsg = ref('')
const maps = ref([])
const selectedMap = ref(props.selectedMap)
const isSettingPose = ref(props.isSettingPose)
const multiPointMode = ref(props.multiPointMode)
let statusTimer = null

const hintText = computed(() => {
  if (isSettingPose.value) return '在地图中按住并拖动，设置机器人位置与朝向。'
  if (multiPointMode.value && !isNavigating.value) return '双击地图添加巡检点，确认后启动导航依次执行。'
  return multiPointMode.value ? '双击地图连续添加航点，机器人将依次执行。' : '双击地图设置一个导航目标点。'
})

async function loadMaps() {
  isLoading.value = true
  try {
    const res = await fetch(`${API_BASE}/list_maps`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    maps.value = data.maps || []
    const selectionExists = maps.value.some((map) => map.path === selectedMap.value)
    if (!selectionExists) selectedMap.value = maps.value[0]?.path || ''
  } catch (err) {
    console.error('加载地图列表失败:', err)
    errorMsg.value = '无法加载地图列表'
  } finally {
    isLoading.value = false
  }
}

async function checkStatus() {
  try {
    const res = await fetch(`${API_BASE}/navigation_status`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    isNavigating.value = data.isRunning
    emit('update:isNavigating', data.isRunning)
    if (!data.isRunning) errorMsg.value = ''
  } catch (err) {
    console.error('获取导航状态失败:', err)
  }
}

async function startNavigation() {
  if (!selectedMap.value) {
    errorMsg.value = '请先选择一张地图'
    return
  }
  isLoading.value = true
  errorMsg.value = ''
  try {
    const res = await fetch(`${API_BASE}/start_navigation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mapPath: selectedMap.value })
    })
    const data = await res.json()
    if (!data.success) throw new Error(data.error || '启动失败')
    isNavigating.value = true
    emit('update:isNavigating', true)
    emit('navigationStarted')
  } catch (err) {
    errorMsg.value = err.message || '无法连接到本地控制服务'
  } finally {
    isLoading.value = false
  }
}

async function stopNavigation() {
  isLoading.value = true
  errorMsg.value = ''
  setPoseMode(false)
  if (multiPointMode.value) {
    multiPointMode.value = false
    emit('update:multiPointMode', false)
    emit('clear-waypoints')
  }
  try {
    const res = await fetch(`${API_BASE}/stop_navigation`, { method: 'POST' })
    const data = await res.json()
    if (!data.success) throw new Error(data.error || '停止失败')
    isNavigating.value = false
    emit('update:isNavigating', false)
  } catch (err) {
    errorMsg.value = err.message || '无法连接到本地控制服务'
  } finally {
    isLoading.value = false
  }
}

function setPoseMode(enabled) {
  isSettingPose.value = enabled
  emit('update:isSettingPose', enabled)
}

function togglePoseMode() {
  setPoseMode(!isSettingPose.value)
}

function toggleMultiPointMode() {
  multiPointMode.value = !multiPointMode.value
  emit('update:multiPointMode', multiPointMode.value)
  if (!multiPointMode.value) emit('clear-waypoints')
}

function clearWaypoints() {
  emit('clear-waypoints')
}

watch(() => props.multiPointMode, (value) => { multiPointMode.value = value })
watch(() => props.isNavigating, (value) => { isNavigating.value = value })
watch(() => props.isSettingPose, (value) => { isSettingPose.value = value })
watch(() => props.mapsRevision, loadMaps)
watch(selectedMap, (value) => emit('update:selectedMap', value))
watch(() => props.selectedMap, (value) => { selectedMap.value = value })

onMounted(async () => {
  await loadMaps()
  await checkStatus()
  statusTimer = setInterval(checkStatus, 3000)
})

onUnmounted(() => {
  if (statusTimer) clearInterval(statusTimer)
})
</script>

<style scoped>
.nav-section { margin-bottom: 13px; }
.nav-label { display: block; margin-bottom: 7px; color: var(--text-muted); font-size: 0.66rem; }
.map-select-group { display: flex; gap: 7px; align-items: center; }
.map-select { flex: 1; min-width: 0; height: 37px; padding: 0 9px; font-size: 0.7rem; cursor: pointer; }
.map-select option { background: var(--bg-elevated); color: var(--text-primary); }
.btn-icon {
  display: grid;
  place-items: center;
  width: 37px;
  height: 37px;
  flex: 0 0 auto;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  background: var(--bg-soft);
  cursor: pointer;
}
.btn-icon:hover:not(:disabled) { color: var(--accent-primary); border-color: rgba(34, 211, 238, 0.3); }
.spinning { animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.nav-hint { margin-top: 7px; color: var(--text-muted); font-size: 0.66rem; line-height: 1.5; }
.navigation-modes { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 14px; }
.navigation-modes button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 36px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  background: var(--bg-soft);
  font-size: 0.68rem;
  cursor: pointer;
}
.navigation-modes button.active { border-color: rgba(34, 211, 238, 0.3); color: var(--accent-primary); background: rgba(34, 211, 238, 0.07); }
.waypoint-row { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; color: var(--text-muted); font-size: 0.67rem; }
.waypoint-row strong { color: var(--text-primary); font-family: var(--font-mono); }
.waypoint-row button { border: 0; color: var(--danger); background: transparent; font-size: 0.65rem; cursor: pointer; }
.save-mission-button { display: flex; width: 100%; align-items: center; justify-content: center; gap: 6px; margin-top: 10px; font-size: 0.66rem; }
.navigation-hint {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 12px;
  padding: 9px 10px;
  border: 1px solid rgba(34, 211, 238, 0.15);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  background: rgba(34, 211, 238, 0.045);
  font-size: 0.65rem;
  line-height: 1.6;
}
.navigation-hint svg { flex: 0 0 auto; margin-top: 2px; color: var(--accent-primary); }
.navigation-hint.pose { border-color: rgba(251, 191, 36, 0.18); background: rgba(251, 191, 36, 0.05); }
.navigation-hint.pose svg { color: var(--warning); }
</style>
