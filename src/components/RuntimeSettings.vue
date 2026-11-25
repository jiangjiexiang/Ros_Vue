<template>
  <div class="runtime-settings">
    <header class="settings-header">
      <div>
        <h1>ROS 运行配置</h1>
        <p>分组管理工作目录、运动安全限制、ROS 话题映射以及后台建图/导航任务。</p>
      </div>
      <div class="header-buttons">
        <button type="button" :disabled="loading || saving" @click="loadConfig(true)">
          {{ loading ? '正在加载…' : '重新加载' }}
        </button>
      </div>
    </header>

    <div class="settings-tabs" role="tablist" aria-label="系统配置分类">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        role="tab"
        :aria-selected="activeTab === tab.id"
        :class="{ active: activeTab === tab.id }"
        @click="activeTab = tab.id"
      >
        <span>{{ tab.label }}</span>
        <small v-if="tab.badge">{{ tab.badge }}</small>
      </button>
    </div>

    <form @submit.prevent="saveConfig">
      <fieldset :disabled="loading || saving">
        <section v-show="activeTab === 'directories'" class="settings-section">
          <div class="section-heading">
            <h2>基本目录</h2>
            <p>相对路径以项目根目录为基准，也可以填写本机绝对路径。</p>
          </div>
          <div class="directory-grid">
            <label>
              <span>ROS 工作空间</span>
              <input
                v-model.trim="form.workspace"
                required
                maxlength="1024"
                placeholder="例如：.. 或 /home/user/ros2_ws"
                spellcheck="false"
              >
              <small>后端将加载该目录下的 install/setup.bash。</small>
            </label>
            <label>
              <span>地图目录</span>
              <input
                v-model.trim="form.maps_dir"
                required
                maxlength="1024"
                placeholder="例如：maps"
                spellcheck="false"
              >
              <small>用于读取、保存和编辑 PGM/YAML 地图文件。</small>
            </label>
          </div>
          <p class="restart-note">
            修改目录或工作空间后请重新启动对应任务，确保新环境变量与路径生效。
          </p>
        </section>

        <section v-show="activeTab === 'control'" class="settings-section">
          <div class="section-heading">
            <h2>运动控制</h2>
            <p>统一限制摇杆与 WASD 控制的速度和指令发送频率，并配置仿真控制超时。</p>
          </div>
          <div class="control-grid">
            <label>
              <span>最大线速度（m/s）</span>
              <input v-model.number="form.control.max_linear_speed" type="number" required min="0.1" max="5" step="any">
              <small>范围 0.1～2 m/s。</small>
            </label>
            <label>
              <span>最大角速度（rad/s）</span>
              <input v-model.number="form.control.max_angular_speed" type="number" required min="0.1" max="3" step="any">
              <small>范围 0.1～3 rad/s。</small>
            </label>
            <label>
              <span>指令频率（Hz）</span>
              <input v-model.number="form.control.command_rate_hz" type="number" required min="1" max="50" step="1">
              <small>范围 1～50 Hz，必须为整数。</small>
            </label>
            <label>
              <span>指令超时（ms）</span>
              <input v-model.number="form.control.command_timeout_ms" type="number" required min="200" max="3000" step="1">
              <small>范围 200～3000 ms，必须为整数。</small>
            </label>
          </div>
        </section>

        <section v-show="activeTab === 'mapping'" class="settings-section">
          <div class="section-heading">
            <h2>建图控制</h2>
            <p>决定启动仿真场景时是否自动启动 FAST-LIO，默认不自动建图。</p>
          </div>
          <label class="mapping-toggle">
            <input v-model="form.mapping.auto_start" type="checkbox">
            <span>启动仿真场景时自动开始建图</span>
          </label>
          <p class="restart-note">
            此选项在下次启动场景时生效。当前场景的建图仍由工作台“开始建图 / 停止建图”按钮控制。
          </p>
        </section>

        <section v-show="activeTab === 'topics'" class="settings-section">
          <div class="section-heading topic-heading">
            <div>
              <h2>平台话题映射</h2>
              <p>按功能分组管理话题名称（必须以 / 开头）；机器狗已连接时可实时核对在线发布状态。</p>
            </div>
            <div class="topic-head-actions">
              <button type="button" @click="restoreDefaultTopics">恢复默认话题</button>
              <button type="button" @click="addTopic">添加自定义话题</button>
            </div>
          </div>

          <div v-for="group in groupedTopics" :key="group.title" class="topic-group">
            <h3>{{ group.title }}</h3>
            <div class="topic-list">
              <div v-for="topic in group.items" :key="topic.id" class="topic-row">
                <label>
                  <span>话题 Key</span>
                  <input
                    v-model.trim="topic.name"
                    required
                    maxlength="128"
                    :readonly="isPresetTopic(topic.name)"
                    placeholder="例如：camera_primary"
                    spellcheck="false"
                  >
                </label>
                <label>
                  <span>ROS 话题路径</span>
                  <input
                    v-model.trim="topic.value"
                    required
                    maxlength="1024"
                    pattern="/.*"
                    placeholder="/camera1/preview/compressed"
                    spellcheck="false"
                  >
                </label>
                <div class="topic-status-cell">
                  <span v-if="isConnected" class="topic-online-pill" :class="{ live: isTopicLive(topic.value) }">
                    {{ isTopicLive(topic.value) ? '在线' : '未发布' }}
                  </span>
                  <span v-else class="topic-online-pill">离线</span>
                </div>
                <button
                  type="button"
                  class="remove-button"
                  :disabled="isPresetTopic(topic.name)"
                  :title="isPresetTopic(topic.name) ? '核心预设话题不可删除' : '删除话题'"
                  @click="removeTopic(topic.id)"
                >
                  删除
                </button>
              </div>
            </div>
          </div>
        </section>

        <div v-show="activeTab === 'tasks'">
          <section v-for="taskName in taskNames" :key="taskName" class="settings-section">
            <div class="section-heading topic-heading">
              <div>
                <h2>{{ taskLabels[taskName] }}任务命令</h2>
                <p>可配置多个依次启动的后台命令；参数按每行一个传递给进程。</p>
              </div>
              <button type="button" @click="addTask(taskName)">添加任务</button>
            </div>
            <p v-if="form.tasks[taskName].length === 0" class="empty-state">
              当前未配置{{ taskLabels[taskName] }}任务，保存空数组可保持未配置状态。
            </p>
            <article v-for="(task, index) in form.tasks[taskName]" :key="task.id" class="task-card">
              <div class="task-card-heading">
                <h3>任务 {{ index + 1 }}</h3>
                <button type="button" class="remove-button" @click="removeTask(taskName, task.id)">删除任务</button>
              </div>
              <div class="task-fields">
                <label>
                  <span>描述</span>
                  <input
                    v-model.trim="task.description"
                    maxlength="512"
                    placeholder="例如：启动 Cartographer 建图"
                  >
                </label>
                <label>
                  <span>命令</span>
                  <input
                    v-model.trim="task.command"
                    required
                    maxlength="2048"
                    placeholder="例如：ros2"
                    spellcheck="false"
                  >
                </label>
                <label class="args-field">
                  <span>命令参数（每行一个）</span>
                  <textarea
                    v-model="task.argsText"
                    rows="4"
                    placeholder="run&#10;slam_toolbox&#10;async_slam_toolbox_node"
                    spellcheck="false"
                  ></textarea>
                  <small>空行会被忽略，不要将命令及其参数写在 shell 脚本字符串中。</small>
                </label>
              </div>
            </article>
          </section>

          <section class="settings-section">
            <div class="section-heading topic-heading">
              <div>
                <h2>后台进程与实时日志</h2>
                <p>查看运行中的任务进程与最近 stdout/stderr 输出。</p>
              </div>
              <button type="button" @click="refreshProcessState">刷新进程与日志</button>
            </div>

            <div class="process-monitor-grid">
              <div class="process-list">
                <div class="process-list-head">
                  <span>活动任务（{{ activeTaskIds.length }}）</span>
                </div>
                <button
                  v-for="id in monitorTaskIds"
                  :key="id"
                  type="button"
                  class="process-item"
                  :class="{ active: selectedLogTaskId === id, running: activeTaskIds.includes(id) }"
                  @click="selectLogTask(id)"
                >
                  <i class="proc-dot"></i>
                  <span>{{ id }}</span>
                  <small>{{ activeTaskIds.includes(id) ? '运行中' : '已停止' }}</small>
                </button>
                <p v-if="!monitorTaskIds.length" class="empty-state">暂无运行中或有日志的任务进程</p>
              </div>

              <div class="process-log-viewer">
                <div class="log-viewer-head">
                  <strong>{{ selectedLogTaskId || '未选择任务' }}</strong>
                  <div class="log-viewer-actions">
                    <button
                      v-if="stopGroupForTask(selectedLogTaskId)"
                      type="button"
                      class="remove-button"
                      @click="stopTaskGroup(stopGroupForTask(selectedLogTaskId))"
                    >
                      停止任务组
                    </button>
                    <button type="button" :disabled="!selectedLogTaskId" @click="fetchTaskLogs(selectedLogTaskId)">
                      刷新日志
                    </button>
                  </div>
                </div>
                <pre v-if="taskLogs.length" class="log-console">{{ formattedLogs }}</pre>
                <p v-else class="empty-state">选择左侧任务 ID 后查看输出日志</p>
              </div>
            </div>
          </section>
        </div>
      </fieldset>

      <footer class="settings-footer">
        <p v-if="message" class="form-message" :class="messageType" role="status">{{ message }}</p>
        <button type="submit" class="save-button" :disabled="loading || saving">
          {{ saving ? '正在保存…' : '保存全部配置' }}
        </button>
      </footer>
    </form>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { API_BASE } from '../config.js'
import { TOPIC_DEFAULTS } from '../stores/runtimeConfigStore.js'
import { useRosSessionStore } from '../stores/rosSessionStore.js'
import { showToast } from '../stores/toastStore.js'

const emit = defineEmits(['saved'])
const { isConnected, topics: liveChannels, robotTopics } = useRosSessionStore()

const TOPIC_GROUPS = [
  { title: '控制与里程计', keys: ['cmd_vel', 'odom', 'imu', 'battery', 'tf'] },
  { title: '建图与导航', keys: ['map', 'plan', 'goal_pose', 'initial_pose', 'navigate_feedback'] },
  { title: '激光雷达与 3D 点云', keys: ['scan', 'pointcloud', 'registered_cloud', 'fastlio_odom', 'fastlio_path'] },
  { title: '定位与点击导航', keys: ['localization', 'localization_path', 'global_map'] },
  { title: '机载相机', keys: ['camera_primary'] }
]
const PRESET_KEY_SET = new Set(TOPIC_GROUPS.flatMap((g) => g.keys))

const controlDefaults = {
  max_linear_speed: 5,
  max_angular_speed: 1.0,
  command_rate_hz: 10,
  command_timeout_ms: 600
}
const controlRules = [
  { field: 'max_linear_speed', label: '最大线速度', min: 0.1, max: 5 },
  { field: 'max_angular_speed', label: '最大角速度', min: 0.1, max: 3 },
  { field: 'command_rate_hz', label: '指令频率', min: 1, max: 50, integer: true },
  { field: 'command_timeout_ms', label: '指令超时', min: 200, max: 3000, integer: true }
]
const taskNames = ['mapping', 'navigation']
const taskLabels = { mapping: '建图', navigation: '导航' }

const activeTab = ref('directories')
const loading = ref(false)
const saving = ref(false)
const message = ref('')
const messageType = ref('')
const activeTaskIds = ref([])
const knownLogTaskIds = ref([])
const selectedLogTaskId = ref('')
const taskLogs = ref([])
let nextId = 0

const form = reactive({
  workspace: '..',
  maps_dir: 'maps',
  control: { ...controlDefaults },
  mapping: { auto_start: false },
  topics: [],
  tasks: { mapping: [], navigation: [] }
})

const tabs = computed(() => [
  { id: 'directories', label: '基本目录' },
  { id: 'control', label: '运动安全' },
  { id: 'mapping', label: '建图控制' },
  { id: 'topics', label: 'ROS 话题', badge: `${form.topics.length}` },
  { id: 'tasks', label: '任务与进程', badge: activeTaskIds.value.length ? `${activeTaskIds.value.length} 运行` : '' }
])

const groupedTopics = computed(() => {
  const byName = new Map(form.topics.map((item) => [item.name, item]))
  const groups = TOPIC_GROUPS.map((group) => ({
    title: group.title,
    items: group.keys.map((key) => byName.get(key)).filter(Boolean)
  })).filter((g) => g.items.length > 0)

  const custom = form.topics.filter((item) => !PRESET_KEY_SET.has(item.name))
  if (custom.length) {
    groups.push({ title: '自定义话题', items: custom })
  }
  return groups
})

const liveTopicSet = computed(() => new Set((liveChannels.value || []).map((c) => c.topic)))
const monitorTaskIds = computed(() => [...new Set([...activeTaskIds.value, ...knownLogTaskIds.value])])
const formattedLogs = computed(() => (
  taskLogs.value.map((item) => `[${item.time.slice(11, 19)}] [${item.stream}] ${item.line}`).join('\n')
))

function localId() {
  nextId += 1
  return nextId
}

function isPresetTopic(name) {
  return PRESET_KEY_SET.has(name)
}

function isTopicLive(topicPath) {
  if (!topicPath) return false
  if (liveTopicSet.value.has(topicPath)) return true
  const namespaced = Object.values(robotTopics.value || {})
  return namespaced.includes(topicPath) && liveTopicSet.value.has(topicPath)
}

function applyConfig(config) {
  form.workspace = typeof config?.workspace === 'string' && config.workspace ? config.workspace : '..'
  form.maps_dir = typeof config?.maps_dir === 'string' && config.maps_dir ? config.maps_dir : 'maps'
  for (const { field } of controlRules) {
    const value = config?.control?.[field]
    form.control[field] = Number.isFinite(value) ? value : controlDefaults[field]
  }
  form.mapping.auto_start = config?.mapping?.auto_start === true
  const topics = { ...TOPIC_DEFAULTS, ...(config?.topics || {}) }
  form.topics = Object.entries(topics).map(([name, value]) => ({ id: localId(), name, value }))
  for (const taskName of taskNames) {
    const tasks = Array.isArray(config?.tasks?.[taskName]) ? config.tasks[taskName] : []
    form.tasks[taskName] = tasks.map((task) => ({
      id: localId(),
      description: task.description || '',
      command: task.command || '',
      argsText: Array.isArray(task.args) ? task.args.join('\n') : ''
    }))
  }
}

async function request(path, options) {
  const response = await fetch(`${API_BASE}${path}`, options)
  let data = {}
  try { data = await response.json() } catch {}
  if (!response.ok) throw new Error(data.error || `请求失败（HTTP ${response.status}）`)
  return data
}

async function loadConfig(showSuccess = false) {
  loading.value = true
  message.value = ''
  try {
    const config = await request('/runtime_config')
    applyConfig(config)
    if (showSuccess) showMessage('已重新加载服务器上的配置。', 'success')
  } catch (error) {
    showMessage(error.message || '加载配置失败，请稍后重试。', 'error')
  } finally {
    loading.value = false
  }
}

async function refreshProcessState() {
  try {
    const data = await request('/tasks/active')
    activeTaskIds.value = data.activeTasks || []
    knownLogTaskIds.value = Object.keys(data.logCounts || {})
    if (!selectedLogTaskId.value && monitorTaskIds.value.length) {
      selectedLogTaskId.value = monitorTaskIds.value[0]
    }
    if (selectedLogTaskId.value) {
      await fetchTaskLogs(selectedLogTaskId.value)
    }
  } catch {}
}

async function fetchTaskLogs(id) {
  if (!id) return
  try {
    const data = await request(`/tasks/logs/${encodeURIComponent(id)}`)
    taskLogs.value = data.logs || []
  } catch {
    taskLogs.value = []
  }
}

function selectLogTask(id) {
  selectedLogTaskId.value = id
  fetchTaskLogs(id)
}

function stopGroupForTask(id) {
  if (!id) return ''
  if (id === 'foxglove') return 'startup'
  if (id.startsWith('simulation_indoor')) return 'simulation_indoor'
  if (id.startsWith('simulation_warehouse')) return 'simulation_warehouse'
  if (id.startsWith('simulation_outdoor')) return 'simulation_outdoor'
  if (id.startsWith('mapping')) return 'mapping'
  if (id.startsWith('navigation')) return 'navigation'
  return ''
}

async function stopTaskGroup(groupName) {
  try {
    await request(`/stop_task/${encodeURIComponent(groupName)}`, { method: 'POST' })
    showToast(`已发送停止指令：${groupName}`, 'info')
    await refreshProcessState()
  } catch (err) {
    showToast(err.message || '停止任务失败', 'error')
  }
}

function addTopic() {
  form.topics.push({ id: localId(), name: '', value: '/' })
}

function removeTopic(id) {
  form.topics = form.topics.filter((topic) => topic.id !== id)
}

function restoreDefaultTopics() {
  const custom = form.topics.filter((item) => !PRESET_KEY_SET.has(item.name))
  const defaults = Object.entries(TOPIC_DEFAULTS).map(([name, value]) => ({ id: localId(), name, value }))
  form.topics = [...defaults, ...custom]
  showToast('已恢复默认 ROS 话题映射（保存后生效）', 'info')
}

function addTask(taskName) {
  form.tasks[taskName].push({ id: localId(), description: '', command: '', argsText: '' })
}

function removeTask(taskName, id) {
  form.tasks[taskName] = form.tasks[taskName].filter((task) => task.id !== id)
}

function showMessage(text, type) {
  message.value = text
  messageType.value = type
}

function buildPayload() {
  const topics = {}
  for (const item of form.topics) {
    const name = item.name.trim()
    const value = item.value.trim()
    if (!name) throw new Error('话题名称不能为空。')
    if (Object.hasOwn(topics, name)) throw new Error(`话题名称“${name}”重复，请修改后再保存。`)
    if (!value.startsWith('/')) throw new Error(`话题“${name}”必须以 / 开头。`)
    topics[name] = value
  }

  const tasks = {}
  for (const taskName of taskNames) {
    tasks[taskName] = form.tasks[taskName].map((task, index) => {
      if (!task.command.trim()) throw new Error(`${taskLabels[taskName]}任务 ${index + 1} 的命令不能为空。`)
      return {
        description: task.description.trim(),
        command: task.command.trim(),
        args: task.argsText.split(/\r?\n/).map((arg) => arg.trim()).filter(Boolean)
      }
    })
  }
  const control = {}
  for (const { field, label, min, max, integer } of controlRules) {
    const value = Number(form.control[field])
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      throw new Error(`${label}必须是 ${min}～${max} 范围内的${integer ? '整数' : '数值'}。`)
    }
    control[field] = value
  }

  return {
    workspace: form.workspace.trim(),
    maps_dir: form.maps_dir.trim(),
    control,
    mapping: { auto_start: form.mapping.auto_start === true },
    topics,
    tasks
  }
}

async function saveConfig() {
  saving.value = true
  message.value = ''
  try {
    const payload = buildPayload()
    const result = await request('/runtime_config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    applyConfig(result.config || payload)
    emit('saved', result.config || payload)
    showMessage('配置保存成功。话题或运动控制变更后请重连机器狗，任务变更后请重启对应任务。', 'success')
  } catch (error) {
    showMessage(error.message || '保存配置失败，请稍后重试。', 'error')
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  loadConfig()
  refreshProcessState()
})
</script>

<style scoped>
.runtime-settings { width: min(1100px, 100%); margin: 0 auto; padding-bottom: 24px; }
.settings-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.settings-header h1 { font-size: 1.32rem; font-weight: 650; }
.settings-header p, .section-heading p { margin-top: 6px; color: var(--text-muted); font-size: var(--text-sm); line-height: 1.6; }
button { min-height: 36px; padding: 0 13px; border: 1px solid var(--border-color); border-radius: 8px; color: var(--text-secondary); background: var(--bg-soft); font-size: var(--text-xs); cursor: pointer; }
button:hover:not(:disabled) { border-color: var(--accent-primary); color: var(--accent-primary); }
button:disabled { opacity: 0.5; cursor: not-allowed; }

.settings-tabs {
  display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; padding: 5px;
  border: 1px solid var(--border-color); border-radius: var(--radius-md); background: var(--bg-card);
}
.settings-tabs button {
  display: inline-flex; align-items: center; gap: 7px; border: 0; border-radius: 7px; background: transparent;
  font-size: var(--text-sm); font-weight: 500;
}
.settings-tabs button.active { color: var(--accent-primary); background: rgba(34, 211, 238, 0.1); }
.settings-tabs small { padding: 1px 6px; border-radius: 999px; background: var(--bg-elevated); color: var(--text-secondary); font-size: 0.7rem; }

.restart-note { margin-top: 16px; padding: 11px 13px; border: 1px solid rgba(34, 211, 238, 0.2); border-radius: 8px; color: var(--text-secondary); background: rgba(34, 211, 238, 0.05); font-size: var(--text-xs); line-height: 1.7; }
fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
.settings-section { margin-bottom: 16px; padding: 18px; border: 1px solid var(--border-color); border-radius: var(--radius-lg); background: var(--bg-card); }
.section-heading { margin-bottom: 16px; }
.section-heading h2 { font-size: 1rem; font-weight: 600; }
.topic-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
.topic-head-actions { display: flex; gap: 8px; }
.directory-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.control-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
.mapping-toggle { display: flex; align-items: center; gap: 10px; width: fit-content; cursor: pointer; }
.mapping-toggle input { flex: 0 0 auto; width: 18px; height: 18px; margin: 0; padding: 0; accent-color: var(--accent-primary); }
.mapping-toggle span { margin: 0; color: var(--text-primary); }
label { display: block; min-width: 0; color: var(--text-secondary); font-size: var(--text-xs); }
label > span { display: block; margin-bottom: 7px; }
input, textarea { width: 100%; border: 1px solid var(--border-color); border-radius: 7px; color: var(--text-primary); background: var(--bg-secondary); font-family: var(--font-mono); font-size: var(--text-sm); outline: none; }
input { height: 38px; padding: 0 10px; }
input[readonly] { color: var(--text-muted); background: rgba(2, 8, 18, 0.3); }
textarea { padding: 10px; line-height: 1.65; resize: vertical; }
input:focus, textarea:focus { border-color: var(--accent-primary); }
small { display: block; margin-top: 6px; color: var(--text-muted); font-size: var(--text-xs); line-height: 1.5; }

.topic-group + .topic-group { margin-top: 18px; }
.topic-group h3 { margin-bottom: 10px; color: var(--text-secondary); font-size: var(--text-sm); font-weight: 600; }
.topic-list { display: grid; gap: 8px; }
.topic-row { display: grid; grid-template-columns: minmax(150px, 0.65fr) minmax(220px, 1.5fr) 74px auto; gap: 10px; align-items: end; padding: 11px; border: 1px solid var(--border-color); border-radius: 8px; background: rgba(2, 8, 18, 0.18); }
.topic-status-cell { display: flex; align-items: center; height: 38px; }
.topic-online-pill { padding: 4px 8px; border: 1px solid var(--border-color); border-radius: 999px; color: var(--text-muted); font-size: 0.7rem; }
.topic-online-pill.live { border-color: rgba(52, 211, 153, 0.3); color: var(--success); background: rgba(52, 211, 153, 0.08); }
.remove-button { color: var(--danger); white-space: nowrap; }
.empty-state { padding: 16px; border: 1px dashed var(--border-color); border-radius: 8px; color: var(--text-muted); font-size: var(--text-xs); text-align: center; }

.task-card { margin-top: 12px; padding: 14px; border: 1px solid var(--border-color); border-radius: 9px; background: rgba(2, 8, 18, 0.18); }
.task-card-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 13px; }
.task-card-heading h3 { color: var(--text-secondary); font-size: var(--text-sm); font-weight: 600; }
.task-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 13px; }
.args-field { grid-column: 1 / -1; }

.process-monitor-grid { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 12px; }
.process-list { display: flex; flex-direction: column; gap: 6px; }
.process-list-head { color: var(--text-muted); font-size: var(--text-xs); margin-bottom: 4px; }
.process-item {
  display: flex; align-items: center; gap: 8px; width: 100%; padding: 9px 10px;
  border: 1px solid var(--border-color); border-radius: 8px; text-align: left;
  background: var(--bg-soft); color: var(--text-secondary);
}
.process-item.active { border-color: var(--accent-primary); color: var(--text-primary); background: rgba(34, 211, 238, 0.08); }
.proc-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-muted); }
.process-item.running .proc-dot { background: var(--success); }
.process-item small { margin: 0 0 0 auto; font-size: 0.7rem; }

.process-log-viewer { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.log-viewer-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.log-viewer-head strong { font-family: var(--font-mono); font-size: var(--text-sm); }
.log-viewer-actions { display: flex; gap: 8px; }
.log-console {
  max-height: 260px; padding: 12px; overflow: auto;
  border: 1px solid var(--border-color); border-radius: 8px;
  color: var(--text-secondary); background: #040a12;
  font-family: var(--font-mono); font-size: 0.75rem; line-height: 1.55; white-space: pre-wrap; word-break: break-all;
}

.settings-footer { display: flex; align-items: center; justify-content: flex-end; gap: 14px; }
.save-button { min-width: 126px; border-color: rgba(34, 211, 238, 0.45); color: var(--accent-primary); background: rgba(34, 211, 238, 0.09); font-size: var(--text-sm); }
.form-message { margin-right: auto; font-size: var(--text-sm); line-height: 1.6; }
.form-message.success { color: var(--success); }
.form-message.error { color: var(--danger); }

@media (max-width: 820px) {
  .directory-grid, .control-grid, .task-fields, .process-monitor-grid { grid-template-columns: 1fr; }
  .topic-row { grid-template-columns: 1fr; }
  .settings-footer { align-items: stretch; flex-direction: column; }
  .form-message { margin-right: 0; }
}
</style>
