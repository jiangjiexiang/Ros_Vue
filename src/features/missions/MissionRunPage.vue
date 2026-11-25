<template>
  <main class="mission-page mission-run-page">
    <header class="mission-header">
      <div class="mission-heading">
        <span class="mission-eyebrow">MISSION EXECUTION</span>
        <h1>{{ mission?.name || '任务执行' }}</h1>
        <p>通过真实 ROS 导航下发巡检目标，实时查看相机画面、点位进度与状态日志。</p>
      </div>
      <div class="mission-header-actions">
        <button class="mission-button" @click="goBack">← 返回列表</button>
        <button v-if="mission" class="mission-button" :disabled="isActive" @click="openEdit">编辑配置</button>
        <button
          v-if="mission && ['completed', 'aborted'].includes(mission.status)"
          class="mission-button primary"
          @click="openRecords"
        >
          查看巡检记录 →
        </button>
      </div>
    </header>

    <div v-if="storageError" class="mission-alert error">{{ storageError }}</div>
    <div v-if="errorMessage" class="mission-alert error">{{ errorMessage }}</div>

    <section v-if="!mission" class="mission-panel empty-state">
      <strong>未找到该巡检任务</strong>
      <p>任务可能已被删除，或当前链接缺少任务 ID。</p>
      <button class="mission-button primary" @click="goBack">返回任务列表</button>
    </section>

    <template v-else>
      <section class="run-summary">
        <article class="summary-item">
          <span>执行状态</span>
          <MissionStatusBadge :status="mission.status" />
        </article>
        <article class="summary-item">
          <span>执行机器狗</span>
          <strong>{{ mission.robotName || '未配置' }}</strong>
          <small>{{ isConnected ? 'ROS 在线 · 可下发导航' : 'ROS 离线' }}</small>
        </article>
        <article class="summary-item">
          <span>地图场景</span>
          <strong>{{ mission.map?.name || '未配置' }}</strong>
          <small>目标容差 {{ mission.navigation.goalTolerance }} m</small>
        </article>
        <article class="summary-item">
          <span>巡检进度</span>
          <strong class="mono">{{ progress.percent }}%</strong>
          <small>{{ progress.completed }} / {{ progress.total }} 点次</small>
        </article>
      </section>

      <div class="run-layout">
        <section class="mission-panel">
          <div class="panel-heading">
            <h2>巡检点执行顺序</h2>
            <span>第 {{ displayCycle }} / {{ mission.loopCount }} 轮</span>
          </div>
          <div class="point-timeline">
            <article
              v-for="(waypoint, index) in mission.waypoints"
              :key="waypoint.id"
              class="run-point"
              :class="{ current: isCurrentPoint(index), done: isPointDone(index) }"
            >
              <div class="timeline-marker">
                <span>{{ isPointDone(index) ? '✓' : index + 1 }}</span>
                <i v-if="index < mission.waypoints.length - 1"></i>
              </div>
              <div class="run-point-content">
                <div class="run-point-heading">
                  <div>
                    <strong>{{ waypoint.name }}</strong>
                    <span class="point-pose mono">X {{ formatNumber(waypoint.pose.x) }} · Y {{ formatNumber(waypoint.pose.y) }} · Yaw {{ formatNumber(waypoint.pose.yaw) }}</span>
                  </div>
                  <span class="point-state">{{ pointState(index) }}</span>
                </div>
                <div class="run-point-actions">
                  <span v-for="action in waypoint.actions" :key="action" class="mission-tag action">{{ getActionLabel(action) }}</span>
                </div>
                <div class="run-point-meta">
                  <span>停留 {{ waypoint.dwellSeconds }} 秒</span>
                  <span v-if="waypoint.note">{{ waypoint.note }}</span>
                </div>
                <div v-if="isCurrentPoint(index) && mission.status === 'running'" class="point-phase">
                  <span>{{ phaseText }}</span>
                  <span v-if="mission.run.phase === 'inspecting'" class="mono">
                    {{ Math.min(mission.run.elapsedSeconds, waypoint.dwellSeconds) }} / {{ waypoint.dwellSeconds }} s
                  </span>
                  <span v-else-if="remainingDistance !== null" class="mono">
                    剩余 {{ remainingDistance.toFixed(2) }} m
                  </span>
                </div>
              </div>
            </article>
            <div v-if="!mission.waypoints.length" class="empty-state">
              <strong>任务尚未配置巡检点</strong>
              <p>返回编辑页面添加巡检点后，才能开始任务。</p>
              <button class="mission-button primary" @click="openEdit">编辑任务</button>
            </div>
          </div>
        </section>

        <aside class="run-sidebar">
          <CameraPanel
            title="机载实时画面"
            :message="cameraPrimary"
            :connected="isConnected"
            :topic="cameraPrimary?.topic || robotTopics.camera_primary"
          />

          <section class="mission-panel">
            <div class="panel-heading">
              <h2>执行控制</h2>
              <span class="mono">{{ isConnected ? `${linearSpeed} m/s` : '离线' }}</span>
            </div>
            <div class="panel-body run-controls">
              <div class="overall-progress">
                <div><strong>{{ progress.percent }}%</strong><span>{{ progress.completed }} / {{ progress.total }} 点次</span></div>
                <div class="progress-track" role="progressbar" :aria-valuenow="progress.percent" aria-valuemin="0" aria-valuemax="100">
                  <i :style="{ width: `${progress.percent}%` }"></i>
                </div>
              </div>

              <div class="current-stage">
                <span>当前阶段</span>
                <strong>{{ phaseText }}</strong>
                <small v-if="currentWaypoint">{{ currentWaypoint.name }}</small>
              </div>

              <div class="control-buttons">
                <button v-if="mission.status === 'pending'" class="mission-button primary" :disabled="!mission.waypoints.length" @click="startExecution">
                  <UiIcon name="play" :size="14" />开始任务
                </button>
                <button v-else-if="mission.status === 'running'" class="mission-button warning" @click="pauseExecution">暂停</button>
                <button v-else-if="mission.status === 'paused'" class="mission-button primary" @click="startExecution">
                  <UiIcon name="play" :size="14" />继续执行
                </button>
                <button v-else class="mission-button primary" @click="startExecution">
                  <UiIcon name="play" :size="14" />重新执行
                </button>

                <button
                  v-if="mission.status === 'running' && mission.run.phase === 'navigating'"
                  class="mission-button"
                  @click="confirmArrived"
                >
                  <UiIcon name="check" :size="14" />手动确认到达
                </button>

                <button v-if="isActive" class="mission-button danger" @click="abortExecution">
                  <UiIcon name="stop" :size="14" />终止任务
                </button>
              </div>
              <p class="control-note">
                自动发送 /goal_pose，到达容差 {{ mission.navigation.goalTolerance }} m 内或手动确认后进入点位动作。
              </p>
            </div>
          </section>

          <section class="mission-panel">
            <div class="panel-heading"><h2>任务参数</h2></div>
            <dl class="run-parameters">
              <div><dt>循环次数</dt><dd>{{ mission.loopCount }} 轮</dd></div>
              <div><dt>异常处理</dt><dd>{{ getFailureLabel(mission.onFailure) }}</dd></div>
              <div v-if="mission.onFailure === 'retry'"><dt>重试次数</dt><dd>{{ mission.retryLimit }} 次</dd></div>
              <div><dt>默认停留</dt><dd>{{ mission.dwellSeconds }} 秒</dd></div>
              <div><dt>速度上限</dt><dd>{{ mission.navigation.maxLinearSpeed }} m/s · {{ mission.navigation.maxAngularSpeed }} rad/s</dd></div>
              <div><dt>目标容差</dt><dd>{{ mission.navigation.goalTolerance }} m</dd></div>
              <div><dt>单点导航超时</dt><dd>{{ mission.navigation.navigationTimeoutSeconds }} 秒</dd></div>
              <div><dt>开始时间</dt><dd>{{ formatDate(mission.run.startedAt) }}</dd></div>
              <div><dt>结束时间</dt><dd>{{ formatDate(mission.run.completedAt || mission.run.abortedAt) }}</dd></div>
            </dl>
          </section>
        </aside>
      </div>

      <section class="mission-panel">
        <div class="panel-heading">
          <h2>状态日志</h2>
          <span>任务执行事件</span>
        </div>
        <div v-if="orderedLogs.length" class="run-log">
          <div v-for="entry in orderedLogs" :key="entry.id" class="log-entry" :class="entry.type">
            <time class="mono">{{ formatLogTime(entry.time) }}</time>
            <i aria-hidden="true"></i>
            <span>{{ entry.message }}</span>
          </div>
        </div>
        <div v-else class="empty-state log-empty">
          <p>开始任务后，这里会显示下发目标点、到点动作、暂停和归档记录。</p>
        </div>
      </section>
    </template>
  </main>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import CameraPanel from '../../components/CameraPanel.vue'
import UiIcon from '../../components/UiIcon.vue'
import { useRosSessionStore } from '../../stores/rosSessionStore.js'
import { useInspectionStore } from '../../stores/inspectionStore.js'
import { confirmDialog, showToast } from '../../stores/toastStore.js'
import {
  getActionLabel,
  getFailureLabel,
  getMissionProgress
} from './missionModel.js'
import { useMissionStore } from './missionStore.js'
import { MISSION_PATHS, useMissionNavigation } from './useMissionNavigation.js'
import MissionStatusBadge from './MissionStatusBadge.vue'

const props = defineProps({
  missionId: { type: String, default: '' },
  id: { type: String, default: '' }
})
const emit = defineEmits(['navigate'])
const router = useRouter()
const { routeMissionId, navigate } = useMissionNavigation(props, emit)
const {
  missions,
  storageError,
  initMissionsFromServer,
  startMission,
  pauseMission,
  abortMission,
  tickMission,
  completeCurrentWaypointNavigation,
  appendRunLog
} = useMissionStore()
const {
  isConnected,
  cameraPrimary,
  robotTopics,
  linearSpeed,
  navFeedback,
  sendGoalPose
} = useRosSessionStore()
const { pushRuntimeAlert } = useInspectionStore()

const errorMessage = ref('')
let timer = null
let lastDispatchedKey = ''

const mission = computed(() => missions.value.find((item) => item.id === routeMissionId.value))
const isActive = computed(() => ['running', 'paused'].includes(mission.value?.status))
const progress = computed(() => mission.value ? getMissionProgress(mission.value) : { completed: 0, total: 0, percent: 0 })
const currentWaypoint = computed(() => mission.value?.waypoints[mission.value.run.currentWaypointIndex] || null)
const remainingDistance = computed(() => {
  const dist = navFeedback.value?.distance_remaining
  return Number.isFinite(dist) ? dist : null
})
const displayCycle = computed(() => {
  if (!mission.value) return 0
  if (mission.value.status === 'pending') return 0
  return Math.max(1, mission.value.run.currentCycle || 1)
})
const orderedLogs = computed(() => (mission.value?.run.logs || []).slice().reverse())
const completedThisCycle = computed(() => {
  if (!mission.value) return 0
  if (mission.value.status === 'completed') return mission.value.waypoints.length
  const count = mission.value.run.completedVisits - (Math.max(1, mission.value.run.currentCycle) - 1) * mission.value.waypoints.length
  return Math.max(0, Math.min(mission.value.waypoints.length, count))
})
const phaseText = computed(() => {
  if (!mission.value) return '未加载任务'
  if (mission.value.status === 'pending') return '等待开始'
  if (mission.value.status === 'completed') return '全部巡检已完成'
  if (mission.value.status === 'aborted') return '任务已终止'
  const prefix = mission.value.status === 'paused' ? '已暂停 · ' : ''
  if (mission.value.run.phase === 'navigating') return `${prefix}正在前往巡检点`
  if (mission.value.run.phase === 'inspecting') return `${prefix}正在执行点位动作`
  return `${prefix}等待状态更新`
})

function dispatchCurrentGoalIfNeeded() {
  if (!isConnected.value) return
  if (!mission.value || mission.value.status !== 'running' || mission.value.run.phase !== 'navigating') return
  const wp = currentWaypoint.value
  if (!wp) return
  const key = `${mission.value.id}:${mission.value.run.currentCycle}:${mission.value.run.currentWaypointIndex}`
  if (lastDispatchedKey === key) return
  lastDispatchedKey = key
  sendGoalPose(wp.pose.x, wp.pose.y, wp.pose.yaw || 0)
  appendRunLog(mission.value, `已下发导航目标“${wp.name}” (${wp.pose.x.toFixed(2)}, ${wp.pose.y.toFixed(2)})。`)
}

async function startExecution() {
  errorMessage.value = ''
  if (!isConnected.value) {
    errorMessage.value = '当前机器狗未连接，无法执行真实 ROS 任务，请先连接机器狗。'
    return
  }
  if (['completed', 'aborted'].includes(mission.value?.status)) {
    const ok = await confirmDialog({
      title: '重新执行任务',
      message: '重新执行将清空当前执行进度和日志，是否继续？',
      confirmText: '重新执行'
    })
    if (!ok) return
  }
  try {
    lastDispatchedKey = ''
    startMission(mission.value.id)
    dispatchCurrentGoalIfNeeded()
  } catch (error) {
    errorMessage.value = error.message
  }
}

function pauseExecution() {
  errorMessage.value = ''
  try {
    pauseMission(mission.value.id)
  } catch (error) {
    errorMessage.value = error.message
  }
}

function confirmArrived() {
  if (!mission.value) return
  completeCurrentWaypointNavigation(mission.value.id, '（操作员手动确认到达）')
}

async function abortExecution() {
  const ok = await confirmDialog({
    title: '终止巡检任务',
    message: `确定终止任务“${mission.value.name}”吗？已完成进度将自动归档至巡检记录。`,
    confirmText: '确认终止',
    danger: true
  })
  if (!ok) return
  errorMessage.value = ''
  try {
    abortMission(mission.value.id)
  } catch (error) {
    errorMessage.value = error.message
  }
}

function isPointDone(index) {
  return index < completedThisCycle.value
}

function isCurrentPoint(index) {
  return Boolean(mission.value)
    && mission.value.status !== 'pending'
    && mission.value.status !== 'completed'
    && index === mission.value.run.currentWaypointIndex
}

function pointState(index) {
  if (isPointDone(index)) return '本轮已完成'
  if (isCurrentPoint(index)) {
    if (mission.value.status === 'aborted') return '已终止'
    if (mission.value.status === 'paused') return '已暂停'
    return mission.value.run.phase === 'navigating' ? '正在前往' : '正在执行动作'
  }
  return '待执行'
}

function formatNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '--'
}

function formatDate(value) {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}

function formatLogTime(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '--:--:--' : date.toLocaleTimeString('zh-CN', { hour12: false })
}

function goBack() {
  navigate(MISSION_PATHS.list)
}

function openEdit() {
  if (!mission.value || isActive.value) return
  navigate(MISSION_PATHS.edit(mission.value.id), mission.value.id)
}

function openRecords() {
  router.push('/records')
}

watch(routeMissionId, () => {
  errorMessage.value = ''
  lastDispatchedKey = ''
})

watch(() => [mission.value?.status, mission.value?.run?.phase, mission.value?.run?.currentWaypointIndex], () => {
  dispatchCurrentGoalIfNeeded()
})

watch(remainingDistance, (dist) => {
  if (dist === null) return
  if (!mission.value || mission.value.status !== 'running' || mission.value.run.phase !== 'navigating') return
  if (mission.value.run.elapsedSeconds < 2) return
  const tolerance = Math.max(0.1, Number(mission.value.navigation?.goalTolerance || 0.25))
  if (dist <= tolerance) {
    completeCurrentWaypointNavigation(mission.value.id, `（距离目标 ${dist.toFixed(2)} m，已到达）`)
  }
})

onMounted(() => {
  initMissionsFromServer()
  timer = window.setInterval(() => {
    if (mission.value?.status === 'running') {
      tickMission(mission.value.id, {
        onTimeout: (m, wp) => {
          pushRuntimeAlert({
            dedupeKey: `nav-timeout-${m.id}-${wp.id}`,
            robotId: m.robotId || 'runtime',
            robotName: m.robotName || '机器狗',
            scene: m.map?.name || '巡检任务',
            level: 'critical',
            title: `巡检点导航超时：${wp.name}`,
            description: `任务“${m.name}”前往“${wp.name}”超过 ${m.navigation.navigationTimeoutSeconds} 秒未到达。`,
            recommendation: '请检查路径障碍物、定位状态及 Nav2 规划器日志。',
            reading: `${m.navigation.navigationTimeoutSeconds}s`,
            threshold: '单点导航超时阈值'
          })
          abortMission(m.id, `前往“${wp.name}”导航超时，任务已自动中止并生成告警。`)
          showToast(`导航超时：已中止任务并生成告警`, 'error')
        }
      })
    }
  }, 1000)
})

onUnmounted(() => {
  if (timer) window.clearInterval(timer)
})
</script>

<style scoped src="./missionShared.css"></style>
<style scoped>
.run-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.summary-item { display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 7px; min-height: 91px; padding: 13px 15px; border: 1px solid var(--border-color); border-radius: var(--radius-md); background: var(--bg-card); }
.summary-item > span { color: var(--text-muted); font-size: var(--text-xs); }
.summary-item > strong { overflow: hidden; max-width: 100%; color: var(--text-primary); font-size: 0.92rem; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.summary-item > small { color: var(--text-muted); font-size: var(--text-xs); }
.run-layout { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(300px, 0.8fr); align-items: start; gap: 16px; }
.run-sidebar { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.point-timeline { padding: 17px; }
.run-point { display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 10px; }
.timeline-marker { display: flex; flex-direction: column; align-items: center; }
.timeline-marker > span { display: grid; place-items: center; width: 26px; height: 26px; flex: 0 0 auto; border: 1px solid var(--border-strong); border-radius: 50%; color: var(--text-muted); background: var(--bg-card); font-family: var(--font-mono); font-size: var(--text-xs); }
.timeline-marker > i { width: 1px; min-height: 25px; flex: 1; margin: 5px 0; background: var(--border-color); }
.run-point.done .timeline-marker > span { border-color: rgba(52, 211, 153, 0.35); color: var(--success); background: rgba(52, 211, 153, 0.07); }
.run-point.current .timeline-marker > span { border-color: rgba(34, 211, 238, 0.45); color: var(--accent-primary); background: rgba(34, 211, 238, 0.08); }
.run-point-content { min-width: 0; margin-bottom: 12px; padding: 12px 13px; border: 1px solid var(--border-color); border-radius: var(--radius-md); background: var(--bg-soft); }
.run-point.current .run-point-content { border-color: rgba(34, 211, 238, 0.3); background: rgba(34, 211, 238, 0.04); }
.run-point.done .run-point-content { border-color: rgba(52, 211, 153, 0.18); }
.run-point-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.run-point-heading strong { display: block; color: var(--text-primary); font-size: var(--text-sm); font-weight: 600; }
.point-pose { display: block; margin-top: 5px; color: var(--text-muted); font-size: var(--text-xs); }
.point-state { flex: 0 0 auto; color: var(--text-muted); font-size: var(--text-xs); }
.run-point.current .point-state { color: var(--accent-primary); }
.run-point.done .point-state { color: var(--success); }
.run-point-actions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 10px; }
.run-point-meta { display: flex; flex-wrap: wrap; gap: 5px 14px; margin-top: 10px; color: var(--text-muted); font-size: var(--text-xs); line-height: 1.55; }
.point-phase { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 10px; padding-top: 9px; border-top: 1px solid rgba(34, 211, 238, 0.14); color: var(--accent-primary); font-size: var(--text-xs); }
.run-controls { display: flex; flex-direction: column; gap: 14px; }
.overall-progress > div:first-child { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.overall-progress strong { color: var(--accent-primary); font-family: var(--font-mono); font-size: 1.35rem; font-weight: 600; }
.overall-progress span { color: var(--text-muted); font-size: var(--text-xs); }
.progress-track { height: 7px; margin-top: 9px; overflow: hidden; border-radius: 5px; background: var(--bg-elevated); }
.progress-track i { display: block; height: 100%; border-radius: inherit; background: var(--accent-gradient); transition: width 200ms ease; }
.current-stage { padding: 11px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-soft); }
.current-stage > span { display: block; color: var(--text-muted); font-size: var(--text-xs); }
.current-stage > strong { display: block; margin-top: 6px; color: var(--text-primary); font-size: var(--text-sm); font-weight: 600; }
.current-stage > small { display: block; margin-top: 4px; color: var(--accent-primary); font-size: var(--text-xs); }
.control-buttons { display: grid; grid-template-columns: 1fr; gap: 8px; }
.control-note { color: var(--text-muted); font-size: var(--text-xs); line-height: 1.65; }
.run-parameters { padding: 6px 15px 12px; }
.run-parameters > div { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border-color); font-size: var(--text-xs); line-height: 1.5; }
.run-parameters > div:last-child { border-bottom: 0; }
.run-parameters dt { color: var(--text-muted); }
.run-parameters dd { margin: 0; color: var(--text-secondary); text-align: right; }
.run-log { max-height: 330px; padding: 8px 16px 14px; overflow-y: auto; }
.log-entry { display: grid; grid-template-columns: 76px 8px minmax(0, 1fr); align-items: start; gap: 9px; padding: 10px 0; border-bottom: 1px solid var(--border-color); color: var(--text-secondary); font-size: var(--text-xs); line-height: 1.55; }
.log-entry:last-child { border-bottom: 0; }
.log-entry time { color: var(--text-muted); font-size: var(--text-xs); }
.log-entry i { width: 6px; height: 6px; margin-top: 5px; border-radius: 50%; background: var(--accent-primary); }
.log-entry.success i { background: var(--success); }
.log-entry.warning i { background: var(--warning); }
.log-empty { min-height: 110px; }
@media (max-width: 1050px) {
  .run-layout { grid-template-columns: 1fr; }
}
@media (max-width: 720px) {
  .run-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
