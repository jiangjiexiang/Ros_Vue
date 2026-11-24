<template>
  <div class="robot-manager">
    <header class="robot-manager-header">
      <div>
        <h1>多机器狗管理</h1>
        <p>管理实体与仿真机器狗的连接地址、命名空间及雷达算法方案，支持一键测速与切换。</p>
      </div>
      <div class="header-right-actions">
        <span class="robot-count-pill">{{ robots.length }} 台机器狗</span>
        <button type="button" class="btn btn-connect add-trigger-btn" @click="openCreateDrawer">
          + 添加机器狗
        </button>
      </div>
    </header>

    <section class="robot-grid">
      <article v-for="robot in robots" :key="robot.id" class="robot-card" :class="{ active: robot.id === activeRobotId }">
        <div class="robot-card-header">
          <div class="robot-avatar"><UiIcon name="robot" :size="23" /></div>
          <div class="robot-card-title">
            <h2>{{ robot.name }}</h2>
            <span v-if="robot.id === activeRobotId" class="robot-state" :class="connectionState">
              <i class="status-dot" :class="connectionState"></i>{{ stateText }}
            </span>
            <span v-else class="robot-state">待切换</span>
          </div>
          <span
            v-if="probeResults[robot.id]"
            class="probe-badge"
            :class="probeResults[robot.id].status"
          >
            {{ probeResults[robot.id].text }}
          </span>
        </div>

        <dl>
          <div><dt>地址</dt><dd>{{ displayAddress(robot.url) }}</dd></div>
          <div><dt>通信</dt><dd>{{ robot.transport === 'doglink' ? 'DogLink 自研' : robot.transport === 'rosbridge' ? 'ROS Bridge' : 'Foxglove' }}</dd></div>
          <div><dt>命名空间</dt><dd>{{ robot.namespace || '无' }}</dd></div>
          <div><dt>算法方案</dt><dd>{{ formatAlgorithmPlan(robot) }}</dd></div>
        </dl>

        <div class="robot-card-actions">
          <button
            class="switch-button"
            :disabled="robot.id === activeRobotId && connectionState === 'connecting'"
            @click="$emit('switch', robot)"
          >
            {{ robot.id === activeRobotId ? '进入工作台' : '切换并连接' }}
          </button>
          <button
            type="button"
            class="test-button"
            :disabled="probeResults[robot.id]?.status === 'testing'"
            @click="testConnectivity(robot)"
          >
            {{ probeResults[robot.id]?.status === 'testing' ? '测试中…' : '测速' }}
          </button>
          <button type="button" class="edit-button" @click="openEditDrawer(robot)">编辑</button>
          <button type="button" class="delete-button" :disabled="robots.length <= 1" @click="remove(robot)">删除</button>
        </div>
      </article>
    </section>

    <p class="robot-manager-note">
      当前为一个活动连接：切换机器狗时会断开上一台并清空其地图与遥测，重新连接后自动订阅新机器狗的话题。配置同步保存于后端与本机浏览器。
    </p>

    <Teleport to="body">
      <div v-if="drawerOpen" class="drawer-backdrop" @click.self="closeDrawer">
        <aside class="robot-drawer" role="dialog" aria-modal="true" :aria-label="editingId ? '编辑机器狗' : '添加机器狗'">
          <header class="drawer-header">
            <div>
              <h2>{{ editingId ? '编辑机器狗配置' : '添加机器狗' }}</h2>
              <p>选择接入方式并配置通信地址与雷达 SLAM 方案。</p>
            </div>
            <button type="button" class="drawer-close" aria-label="关闭抽屉" @click="closeDrawer">
              <UiIcon name="x" :size="18" />
            </button>
          </header>

          <div class="drawer-body">
            <div v-if="!editingId" class="access-presets">
              <button type="button" @click="useRealPreset">实体机器狗模板</button>
              <button type="button" @click="useSimulationPreset">Isaac 仿真一键模板</button>
            </div>

            <form id="robot-drawer-form" class="drawer-form" @submit.prevent="submitForm">
              <div class="form-row-2">
                <label>
                  <span>机器狗名称</span>
                  <input v-model.trim="form.name" required placeholder="例如：巡检机器狗 2">
                </label>
                <label>
                  <span>通信方式</span>
                  <select v-model="form.transport" @change="changeTransport">
                    <option value="doglink">DogLink 自研协议（8768 · 低延迟二进制）</option>
                    <option value="foxglove">Foxglove（8765）</option>
                    <option value="rosbridge">ROS Bridge（9090）</option>
                  </select>
                </label>
              </div>

              <div class="form-row-3">
                <label>
                  <span>局域网 IP / 主机名</span>
                  <input v-model.trim="form.host" required placeholder="192.168.1.20">
                </label>
                <label>
                  <span>端口</span>
                  <input v-model.trim="form.port" type="number" min="1" max="65535" required>
                </label>
                <label>
                  <span>命名空间（可选）</span>
                  <input v-model.trim="form.namespace" placeholder="例如 robot2">
                </label>
              </div>

              <section class="algorithm-config">
                <div class="algorithm-config-heading">
                  <h3>雷达与算法方案</h3>
                  <span>先选雷达维度，再配置建图与定位</span>
                </div>
                <div class="algorithm-fields">
                  <label>
                    <span>雷达类型</span>
                    <select v-model="form.lidarType" @change="changeLidarType">
                      <option value="2d">2D 激光雷达</option>
                      <option value="3d">3D 激光雷达</option>
                    </select>
                  </label>
                  <label>
                    <span>建图算法</span>
                    <select v-model="form.slamAlgorithm" @change="changeSlamAlgorithm">
                      <option v-for="option in slamAlgorithmOptions" :key="option.value" :value="option.value">
                        {{ option.label }}
                      </option>
                    </select>
                  </label>
                  <label>
                    <span>定位方式</span>
                    <select v-model="form.localizationAlgorithm">
                      <option v-for="option in localizationAlgorithmOptions" :key="option.value" :value="option.value">
                        {{ option.label }}
                      </option>
                    </select>
                  </label>
                  <template v-if="usesCustomAlgorithm">
                    <label>
                      <span>自定义算法包</span>
                      <input v-model.trim="form.algorithmPackage" placeholder="ROS 包名，例如 my_slam">
                    </label>
                    <label>
                      <span>Launch 文件名</span>
                      <input v-model.trim="form.algorithmLaunch" placeholder="不含路径，例如 slam.launch.py">
                    </label>
                  </template>
                </div>
                <p v-if="form.slamAlgorithm === 'fast_lio_localization'" class="algo-hint">
                  当前建图算法为 FAST-LIO 定位模式，无需再选择单独定位方式。
                </p>
                <p v-else-if="usesCustomAlgorithm" class="algo-hint">
                  算法包和 Launch 文件名用于自定义建图或定位启动配置。
                </p>
                <p v-else class="algo-hint">
                  2D 可搭配 AMCL 定位；3D 可搭配 FAST-LIO Localization。
                </p>
              </section>

              <p v-if="errorMsg" class="error-message">{{ errorMsg }}</p>
            </form>
          </div>

          <footer class="drawer-footer">
            <button type="button" class="btn btn-secondary" @click="closeDrawer">取消</button>
            <button type="submit" form="robot-drawer-form" class="btn btn-connect">
              {{ editingId ? '保存修改' : '添加并连接' }}
            </button>
          </footer>
        </aside>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import UiIcon from './UiIcon.vue'
import { confirmDialog, showToast } from '../stores/toastStore.js'

const props = defineProps({
  robots: { type: Array, required: true },
  activeRobotId: { type: String, required: true },
  connectionState: { type: String, default: 'disconnected' }
})
const emit = defineEmits(['add', 'update', 'remove', 'switch'])

const drawerOpen = ref(false)
const editingId = ref('')
const errorMsg = ref('')
const probeResults = reactive({})

const SLAM_ALGORITHMS = {
  '2d': [
    { value: 'slam_toolbox', label: 'SLAM Toolbox' },
    { value: 'cartographer', label: 'Cartographer' }
  ],
  '3d': [
    { value: 'fast_lio', label: 'FAST-LIO' },
    { value: 'fast_lio_localization', label: 'FAST-LIO Localization（定位模式）' },
    { value: 'custom', label: '自定义算法' }
  ]
}
const LOCALIZATION_ALGORITHMS = {
  '2d': [
    { value: 'none', label: '不启用单独定位' },
    { value: 'amcl', label: 'AMCL（建图后定位）' },
    { value: 'custom', label: '自定义定位' }
  ],
  '3d': [
    { value: 'none', label: '不启用单独定位' },
    { value: 'fast_lio_localization', label: 'FAST-LIO Localization' },
    { value: 'custom', label: '自定义定位' }
  ]
}

function getLocalizationOptions(lidarType, slamAlgorithm) {
  return LOCALIZATION_ALGORITHMS[lidarType].filter((option) => (
    slamAlgorithm !== 'fast_lio_localization' || option.value !== 'fast_lio_localization'
  ))
}

function normalizeAlgorithmConfig(robot = {}) {
  const lidarType = robot.lidarType === '3d' ? '3d' : '2d'
  const defaultSlam = lidarType === '3d' ? 'fast_lio' : 'slam_toolbox'
  const slamAlgorithm = SLAM_ALGORITHMS[lidarType].some((option) => option.value === robot.slamAlgorithm)
    ? robot.slamAlgorithm
    : defaultSlam
  const defaultLocalization = lidarType === '2d' ? 'amcl' : 'none'
  const localizationOptions = getLocalizationOptions(lidarType, slamAlgorithm)
  const localizationAlgorithm = localizationOptions.some((option) => option.value === robot.localizationAlgorithm)
    ? robot.localizationAlgorithm
    : defaultLocalization
  return {
    lidarType,
    slamAlgorithm,
    localizationAlgorithm,
    algorithmPackage: robot.algorithmPackage || '',
    algorithmLaunch: robot.algorithmLaunch || ''
  }
}

function createDefaultForm() {
  return {
    name: '',
    transport: 'foxglove',
    host: '',
    port: '8765',
    namespace: '',
    ...normalizeAlgorithmConfig()
  }
}

const form = reactive(createDefaultForm())
const slamAlgorithmOptions = computed(() => SLAM_ALGORITHMS[form.lidarType])
const localizationAlgorithmOptions = computed(() => getLocalizationOptions(form.lidarType, form.slamAlgorithm))
const usesCustomAlgorithm = computed(() => form.slamAlgorithm === 'custom' || form.localizationAlgorithm === 'custom')
const stateText = computed(() => ({
  connected: '已连接', connecting: '连接中', error: '连接异常'
}[props.connectionState] || '未连接'))

function normalizeFormAlgorithms() {
  Object.assign(form, normalizeAlgorithmConfig(form))
}

function changeLidarType() {
  normalizeFormAlgorithms()
}

function changeSlamAlgorithm() {
  normalizeFormAlgorithms()
}

function formatAlgorithmPlan(robot) {
  const config = normalizeAlgorithmConfig(robot)
  const slam = SLAM_ALGORITHMS[config.lidarType].find((option) => option.value === config.slamAlgorithm)
  const localization = getLocalizationOptions(config.lidarType, config.slamAlgorithm)
    .find((option) => option.value === config.localizationAlgorithm)
  return `${config.lidarType.toUpperCase()} · ${slam.label} · ${localization.label}`
}

function changeTransport() {
  if (['8765', '9090', '8768'].includes(form.port)) {
    form.port = form.transport === 'rosbridge'
      ? '9090'
      : form.transport === 'doglink'
        ? '8768'
        : '8765'
  }
}

function useRealPreset() {
  form.name = '巡检机器狗'
  form.transport = 'doglink'
  form.host = ''
  form.port = '8768'
  form.namespace = ''
}

function useSimulationPreset() {
  form.name = 'Isaac 仿真机器狗'
  form.transport = 'doglink'
  form.host = window.location.hostname || 'localhost'
  form.port = '8768'
  form.namespace = ''
}

function openCreateDrawer() {
  resetForm()
  drawerOpen.value = true
}

function openEditDrawer(robot) {
  try {
    const url = new URL(robot.url)
    editingId.value = robot.id
    form.name = robot.name
    form.transport = robot.transport || 'foxglove'
    form.host = url.hostname.replace(/^\[|\]$/g, '')
    form.port = url.port || '8765'
    form.namespace = robot.namespace || ''
    Object.assign(form, normalizeAlgorithmConfig(robot))
    errorMsg.value = ''
    drawerOpen.value = true
  } catch {
    showToast('该机器人的连接地址无效，无法编辑', 'error')
  }
}

function closeDrawer() {
  drawerOpen.value = false
  resetForm()
}

function resetForm() {
  editingId.value = ''
  errorMsg.value = ''
  Object.assign(form, createDefaultForm())
}

function submitForm() {
  errorMsg.value = ''
  normalizeFormAlgorithms()
  const algorithmLaunch = form.algorithmLaunch.trim()
  if (usesCustomAlgorithm.value && (/[\\/]/.test(algorithmLaunch) || algorithmLaunch === '.' || algorithmLaunch === '..')) {
    errorMsg.value = 'Launch 文件只填写文件名，不要包含目录路径'
    return
  }
  const portNumber = Number(form.port)
  if (!form.host || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    errorMsg.value = '请输入有效的机器人 IP 和端口'
    return
  }
  const host = form.host.includes(':') && !form.host.startsWith('[') ? `[${form.host}]` : form.host
  const config = {
    name: form.name.trim(),
    url: `ws://${host}:${portNumber}`,
    transport: form.transport,
    namespace: form.namespace.trim().replace(/^\/+|\/+$/g, ''),
    lidarType: form.lidarType,
    slamAlgorithm: form.slamAlgorithm,
    localizationAlgorithm: form.localizationAlgorithm,
    algorithmPackage: usesCustomAlgorithm.value ? form.algorithmPackage.trim() : '',
    algorithmLaunch: usesCustomAlgorithm.value ? algorithmLaunch : ''
  }
  if (editingId.value) emit('update', { ...config, id: editingId.value })
  else emit('add', config)
  closeDrawer()
}

function displayAddress(value) {
  try {
    const url = new URL(value)
    return `${url.hostname}:${url.port || '8765'}`
  } catch {
    return value
  }
}

function testConnectivity(robot) {
  probeResults[robot.id] = { status: 'testing', text: '测速中' }
  const startedAt = performance.now()
  let settled = false
  let socket = null

  const finish = (status, text) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    probeResults[robot.id] = { status, text }
    try { socket?.close() } catch {}
  }

  const timer = setTimeout(() => finish('fail', '连接超时'), 2500)

  try {
    const protocols = robot.transport === 'foxglove' || !robot.transport ? ['foxglove.websocket.v1'] : undefined
    socket = protocols ? new WebSocket(robot.url, protocols) : new WebSocket(robot.url)
    socket.onopen = () => {
      const rtt = Math.max(1, Math.round(performance.now() - startedAt))
      finish('ok', `连通 · ${rtt} ms`)
    }
    socket.onerror = () => finish('fail', '连接失败')
  } catch {
    finish('fail', '地址无效')
  }
}

async function remove(robot) {
  const confirmed = await confirmDialog({
    title: '删除机器狗配置',
    message: `确定删除「${robot.name}」的连接与算法配置吗？此操作不可恢复。`,
    confirmText: '确认删除',
    danger: true
  })
  if (!confirmed) return
  if (editingId.value === robot.id) closeDrawer()
  emit('remove', robot.id)
}

function onKeyDown(e) {
  if (drawerOpen.value && e.key === 'Escape') closeDrawer()
}

onMounted(() => window.addEventListener('keydown', onKeyDown))
onUnmounted(() => window.removeEventListener('keydown', onKeyDown))
</script>

<style scoped>
.robot-manager { width: min(1220px, 100%); margin: 0 auto; }
.robot-manager-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
.robot-manager-header h1 { font-size: 1.32rem; font-weight: 650; }
.robot-manager-header p { margin-top: 6px; color: var(--text-muted); font-size: var(--text-sm); }
.header-right-actions { display: flex; align-items: center; gap: 10px; }
.robot-count-pill { padding: 6px 12px; border: 1px solid var(--border-color); border-radius: 20px; color: var(--text-secondary); font-size: var(--text-xs); }
.add-trigger-btn { min-height: 36px; font-size: var(--text-sm); }

.robot-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(310px, 1fr)); gap: 14px; }
.robot-card { padding: 18px; border: 1px solid var(--border-color); border-radius: var(--radius-lg); background: var(--bg-card); box-shadow: var(--shadow-card); }
.robot-card.active { border-color: rgba(34, 211, 238, 0.38); }
.robot-card-header { display: flex; align-items: center; gap: 12px; }
.robot-avatar { display: grid; place-items: center; width: 44px; height: 44px; flex: 0 0 auto; border-radius: 11px; color: var(--accent-primary); background: rgba(34, 211, 238, 0.08); }
.robot-card-title { min-width: 0; flex: 1; }
.robot-card h2 { overflow: hidden; font-size: 0.98rem; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.robot-state { display: flex; align-items: center; gap: 6px; margin-top: 4px; color: var(--text-muted); font-size: var(--text-xs); }
.robot-state.connected { color: var(--success); }
.robot-state.error { color: var(--danger); }

.probe-badge {
  flex: 0 0 auto;
  padding: 3px 8px;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  font-family: var(--font-mono);
  font-size: 0.7rem;
  color: var(--text-secondary);
  background: var(--bg-soft);
}
.probe-badge.ok { border-color: rgba(52, 211, 153, 0.35); color: var(--success); background: rgba(52, 211, 153, 0.08); }
.probe-badge.fail { border-color: rgba(251, 113, 133, 0.35); color: var(--danger); background: rgba(251, 113, 133, 0.08); }

dl { margin: 15px 0; }
dl > div { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--border-color); font-size: var(--text-xs); }
dt { color: var(--text-muted); flex: 0 0 auto; }
dd { overflow: hidden; color: var(--text-secondary); font-family: var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }

.robot-card-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.robot-card-actions button { min-height: 35px; padding: 0 12px; border: 1px solid var(--border-color); border-radius: 8px; color: var(--text-secondary); background: var(--bg-soft); font-size: var(--text-xs); cursor: pointer; transition: var(--transition); }
.robot-card-actions button:hover:not(:disabled) { border-color: var(--border-strong); color: var(--text-primary); }
.robot-card-actions .switch-button { flex: 1; color: var(--accent-primary); border-color: rgba(34, 211, 238, 0.25); }
.robot-card-actions .delete-button { color: var(--danger); }
.robot-manager-note { margin-top: 16px; color: var(--text-muted); font-size: var(--text-xs); line-height: 1.6; }

.drawer-backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  justify-content: flex-end;
  background: rgba(2, 8, 18, 0.68);
  backdrop-filter: blur(5px);
}
.robot-drawer {
  display: flex;
  flex-direction: column;
  width: min(560px, 100vw);
  height: 100%;
  border-left: 1px solid var(--border-strong);
  background: var(--bg-card);
  box-shadow: -16px 0 48px rgba(0, 0, 0, 0.45);
}
.drawer-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 20px;
  border-bottom: 1px solid var(--border-color);
}
.drawer-header h2 { font-size: 1.08rem; font-weight: 650; }
.drawer-header p { margin-top: 5px; color: var(--text-muted); font-size: var(--text-xs); }
.drawer-close {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-secondary);
  background: var(--bg-soft);
  cursor: pointer;
}
.drawer-body {
  flex: 1;
  padding: 20px;
  overflow-y: auto;
}
.access-presets { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.access-presets button {
  min-height: 34px;
  padding: 0 12px;
  border: 1px solid rgba(34, 211, 238, 0.28);
  border-radius: 8px;
  color: var(--accent-primary);
  background: rgba(34, 211, 238, 0.06);
  font-size: var(--text-xs);
  cursor: pointer;
}
.drawer-form { display: flex; flex-direction: column; gap: 14px; }
.form-row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.form-row-3 { display: grid; grid-template-columns: 1.4fr 0.7fr 1fr; gap: 10px; }
.drawer-form label { display: block; color: var(--text-secondary); font-size: var(--text-xs); }
.drawer-form label > span { display: block; margin-bottom: 6px; }
.drawer-form input, .drawer-form select {
  width: 100%;
  height: 38px;
  padding: 0 10px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-primary);
  background: var(--bg-secondary);
  font-size: var(--text-sm);
}
.algorithm-config {
  padding: 14px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-soft);
}
.algorithm-config-heading h3 { font-size: var(--text-sm); font-weight: 600; color: var(--text-primary); }
.algorithm-config-heading span { display: block; margin-top: 4px; color: var(--text-muted); font-size: var(--text-xs); }
.algorithm-fields { display: grid; grid-template-columns: 1fr; gap: 10px; margin-top: 12px; }
.algo-hint { margin-top: 10px; color: var(--text-muted); font-size: var(--text-xs); line-height: 1.5; }
.drawer-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 16px 20px;
  border-top: 1px solid var(--border-color);
  background: rgba(7, 17, 31, 0.45);
}

@media (max-width: 640px) {
  .form-row-2, .form-row-3 { grid-template-columns: 1fr; }
}
</style>
