<template>
  <section class="access-overview" aria-labelledby="access-overview-title">
    <header class="access-header">
      <div class="access-heading">
        <span class="access-kicker"><UiIcon name="link" :size="15" />接入与部署自检</span>
        <div class="access-title-row">
          <h2 id="access-overview-title">当前接入概览</h2>
          <span class="config-state" :class="overallStatus.tone">{{ overallStatus.label }}</span>
        </div>
        <p>实时汇总本机保存的机器狗、通信协议、算法方案与 ROS 路径诊断状态。</p>
      </div>
      <div class="access-actions">
        <button type="button" class="access-button" @click="expanded = !expanded">
          <UiIcon name="layers" :size="15" />
          {{ expanded ? '收起明细' : '展开明细' }}
        </button>
        <RouterLink class="access-button primary" to="/robots">
          <UiIcon name="robot" :size="15" />管理机器狗
        </RouterLink>
        <RouterLink class="access-button" to="/settings">
          <UiIcon name="sliders" :size="15" />系统配置
        </RouterLink>
      </div>
    </header>

    <div class="access-metrics" aria-label="接入配置关键指标">
      <article class="access-metric">
        <span class="metric-icon"><UiIcon name="robot" :size="19" /></span>
        <div>
          <span>机器狗配置</span>
          <strong>{{ robotConfigs.length }}<small>台</small></strong>
          <p>{{ configuredRobotCount }} 台已填写完整连接地址</p>
        </div>
      </article>
      <article class="access-metric">
        <span class="metric-icon"><UiIcon name="layers" :size="19" /></span>
        <div>
          <span>雷达方案</span>
          <strong class="metric-text">2D {{ lidarCounts['2d'] || 0 }} · 3D {{ lidarCounts['3d'] || 0 }}</strong>
          <p>按各台设备的激光雷达配置统计</p>
        </div>
      </article>
      <article class="access-metric">
        <span class="metric-icon"><UiIcon name="link" :size="19" /></span>
        <div>
          <span>通信协议</span>
          <strong class="metric-text">{{ transportSummary }}</strong>
          <p>支持 Foxglove 与 ROS Bridge</p>
        </div>
      </article>
      <article class="access-metric">
        <span class="metric-icon"><UiIcon name="activity" :size="19" /></span>
        <div>
          <span>ROS 话题 & 环境</span>
          <strong class="metric-status" :class="topicStatusClass">{{ topicStatus }}</strong>
          <p>{{ topicDetail }}</p>
        </div>
      </article>
    </div>

    <template v-if="expanded">
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
            <p>逐台核对连接状态、传感器、算法与通信配置</p>
          </div>
          <span>{{ robotConfigs.length }} 条记录</span>
        </div>

        <ul class="configuration-list">
          <li v-for="robot in robotConfigs" :key="robot.key" class="configuration-card">
            <div class="configuration-card-header">
              <div>
                <strong>{{ robot.name }}</strong>
                <small>{{ robot.id }}</small>
              </div>
              <span class="config-state" :class="robot.statusTone">
                {{ robot.statusLabel }}
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
    </template>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue'
import UiIcon from '../../components/UiIcon.vue'
import { useRobotStore } from '../../stores/robotStore.js'
import { useRuntimeConfigStore } from '../../stores/runtimeConfigStore.js'
import { useRosSessionStore } from '../../stores/rosSessionStore.js'

const expanded = ref(false)
const { robots, activeRobotId } = useRobotStore()
const { runtimeTopics, diagnostics, loading: runtimeLoading, loadError: runtimeError } = useRuntimeConfigStore()
const { isConnected } = useRosSessionStore()

const slamOptions = [
  { key: 'slam_toolbox', label: 'SLAM Toolbox' },
  { key: 'cartographer', label: 'Cartographer' },
  { key: 'fast_lio', label: 'FAST-LIO' },
  { key: 'fast_lio_localization', label: 'FAST-LIO Localization' },
  { key: 'custom', label: '自定义' }
]
const localizationOptions = [
  { key: 'amcl', label: 'AMCL' },
  { key: 'fast_lio_localization', label: 'FAST-LIO Localization' },
  { key: 'none', label: '无定位' },
  { key: 'custom', label: '自定义' }
]

const robotConfigs = computed(() => robots.value.map((robot, index) => {
  const lidar = robot.lidarType === '3d' ? '3d' : '2d'
  const slam = slamOptions.some((o) => o.key === robot.slamAlgorithm) ? robot.slamAlgorithm : 'slam_toolbox'
  const localization = localizationOptions.some((o) => o.key === robot.localizationAlgorithm) ? robot.localizationAlgorithm : 'amcl'
  const transport = robot.transport === 'rosbridge' ? 'rosbridge' : 'foxglove'
  const algorithmPackage = (robot.algorithmPackage || '').trim()
  const algorithmLaunch = (robot.algorithmLaunch || '').trim()
  const customConfigMissing = (slam === 'custom' || localization === 'custom') && (!algorithmPackage || !algorithmLaunch)
  const url = (robot.url || '').trim()
  const isOnline = robot.id === activeRobotId.value && isConnected.value

  let statusLabel = '待完善'
  let statusTone = 'pending'
  if (isOnline) {
    statusLabel = '在线运行'
    statusTone = 'online'
  } else if (url && !customConfigMissing) {
    statusLabel = '已配置离线'
    statusTone = 'ready'
  }

  return {
    key: robot.id || `robot-${index}`,
    id: robot.id || `robot-${index}`,
    name: robot.name || `机器人 ${index + 1}`,
    url,
    namespace: (robot.namespace || '').trim(),
    lidar,
    lidarLabel: `${lidar.toUpperCase()} 激光`,
    transport,
    transportLabel: transport === 'rosbridge' ? 'ROS Bridge' : 'Foxglove',
    slam,
    slamLabel: slamOptions.find((o) => o.key === slam)?.label || '自定义',
    localization,
    localizationLabel: localizationOptions.find((o) => o.key === localization)?.label || '自定义',
    algorithmPackage,
    algorithmLaunch,
    customConfigMissing,
    statusLabel,
    statusTone
  }
}))

const overallStatus = computed(() => {
  if (isConnected.value) return { label: '在线运行', tone: 'online' }
  if (configuredRobotCount.value > 0) return { label: '已配置待连接', tone: 'ready' }
  return { label: '待配置', tone: 'pending' }
})

const configuredRobotCount = computed(() => robotConfigs.value.filter((robot) => robot.url).length)
const lidarCounts = computed(() => countBy(robotConfigs.value, 'lidar'))

const transportSummary = computed(() => {
  if (!robotConfigs.value.length) return '未配置'
  const counts = countBy(robotConfigs.value, 'transport')
  const labels = { foxglove: 'Foxglove', rosbridge: 'ROS Bridge' }
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${labels[key] || key} ${count}`)
    .join(' · ')
})

const algorithmGroups = computed(() => [
  buildAlgorithmGroup('建图算法', 'slam', slamOptions, 'map'),
  buildAlgorithmGroup('定位方式', 'localization', localizationOptions, 'compass')
])

const topicCount = computed(() => Object.entries(runtimeTopics.value || {})
  .filter(([name, value]) => name.trim() && typeof value === 'string' && value.trim()).length)

const topicStatus = computed(() => {
  if (runtimeLoading.value) return '读取中'
  return topicCount.value > 0 ? '已配置' : '未配置'
})

const topicStatusClass = computed(() => ({
  configured: topicStatus.value === '已配置',
  unconfigured: topicStatus.value === '未配置',
  pending: topicStatus.value === '读取中'
}))

const topicDetail = computed(() => {
  if (runtimeLoading.value) return '正在读取运行时配置'
  if (runtimeError.value) return '无法连接后端读取配置'
  const wsReady = diagnostics.value.workspaceExists ? '工作空间就绪' : '工作空间待检查'
  return `${topicCount.value} 个话题 · ${wsReady}`
})

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
</script>

<style scoped>
.access-overview {
  position: relative;
  margin-top: 20px;
  padding: 20px;
  overflow: hidden;
  border: 1px solid rgba(34, 211, 238, 0.22);
  border-radius: var(--radius-lg);
  background:
    radial-gradient(circle at 100% 0, rgba(34, 211, 238, 0.07), transparent 34%),
    linear-gradient(145deg, var(--bg-card), var(--bg-secondary));
  box-shadow: var(--shadow-card);
}
.access-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
.access-heading { min-width: 0; }
.access-kicker { display: inline-flex; align-items: center; gap: 7px; color: var(--accent-primary); font-size: var(--text-xs); font-weight: 600; letter-spacing: 0.06em; }
.access-title-row { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
.access-title-row h2 { font-size: 1.12rem; font-weight: 650; }
.access-heading > p { margin-top: 6px; color: var(--text-muted); font-size: var(--text-sm); line-height: 1.6; }
.config-state { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; padding: 4px 10px; border: 1px solid var(--border-color); border-radius: 6px; color: var(--text-muted); background: var(--bg-soft); font-size: var(--text-xs); font-weight: 500; white-space: nowrap; }
.config-state.online { border-color: rgba(52, 211, 153, 0.28); color: var(--success); background: rgba(52, 211, 153, 0.09); }
.config-state.ready { border-color: rgba(34, 211, 238, 0.28); color: var(--accent-primary); background: rgba(34, 211, 238, 0.08); }
.config-state.pending { border-color: rgba(251, 191, 36, 0.24); color: var(--warning); background: rgba(251, 191, 36, 0.08); }
.access-actions { display: flex; flex-wrap: wrap; flex: 0 0 auto; gap: 8px; padding-top: 4px; }
.access-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 36px; padding: 0 13px; border: 1px solid var(--border-color); border-radius: 8px; color: var(--text-secondary); background: var(--bg-soft); font-size: var(--text-xs); text-decoration: none; cursor: pointer; transition: var(--transition); }
.access-button:hover { border-color: rgba(34, 211, 238, 0.45); color: var(--accent-primary); }
.access-button.primary { border-color: rgba(34, 211, 238, 0.35); color: var(--accent-primary); background: rgba(34, 211, 238, 0.09); }
.access-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 11px; margin-top: 18px; }
.access-metric { display: flex; align-items: center; gap: 12px; min-width: 0; min-height: 98px; padding: 14px; border: 1px solid var(--border-color); border-radius: var(--radius-md); background: rgba(2, 8, 18, 0.2); }
.metric-icon { display: grid; place-items: center; width: 38px; height: 38px; flex: 0 0 auto; border-radius: 9px; color: var(--accent-primary); background: rgba(34, 211, 238, 0.08); }
.access-metric > div { min-width: 0; }
.access-metric div > span { display: block; color: var(--text-muted); font-size: var(--text-xs); }
.access-metric strong { display: block; margin-top: 6px; font-family: var(--font-mono); font-size: 1.4rem; font-weight: 600; line-height: 1.2; }
.access-metric strong small { margin-left: 5px; color: var(--text-secondary); font-size: var(--text-xs); font-weight: 400; }
.access-metric strong.metric-text { overflow: hidden; font-size: 0.92rem; line-height: 1.4; text-overflow: ellipsis; white-space: nowrap; }
.access-metric strong.metric-status { font-family: inherit; font-size: 1rem; }
.metric-status.configured { color: var(--success); }
.metric-status.unconfigured { color: var(--text-muted); }
.metric-status.pending { color: var(--warning); }
.access-metric p { margin-top: 6px; overflow: hidden; color: var(--text-muted); font-size: var(--text-xs); line-height: 1.45; text-overflow: ellipsis; white-space: nowrap; }
.algorithm-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 14px; }
.algorithm-panel { min-width: 0; padding: 15px; border: 1px solid var(--border-color); border-radius: var(--radius-md); background: rgba(2, 8, 18, 0.14); }
.algorithm-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding-bottom: 10px; border-bottom: 1px solid var(--border-color); }
.algorithm-heading > span { display: flex; align-items: center; gap: 7px; font-size: var(--text-sm); font-weight: 600; }
.algorithm-heading > span svg { color: var(--accent-primary); }
.algorithm-heading > small { color: var(--text-muted); font-size: var(--text-xs); }
.algorithm-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 16px; margin-top: 11px; list-style: none; }
.algorithm-list li { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; padding: 5px 0; color: var(--text-muted); font-size: var(--text-xs); }
.algorithm-list li.selected { color: var(--text-secondary); }
.algorithm-list li > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.algorithm-list li strong { flex: 0 0 auto; color: var(--text-muted); font-family: var(--font-mono); font-size: var(--text-sm); font-weight: 600; }
.algorithm-list li.selected strong { color: var(--accent-primary); }
.algorithm-list li strong small { margin-left: 2px; color: var(--text-muted); font-size: 0.7rem; }
.robot-configurations { margin-top: 12px; padding: 16px; border: 1px solid var(--border-color); border-radius: var(--radius-md); background: rgba(2, 8, 18, 0.14); }
.configuration-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.configuration-heading h3 { font-size: var(--text-base); font-weight: 600; }
.configuration-heading p { margin-top: 4px; color: var(--text-muted); font-size: var(--text-xs); }
.configuration-heading > span { color: var(--text-muted); font-size: var(--text-xs); }
.configuration-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(270px, 100%), 1fr)); gap: 10px; margin-top: 14px; list-style: none; }
.configuration-card { min-width: 0; padding: 14px; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-soft); }
.configuration-card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 9px; }
.configuration-card-header > div { min-width: 0; }
.configuration-card-header strong { display: block; overflow: hidden; font-size: var(--text-base); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.configuration-card-header small { display: block; margin-top: 4px; overflow: hidden; color: var(--text-muted); font-family: var(--font-mono); font-size: var(--text-xs); text-overflow: ellipsis; white-space: nowrap; }
.configuration-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 11px; }
.configuration-tags span { padding: 3px 7px; border: 1px solid rgba(34, 211, 238, 0.16); border-radius: 5px; color: var(--accent-primary); background: rgba(34, 211, 238, 0.05); font-size: var(--text-xs); }
.configuration-details { margin-top: 10px; }
.configuration-details > div { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 8px; padding: 5px 0; font-size: var(--text-xs); }
.configuration-details dt { color: var(--text-muted); }
.configuration-details dd { overflow-wrap: anywhere; color: var(--text-secondary); font-family: var(--font-mono); text-align: right; }
.custom-config-warning { margin-top: 8px; color: var(--warning); font-size: var(--text-xs); }
@media (max-width: 1100px) {
  .access-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 720px) {
  .access-overview { padding: 16px; }
  .access-header { flex-direction: column; }
  .algorithm-grid { grid-template-columns: 1fr; }
}
@media (max-width: 480px) {
  .access-metrics, .algorithm-list { grid-template-columns: 1fr; }
}
</style>
