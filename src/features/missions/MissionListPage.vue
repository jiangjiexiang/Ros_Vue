<template>
  <main class="mission-page mission-list-page">
    <header class="mission-header">
      <div class="mission-heading">
        <span class="mission-eyebrow">INSPECTION MISSIONS</span>
        <h1>巡检任务</h1>
        <p>编排机器狗巡检点、采集动作与循环策略，并查看任务执行状态。</p>
      </div>
      <div class="mission-header-actions">
        <button class="mission-button primary" @click="openCreate">
          <span aria-hidden="true">＋</span>新建任务
        </button>
      </div>
    </header>

    <div v-if="storageError" class="mission-alert error">{{ storageError }}</div>
    <div v-if="notice" class="mission-alert success">{{ notice }}</div>
    <div v-if="errorMessage" class="mission-alert error">{{ errorMessage }}</div>

    <section class="summary-grid" aria-label="任务状态概览">
      <button
        v-for="item in summaryItems"
        :key="item.value"
        class="summary-card"
        :class="{ active: statusFilter === item.value }"
        @click="statusFilter = item.value"
      >
        <span>{{ item.label }}</span>
        <strong>{{ item.count }}</strong>
      </button>
    </section>

    <section class="mission-panel filter-panel" aria-label="任务筛选">
      <div class="filter-grid">
        <div class="form-field search-field">
          <label for="mission-search">搜索任务</label>
          <input
            id="mission-search"
            v-model="keyword"
            class="mission-input"
            type="search"
            placeholder="任务名称、巡检点或场景"
          >
        </div>
        <div class="form-field">
          <label for="mission-status-filter">执行状态</label>
          <select id="mission-status-filter" v-model="statusFilter" class="mission-select">
            <option value="all">全部状态</option>
            <option v-for="status in MISSION_STATUSES" :key="status.value" :value="status.value">
              {{ status.label }}
            </option>
          </select>
        </div>
        <div class="form-field">
          <label for="mission-robot-filter">机器狗</label>
          <select id="mission-robot-filter" v-model="robotFilter" class="mission-select">
            <option value="all">全部机器狗</option>
            <option v-for="robot in robotOptions" :key="robot.id" :value="robot.id">{{ robot.name }}</option>
          </select>
        </div>
        <button class="mission-button reset-button" :disabled="!hasFilters" @click="clearFilters">清除筛选</button>
      </div>
    </section>

    <section class="mission-panel">
      <div class="panel-heading">
        <h2>任务列表</h2>
        <span>显示 {{ filteredMissions.length }} / {{ missions.length }} 项</span>
      </div>

      <div v-if="filteredMissions.length" class="mission-table-wrap">
        <table class="mission-table">
          <thead>
            <tr>
              <th>任务</th>
              <th>机器狗 / 场景</th>
              <th>巡检配置</th>
              <th>状态</th>
              <th>更新时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="mission in filteredMissions" :key="mission.id">
              <td class="task-cell">
                <div class="task-title">
                  <strong>{{ mission.name }}</strong>
                </div>
                <p>{{ mission.description || '暂无任务说明' }}</p>
                <div class="action-tags">
                  <span v-for="action in uniqueActions(mission)" :key="action" class="mission-tag action">
                    {{ action }}
                  </span>
                </div>
              </td>
              <td>
                <strong class="cell-primary">{{ mission.robotName || '未选择机器狗' }}</strong>
                <span class="cell-secondary">{{ mission.map?.name || '未选择场景' }}</span>
              </td>
              <td>
                <strong class="cell-primary">{{ mission.waypoints.length }} 个巡检点 · {{ mission.loopCount }} 轮</strong>
                <span class="cell-secondary">默认停留 {{ mission.dwellSeconds }} 秒</span>
                <span class="cell-secondary">异常：{{ getFailureLabel(mission.onFailure) }}</span>
              </td>
              <td>
                <MissionStatusBadge :status="mission.status" />
                <div v-if="mission.status !== 'pending'" class="list-progress">
                  <div class="progress-track"><i :style="{ width: `${progressFor(mission).percent}%` }"></i></div>
                  <span>{{ progressFor(mission).completed }}/{{ progressFor(mission).total }} 点次</span>
                </div>
              </td>
              <td class="date-cell">{{ formatDate(mission.updatedAt) }}</td>
              <td>
                <div class="row-actions">
                  <button class="mission-button small primary" @click="openRun(mission)">
                    {{ mission.status === 'pending' ? '执行' : '查看' }}
                  </button>
                  <button
                    class="mission-button small"
                    :disabled="isActiveMission(mission)"
                    :title="isActiveMission(mission) ? '请先终止任务' : '编辑任务'"
                    @click="openEdit(mission)"
                  >编辑</button>
                  <button class="mission-button small" @click="copyMission(mission)">复制</button>
                  <button
                    class="mission-button small danger"
                    :disabled="isActiveMission(mission)"
                    :title="isActiveMission(mission) ? '请先终止任务' : '删除任务'"
                    @click="removeMission(mission)"
                  >删除</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-else class="empty-state">
        <strong>{{ missions.length ? '没有符合筛选条件的任务' : '还没有巡检任务' }}</strong>
        <p>{{ missions.length ? '可调整关键词、状态或机器狗筛选条件。' : '新建任务后，可添加巡检点并配置采集动作。' }}</p>
        <button v-if="missions.length" class="mission-button" @click="clearFilters">清除筛选</button>
        <button v-else class="mission-button primary" @click="openCreate">新建任务</button>
      </div>
    </section>
  </main>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRobotStore } from '../../stores/robotStore.js'
import { confirmDialog, showToast } from '../../stores/toastStore.js'
import {
  MISSION_STATUSES,
  getActionLabel,
  getFailureLabel,
  getMissionProgress,
  isActiveMission
} from './missionModel.js'
import { useMissionStore } from './missionStore.js'
import { MISSION_PATHS, useMissionNavigation } from './useMissionNavigation.js'
import MissionStatusBadge from './MissionStatusBadge.vue'

const emit = defineEmits(['navigate'])
const { navigate } = useMissionNavigation({}, emit)
const { robots: configuredRobots } = useRobotStore()
const { missions, storageError, initMissionsFromServer, duplicateMission, deleteMission } = useMissionStore()
const keyword = ref('')
const statusFilter = ref('all')
const robotFilter = ref('all')
const notice = ref('')
const errorMessage = ref('')

const robotOptions = computed(() => {
  const robots = new Map(configuredRobots.value.map((robot) => [robot.id, { id: robot.id, name: robot.name }]))
  missions.value.forEach((mission) => {
    if (mission.robotId && !robots.has(mission.robotId)) {
      robots.set(mission.robotId, { id: mission.robotId, name: mission.robotName || mission.robotId })
    }
  })
  return [...robots.values()]
})

const filteredMissions = computed(() => {
  const query = keyword.value.trim().toLowerCase()
  return missions.value
    .filter((mission) => statusFilter.value === 'all' || mission.status === statusFilter.value)
    .filter((mission) => robotFilter.value === 'all' || mission.robotId === robotFilter.value)
    .filter((mission) => {
      if (!query) return true
      const searchable = [
        mission.name,
        mission.description,
        mission.robotName,
        mission.map?.name,
        ...mission.waypoints.map((point) => point.name)
      ].join(' ').toLowerCase()
      return searchable.includes(query)
    })
    .slice()
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
})

const hasFilters = computed(() => keyword.value || statusFilter.value !== 'all' || robotFilter.value !== 'all')
const summaryItems = computed(() => [
  { value: 'all', label: '全部任务', count: missions.value.length },
  ...MISSION_STATUSES.map((status) => ({
    ...status,
    count: missions.value.filter((mission) => mission.status === status.value).length
  }))
])

function clearFilters() {
  keyword.value = ''
  statusFilter.value = 'all'
  robotFilter.value = 'all'
}

function openCreate() {
  navigate(MISSION_PATHS.create)
}

function openEdit(mission) {
  if (isActiveMission(mission)) return
  navigate(MISSION_PATHS.edit(mission.id), mission.id)
}

function openRun(mission) {
  navigate(MISSION_PATHS.run(mission.id), mission.id)
}

async function copyMission(mission) {
  notice.value = ''
  errorMessage.value = ''
  try {
    const copy = await duplicateMission(mission.id)
    notice.value = `已创建“${copy.name}”，可在列表中继续编辑。`
  } catch (error) {
    errorMessage.value = error.message
  }
}

async function removeMission(mission) {
  if (isActiveMission(mission)) return
  const confirmed = await confirmDialog({
    title: '删除巡检任务',
    message: `确定删除任务“${mission.name}”吗？此操作不可恢复。`,
    confirmText: '确认删除',
    danger: true
  })
  if (!confirmed) return
  notice.value = ''
  errorMessage.value = ''
  try {
    await deleteMission(mission.id)
    showToast(`已删除任务“${mission.name}”`, 'info')
  } catch (error) {
    errorMessage.value = error.message
  }
}

onMounted(() => {
  initMissionsFromServer()
})

function uniqueActions(mission) {
  return [...new Set(mission.waypoints.flatMap((point) => point.actions))].map(getActionLabel)
}

function progressFor(mission) {
  return getMissionProgress(mission)
}

function formatDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  })
}
</script>

<style scoped src="./missionShared.css"></style>
<style scoped>
.summary-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 9px; }
.summary-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 58px;
  padding: 11px 13px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  background: var(--bg-card);
  cursor: pointer;
}
.summary-card:hover, .summary-card.active { border-color: rgba(34, 211, 238, 0.28); background: rgba(34, 211, 238, 0.045); }
.summary-card span { font-size: 0.68rem; }
.summary-card strong { color: var(--text-primary); font-family: var(--font-mono); font-size: 1.05rem; font-weight: 600; }
.filter-panel { padding: 13px; }
.filter-grid { display: grid; grid-template-columns: minmax(220px, 1.6fr) minmax(140px, 0.7fr) minmax(160px, 0.8fr) auto; align-items: end; gap: 11px; }
.reset-button { margin-bottom: 0; }
.mission-table-wrap { overflow-x: auto; }
.mission-table { width: 100%; min-width: 1100px; border-collapse: collapse; table-layout: fixed; }
.mission-table th { padding: 11px 13px; border-bottom: 1px solid var(--border-color); color: var(--text-muted); background: rgba(2, 8, 18, 0.18); font-size: 0.63rem; font-weight: 500; text-align: left; }
.mission-table th:nth-child(1) { width: 25%; }
.mission-table th:nth-child(2) { width: 16%; }
.mission-table th:nth-child(3) { width: 16%; }
.mission-table th:nth-child(4) { width: 12%; }
.mission-table th:nth-child(5) { width: 10%; }
.mission-table th:nth-child(6) { width: 21%; }
.mission-table td { padding: 14px 13px; border-bottom: 1px solid var(--border-color); color: var(--text-secondary); font-size: 0.69rem; vertical-align: top; }
.mission-table tr:last-child td { border-bottom: 0; }
.mission-table tbody tr:hover { background: rgba(148, 163, 184, 0.025); }
.task-title { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
.task-title strong { color: var(--text-primary); font-size: 0.77rem; font-weight: 600; line-height: 1.5; }
.task-cell p { display: -webkit-box; margin-top: 6px; overflow: hidden; color: var(--text-muted); font-size: 0.64rem; line-height: 1.55; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.action-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
.cell-primary { display: block; color: var(--text-secondary); font-size: 0.69rem; font-weight: 500; line-height: 1.55; }
.cell-secondary { display: block; margin-top: 5px; color: var(--text-muted); font-size: 0.63rem; line-height: 1.5; }
.date-cell { font-family: var(--font-mono); font-size: 0.64rem !important; line-height: 1.6; }
.row-actions { display: flex; flex-wrap: wrap; gap: 5px; }
.list-progress { margin-top: 9px; }
.progress-track { width: 92px; height: 4px; overflow: hidden; border-radius: 4px; background: var(--bg-elevated); }
.progress-track i { display: block; height: 100%; border-radius: inherit; background: var(--accent-primary); transition: width 200ms ease; }
.list-progress span { display: block; margin-top: 5px; color: var(--text-muted); font-family: var(--font-mono); font-size: 0.58rem; }
@media (max-width: 1100px) {
  .summary-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .filter-grid { grid-template-columns: 1fr 1fr 1fr; }
  .search-field { grid-column: 1 / -1; }
}
@media (max-width: 720px) {
  .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .filter-grid { grid-template-columns: 1fr; }
  .search-field { grid-column: auto; }
  .reset-button { width: 100%; }
}
</style>
