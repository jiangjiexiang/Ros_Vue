<template>
  <div class="card" v-if="connected">
    <div class="card-header">
      🧭 导航控制
    </div>
    <div class="card-body">
      <!-- 地图选择 -->
      <div class="nav-section">
        <label class="nav-label">选择地图</label>
        <div class="map-select-group">
          <select
            class="map-select"
            v-model="selectedMap"
            :disabled="isNavigating || isLoading"
          >
            <option value="" disabled>— 请选择地图 —</option>
            <option v-for="m in maps" :key="m.path" :value="m.path">
              {{ m.name }}
            </option>
          </select>
          <button class="btn-icon" @click="loadMaps" :disabled="isLoading" title="刷新列表">
            <span :class="['refresh-icon', { spinning: isLoading }]">↻</span>
          </button>
        </div>
        <div v-if="maps.length === 0 && !isLoading" class="nav-hint">
          暂无地图，请先完成建图并保存
        </div>
      </div>

      <!-- 启动/停止按钮 -->
      <div class="nav-section">
        <button
          v-if="!isNavigating"
          class="btn btn-connect nav-btn"
          @click="startNavigation"
          :disabled="isLoading || !selectedMap"
        >
          {{ isLoading ? '正在启动...' : '▶ 开始导航' }}
        </button>
        <button
          v-else
          class="btn btn-disconnect nav-btn"
          @click="stopNavigation"
          :disabled="isLoading"
        >
          {{ isLoading ? '正在停止...' : '⏹ 停止导航' }}
        </button>
      </div>

      <!-- 导航状态 -->
      <div class="nav-status">
        <span v-if="isNavigating" class="status-nav-active">● 导航节点运行中</span>
        <span v-else class="status-nav-idle">○ 导航节点未运行</span>
      </div>

      <!-- 初始位置设置 (仅导航运行中显示) -->
      <div v-if="isNavigating" class="nav-section mt-2">
        <button
          class="nav-btn"
          :class="isSettingPose ? 'btn-pose-active' : 'btn-pose'"
          @click="togglePoseMode"
        >
          {{ isSettingPose ? '✅ 正在设置... (按住拖动)' : '📍 设置初始位置' }}
        </button>
      </div>

      <!-- 操作提示 -->
      <div v-if="isNavigating && !isSettingPose" class="nav-hint goal-hint" style="margin-top:4px">
        💡 双击地图设定导航目标点
      </div>
      <div v-if="isSettingPose" class="nav-hint pose-hint">
        🟡 按住地图拖动以设定位置和朝向
      </div>

      <!-- 错误信息 -->
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

const emit = defineEmits(['update:isNavigating', 'update:isSettingPose', 'navigationStarted'])

const isNavigating = ref(false)
const isLoading = ref(false)
const errorMsg = ref('')
const maps = ref([])
const selectedMap = ref('')
const isSettingPose = ref(false)

const API_BASE = `http://${window.location.hostname}:3000/api`
let statusTimer = null

async function loadMaps() {
  isLoading.value = true
  try {
    const res = await fetch(`${API_BASE}/list_maps`)
    const data = await res.json()
    maps.value = data.maps || []
    if (maps.value.length > 0 && !selectedMap.value) {
      // 自动选择最新的地图（最后一个，按字母排序，时间戳格式会是最新的）
      selectedMap.value = maps.value[maps.value.length - 1].path
    }
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
    if (data.success) {
      isNavigating.value = true
      emit('update:isNavigating', true)
      emit('navigationStarted')
    } else {
      errorMsg.value = data.error || '启动失败'
    }
  } catch (err) {
    errorMsg.value = '无法连接到本地控制服务'
  } finally {
    isLoading.value = false
  }
}

async function stopNavigation() {
  isLoading.value = true
  errorMsg.value = ''
  // 停止导航时也退出初始位置模式
  if (isSettingPose.value) {
    isSettingPose.value = false
    emit('update:isSettingPose', false)
  }
  try {
    const res = await fetch(`${API_BASE}/stop_navigation`, { method: 'POST' })
    const data = await res.json()
    if (data.success) {
      isNavigating.value = false
      emit('update:isNavigating', false)
    } else {
      errorMsg.value = data.error || '停止失败'
    }
  } catch (err) {
    errorMsg.value = '无法连接到本地控制服务'
  } finally {
    isLoading.value = false
  }
}

function togglePoseMode() {
  isSettingPose.value = !isSettingPose.value
  emit('update:isSettingPose', isSettingPose.value)
}

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
.nav-section {
  margin-bottom: 12px;
}

.nav-label {
  display: block;
  font-size: 0.78rem;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 6px;
}

.map-select-group {
  display: flex;
  gap: 6px;
  align-items: center;
}

.map-select {
  flex: 1;
  padding: 8px 10px;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 0.8rem;
  outline: none;
  cursor: pointer;
  transition: var(--transition);
}

.map-select:focus {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
}

.map-select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.map-select option {
  background: #1e293b;
  color: var(--text-primary);
}

.btn-icon {
  width: 34px;
  height: 34px;
  background: rgba(99, 102, 241, 0.1);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: 1rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: var(--transition);
  flex-shrink: 0;
}

.btn-icon:hover {
  background: rgba(99, 102, 241, 0.2);
  color: var(--text-primary);
}

.refresh-icon {
  display: inline-block;
  transition: transform 0.5s ease;
}

.refresh-icon.spinning {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.nav-btn {
  width: 100%;
  font-weight: 600;
  padding: 12px;
}

.nav-status {
  margin-top: 4px;
  font-size: 0.82rem;
}

.status-nav-active {
  color: #34d399;
}

.status-nav-idle {
  color: #9ca3af;
}

.nav-hint {
  margin-top: 6px;
  font-size: 0.78rem;
  color: var(--text-muted);
}

.goal-hint {
  color: #a78bfa;
  background: rgba(99, 102, 241, 0.08);
  border: 1px solid rgba(99, 102, 241, 0.2);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
}

.pose-hint {
  color: #fbbf24;
  background: rgba(251, 191, 36, 0.08);
  border: 1px solid rgba(251, 191, 36, 0.25);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
}

.btn-pose {
  width: 100%;
  padding: 10px;
  font-weight: 600;
  font-size: 0.82rem;
  background: rgba(251, 191, 36, 0.1);
  border: 1px solid rgba(251, 191, 36, 0.3);
  color: #fbbf24;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: var(--transition);
}

.btn-pose:hover {
  background: rgba(251, 191, 36, 0.2);
}

.btn-pose-active {
  width: 100%;
  padding: 10px;
  font-weight: 600;
  font-size: 0.82rem;
  background: rgba(251, 191, 36, 0.25);
  border: 1px solid #fbbf24;
  color: #fbbf24;
  border-radius: var(--radius-sm);
  cursor: pointer;
  animation: pose-pulse 1.2s ease-in-out infinite;
}

@keyframes pose-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(251, 191, 36, 0.4); }
  50% { box-shadow: 0 0 0 6px rgba(251, 191, 36, 0); }
}

.mt-2 { margin-top: 8px; }
</style>
