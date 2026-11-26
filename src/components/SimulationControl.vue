<template>
  <section class="simulation-control">
    <div class="simulation-heading">
      <div>
        <h2>GPU 仿真测试</h2>
        <p>Isaac Sim · Unitree Go2 · RTX 物理仿真</p>
      </div>
      <span class="simulation-state" :class="{ active: activeScenes.length }">
        {{ activeScenes.length ? `${activeScenes.length} / 3 条狗运行中` : '仿真待机' }}
      </span>
    </div>

    <div class="scene-grid">
      <article v-for="scene in scenes" :key="scene.id" class="scene-card" :class="{ active: isSceneRunning(scene.id) }">
        <div class="scene-icon"><UiIcon :name="scene.icon" :size="24" /></div>
        <div class="scene-copy">
          <h3>{{ scene.name }}</h3>
          <p>{{ scene.description }}</p>
          <div class="scene-tags"><span v-for="tag in scene.tags" :key="tag">{{ tag }}</span></div>
        </div>
        <button
          v-if="!isSceneRunning(scene.id)"
          class="btn btn-connect"
          :disabled="Boolean(loadingScene)"
          @click="startScene(scene.id)"
        >
          <UiIcon name="play" :size="15" />
          {{ loadingScene === scene.id ? '正在启动…' : '启动机器狗' }}
        </button>
        <button
          v-else-if="activeScene !== scene.id"
          class="btn btn-secondary"
          :disabled="Boolean(loadingScene)"
          @click="selectScene(scene.id)"
        >
          查看遥测与控制
        </button>
        <button
          v-if="isSceneRunning(scene.id)"
          class="btn btn-disconnect"
          :disabled="Boolean(loadingScene)"
          @click="stopScene(scene.id)"
        >
          <UiIcon name="stop" :size="15" />
          {{ loadingScene === scene.id ? '正在停止…' : '停止机器狗' }}
        </button>
      </article>
    </div>

    <div v-if="activeScene" class="simulation-teleoperation">
      <JoystickControl
        ref="joystickRef"
        :connected="Boolean(activeScene)"
        :maxLinearSpeed="controlConfig.max_linear_speed ?? 5"
        :maxAngularSpeed="controlConfig.max_angular_speed ?? 1.0"
        :commandRateHz="controlConfig.command_rate_hz ?? 10"
        @velocity-change="sendVelocity"
        @stop="stopMotion"
      />
      <section class="card telemetry-card">
        <div class="card-header"><span><UiIcon name="activity" :size="17" />仿真遥测</span><small>PHYSICS + WEB</small></div>
        <div class="telemetry-body">
          <div><span>场景</span><strong>{{ sceneName(activeScene) }}</strong></div>
          <div><span>位置 X / Y</span><strong>{{ telemetry.position.x.toFixed(2) }} / {{ telemetry.position.y.toFixed(2) }} m</strong></div>
          <div><span>朝向</span><strong>{{ telemetry.yaw.toFixed(2) }} rad</strong></div>
          <div><span>线速度</span><strong>{{ telemetry.command.linearX.toFixed(2) }} m/s</strong></div>
          <div><span>角速度</span><strong>{{ telemetry.command.angularZ.toFixed(2) }} rad/s</strong></div>
          <div><span>3D 雷达</span><strong>{{ lidarText }}</strong></div>
          <p>每条狗独立提供 16 线 3D 点云、IMU 及机载相机，可按需开启 FAST-LIO 建图。</p>
          <p>拖动左侧摇杆控制 Go2。松开摇杆或点击“停止运动”即停车；控制指令超过 {{ controlConfig.command_timeout_ms ?? 600 }} 毫秒未更新也会自动停车。</p>
        </div>
      </section>
    </div>

    <div class="simulation-note">
      <UiIcon name="activity" :size="16" />
      <span>三个场景可同时运行，分别使用 indoor / warehouse / outdoor 话题命名空间及 DogLink 端口 8770 / 8771 / 8772，遥测与速度指令互不混用。</span>
    </div>
    <div v-if="controlError" class="error-message mt-2">{{ controlError }}</div>
    <div v-if="errorMsg" class="error-message mt-2">{{ errorMsg }}</div>
  </section>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { API_BASE, apiFetch } from '../config.js'
import JoystickControl from './JoystickControl.vue'
import UiIcon from './UiIcon.vue'

defineProps({
  controlConfig: { type: Object, default: () => ({}) }
})

const emit = defineEmits(['active-scene-change'])

const scenes = [
  { id: 'indoor', name: '室内配电与机房巡检', icon: 'map', description: '高压配电柜、温控阵列、服务器机柜及消防管网阀门站，验证室内多点自动巡检。', tags: ['12 × 10 m', '高压配电柜', '消防管网', '服务器机房'] },
  { id: 'warehouse', name: '工业仓储物流巡检', icon: 'layers', description: '蓝橙钢结构货架、条码货箱、叉车、危化品桶与配电消防设施，测试复杂通道巡检。', tags: ['16 × 13 m', '钢结构货架', '叉车障碍', '危化品区'] },
  { id: 'outdoor', name: '户外变电站巡检', icon: 'route', description: '沥青变电园区、高压主变与瓷套管、户外开关柜及护栏检修坡道与台阶，验证户外巡检。', tags: ['17 × 14 m', '高压变压器', '检修坡道', '户外开关柜'] }
]

const activeScene = ref('')
const activeScenes = ref([])
const joystickRef = ref(null)
const loadingScene = ref('')
const errorMsg = ref('')
const controlError = ref('')
const telemetry = ref({
  position: { x: 0, y: 0, z: 0 },
  yaw: 0,
  command: { linearX: 0, angularZ: 0 }
})
let statusTimer = null
let telemetryTimer = null
let queuedCommand = null
let commandWorker = null
let suppressJoystickEvents = false
let disposed = false

const lidarText = computed(() => {
  const pointcloud = telemetry.value.pointcloud
  return pointcloud ? `${pointcloud.channels} 线 / ${pointcloud.range_max} m` : '16 线 / 20 m'
})

function sceneName(id) {
  return scenes.find((scene) => scene.id === id)?.name || ''
}

function isSceneRunning(id) {
  return activeScenes.value.includes(id)
}

function sceneQuery(id) {
  return `?scene=${encodeURIComponent(id)}`
}

async function request(path) {
  const res = await apiFetch(`${API_BASE}${path}`, { method: 'POST' })
  const data = await res.json()
  if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`)
}

async function checkStatus() {
  try {
    const statuses = await Promise.all(scenes.map(async (scene) => {
      const res = await apiFetch(`${API_BASE}/task_status/simulation_${scene.id}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()).isRunning ? scene.id : ''
    }))
    activeScenes.value = statuses.filter(Boolean)
    if (!activeScenes.value.includes(activeScene.value)) {
      await changeActiveScene(activeScenes.value[0] || '')
    }
  } catch (err) {
    console.error('获取仿真状态失败:', err)
  }
}

async function updateTelemetry() {
  const scene = activeScene.value
  if (!scene) return
  try {
    const res = await apiFetch(`${API_BASE}/simulation/status${sceneQuery(scene)}`)
    if (!res.ok) return
    const data = await res.json()
    if (data.ready && !disposed && scene === activeScene.value) {
      telemetry.value = data
      controlError.value = ''
    }
  } catch {}
}

function enqueueVelocity(scene, { linearX, angularZ }) {
  if (!scene) return Promise.resolve(false)
  const isZero = linearX === 0 && angularZ === 0
  if (queuedCommand && queuedCommand.linearX === 0 && queuedCommand.angularZ === 0 && !isZero) {
    return Promise.resolve(false)
  }
  if (queuedCommand) queuedCommand.resolve(false)
  return new Promise((resolve) => {
    queuedCommand = { scene, linearX, angularZ, resolve }
    void drainVelocityQueue()
  })
}

async function drainVelocityQueue() {
  if (commandWorker) return commandWorker
  commandWorker = (async () => {
    while (queuedCommand) {
      const command = queuedCommand
      queuedCommand = null
      try {
        const res = await apiFetch(`${API_BASE}/simulation/velocity${sceneQuery(command.scene)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ linearX: command.linearX, angularZ: command.angularZ })
        })
        const data = await res.json()
        if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`)
        if (!disposed) controlError.value = ''
        command.resolve(true)
      } catch (err) {
        if (!disposed) controlError.value = err.message || '仿真控制失败'
        command.resolve(false)
      }
    }
  })()
  try {
    await commandWorker
  } finally {
    commandWorker = null
    if (queuedCommand) void drainVelocityQueue()
  }
}

function sendVelocity(command) {
  if (suppressJoystickEvents) return Promise.resolve(false)
  return enqueueVelocity(activeScene.value, command)
}

function stopMotion() {
  if (suppressJoystickEvents) return
  void sendVelocity({ linearX: 0, angularZ: 0 })
}

function resetJoystick() {
  suppressJoystickEvents = true
  try { joystickRef.value?.reset() } finally { suppressJoystickEvents = false }
}

let sceneTransition = Promise.resolve()
function changeActiveScene(id) {
  sceneTransition = sceneTransition.then(async () => {
    const previous = activeScene.value
    if (previous === id) return
    resetJoystick()
    if (previous) await enqueueVelocity(previous, { linearX: 0, angularZ: 0 })
    if (!disposed) activeScene.value = id
  })
  return sceneTransition
}

function selectScene(id) {
  void changeActiveScene(id)
}

async function startScene(id) {
  loadingScene.value = id
  errorMsg.value = ''
  try {
    await request(`/run_task/simulation_${id}`)
    if (!activeScenes.value.includes(id)) activeScenes.value.push(id)
    await changeActiveScene(id)
  } catch (err) {
    errorMsg.value = err.message || '无法启动仿真场景'
  } finally {
    loadingScene.value = ''
  }
}

async function stopScene(id) {
  if (!isSceneRunning(id)) return
  loadingScene.value = id
  errorMsg.value = ''
  try {
    if (activeScene.value === id) {
      resetJoystick()
      await enqueueVelocity(id, { linearX: 0, angularZ: 0 })
    }
    await request(`/stop_task/simulation_${id}`)
    activeScenes.value = activeScenes.value.filter((scene) => scene !== id)
    if (activeScene.value === id) await changeActiveScene(activeScenes.value[0] || '')
  } catch (err) {
    errorMsg.value = err.message || '无法停止仿真场景'
  } finally {
    loadingScene.value = ''
  }
}

onMounted(() => {
  checkStatus()
  statusTimer = setInterval(checkStatus, 3000)
  telemetryTimer = setInterval(updateTelemetry, 500)
})

watch(activeScene, (value) => {
  emit('active-scene-change', value)
}, { immediate: true })

onUnmounted(() => {
  disposed = true
  if (statusTimer) clearInterval(statusTimer)
  if (telemetryTimer) clearInterval(telemetryTimer)
  resetJoystick()
  if (activeScene.value) void enqueueVelocity(activeScene.value, { linearX: 0, angularZ: 0 })
})
</script>

<style scoped>
.simulation-control { padding: 24px; }
.simulation-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
.simulation-heading h2 { margin: 0 0 6px; font-size: 1.05rem; }
.simulation-heading p { margin: 0; color: var(--text-muted); font-size: 0.72rem; }
.simulation-state { padding: 6px 10px; border: 1px solid var(--border-color); border-radius: 999px; color: var(--text-muted); font-size: 0.68rem; white-space: nowrap; }
.simulation-state.active { color: var(--accent-primary); border-color: rgba(34, 211, 238, 0.3); background: rgba(34, 211, 238, 0.06); }
.scene-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.scene-card { display: flex; flex-direction: column; align-items: flex-start; min-height: 270px; padding: 20px; border: 1px solid var(--border-color); border-radius: var(--radius-md); background: var(--bg-soft); }
.scene-card.active { border-color: rgba(34, 211, 238, 0.35); box-shadow: inset 0 0 0 1px rgba(34, 211, 238, 0.08); }
.scene-icon { display: grid; place-items: center; width: 46px; height: 46px; margin-bottom: 16px; border-radius: 12px; color: var(--accent-primary); background: rgba(34, 211, 238, 0.08); }
.scene-copy { flex: 1; }
.scene-copy h3 { margin: 0 0 8px; font-size: 0.9rem; }
.scene-copy p { min-height: 42px; margin: 0 0 14px; color: var(--text-secondary); font-size: 0.7rem; line-height: 1.6; }
.scene-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.scene-tags span { padding: 4px 7px; border-radius: 4px; color: var(--text-muted); background: var(--bg-elevated); font-size: 0.62rem; }
.scene-card .btn { width: 100%; justify-content: center; margin-top: 20px; }
.simulation-teleoperation { display: grid; grid-template-columns: minmax(280px, 0.8fr) minmax(300px, 1.2fr); gap: 16px; margin-top: 20px; }
.telemetry-body { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; padding: 20px; }
.telemetry-body div { display: flex; flex-direction: column; gap: 5px; }
.telemetry-body span { color: var(--text-muted); font-size: 0.65rem; }
.telemetry-body strong { color: var(--text-primary); font-family: var(--font-mono); font-size: 0.78rem; font-weight: 500; }
.telemetry-body p { grid-column: 1 / -1; margin: 4px 0 0; color: var(--text-secondary); font-size: 0.68rem; line-height: 1.7; }
.simulation-note { display: flex; align-items: flex-start; gap: 8px; margin-top: 18px; color: var(--text-muted); font-size: 0.68rem; line-height: 1.6; }
.simulation-note svg { flex: 0 0 auto; margin-top: 2px; color: var(--accent-primary); }
@media (max-width: 1100px) { .scene-grid, .simulation-teleoperation { grid-template-columns: 1fr; } .scene-card { min-height: 0; } }
</style>
