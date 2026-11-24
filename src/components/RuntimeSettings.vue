<template>
  <div class="runtime-settings">
    <header class="settings-header">
      <div>
        <h1>ROS 运行配置</h1>
        <p>通过表单管理工作目录、运动控制、平台话题以及建图和导航任务。</p>
      </div>
      <button type="button" :disabled="loading || saving" @click="loadConfig(true)">
        {{ loading ? '正在加载…' : '重新加载' }}
      </button>
    </header>

    <p class="restart-note">
      保存不会中断当前连接或任务。修改目录、工作空间、话题或运动控制后请重新连接机器人；修改任务或仿真控制参数后请停止并重新启动对应任务。
    </p>

    <form @submit.prevent="saveConfig">
      <fieldset :disabled="loading || saving">
        <section class="settings-section">
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
              <small>用于读取、保存和编辑地图文件。</small>
            </label>
          </div>
        </section>

        <section class="settings-section">
          <div class="section-heading">
            <h2>运动控制</h2>
            <p>统一限制摇杆与 WASD 控制的速度和指令发送频率，并配置仿真控制超时。</p>
          </div>
          <div class="control-grid">
            <label>
              <span>最大线速度（m/s）</span>
              <input v-model.number="form.control.max_linear_speed" type="number" required min="0.1" max="2" step="any">
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

        <section class="settings-section">
          <div class="section-heading topic-heading">
            <div>
              <h2>平台话题</h2>
              <p>名称用于前端识别，值为 ROS 话题完整名称，必须以 / 开头。</p>
            </div>
            <button type="button" @click="addTopic">添加话题</button>
          </div>
          <div class="topic-list">
            <div v-for="topic in form.topics" :key="topic.id" class="topic-row">
              <label>
                <span>话题名称</span>
                <input
                  v-model.trim="topic.name"
                  required
                  maxlength="128"
                  placeholder="例如：camera_primary"
                  spellcheck="false"
                >
              </label>
              <label>
                <span>ROS 话题</span>
                <input
                  v-model.trim="topic.value"
                  required
                  maxlength="1024"
                  pattern="/.*"
                  placeholder="/camera1/preview/compressed"
                  spellcheck="false"
                >
              </label>
              <button type="button" class="remove-button" @click="removeTopic(topic.id)">删除</button>
            </div>
            <p v-if="form.topics.length === 0" class="empty-state">暂无话题，可点击“添加话题”创建。</p>
          </div>
        </section>

        <section v-for="taskName in taskNames" :key="taskName" class="settings-section">
          <div class="section-heading topic-heading">
            <div>
              <h2>{{ taskLabels[taskName] }}任务</h2>
              <p>可配置多个依次启动的任务；参数按每行一个传递给命令。</p>
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
                  rows="5"
                  placeholder="run&#10;slam_toolbox&#10;async_slam_toolbox_node"
                  spellcheck="false"
                ></textarea>
                <small>空行会被忽略，不要将命令及其参数写在 shell 脚本字符串中。</small>
              </label>
            </div>
          </article>
        </section>
      </fieldset>

      <footer class="settings-footer">
        <p v-if="message" class="form-message" :class="messageType" role="status">{{ message }}</p>
        <button type="submit" class="save-button" :disabled="loading || saving">
          {{ saving ? '正在保存…' : '保存配置' }}
        </button>
      </footer>
    </form>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'

const emit = defineEmits(['saved'])

const cameraDefaults = {
  camera_primary: '/camera1/preview/compressed',
  camera_secondary: '/camera2/preview/compressed'
}
const controlDefaults = {
  max_linear_speed: 0.5,
  max_angular_speed: 1.0,
  command_rate_hz: 10,
  command_timeout_ms: 600
}
const controlRules = [
  { field: 'max_linear_speed', label: '最大线速度', min: 0.1, max: 2 },
  { field: 'max_angular_speed', label: '最大角速度', min: 0.1, max: 3 },
  { field: 'command_rate_hz', label: '指令频率', min: 1, max: 50, integer: true },
  { field: 'command_timeout_ms', label: '指令超时', min: 200, max: 3000, integer: true }
]
const taskNames = ['mapping', 'navigation']
const taskLabels = { mapping: '建图', navigation: '导航' }
const loading = ref(false)
const saving = ref(false)
const message = ref('')
const messageType = ref('')
let nextId = 0

const form = reactive({
  workspace: '..',
  maps_dir: 'maps',
  control: { ...controlDefaults },
  topics: [],
  tasks: { mapping: [], navigation: [] }
})

function localId() {
  nextId += 1
  return nextId
}

function applyConfig(config) {
  form.workspace = typeof config?.workspace === 'string' && config.workspace ? config.workspace : '..'
  form.maps_dir = typeof config?.maps_dir === 'string' && config.maps_dir ? config.maps_dir : 'maps'
  for (const { field } of controlRules) {
    const value = config?.control?.[field]
    form.control[field] = Number.isFinite(value) ? value : controlDefaults[field]
  }
  const topics = { ...cameraDefaults, ...(config?.topics || {}) }
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

async function request(url, options) {
  const response = await fetch(url, options)
  let data = {}
  try {
    data = await response.json()
  } catch {
  }
  if (!response.ok) throw new Error(data.error || `请求失败（HTTP ${response.status}）`)
  return data
}

async function loadConfig(showSuccess = false) {
  loading.value = true
  message.value = ''
  try {
    const config = await request('/api/runtime_config')
    applyConfig(config)
    if (showSuccess) showMessage('已重新加载服务器上的配置。', 'success')
  } catch (error) {
    showMessage(error.message || '加载配置失败，请稍后重试。', 'error')
  } finally {
    loading.value = false
  }
}

function addTopic() {
  form.topics.push({ id: localId(), name: '', value: '/' })
}

function removeTopic(id) {
  form.topics = form.topics.filter((topic) => topic.id !== id)
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

  return { workspace: form.workspace.trim(), maps_dir: form.maps_dir.trim(), control, topics, tasks }
}

async function saveConfig() {
  saving.value = true
  message.value = ''
  try {
    const payload = buildPayload()
    const result = await request('/api/runtime_config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    applyConfig(result.config || payload)
    emit('saved', result.config || payload)
    showMessage('配置保存成功。请按需重新连接机器人或重启任务；运动控制与仿真参数变更后请重连或重启对应任务。', 'success')
  } catch (error) {
    showMessage(error.message || '保存配置失败，请稍后重试。', 'error')
  } finally {
    saving.value = false
  }
}

onMounted(() => loadConfig())
</script>

<style scoped>
.runtime-settings { width: min(1100px, 100%); margin: 0 auto; padding-bottom: 24px; }
.settings-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.settings-header h1 { font-size: 1.25rem; font-weight: 600; }
.settings-header p, .section-heading p { margin-top: 6px; color: var(--text-muted); font-size: 0.72rem; line-height: 1.6; }
button { min-height: 35px; padding: 0 13px; border: 1px solid var(--border-color); border-radius: 7px; color: var(--text-secondary); background: var(--bg-soft); font-size: 0.7rem; cursor: pointer; }
button:hover:not(:disabled) { border-color: var(--accent-primary); color: var(--accent-primary); }
button:disabled { opacity: 0.55; cursor: not-allowed; }
.restart-note { margin-bottom: 16px; padding: 11px 13px; border: 1px solid rgba(34, 211, 238, 0.2); border-radius: 8px; color: var(--text-secondary); background: rgba(34, 211, 238, 0.05); font-size: 0.7rem; line-height: 1.7; }
fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
.settings-section { margin-bottom: 16px; padding: 18px; border: 1px solid var(--border-color); border-radius: var(--radius-lg); background: var(--bg-card); }
.section-heading { margin-bottom: 16px; }
.section-heading h2 { font-size: 0.92rem; font-weight: 600; }
.topic-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.directory-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.control-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
label { display: block; min-width: 0; color: var(--text-secondary); font-size: 0.68rem; }
label > span { display: block; margin-bottom: 7px; }
input, textarea { width: 100%; border: 1px solid var(--border-color); border-radius: 7px; color: var(--text-primary); background: var(--bg-secondary); font-family: var(--font-mono); font-size: 0.72rem; outline: none; }
input { height: 38px; padding: 0 10px; }
textarea { padding: 10px; line-height: 1.7; resize: vertical; }
input:focus, textarea:focus { border-color: var(--accent-primary); }
small { display: block; margin-top: 7px; color: var(--text-muted); font-size: 0.62rem; line-height: 1.5; }
.topic-list { display: grid; gap: 10px; }
.topic-row { display: grid; grid-template-columns: minmax(160px, 0.65fr) minmax(240px, 1.5fr) auto; gap: 10px; align-items: end; padding: 12px; border: 1px solid var(--border-color); border-radius: 8px; background: rgba(2, 8, 18, 0.18); }
.remove-button { color: var(--danger); white-space: nowrap; }
.empty-state { padding: 14px; border: 1px dashed var(--border-color); border-radius: 8px; color: var(--text-muted); font-size: 0.68rem; text-align: center; }
.task-card { margin-top: 12px; padding: 14px; border: 1px solid var(--border-color); border-radius: 9px; background: rgba(2, 8, 18, 0.18); }
.task-card-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 13px; }
.task-card-heading h3 { color: var(--text-secondary); font-size: 0.75rem; font-weight: 600; }
.task-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 13px; }
.args-field { grid-column: 1 / -1; }
.settings-footer { display: flex; align-items: center; justify-content: flex-end; gap: 14px; }
.save-button { min-width: 110px; border-color: rgba(34, 211, 238, 0.45); color: var(--accent-primary); background: rgba(34, 211, 238, 0.09); }
.form-message { margin-right: auto; font-size: 0.7rem; line-height: 1.6; }
.form-message.success { color: var(--success); }
.form-message.error { color: var(--danger); }
@media (max-width: 720px) {
  .settings-header, .topic-heading { align-items: flex-start; }
  .directory-grid, .control-grid, .task-fields { grid-template-columns: 1fr; }
  .topic-row { grid-template-columns: 1fr; }
  .topic-row .remove-button { justify-self: start; }
  .settings-footer { align-items: stretch; flex-direction: column; }
  .form-message { margin-right: 0; }
}
</style>
