<template>
  <main class="mission-page mission-editor-page">
    <header class="mission-header">
      <div class="mission-heading">
        <span class="mission-eyebrow">MISSION EDITOR</span>
        <h1>{{ isNew ? '新建巡检任务' : '编辑巡检任务' }}</h1>
        <p>推荐先在巡检工作台的 SLAM 地图上选点，再配置停留、动作与执行参数；此处可微调坐标和顺序。</p>
      </div>
      <div class="mission-header-actions">
        <button class="mission-button" @click="goBack">← 返回列表</button>
      </div>
    </header>

    <div v-if="storageError" class="mission-alert error">{{ storageError }}</div>

    <section v-if="notFound" class="mission-panel empty-state">
      <strong>未找到该巡检任务</strong>
      <p>任务可能已在其他页面删除，请返回任务列表重新选择。</p>
      <button class="mission-button primary" @click="goBack">返回任务列表</button>
    </section>

    <template v-else>
      <div v-if="editorLocked" class="mission-alert warning lock-notice">
        <span>任务当前处于{{ draft.status === 'running' ? '执行中' : '已暂停' }}状态，配置为只读。终止任务后才可编辑。</span>
        <button class="mission-button small" @click="openRun">查看执行</button>
      </div>

      <div v-if="errors.length" class="mission-alert error validation-errors" role="alert">
        <strong>请检查以下内容：</strong>
        <ul><li v-for="error in errors" :key="error">{{ error }}</li></ul>
      </div>

      <form @submit.prevent="save(false)">
        <fieldset class="editor-fieldset" :disabled="editorLocked">
          <section class="mission-panel">
            <div class="panel-heading">
              <h2>基本信息与执行策略</h2>
              <span>带 * 为必填项</span>
            </div>
            <div class="panel-body form-grid">
              <div class="form-field full">
                <label for="mission-name">任务名称 <strong>*</strong></label>
                <input id="mission-name" v-model="draft.name" class="mission-input" maxlength="80" placeholder="例如：仓库早班巡检">
              </div>
              <div class="form-field full">
                <label for="mission-description">任务说明</label>
                <textarea id="mission-description" v-model="draft.description" class="mission-textarea" maxlength="300" placeholder="记录巡检目的、注意事项等"></textarea>
              </div>

              <div class="form-field">
                <label for="mission-robot">执行机器狗 <strong>*</strong></label>
                <select id="mission-robot" v-model="draft.robotId" class="mission-select" @change="updateRobot">
                  <option value="" disabled>请选择机器狗</option>
                  <option v-for="robot in robotChoices" :key="robot.id" :value="robot.id">
                    {{ robot.name }}
                  </option>
                </select>
                <span class="form-hint">{{ selectedRobotHint }}</span>
              </div>

              <div class="form-field">
                <label for="mission-map">地图场景 <strong>*</strong></label>
                <div class="map-select-row">
                  <select id="mission-map" v-model="selectedMapKey" class="mission-select" :disabled="mapLoading && !mapChoices.length" @change="updateMap">
                    <option value="" disabled>{{ mapLoading ? '正在读取地图…' : '请选择地图场景' }}</option>
                    <option v-for="map in mapChoices" :key="getMapKey(map)" :value="getMapKey(map)">
                      {{ map.name }}{{ map.isDemo ? '' : '' }}{{ map.unavailable ? '（当前不可用）' : '' }}
                    </option>
                  </select>
                  <button class="mission-button icon-only" type="button" :disabled="mapLoading" title="刷新地图列表" @click="loadMaps">
                    <UiIcon name="refresh" :size="15" :class="{ spinning: mapLoading }" />
                  </button>
                </div>
                <span class="form-hint">{{ mapSourceHint }}</span>
              </div>

              <div v-if="mapMessage" class="form-field full">
                <div class="mission-alert warning">{{ mapMessage }}</div>
              </div>

              <div class="form-field">
                <label for="mission-dwell">新巡检点默认停留（秒）</label>
                <input id="mission-dwell" v-model.number="draft.dwellSeconds" class="mission-input" type="number" min="1" max="600" step="1">
                <span class="form-hint">新增点时带入，仍可为每个点单独调整。</span>
                <button class="mission-button small inline-action" type="button" :disabled="!draft.waypoints.length" @click="applyDwellToAll">
                  应用到全部巡检点
                </button>
              </div>
              <div class="form-field">
                <label for="mission-loops">循环次数</label>
                <input id="mission-loops" v-model.number="draft.loopCount" class="mission-input" type="number" min="1" max="99" step="1">
              </div>
              <div class="form-field">
                <label for="mission-failure">异常处理</label>
                <select id="mission-failure" v-model="draft.onFailure" class="mission-select">
                  <option v-for="policy in FAILURE_POLICIES" :key="policy.value" :value="policy.value">{{ policy.label }}</option>
                </select>
                <span class="form-hint">{{ selectedPolicy?.description }}</span>
              </div>
              <div v-if="draft.onFailure === 'retry'" class="form-field">
                <label for="mission-retries">失败重试次数</label>
                <input id="mission-retries" v-model.number="draft.retryLimit" class="mission-input" type="number" min="1" max="5" step="1">
              </div>
              <div class="form-field">
                <label for="mission-linear-speed">最大线速度（m/s）</label>
                <input id="mission-linear-speed" v-model.number="draft.navigation.maxLinearSpeed" class="mission-input" type="number" min="0.1" max="2" step="0.1">
              </div>
              <div class="form-field">
                <label for="mission-angular-speed">最大角速度（rad/s）</label>
                <input id="mission-angular-speed" v-model.number="draft.navigation.maxAngularSpeed" class="mission-input" type="number" min="0.1" max="3" step="0.1">
              </div>
              <div class="form-field">
                <label for="mission-goal-tolerance">目标容差（m）</label>
                <input id="mission-goal-tolerance" v-model.number="draft.navigation.goalTolerance" class="mission-input" type="number" min="0.05" max="1" step="0.05">
                <span class="form-hint">进入该范围后判定到达巡检点。</span>
              </div>
              <div class="form-field">
                <label for="mission-navigation-timeout">单点导航超时（秒）</label>
                <input id="mission-navigation-timeout" v-model.number="draft.navigation.navigationTimeoutSeconds" class="mission-input" type="number" min="5" max="600" step="1">
              </div>
            </div>
          </section>

          <MissionMapPicker
            :mapName="draft.map?.name || ''"
            :waypoints="draft.waypoints"
            :selectedWaypointId="selectedWaypointId"
            :disabled="editorLocked"
            @add-point="addWaypointFromMap"
            @select-point="selectedWaypointId = $event"
          />

          <div class="point-workspace">
            <section class="mission-panel point-list-panel">
              <div class="panel-heading">
                <h2>巡检点顺序</h2>
                <span>{{ draft.waypoints.length }} 个</span>
              </div>
              <div class="panel-body">
                <div class="add-point-form">
                  <label class="field-label" for="new-point-name">添加巡检点</label>
                  <input id="new-point-name" v-model="newPoint.name" class="mission-input" maxlength="50" placeholder="点位名称，可留空自动编号" @keydown.enter.prevent="addWaypoint">
                  <div class="coordinate-inputs">
                    <label><span>X (m)</span><input v-model.number="newPoint.x" class="mission-input" type="number" step="0.1" aria-label="新巡检点 X 坐标"></label>
                    <label><span>Y (m)</span><input v-model.number="newPoint.y" class="mission-input" type="number" step="0.1" aria-label="新巡检点 Y 坐标"></label>
                    <label><span>Yaw (rad)</span><input v-model.number="newPoint.yaw" class="mission-input" type="number" step="0.1" aria-label="新巡检点朝向"></label>
                  </div>
                  <button class="mission-button primary add-point-button" type="button" @click="addWaypoint">＋ 添加巡检点</button>
                </div>

                <div v-if="draft.waypoints.length" class="point-list">
                  <article
                    v-for="(waypoint, index) in draft.waypoints"
                    :key="waypoint.id"
                    class="point-item"
                    :class="{ selected: selectedWaypointId === waypoint.id }"
                  >
                    <button class="point-main" type="button" @click="selectedWaypointId = waypoint.id">
                      <span class="point-index">{{ index + 1 }}</span>
                      <span class="point-copy">
                        <strong>{{ waypoint.name }}</strong>
                        <small>{{ formatCoordinate(waypoint.pose.x) }}, {{ formatCoordinate(waypoint.pose.y) }} · {{ waypoint.actions.length }} 个动作</small>
                      </span>
                    </button>
                    <div class="point-order-actions">
                      <button type="button" :disabled="index === 0" title="上移" :aria-label="`上移${waypoint.name}`" @click="moveWaypoint(index, -1)">↑</button>
                      <button type="button" :disabled="index === draft.waypoints.length - 1" title="下移" :aria-label="`下移${waypoint.name}`" @click="moveWaypoint(index, 1)">↓</button>
                      <button class="remove" type="button" title="删除" :aria-label="`删除${waypoint.name}`" @click="removeWaypoint(index)">×</button>
                    </div>
                  </article>
                </div>
                <div v-else class="point-empty">
                  <span>尚无巡检点。请先在 SLAM 地图上选点，再配置动作。</span>
                  <button class="mission-button primary" type="button" @click="navigate('/inspection')">前往地图选点</button>
                </div>
              </div>
            </section>

            <section class="mission-panel point-detail-panel">
              <div class="panel-heading">
                <h2>巡检点动作配置</h2>
                <span v-if="selectedWaypoint">顺序 {{ selectedWaypointIndex + 1 }}</span>
              </div>
              <div v-if="selectedWaypoint" class="panel-body point-detail-body">
                <div class="form-grid">
                  <div class="form-field full">
                    <label for="point-name">点位名称 <strong>*</strong></label>
                    <input id="point-name" v-model="selectedWaypoint.name" class="mission-input" maxlength="50">
                  </div>
                  <div class="form-field">
                    <label for="point-x">X 坐标（米）</label>
                    <input id="point-x" v-model.number="selectedWaypoint.pose.x" class="mission-input" type="number" step="0.1">
                  </div>
                  <div class="form-field">
                    <label for="point-y">Y 坐标（米）</label>
                    <input id="point-y" v-model.number="selectedWaypoint.pose.y" class="mission-input" type="number" step="0.1">
                  </div>
                  <div class="form-field">
                    <label for="point-yaw">朝向 Yaw（弧度）</label>
                    <input id="point-yaw" v-model.number="selectedWaypoint.pose.yaw" class="mission-input" type="number" step="0.1">
                  </div>
                  <div class="form-field">
                    <label for="point-dwell">到达后停留（秒）</label>
                    <input id="point-dwell" v-model.number="selectedWaypoint.dwellSeconds" class="mission-input" type="number" min="1" max="600" step="1">
                  </div>
                  <div class="form-field full">
                    <label for="point-note">点位备注</label>
                    <input id="point-note" v-model="selectedWaypoint.note" class="mission-input" maxlength="120" placeholder="例如：镜头朝向压力表，注意避开通道">
                  </div>
                </div>

                <div class="action-section">
                  <div class="action-section-heading">
                    <h3>巡检动作 <strong>*</strong></h3>
                    <span>可同时选择多项</span>
                  </div>
                  <div class="action-options">
                    <label v-for="action in ACTION_DEFINITIONS" :key="action.value" class="action-option">
                      <input v-model="selectedWaypoint.actions" type="checkbox" :value="action.value">
                      <span><strong>{{ action.label }}</strong><small>{{ action.description }}</small></span>
                    </label>
                  </div>
                  <div v-if="!selectedWaypoint.actions.length" class="mission-alert warning">至少选择一种动作，否则保存时无法通过校验。</div>
                </div>

                <div v-if="selectedWaypoint.actions.includes('thermal')" class="action-config">
                  <h3>热成像参数</h3>
                  <div class="form-grid three-columns">
                    <div class="form-field">
                      <label :for="`thermal-threshold-${selectedWaypoint.id}`">高温告警阈值（°C）</label>
                      <input :id="`thermal-threshold-${selectedWaypoint.id}`" v-model.number="selectedWaypoint.actionSettings.thermal.alarmAbove" class="mission-input" type="number" step="1">
                    </div>
                  </div>
                </div>

                <div v-if="selectedWaypoint.actions.includes('meter')" class="action-config">
                  <h3>仪表读数参数</h3>
                  <div class="form-grid three-columns">
                    <div class="form-field">
                      <label :for="`meter-unit-${selectedWaypoint.id}`">读数单位</label>
                      <input :id="`meter-unit-${selectedWaypoint.id}`" v-model="selectedWaypoint.actionSettings.meter.unit" class="mission-input" placeholder="如 bar、MPa、A">
                    </div>
                    <div class="form-field">
                      <label :for="`meter-min-${selectedWaypoint.id}`">正常下限（可选）</label>
                      <input :id="`meter-min-${selectedWaypoint.id}`" v-model.number="selectedWaypoint.actionSettings.meter.min" class="mission-input" type="number" step="any">
                    </div>
                    <div class="form-field">
                      <label :for="`meter-max-${selectedWaypoint.id}`">正常上限（可选）</label>
                      <input :id="`meter-max-${selectedWaypoint.id}`" v-model.number="selectedWaypoint.actionSettings.meter.max" class="mission-input" type="number" step="any">
                    </div>
                  </div>
                </div>

                <div v-if="selectedWaypoint.actions.includes('gas')" class="action-config">
                  <h3>气体检测参数</h3>
                  <div class="form-grid three-columns">
                    <div class="form-field">
                      <label :for="`gas-type-${selectedWaypoint.id}`">气体类型</label>
                      <input :id="`gas-type-${selectedWaypoint.id}`" v-model="selectedWaypoint.actionSettings.gas.gasType" class="mission-input" placeholder="如可燃气体、氧气">
                    </div>
                    <div class="form-field">
                      <label :for="`gas-threshold-${selectedWaypoint.id}`">告警阈值</label>
                      <input :id="`gas-threshold-${selectedWaypoint.id}`" v-model.number="selectedWaypoint.actionSettings.gas.alarmAbove" class="mission-input" type="number" step="any">
                    </div>
                    <div class="form-field">
                      <label :for="`gas-unit-${selectedWaypoint.id}`">阈值单位</label>
                      <input :id="`gas-unit-${selectedWaypoint.id}`" v-model="selectedWaypoint.actionSettings.gas.unit" class="mission-input" placeholder="如 %LEL、ppm">
                    </div>
                  </div>
                </div>
              </div>
              <div v-else class="empty-state point-detail-empty">
                <strong>请选择或添加巡检点</strong>
                <p>每个点可独立配置拍照、热成像、仪表读数和气体检测。</p>
              </div>
            </section>
          </div>
        </fieldset>

        <footer class="editor-footer">
          <span>保存后，已有执行记录将清零，任务回到待执行状态。</span>
          <div>
            <button class="mission-button" type="button" @click="goBack">取消</button>
            <button class="mission-button" type="submit" :disabled="editorLocked || saving">{{ saving ? '保存中…' : '保存' }}</button>
            <button class="mission-button primary" type="button" :disabled="editorLocked || saving" @click="save(true)">{{ saving ? '保存中…' : '保存并前往执行' }}</button>
          </div>
        </footer>
      </form>
    </template>
  </main>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import UiIcon from '../../components/UiIcon.vue'
import MissionMapPicker from './MissionMapPicker.vue'
import { useRobotStore } from '../../stores/robotStore.js'
import { loadMapScenes } from './missionMaps.js'
import {
  ACTION_DEFINITIONS,
  FAILURE_POLICIES,
  cloneData,
  createEmptyMission,
  createWaypoint,
  getMapKey,
  normalizeMission,
  validateMission
} from './missionModel.js'
import { useMissionStore } from './missionStore.js'
import { MISSION_PATHS, useMissionNavigation } from './useMissionNavigation.js'

const props = defineProps({
  missionId: { type: String, default: '' },
  id: { type: String, default: '' }
})
const emit = defineEmits(['navigate', 'saved'])
const { routeMissionId, navigate } = useMissionNavigation(props, emit)
const { missions, storageError, initMissionsFromServer, saveMission: persistMission } = useMissionStore()
const { robots: configuredRobots } = useRobotStore()
const draft = ref(createEmptyMission())
const selectedWaypointId = ref('')
const selectedMapKey = ref('')
const mapOptions = ref([])
const robotOptions = computed(() => configuredRobots.value.map((robot) => ({
  ...robot,
  model: `${robot.transport === 'rosbridge' ? 'ROS Bridge' : 'Foxglove'}${robot.namespace ? ` · /${robot.namespace}` : ''}`
})))
const mapLoading = ref(false)
const mapSource = ref('')
const mapMessage = ref('')
const notFound = ref(false)
const sourceStatus = ref('pending')
const saving = ref(false)
const errors = ref([])
const newPoint = reactive({ name: '', x: 0, y: 0, yaw: 0 })
const ROBOT_ALGORITHM_OPTIONS = {
  '2d': {
    slam: ['slam_toolbox', 'cartographer'],
    localization: ['none', 'amcl', 'custom']
  },
  '3d': {
    slam: ['fast_lio', 'fast_lio_localization', 'custom'],
    localization: ['none', 'fast_lio_localization', 'custom']
  }
}
const SLAM_ALGORITHM_LABELS = {
  slam_toolbox: 'SLAM Toolbox',
  cartographer: 'Cartographer',
  fast_lio: 'FAST-LIO',
  fast_lio_localization: 'FAST-LIO Localization（定位模式）',
  custom: '自定义算法'
}
const LOCALIZATION_ALGORITHM_LABELS = {
  none: '无单独定位',
  amcl: 'AMCL',
  fast_lio_localization: 'FAST-LIO Localization',
  custom: '自定义定位'
}

function formatRobotAlgorithm(robot) {
  const lidarType = robot.lidarType === '3d' ? '3d' : '2d'
  const options = ROBOT_ALGORITHM_OPTIONS[lidarType]
  const slamAlgorithm = options.slam.includes(robot.slamAlgorithm)
    ? robot.slamAlgorithm
    : options.slam[0]
  let localizationAlgorithm = options.localization.includes(robot.localizationAlgorithm)
    ? robot.localizationAlgorithm
    : (lidarType === '2d' ? 'amcl' : 'none')
  if (slamAlgorithm === 'fast_lio_localization' && localizationAlgorithm === 'fast_lio_localization') {
    localizationAlgorithm = 'none'
  }
  return `${lidarType.toUpperCase()} · ${SLAM_ALGORITHM_LABELS[slamAlgorithm]} · ${LOCALIZATION_ALGORITHM_LABELS[localizationAlgorithm]}`
}

const isNew = computed(() => !routeMissionId.value)
const editorLocked = computed(() => ['running', 'paused'].includes(sourceStatus.value))
const robotChoices = computed(() => {
  const choices = robotOptions.value.map((robot) => ({ ...robot }))
  if (draft.value.robotId && !choices.some((robot) => robot.id === draft.value.robotId)) {
    choices.push({ id: draft.value.robotId, name: draft.value.robotName || '历史机器狗', model: '当前未接入' })
  }
  return choices
})
const selectedRobot = computed(() => robotChoices.value.find((robot) => robot.id === draft.value.robotId))
const selectedRobotHint = computed(() => selectedRobot.value
  ? `${selectedRobot.value.model} · ${formatRobotAlgorithm(selectedRobot.value)}`
  : '请选择任务执行设备')
const selectedPolicy = computed(() => FAILURE_POLICIES.find((policy) => policy.value === draft.value.onFailure))
const selectedWaypoint = computed(() => draft.value.waypoints.find((point) => point.id === selectedWaypointId.value))
const selectedWaypointIndex = computed(() => draft.value.waypoints.findIndex((point) => point.id === selectedWaypointId.value))
const mapChoices = computed(() => {
  const choices = mapOptions.value.map((map) => ({ ...map }))
  if (draft.value.map?.path && !choices.some((map) => getMapKey(map) === getMapKey(draft.value.map))) {
    choices.push({ ...draft.value.map, unavailable: mapOptions.value.length > 0 })
  }
  return choices
})
const mapSourceHint = computed(() => {
  if (mapLoading.value) return '正在请求 /api/list_maps…'
  if (draft.value.map?.isDemo) return '当前使用任务中保存的地图场景。'
  if (mapSource.value === 'api') return `已从 /api/list_maps 读取 ${mapOptions.value.length} 张地图。`
  return '地图路径将随任务保存，用于任务导航。'
})

function readWorkspaceDraft() {
  try {
    const value = localStorage.getItem('robot-console-inspection-draft-v1')
    return value ? JSON.parse(value) : null
  } catch {
    return null
  }
}

function loadDraft() {
  errors.value = []
  notFound.value = false
  sourceStatus.value = 'pending'
  if (!routeMissionId.value) {
    const workspaceDraft = readWorkspaceDraft()
    if (workspaceDraft) {
      draft.value = normalizeMission({ ...workspaceDraft, id: '', status: 'pending' })
      draft.value.id = ''
      selectedWaypointId.value = draft.value.waypoints[0]?.id || ''
      selectedMapKey.value = getMapKey(draft.value.map)
      localStorage.removeItem('robot-console-inspection-draft-v1')
      ensureMapSelection()
      return
    }
    draft.value = createEmptyMission()
    const robot = robotOptions.value[0]
    draft.value.robotId = robot?.id || ''
    draft.value.robotName = robot?.name || ''
    selectedWaypointId.value = ''
    selectedMapKey.value = ''
    ensureMapSelection()
    return
  }

  const source = missions.value.find((mission) => mission.id === routeMissionId.value)
  if (!source) {
    notFound.value = true
    return
  }
  draft.value = cloneData(source)
  sourceStatus.value = source.status
  selectedWaypointId.value = draft.value.waypoints[0]?.id || ''
  selectedMapKey.value = getMapKey(draft.value.map)
}

function updateRobot() {
  draft.value.robotName = selectedRobot.value?.name || ''
}

function ensureMapSelection() {
  if (selectedMapKey.value || !mapOptions.value.length) return
  const first = mapOptions.value[0]
  selectedMapKey.value = getMapKey(first)
  updateMap()
}

function updateMap() {
  const selected = mapChoices.value.find((map) => getMapKey(map) === selectedMapKey.value)
  if (!selected) return
  draft.value.map = {
    id: selected.id,
    name: selected.name,
    path: selected.path,
    source: selected.source,
    isDemo: Boolean(selected.isDemo)
  }
}

function applyDwellToAll() {
  for (const waypoint of draft.value.waypoints) {
    waypoint.dwellSeconds = draft.value.dwellSeconds
  }
}

function addWaypointFromMap({ x, y, yaw = 0 }) {
  const waypoint = createWaypoint({
    pose: { x, y, yaw },
    actions: ['photo'],
    dwellSeconds: draft.value.dwellSeconds
  }, draft.value.waypoints.length)
  draft.value.waypoints.push(waypoint)
  selectedWaypointId.value = waypoint.id
}

function addWaypoint() {
  const waypoint = createWaypoint({
    name: newPoint.name.trim() || undefined,
    pose: { x: newPoint.x, y: newPoint.y, yaw: newPoint.yaw },
    actions: ['photo'],
    dwellSeconds: draft.value.dwellSeconds
  }, draft.value.waypoints.length)
  draft.value.waypoints.push(waypoint)
  selectedWaypointId.value = waypoint.id
  Object.assign(newPoint, { name: '', x: 0, y: 0, yaw: 0 })
}

function formatCoordinate(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(1) : '--'
}

function moveWaypoint(index, offset) {
  const target = index + offset
  if (target < 0 || target >= draft.value.waypoints.length) return
  const [waypoint] = draft.value.waypoints.splice(index, 1)
  draft.value.waypoints.splice(target, 0, waypoint)
}

function removeWaypoint(index) {
  const removedId = draft.value.waypoints[index]?.id
  draft.value.waypoints.splice(index, 1)
  if (selectedWaypointId.value === removedId) {
    selectedWaypointId.value = draft.value.waypoints[Math.min(index, draft.value.waypoints.length - 1)]?.id || ''
  }
}

async function save(openExecution) {
  if (editorLocked.value || saving.value) return
  updateRobot()
  updateMap()
  errors.value = validateMission(draft.value)
  if (errors.value.length) return

  saving.value = true
  try {
    const saved = await persistMission(draft.value)
    draft.value = cloneData(saved)
    emit('saved', cloneData(saved))
    navigate(openExecution ? MISSION_PATHS.run(saved.id) : MISSION_PATHS.list, saved.id)
  } catch (error) {
    errors.value = [error.message]
  } finally {
    saving.value = false
  }
}

function goBack() {
  navigate(MISSION_PATHS.list)
}

function openRun() {
  navigate(MISSION_PATHS.run(draft.value.id), draft.value.id)
}

async function loadMaps() {
  mapLoading.value = true
  mapMessage.value = ''
  const result = await loadMapScenes()
  mapOptions.value = result.maps
  mapSource.value = result.source
  mapMessage.value = result.error || (!result.maps.length ? '地图服务当前没有已保存地图，请先建图或稍后重试。' : '')
  ensureMapSelection()
  mapLoading.value = false
}

watch(routeMissionId, loadDraft, { immediate: true })
watch(missions, () => {
  if (notFound.value) loadDraft()
})
onMounted(() => {
  initMissionsFromServer()
  if (!draft.value.robotId && robotOptions.value.length) {
    draft.value.robotId = robotOptions.value[0].id
    updateRobot()
  }
  loadMaps()
})
</script>

<style scoped src="./missionShared.css"></style>
<style scoped>
.editor-fieldset { display: flex; flex-direction: column; gap: 16px; min-width: 0; margin: 0; padding: 0; border: 0; }
.lock-notice { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.validation-errors ul { margin: 5px 0 0 18px; }
.map-select-row { display: flex; gap: 7px; }
.map-select-row .mission-select { flex: 1; }
.inline-action { margin-top: 8px; }
.spinning { animation: mission-spin 0.8s linear infinite; }
@keyframes mission-spin { to { transform: rotate(360deg); } }
.point-workspace { display: grid; grid-template-columns: minmax(310px, 360px) minmax(0, 1fr); align-items: start; gap: 16px; }
.point-list-panel, .point-detail-panel { min-width: 0; }
.add-point-form { display: flex; flex-direction: column; gap: 9px; padding-bottom: 15px; border-bottom: 1px solid var(--border-color); }
.coordinate-inputs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; }
.coordinate-inputs label { display: flex; flex-direction: column; gap: 5px; color: var(--text-muted); font-size: 0.59rem; }
.coordinate-inputs .mission-input { padding: 0 7px; font-family: var(--font-mono); font-size: 0.66rem; }
.add-point-button { width: 100%; }
.point-list { display: flex; flex-direction: column; gap: 7px; margin-top: 14px; }
.point-item { display: flex; align-items: stretch; overflow: hidden; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-soft); }
.point-item.selected { border-color: rgba(34, 211, 238, 0.38); background: rgba(34, 211, 238, 0.05); }
.point-main { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; padding: 10px; border: 0; color: var(--text-secondary); background: transparent; text-align: left; cursor: pointer; }
.point-index { display: grid; place-items: center; width: 25px; height: 25px; flex: 0 0 auto; border: 1px solid var(--border-color); border-radius: 50%; color: var(--text-muted); font-family: var(--font-mono); font-size: 0.64rem; }
.point-item.selected .point-index { border-color: rgba(34, 211, 238, 0.3); color: var(--accent-primary); }
.point-copy { display: block; min-width: 0; }
.point-copy strong { display: block; overflow: hidden; color: var(--text-primary); font-size: 0.7rem; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.point-copy small { display: block; margin-top: 5px; color: var(--text-muted); font-family: var(--font-mono); font-size: 0.58rem; }
.point-order-actions { display: flex; align-items: center; padding-right: 6px; }
.point-order-actions button { width: 25px; height: 28px; padding: 0; border: 0; border-radius: 5px; color: var(--text-muted); background: transparent; cursor: pointer; }
.point-order-actions button:hover:not(:disabled) { color: var(--accent-primary); background: var(--bg-soft); }
.point-order-actions button.remove:hover:not(:disabled) { color: var(--danger); }
.point-empty { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 25px 8px 8px; color: var(--text-muted); font-size: 0.67rem; line-height: 1.7; text-align: center; }
.point-detail-body { display: flex; flex-direction: column; gap: 19px; }
.point-detail-empty { min-height: 320px; }
.action-section { display: flex; flex-direction: column; gap: 10px; }
.action-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.action-section-heading h3, .action-config h3 { color: var(--text-secondary); font-size: 0.72rem; font-weight: 600; }
.action-section-heading h3 strong { color: var(--danger); }
.action-section-heading span { color: var(--text-muted); font-size: 0.61rem; }
.action-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.action-option { display: flex; align-items: flex-start; gap: 9px; padding: 11px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-soft); cursor: pointer; }
.action-option:has(input:checked) { border-color: rgba(34, 211, 238, 0.3); background: rgba(34, 211, 238, 0.045); }
.action-option input { margin-top: 2px; accent-color: var(--accent-primary); }
.action-option strong { display: block; color: var(--text-primary); font-size: 0.69rem; font-weight: 600; }
.action-option small { display: block; margin-top: 5px; color: var(--text-muted); font-size: 0.6rem; line-height: 1.45; }
.action-config { padding: 13px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: rgba(2, 8, 18, 0.18); }
.action-config h3 { margin-bottom: 11px; }
.editor-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 16px; padding: 13px 0 2px; border-top: 1px solid var(--border-color); }
.editor-footer > span { color: var(--text-muted); font-size: 0.64rem; line-height: 1.5; }
.editor-footer > div { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
@media (max-width: 1080px) {
  .point-workspace { grid-template-columns: 1fr; }
  .point-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 720px) {
  .point-list { display: flex; }
  .action-options { grid-template-columns: 1fr; }
  .editor-footer { align-items: stretch; flex-direction: column; }
  .editor-footer > div { justify-content: flex-start; }
  .lock-notice { align-items: flex-start; flex-direction: column; }
}
</style>
