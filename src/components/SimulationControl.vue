<template>
  <section class="simulation-control">
    <div class="simulation-heading">
      <div>
        <h2>GPU 仿真测试</h2>
        <p>Isaac Sim · Unitree Go2 · RTX 物理仿真</p>
      </div>
      <span class="simulation-state" :class="{ active: activeScene }">
        {{ activeScene ? sceneName(activeScene) + '运行中' : '仿真待机' }}
      </span>
    </div>

    <div class="scene-grid">
      <article v-for="scene in scenes" :key="scene.id" class="scene-card" :class="{ active: activeScene === scene.id }">
        <div class="scene-icon"><UiIcon :name="scene.icon" :size="24" /></div>
        <div class="scene-copy">
          <h3>{{ scene.name }}</h3>
          <p>{{ scene.description }}</p>
          <div class="scene-tags"><span v-for="tag in scene.tags" :key="tag">{{ tag }}</span></div>
        </div>
        <button
          v-if="activeScene !== scene.id"
          class="btn btn-connect"
          :disabled="Boolean(loadingScene)"
          @click="startScene(scene.id)"
        >
          <UiIcon name="play" :size="15" />
          {{ loadingScene === scene.id ? '正在启动…' : activeScene ? '切换至此场景' : '启动场景' }}
        </button>
        <button v-else class="btn btn-disconnect" :disabled="Boolean(loadingScene)" @click="stopScene">
          <UiIcon name="stop" :size="15" />
          {{ loadingScene === scene.id ? '正在停止…' : '停止场景' }}
        </button>
      </article>
    </div>

    <div v-if="activeScene" class="simulation-teleoperation">
      <JoystickControl
        :connected="Boolean(activeScene)"
        :maxLinearSpeed="controlConfig.max_linear_speed ?? 0.5"
        :maxAngularSpeed="controlConfig.max_angular_speed ?? 1.0"
        :commandRateHz="controlConfig.command_rate_hz ?? 10"
        @velocity-change="sendVelocity"
        @stop="stopMotion"
      />
      <section class="card telemetry-card">
        <div class="card-header"><span><UiIcon name="activity" :size="17" />仿真遥测</span><small>GUI + WEB</small></div>
        <div class="telemetry-body">
          <div><span>场景</span><strong>{{ sceneName(activeScene) }}</strong></div>
          <div><span>位置 X / Y</span><strong>{{ telemetry.position.x.toFixed(2) }} / {{ telemetry.position.y.toFixed(2) }} m</strong></div>
          <div><span>朝向</span><strong>{{ telemetry.yaw.toFixed(2) }} rad</strong></div>
          <div><span>线速度</span><strong>{{ telemetry.command.linearX.toFixed(2) }} m/s</strong></div>
          <div><span>角速度</span><strong>{{ telemetry.command.angularZ.toFixed(2) }} rad/s</strong></div>
          <div><span>虚拟雷达</span><strong>{{ lidarText }}</strong></div>
          <p>提供 2D 激光（360 束 / 12 m）与 16 线 3D 点云（/points，20 m）及双路机载/观察相机，用于建图、点云和工作台联调。</p>
          <p>拖动左侧摇杆控制 Go2。松开摇杆或点击“停止运动”即停车；控制指令超过 {{ controlConfig.command_timeout_ms ?? 600 }} 毫秒未更新也会自动停车。</p>
        </div>
      </section>
    </div>

    <div class="simulation-note">
      <UiIcon name="activity" :size="16" />
      <span>场景在本机 Isaac Sim 图形窗口中显示。ROS 2 桥接同步发布 /odom、/tf、/scan、/points、/imu、/battery 及双路压缩相机流，并订阅 /cmd_vel。</span>
    </div>
    <div v-if="controlError" class="error-message mt-2">{{ controlError }}</div>
    <div v-if="errorMsg" class="error-message mt-2">{{ errorMsg }}</div>
  </section>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { API_BASE } from '../config.js'
import JoystickControl from './JoystickControl.vue'
import UiIcon from './UiIcon.vue'

defineProps({
  controlConfig: { type: Object, default: () => ({}) }
})

const emit = defineEmits(['active-scene-change'])

const scenes = [
  { id: 'indoor', name: '室内巡检', icon: 'map', description: '办公室隔墙、门洞和桌椅，测试基础巡检与绕障。', tags: ['12 × 10 m', '门洞', '室内障碍'] },
  { id: 'warehouse', name: '仓库障碍', icon: 'layers', description: '货架、堆垛和窄通道，测试复杂环境通过能力。', tags: ['16 × 13 m', '窄通道', '货架'] },
  { id: 'outdoor', name: '户外坡道', icon: 'route', description: '连续坡道、台阶和岩石，测试地形适应能力。', tags: ['17 × 14 m', '12° 坡道', '台阶'] }
]

const activeScene = ref('')
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
let commandPending = false

const lidarText = computed(() => {
  const lidar = telemetry.value.lidar
  return lidar ? `${lidar.beams} 束 / ${lidar.range_max} m` : '360 束 / 12 m'
})

function sceneName(id) {
  return scenes.find((scene) => scene.id === id)?.name || ''
}

async function request(path) {
  const res = await fetch(`${API_BASE}${path}`, { method: 'POST' })
  const data = await res.json()
  if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`)
}

async function checkStatus() {
  try {
    const statuses = await Promise.all(scenes.map(async (scene) => {
      const res = await fetch(`${API_BASE}/task_status/simulation_${scene.id}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()).isRunning ? scene.id : ''
    }))
    activeScene.value = statuses.find(Boolean) || ''
  } catch (err) {
    console.error('获取仿真状态失败:', err)
  }
}

async function updateTelemetry() {
  if (!activeScene.value) return
  try {
    const res = await fetch(`${API_BASE}/simulation/status`)
    if (!res.ok) return
    const data = await res.json()
    if (data.ready) {
      telemetry.value = data
      controlError.value = ''
    }
  } catch {}
}

async function sendVelocity({ linearX, angularZ }) {
  if (!activeScene.value || commandPending) return
  commandPending = true
  try {
    const res = await fetch(`${API_BASE}/simulation/velocity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ linearX, angularZ })
    })
    const data = await res.json()
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`)
    controlError.value = ''
  } catch (err) {
    controlError.value = err.message || '仿真控制失败'
  } finally {
    commandPending = false
  }
}

function stopMotion() {
  sendVelocity({ linearX: 0, angularZ: 0 })
}

async function startScene(id) {
  loadingScene.value = id
  errorMsg.value = ''
  try {
    if (activeScene.value && activeScene.value !== id) {
      await request(`/stop_task/simulation_${activeScene.value}`)
    }
    await request(`/run_task/simulation_${id}`)
    activeScene.value = id
  } catch (err) {
    errorMsg.value = err.message || '无法启动仿真场景'
  } finally {
    loadingScene.value = ''
  }
}

async function stopScene() {
  if (!activeScene.value) return
  loadingScene.value = activeScene.value
  errorMsg.value = ''
  try {
    await request(`/stop_task/simulation_${activeScene.value}`)
    activeScene.value = ''
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
  if (statusTimer) clearInterval(statusTimer)
  if (telemetryTimer) clearInterval(telemetryTimer)
  stopMotion()
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
