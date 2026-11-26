<template>
  <main class="simulation-page">
    <header class="sim-page-header">
      <div>
        <h1>GPU 仿真测试</h1>
        <p>启动 Isaac Sim 物理场景与 ROS 2 双向桥接，监控传感器话题健康度与仿真日志。</p>
      </div>
      <button type="button" class="btn btn-connect" @click="connectSimulationWorkspace">
        <UiIcon name="activity" :size="16" />
        <span>连接仿真狗并进入工作台</span>
      </button>
    </header>

    <section class="card sim-page-card">
      <SimulationControl
        :controlConfig="controlConfig"
        @active-scene-change="activeScene = $event"
      />
    </section>

    <section class="card sim-health-card">
      <div class="card-header">
        <span><UiIcon name="link" :size="17" />ROS 2 仿真话题健康检查</span>
        <small>{{ isConnected ? `已发现 ${topics.length} 个通道` : '未连接当前场景 DogLink' }}</small>
      </div>
      <div class="topic-health-grid">
        <div
          v-for="item in expectedSimTopics"
          :key="item.topic"
          class="topic-health-pill"
          :class="{ live: isConnected && liveTopicSet.has(item.topic) }"
        >
          <i></i>
          <strong>{{ item.label }}</strong>
          <span>{{ item.topic }}</span>
        </div>
      </div>
    </section>

    <section class="card sim-logs-card">
      <div class="card-header">
        <span><UiIcon name="sliders" :size="17" />仿真进程与 ROS 桥接日志</span>
        <div class="log-controls">
          <select v-model="selectedLogId" class="log-task-select" aria-label="选择进程日志" @change="fetchLogs">
            <option value="simulation_indoor">simulation_indoor（室内仿真）</option>
            <option value="simulation_indoor_ros">simulation_indoor_ros（室内桥接）</option>
            <option value="simulation_indoor_fastlio">simulation_indoor_fastlio（室内 FAST-LIO）</option>
            <option value="doglink">doglink（三狗统一网关）</option>
            <option value="simulation_warehouse">simulation_warehouse（仓库仿真）</option>
            <option value="simulation_warehouse_ros">simulation_warehouse_ros（仓库桥接）</option>
            <option value="simulation_warehouse_fastlio">simulation_warehouse_fastlio（仓库 FAST-LIO）</option>
            <option value="simulation_outdoor">simulation_outdoor（户外仿真）</option>
            <option value="simulation_outdoor_ros">simulation_outdoor_ros（户外桥接）</option>
            <option value="simulation_outdoor_fastlio">simulation_outdoor_fastlio（户外 FAST-LIO）</option>
          </select>
          <button type="button" class="btn btn-secondary refresh-log-btn" @click="fetchLogs">
            <UiIcon name="refresh" :size="14" />刷新
          </button>
        </div>
      </div>
      <pre v-if="logs.length" class="sim-log-pre">{{ formattedLogs }}</pre>
      <div v-else class="sim-log-empty">暂无日志输出；启动场景后点击“刷新”查看实时输出。</div>
    </section>
  </main>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import SimulationControl from '../components/SimulationControl.vue'
import UiIcon from '../components/UiIcon.vue'
import { API_BASE, apiFetch } from '../config.js'
import { useRobotStore } from '../stores/robotStore.js'
import { useRuntimeConfigStore } from '../stores/runtimeConfigStore.js'
import { useRosSessionStore } from '../stores/rosSessionStore.js'
import { showToast } from '../stores/toastStore.js'

const router = useRouter()
const { ensureSimulationRobot, activeRobot } = useRobotStore()
const { controlConfig } = useRuntimeConfigStore()
const { isConnected, topics, robotTopics, switchRobot } = useRosSessionStore()

const activeScene = ref('')
const selectedLogId = ref('simulation_indoor')
const logs = ref([])

const expectedSimTopics = computed(() => {
  const items = [
    { label: '里程计', topic: robotTopics.value.odom || '/odom' },
    { label: '3D 点云', topic: robotTopics.value.pointcloud || '/points' },
    { label: 'IMU', topic: robotTopics.value.imu || '/imu' },
    { label: 'TF 坐标', topic: robotTopics.value.tf || '/tf' },
    { label: '电量', topic: robotTopics.value.battery || '/battery' },
    { label: '机载主相机', topic: robotTopics.value.camera_primary || '/camera1/preview/compressed' }
  ]
  if (activeRobot.value?.lidarType !== '3d') {
    items.splice(1, 0, { label: '2D 激光', topic: robotTopics.value.scan || '/scan' })
  }
  return items
})

const liveTopicSet = computed(() => new Set((topics.value || []).map((c) => c.topic)))
const formattedLogs = computed(() => (
  logs.value.map((item) => `[${item.time.slice(11, 19)}] [${item.stream}] ${item.line}`).join('\n')
))

async function fetchLogs() {
  try {
    const res = await apiFetch(`${API_BASE}/tasks/logs/${encodeURIComponent(selectedLogId.value)}`)
    if (!res.ok) return
    const data = await res.json()
    logs.value = data.logs || []
  } catch {
    logs.value = []
  }
}

async function connectSimulationWorkspace() {
  try {
    const simRobot = await ensureSimulationRobot(activeScene.value || 'indoor')
    switchRobot(simRobot, { reconnect: true })
    showToast(`已切换至「${simRobot.name}」并尝试连接`, 'success')
    router.push('/inspection')
  } catch (error) {
    showToast(error.message || '仿真机器狗配置保存失败', 'error')
  }
}

watch(activeScene, (scene) => {
  if (scene) {
    selectedLogId.value = `simulation_${scene}`
    fetchLogs()
  }
})

onMounted(fetchLogs)
</script>

<style scoped>
.simulation-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: min(1180px, 100%);
  margin: 0 auto;
  padding: 24px;
  overflow: auto;
}

.sim-page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.sim-page-header h1 { font-size: 1.32rem; font-weight: 650; }
.sim-page-header p { margin-top: 6px; color: var(--text-muted); font-size: var(--text-sm); }

.topic-health-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 10px;
  padding: 16px;
}

.topic-health-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-soft);
}

.topic-health-pill i {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--text-muted);
}

.topic-health-pill.live {
  border-color: rgba(52, 211, 153, 0.28);
  background: rgba(52, 211, 153, 0.06);
}

.topic-health-pill.live i {
  background: var(--success);
}

.topic-health-pill strong {
  font-size: var(--text-xs);
  color: var(--text-primary);
  flex: 0 0 auto;
}

.topic-health-pill span {
  overflow: hidden;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 0.72rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.log-task-select {
  height: 32px;
  padding: 0 8px;
  border: 1px solid var(--border-color);
  border-radius: 7px;
  color: var(--text-primary);
  background: var(--bg-secondary);
  font-size: var(--text-xs);
}

.refresh-log-btn {
  min-height: 32px;
  padding: 0 10px;
  font-size: var(--text-xs);
}

.sim-log-pre {
  max-height: 240px;
  padding: 14px 16px;
  overflow: auto;
  color: var(--text-secondary);
  background: #040a12;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-all;
}

.sim-log-empty {
  padding: 20px;
  color: var(--text-muted);
  font-size: var(--text-sm);
  text-align: center;
}

@media (max-width: 720px) {
  .simulation-page { padding: 14px; }
  .sim-page-header { flex-direction: column; align-items: flex-start; }
}
</style>
