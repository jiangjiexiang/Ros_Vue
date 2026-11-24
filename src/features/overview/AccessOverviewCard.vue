<template>
  <section class="access-overview" aria-labelledby="access-overview-title">
    <header class="access-header">
      <div class="access-heading">
        <span class="access-kicker"><UiIcon name="link" :size="15" />实际接入方案</span>
        <div class="access-title-row">
          <h2 id="access-overview-title">当前接入概览</h2>
          <span class="config-state pending">待部署</span>
        </div>
        <p>汇总本机保存的机器人与 ROS 运行配置，用于部署前核对。</p>
      </div>
      <div class="access-actions">
        <RouterLink class="access-button primary" to="/robots">
          <UiIcon name="robot" :size="16" />管理机器人
        </RouterLink>
        <RouterLink class="access-button" to="/settings">
          <UiIcon name="layers" :size="16" />系统配置
        </RouterLink>
      </div>
    </header>

    <div class="access-metrics" aria-label="接入配置关键指标">
      <article class="access-metric">
        <span class="metric-icon"><UiIcon name="robot" :size="19" /></span>
        <div>
          <span>机器人数量</span>
          <strong>{{ robotConfigs.length }}<small>台</small></strong>
          <p>{{ configuredRobotCount }} 台已填写连接地址</p>
        </div>
      </article>
      <article class="access-metric">
        <span class="metric-icon"><UiIcon name="layers" :size="19" /></span>
        <div>
          <span>雷达方案</span>
          <strong class="metric-text">2D {{ lidarCounts['2d'] || 0 }} · 3D {{ lidarCounts['3d'] || 0 }}</strong>
          <p>按各机器人的 lidarType 统计</p>
        </div>
      </article>
      <article class="access-metric">
        <span class="metric-icon"><UiIcon name="link" :size="19" /></span>
        <div>
          <span>通信协议</span>
          <strong class="metric-text">{{ transportSummary }}</strong>
          <p>WebSocket 接入方式配置</p>
        </div>
      </article>
      <article class="access-metric">
        <span class="metric-icon"><UiIcon name="activity" :size="19" /></span>
        <div>
          <span>ROS 话题</span>
          <strong class="metric-status" :class="topicStatusClass">{{ topicStatus }}</strong>
          <p>{{ topicDetail }}</p>
        </div>
      </article>
    </div>

    <div class="algorithm-grid">
      <section v-for="group in algorithmGroups" :key="group.key" class="algorithm-panel">
        <div class="algorithm-heading">
          <span><UiIcon :name="group.icon" :size="17" />{{ group.title }}</span>
          <small>{{ group.configuredCount }} 台已配置</small>
        </div>
        <ul class="algorithm-list">
          <li v-for="item in group.items" :key="item.key" :class="{ selected: item.count > 0 }">
            <span>{{ item.label }}</span>
            <strong>{{ item.count }}<small>台</small></strong>
          </li>
        </ul>
      </section>
    </div>

    <section class="robot-configurations" aria-labelledby="robot-configurations-title">
      <div class="configuration-heading">
        <div>
          <h3 id="robot-configurations-title">接入清单</h3>
          <p>逐台核对传感器、算法与通信配置</p>
        </div>
        <span>{{ robotConfigs.length }} 条本机记录</span>
      </div>

      <div v-if="robotConfigs.length === 0" class="configuration-empty">
        <UiIcon name="robot" :size="24" />
        <strong>尚未保存机器人接入配置</strong>
        <p>请先在机器狗管理中添加连接信息，再核对 ROS 话题。</p>
        <RouterLink to="/robots">添加机器人</RouterLink>
      </div>

      <ul v-else class="configuration-list">
        <li v-for="robot in robotConfigs" :key="robot.key" class="configuration-card">
          <div class="configuration-card-header">
            <div>
              <strong>{{ robot.name }}</strong>
              <small>{{ robot.id || '未设置机器人 ID' }}</small>
            </div>
            <span class="config-state" :class="robot.status === '待部署' ? 'pending' : 'unconfigured'">
              {{ robot.status }}
            </span>
          </div>

          <div class="configuration-tags">
            <span>{{ robot.lidarLabel }}</span>
            <span>{{ robot.transportLabel }}</span>
            <span>{{ robot.slamLabel }}</span>
            <span>{{ robot.localizationLabel }}</span>
          </div>

          <dl class="configuration-details">
            <div>
              <dt>连接地址</dt>
              <dd>{{ robot.url || '未配置' }}</dd>
            </div>
            <div>
              <dt>命名空间</dt>
              <dd>{{ robot.namespace || '无' }}</dd>
            </div>
            <div v-if="robot.algorithmPackage">
              <dt>算法包</dt>
              <dd>{{ robot.algorithmPackage }}</dd>
            </div>
            <div v-if="robot.algorithmLaunch">
              <dt>启动配置</dt>
              <dd>{{ robot.algorithmLaunch }}</dd>
            </div>
          </dl>
          <p v-if="robot.customConfigMissing" class="custom-config-warning">
            自定义算法包或启动配置未填写完整。
          </p>
        </li>
      </ul>
    </section>

    <p v-if="robotConfigError" class="configuration-error" role="alert">{{ robotConfigError }}</p>
    <p v-if="runtimeConfigError" class="configuration-error" role="alert">{{ runtimeConfigError }}</p>
    <footer class="access-note">
      <span class="note-dot" aria-hidden="true"></span>
      此区域仅展示配置结果，不代表机器人在线、连接成功或 FAST-LIO 已启动；实际运行需在部署后验证。
    </footer>
  </section>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import UiIcon from '../../components/UiIcon.vue'

const STORAGE_KEY = 'robot-console-robots'
const robots = ref([])
const runtimeTopics = ref({})
const runtimeLoading = ref(false)
const runtimeConfigError = ref('')
const robotConfigError = ref('')
let runtimeController = null

const slamOptions = [
  { key: 'slam_toolbox', label: 'SLAM Toolbox' },
  { key: 'cartographer', label: 'Cartographer' },
  { key: 'fast_lio', label: 'FAST-LIO' },
  { key: 'custom', label: '自定义' }
]
const localizationOptions = [
  { key: 'amcl', label: 'AMCL' },
  { key: 'fast_lio_localization', label: 'FAST-LIO Localization' },
  { key: 'none', label: '无定位' },
  { key: 'custom', label: '自定义' }
]

const robotConfigs = computed(() => robots.value.map(normalizeRobot))
const configuredRobotCount = computed(() => robotConfigs.value.filter((robot) => robot.url).length)
const lidarCounts = computed(() => countBy(robotConfigs.value, 'lidar'))
const transportSummary = computed(() => {
  if (!robotConfigs.value.length) return '未配置'
  const counts = countBy(robotConfigs.value, 'transport')
  const labels = { foxglove: 'Foxglove', rosbridge: 'ROS Bridge', custom: '其他' }
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${labels[key]} ${count}`)
    .join(' · ')
})
const algorithmGroups = computed(() => [
  buildAlgorithmGroup('建图算法', 'slam', slamOptions, 'map'),
  buildAlgorithmGroup('定位方式', 'localization', localizationOptions, 'compass')
])
const topicCount = computed(() => Object.entries(runtimeTopics.value)
  .filter(([name, value]) => name.trim() && typeof value === 'string' && value.trim()).length)
const topicStatus = computed(() => {
  if (runtimeLoading.value) return '待部署'
  return topicCount.value > 0 ? '已配置' : '未配置'
})
const topicStatusClass = computed(() => ({
  configured: topicStatus.value === '已配置',
  unconfigured: topicStatus.value === '未配置',
  pending: topicStatus.value === '待部署'
}))
const topicDetail = computed(() => {
  if (runtimeLoading.value) return '正在读取运行时配置'
  if (runtimeConfigError.value) return '暂无法确认服务器话题配置'
  return topicCount.value > 0 ? `${topicCount.value} 个话题已保存` : '请在系统配置中添加话题'
})

function normalizeRobot(robot, index) {
  const lidar = normalizeOption(robot.lidarType, ['2d', '3d'], '2d')
  const slam = normalizeOption(robot.slamAlgorithm, slamOptions.map((item) => item.key), 'slam_toolbox')
  const localization = normalizeOption(
    robot.localizationAlgorithm,
    localizationOptions.map((item) => item.key),
    'amcl'
  )
  const transport = normalizeOption(robot.transport, ['foxglove', 'rosbridge'], 'foxglove')
  const algorithmPackage = cleanText(robot.algorithmPackage)
  const algorithmLaunch = cleanText(robot.algorithmLaunch)
  const customConfigMissing = (slam === 'custom' || localization === 'custom')
    && (!algorithmPackage || !algorithmLaunch)
  const url = cleanText(robot.url)

  return {
    key: cleanText(robot.id) || `robot-${index}`,
    id: cleanText(robot.id),
    name: cleanText(robot.name) || `机器人 ${index + 1}`,
    url,
    namespace: cleanText(robot.namespace),
    lidar,
    lidarLabel: lidar === 'custom' ? '自定义雷达' : `${lidar.toUpperCase()} 激光`,
    transport,
    transportLabel: { foxglove: 'Foxglove', rosbridge: 'ROS Bridge', custom: '其他协议' }[transport],
    slam,
    slamLabel: optionLabel(slamOptions, slam),
    localization,
    localizationLabel: optionLabel(localizationOptions, localization),
    algorithmPackage,
    algorithmLaunch,
    customConfigMissing,
    status: url && !customConfigMissing ? '待部署' : '未配置'
  }
}

function normalizeOption(value, options, fallback) {
  const normalized = cleanText(value).toLowerCase()
  if (!normalized) return fallback
  return options.includes(normalized) ? normalized : 'custom'
}

function optionLabel(options, key) {
  return options.find((item) => item.key === key)?.label || '自定义'
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function countBy(items, key) {
  return items.reduce((counts, item) => {
    counts[item[key]] = (counts[item[key]] || 0) + 1
    return counts
  }, {})
}

function buildAlgorithmGroup(title, key, options, icon) {
  const counts = countBy(robotConfigs.value, key)
  const configuredCount = robotConfigs.value.filter((robot) => (
    robot[key] !== 'custom' || (robot.algorithmPackage && robot.algorithmLaunch)
  )).length
  return {
    key,
    title,
    icon,
    configuredCount,
    items: options.map((option) => ({ ...option, count: counts[option.key] || 0 }))
  }
}

function loadRobots() {
  robotConfigError.value = ''
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (!saved) {
      robots.value = []
      return
    }
    const parsed = JSON.parse(saved)
    if (!Array.isArray(parsed)) throw new Error('机器人配置不是数组')
    const validRobots = parsed.filter((robot) => robot && typeof robot === 'object' && !Array.isArray(robot))
    robots.value = validRobots
    if (validRobots.length !== parsed.length) {
      robotConfigError.value = '本机机器人记录中包含无效条目，接入清单已忽略这些条目。'
    }
  } catch {
    robots.value = []
    robotConfigError.value = '本机机器人配置无法读取，请前往机器狗管理检查并重新保存。'
  }
}

async function loadRuntimeConfig() {
  runtimeController?.abort()
  const controller = new AbortController()
  runtimeController = controller
  runtimeLoading.value = true
  runtimeConfigError.value = ''
  try {
    const response = await fetch('/api/runtime_config', { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const config = await response.json()
    runtimeTopics.value = config?.topics && typeof config.topics === 'object' && !Array.isArray(config.topics)
      ? config.topics
      : {}
    if (!config?.topics || typeof config.topics !== 'object' || Array.isArray(config.topics)) {
      runtimeConfigError.value = 'ROS 运行配置中未找到有效的话题对象，当前按未配置展示。'
    }
  } catch (error) {
    if (error.name === 'AbortError') return
    runtimeTopics.value = {}
    runtimeConfigError.value = '无法读取 ROS 运行配置，话题暂按未配置展示；机器人本机配置不受影响。'
  } finally {
    if (runtimeController === controller) {
      runtimeLoading.value = false
      runtimeController = null
    }
  }
}

function handleStorage(event) {
  if (event.key === STORAGE_KEY) loadRobots()
}

function handleVisibility() {
  if (document.visibilityState !== 'visible') return
  loadRobots()
  loadRuntimeConfig()
}

onMounted(() => {
  loadRobots()
  loadRuntimeConfig()
  window.addEventListener('storage', handleStorage)
  document.addEventListener('visibilitychange', handleVisibility)
})

onUnmounted(() => {
  runtimeController?.abort()
  window.removeEventListener('storage', handleStorage)
  document.removeEventListener('visibilitychange', handleVisibility)
})
</script>

<style scoped>
.access-overview {
  position: relative;
  margin-top: 20px;
  padding: 22px;
  overflow: hidden;
  border: 1px solid rgba(34, 211, 238, 0.24);
  border-radius: var(--radius-lg);
  background:
    radial-gradient(circle at 100% 0, rgba(34, 211, 238, 0.075), transparent 34%),
    linear-gradient(145deg, var(--bg-card), var(--bg-secondary));
  box-shadow: var(--shadow-card);
}
.access-overview::before {
  position: absolute;
  top: 0;
  left: 22px;
  width: 92px;
  height: 2px;
  background: var(--accent-primary);
  box-shadow: 0 0 14px rgba(34, 211, 238, 0.4);
  content: '';
}
.access-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.access-heading { min-width: 0; }
.access-kicker { display: inline-flex; align-items: center; gap: 7px; color: var(--accent-primary); font-size: 0.66rem; font-weight: 600; letter-spacing: 0.08em; }
.access-title-row { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
.access-title-row h2 { font-size: 1.16rem; font-weight: 650; letter-spacing: 0.02em; }
.access-heading > p { margin-top: 7px; color: var(--text-muted); font-size: 0.7rem; line-height: 1.6; }
.config-state { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; padding: 4px 8px; border: 1px solid var(--border-color); border-radius: 5px; color: var(--text-muted); background: var(--bg-soft); font-size: 0.59rem; font-weight: 500; white-space: nowrap; }
.config-state.pending { border-color: rgba(251, 191, 36, 0.22); color: var(--warning); background: rgba(251, 191, 36, 0.07); }
.config-state.unconfigured { color: var(--text-muted); background: rgba(148, 163, 184, 0.05); }
.access-actions { display: flex; flex: 0 0 auto; gap: 8px; padding-top: 5px; }
.access-button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 35px; padding: 0 12px; border: 1px solid var(--border-color); border-radius: 7px; color: var(--text-secondary); background: var(--bg-soft); font-size: 0.68rem; text-decoration: none; transition: var(--transition); }
.access-button:hover { border-color: rgba(34, 211, 238, 0.45); color: var(--accent-primary); }
.access-button.primary { border-color: rgba(34, 211, 238, 0.35); color: var(--accent-primary); background: rgba(34, 211, 238, 0.08); }
.access-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 11px; margin-top: 20px; }
.access-metric { display: flex; align-items: center; gap: 12px; min-width: 0; min-height: 105px; padding: 15px; border: 1px solid var(--border-color); border-radius: var(--radius-md); background: rgba(2, 8, 18, 0.2); }
.metric-icon { display: grid; place-items: center; width: 36px; height: 36px; flex: 0 0 auto; border-radius: 9px; color: var(--accent-primary); background: rgba(34, 211, 238, 0.07); }
.access-metric > div { min-width: 0; }
.access-metric div > span { display: block; color: var(--text-muted); font-size: 0.64rem; }
.access-metric strong { display: block; margin-top: 6px; font-family: var(--font-mono); font-size: 1.5rem; font-weight: 600; line-height: 1.2; }
.access-metric strong small { margin-left: 5px; color: var(--text-secondary); font-size: 0.65rem; font-weight: 400; }
.access-metric strong.metric-text { overflow: hidden; font-size: 0.86rem; line-height: 1.45; text-overflow: ellipsis; white-space: nowrap; }
.access-metric strong.metric-status { font-family: inherit; font-size: 0.95rem; }
.metric-status.configured { color: var(--success); }
.metric-status.unconfigured { color: var(--text-muted); }
.metric-status.pending { color: var(--warning); }
.access-metric p { margin-top: 6px; overflow: hidden; color: var(--text-muted); font-size: 0.59rem; line-height: 1.45; text-overflow: ellipsis; white-space: nowrap; }
.algorithm-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 12px; }
.algorithm-panel { min-width: 0; padding: 15px; border: 1px solid var(--border-color); border-radius: var(--radius-md); background: rgba(2, 8, 18, 0.14); }
.algorithm-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding-bottom: 11px; border-bottom: 1px solid var(--border-color); }
.algorithm-heading > span { display: flex; align-items: center; gap: 7px; font-size: 0.72rem; font-weight: 600; }
.algorithm-heading > span svg { color: var(--accent-primary); }
.algorithm-heading > small { color: var(--text-muted); font-size: 0.6rem; white-space: nowrap; }
.algorithm-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 16px; margin-top: 11px; }
.algorithm-list li { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; padding: 5px 0; color: var(--text-muted); font-size: 0.64rem; }
.algorithm-list li.selected { color: var(--text-secondary); }
.algorithm-list li > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.algorithm-list li strong { flex: 0 0 auto; color: var(--text-muted); font-family: var(--font-mono); font-size: 0.68rem; font-weight: 500; }
.algorithm-list li.selected strong { color: var(--accent-primary); }
.algorithm-list li strong small { margin-left: 2px; color: var(--text-muted); font-size: 0.55rem; }
.robot-configurations { margin-top: 12px; padding: 16px; border: 1px solid var(--border-color); border-radius: var(--radius-md); background: rgba(2, 8, 18, 0.14); }
.configuration-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.configuration-heading h3 { font-size: 0.75rem; font-weight: 600; }
.configuration-heading p { margin-top: 5px; color: var(--text-muted); font-size: 0.61rem; }
.configuration-heading > span { color: var(--text-muted); font-size: 0.61rem; white-space: nowrap; }
.configuration-empty { display: flex; align-items: center; flex-direction: column; margin-top: 14px; padding: 24px 14px; border: 1px dashed var(--border-color); border-radius: var(--radius-md); color: var(--text-muted); text-align: center; }
.configuration-empty > svg { color: var(--accent-primary); opacity: 0.7; }
.configuration-empty strong { margin-top: 10px; color: var(--text-secondary); font-size: 0.72rem; font-weight: 550; }
.configuration-empty p { margin-top: 6px; font-size: 0.64rem; }
.configuration-empty a { margin-top: 11px; color: var(--accent-primary); font-size: 0.66rem; text-decoration: none; }
.configuration-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(270px, 100%), 1fr)); gap: 10px; margin-top: 14px; }
.configuration-card { min-width: 0; padding: 13px; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-soft); }
.configuration-card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 9px; }
.configuration-card-header > div { min-width: 0; }
.configuration-card-header strong { display: block; overflow: hidden; font-size: 0.72rem; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.configuration-card-header small { display: block; margin-top: 4px; overflow: hidden; color: var(--text-muted); font-family: var(--font-mono); font-size: 0.56rem; text-overflow: ellipsis; white-space: nowrap; }
.configuration-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 11px; }
.configuration-tags span { padding: 3px 6px; border: 1px solid rgba(34, 211, 238, 0.12); border-radius: 4px; color: var(--accent-primary); background: rgba(34, 211, 238, 0.045); font-size: 0.55rem; }
.configuration-details { margin-top: 10px; }
.configuration-details > div { display: grid; grid-template-columns: 58px minmax(0, 1fr); gap: 8px; padding: 5px 0; font-size: 0.59rem; }
.configuration-details dt { color: var(--text-muted); }
.configuration-details dd { overflow-wrap: anywhere; color: var(--text-secondary); font-family: var(--font-mono); line-height: 1.5; text-align: right; }
.custom-config-warning { margin-top: 8px; color: var(--warning); font-size: 0.58rem; line-height: 1.5; }
.configuration-error { margin-top: 11px; padding: 9px 11px; border: 1px solid rgba(251, 191, 36, 0.18); border-radius: 7px; color: var(--warning); background: rgba(251, 191, 36, 0.04); font-size: 0.63rem; line-height: 1.6; }
.access-note { display: flex; align-items: flex-start; gap: 7px; margin-top: 13px; color: var(--text-muted); font-size: 0.61rem; line-height: 1.65; }
.note-dot { width: 5px; height: 5px; flex: 0 0 auto; margin-top: 5px; border-radius: 50%; background: var(--warning); }
@media (max-width: 1100px) {
  .access-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 720px) {
  .access-overview { padding: 17px; }
  .access-header { flex-direction: column; gap: 13px; }
  .access-actions { padding-top: 0; }
  .algorithm-grid { grid-template-columns: 1fr; }
}
@media (max-width: 480px) {
  .access-metrics { grid-template-columns: 1fr; }
  .access-metric { min-height: 92px; }
  .access-actions { width: 100%; }
  .access-button { flex: 1; }
  .algorithm-list { grid-template-columns: 1fr; }
  .configuration-heading { align-items: flex-start; }
  .access-title-row { align-items: flex-start; }
}
</style>
