<template>
  <main class="inspection-workspace">
    <aside class="inspection-column inspection-left" aria-label="实时相机、连接与遥测">
      <div class="camera-switcher-card">
        <div class="camera-switch-pills" role="tablist" aria-label="相机视角切换">
          <button
            type="button"
            role="tab"
            :aria-selected="cameraSlot === 'primary'"
            :class="{ active: cameraSlot === 'primary' }"
            @click="cameraSlot = 'primary'"
          >
            机载主相机
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="cameraSlot === 'secondary'"
            :class="{ active: cameraSlot === 'secondary' }"
            @click="cameraSlot = 'secondary'"
          >
            副视角相机
          </button>
        </div>

        <CameraPanel
          :title="cameraSlot === 'primary' ? '机器狗机载相机' : '场景 / 辅助相机'"
          :message="activeCameraMessage"
          :connected="connected"
          :topic="activeCameraMessage?.topic || activeCameraTopic"
        />
      </div>

      <ConnectionPanel
        :robots="robots"
        :activeRobotId="activeRobotId"
        :connectionState="connectionState"
        :errorMessage="errorMessage"
        @connect="emit('connect', $event)"
      />

      <TelemetryPanel
        :odomData="odomData"
        :imuData="imuData"
        :connected="connected"
      />
    </aside>

    <section class="inspection-center" aria-label="SLAM 地图工作区">
      <div class="inspection-metrics">
        <article class="inspection-metric">
          <div class="inspection-metric-icon"><UiIcon name="activity" :size="17" /></div>
          <div>
            <span>运行状态</span>
            <strong>{{ modeText }}</strong>
          </div>
        </article>
        <article class="inspection-metric">
          <div class="inspection-metric-icon"><UiIcon name="map" :size="17" /></div>
          <div>
            <span>地图尺寸</span>
            <strong>{{ mapSize }}</strong>
          </div>
        </article>
        <article class="inspection-metric">
          <div class="inspection-metric-icon"><UiIcon name="route" :size="17" /></div>
          <div>
            <span>导航任务</span>
            <strong>
              {{ multiPointMode ? waypointCount : isNavigating ? '单点导航' : '--' }}
              <small v-if="multiPointMode">个航点</small>
            </strong>
          </div>
        </article>
        <article class="inspection-metric">
          <div class="inspection-metric-icon"><UiIcon name="move" :size="17" /></div>
          <div>
            <span>底盘速度</span>
            <strong>{{ linearSpeed }} <small>m/s</small></strong>
          </div>
        </article>
      </div>

      <SlamMap
        class="inspection-map"
        :connected="connected"
        :mapData="mapData"
        :scanData="scanData"
        :tfData="tfData"
        :planData="planData"
        :layers="mapLayers"
        :isMapping="isMapping"
        :isNavigating="isNavigating"
        :isSettingPose="isSettingPose"
        :multiPointMode="multiPointMode"
        :waypoints="waypoints"
        :activeWaypoint="activeWaypoint"
        :navFeedback="navFeedback"
        @update:isSettingPose="emit('update:isSettingPose', $event)"
        @goal-set="emit('goal-set', $event)"
        @waypoint-add="emit('waypoint-add', $event)"
        @waypoint-reached="emit('waypoint-reached')"
        @initial-pose-set="emit('initial-pose-set', $event)"
      />

      <section class="card inspection-map-tools" aria-label="地图图层与操作提示">
        <div class="map-tools-layers">
          <div class="layer-controls">
            <label
              v-for="layer in layerOptions"
              :key="layer.key"
              class="layer-chip"
              :class="layer.key"
            >
              <input v-model="mapLayers[layer.key]" type="checkbox">
              <span class="layer-check"></span>
              <span>{{ layer.label }}</span>
            </label>
          </div>
          <small>{{ enabledLayerCount }}/{{ layerOptions.length }}</small>
        </div>
        <div class="map-tools-footer">
          <div class="map-legend" aria-label="地图图例">
            <span><i class="legend-dot robot"></i>机器狗</span>
            <span><i class="legend-dot scan"></i>激光</span>
            <span><i class="legend-dot path"></i>路径</span>
          </div>
          <p :class="{ active: isSettingPose || isNavigating }">
            <UiIcon :name="isSettingPose ? 'crosshair' : 'compass'" :size="13" />
            <span>{{ interactionHint }}</span>
          </p>
        </div>
      </section>
    </section>

    <aside class="inspection-column inspection-right" aria-label="任务与运动控制">
      <section class="card right-tab-card">
        <div class="right-tabs" role="tablist" aria-label="控制面板切换">
          <button
            type="button"
            role="tab"
            :aria-selected="rightTab === 'navigation'"
            :class="{ active: rightTab === 'navigation' }"
            @click="rightTab = 'navigation'"
          >
            <UiIcon name="route" :size="15" />
            <span>导航</span>
            <i v-if="isNavigating" class="tab-dot"></i>
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="rightTab === 'mapping'"
            :class="{ active: rightTab === 'mapping' }"
            @click="rightTab = 'mapping'"
          >
            <UiIcon name="map" :size="15" />
            <span>建图</span>
            <i v-if="isMapping" class="tab-dot"></i>
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="rightTab === 'joystick'"
            :class="{ active: rightTab === 'joystick' }"
            @click="rightTab = 'joystick'"
          >
            <UiIcon name="move" :size="15" />
            <span>遥控</span>
          </button>
        </div>

        <div v-show="rightTab === 'navigation'" class="tab-panel-body">
          <NavigationControl
            :connected="connected"
            :mapsRevision="mapsRevision"
            :selectedMap="selectedMap"
            :isNavigating="isNavigating"
            :isSettingPose="isSettingPose"
            :multiPointMode="multiPointMode"
            :waypointCount="waypointCount"
            @update:selectedMap="emit('update:selectedMap', $event)"
            @update:isNavigating="emit('update:isNavigating', $event)"
            @update:isSettingPose="emit('update:isSettingPose', $event)"
            @update:multiPointMode="emit('update:multiPointMode', $event)"
            @navigationStarted="emit('navigation-started')"
            @clear-waypoints="emit('clear-waypoints')"
            @save-mission="emit('save-mission')"
          />
        </div>

        <div v-show="rightTab === 'mapping'" class="tab-panel-body">
          <p class="algorithm-plan">{{ algorithmLabel }} · 启动命令在系统配置中管理</p>
          <MappingControl
            :connected="connected"
            :isMapping="isMapping"
            @update:isMapping="emit('update:isMapping', $event)"
            @mappingStarted="emit('mapping-started')"
          />
        </div>

        <div v-show="rightTab === 'joystick'" class="tab-panel-body joystick-tab-wrap">
          <JoystickControl
            :connected="connected"
            :maxLinearSpeed="controlConfig.max_linear_speed ?? 0.5"
            :maxAngularSpeed="controlConfig.max_angular_speed ?? 1.0"
            :commandRateHz="controlConfig.command_rate_hz ?? 10"
            @velocity-change="emit('velocity-change', $event)"
            @stop="emit('stop-motion')"
          />
        </div>
      </section>

      <BatteryStatus
        :percentage="batteryPercentage"
        :voltage="batteryVoltage"
        :connected="connected"
      />
    </aside>
  </main>
</template>

<script setup>
import { computed, ref } from 'vue'
import BatteryStatus from './BatteryStatus.vue'
import CameraPanel from './CameraPanel.vue'
import ConnectionPanel from './ConnectionPanel.vue'
import JoystickControl from './JoystickControl.vue'
import MappingControl from './MappingControl.vue'
import NavigationControl from './NavigationControl.vue'
import SlamMap from './SlamMap.vue'
import TelemetryPanel from './TelemetryPanel.vue'
import UiIcon from './UiIcon.vue'

const props = defineProps({
  robots: { type: Array, default: () => [] },
  robotConfig: { type: Object, default: () => ({}) },
  activeRobotId: { type: String, default: '' },
  connectionState: { type: String, default: 'disconnected' },
  errorMessage: { type: String, default: '' },
  connected: { type: Boolean, default: false },
  controlConfig: { type: Object, default: () => ({}) },
  mapData: { type: Object, default: null },
  scanData: { type: Object, default: null },
  tfData: { type: Object, default: null },
  planData: { type: Object, default: null },
  odomData: { type: Object, default: null },
  imuData: { type: Object, default: null },
  navFeedback: { type: Object, default: null },
  batteryPercentage: { type: Number, default: -1 },
  batteryVoltage: { type: Number, default: 0 },
  mapLayers: { type: Object, default: () => ({}) },
  layerOptions: { type: Array, default: () => [] },
  isMapping: { type: Boolean, default: false },
  isNavigating: { type: Boolean, default: false },
  isSettingPose: { type: Boolean, default: false },
  selectedMap: { type: String, default: '' },
  multiPointMode: { type: Boolean, default: false },
  waypointCount: { type: Number, default: 0 },
  waypoints: { type: Array, default: () => [] },
  activeWaypoint: { type: Object, default: null },
  mapsRevision: { type: Number, default: 0 },
  cameraPrimary: { type: Object, default: null },
  cameraPrimaryTopic: { type: String, default: '' },
  cameraSecondary: { type: Object, default: null },
  cameraSecondaryTopic: { type: String, default: '' }
})

const emit = defineEmits([
  'connect',
  'velocity-change',
  'stop-motion',
  'goal-set',
  'waypoint-add',
  'waypoint-reached',
  'initial-pose-set',
  'clear-waypoints',
  'mapping-started',
  'navigation-started',
  'save-mission',
  'update:isSettingPose',
  'update:multiPointMode',
  'update:selectedMap',
  'update:isMapping',
  'update:isNavigating'
])

const cameraSlot = ref('primary')
const rightTab = ref('navigation')

const activeCameraMessage = computed(() => (
  cameraSlot.value === 'secondary' ? props.cameraSecondary : props.cameraPrimary
))
const activeCameraTopic = computed(() => (
  cameraSlot.value === 'secondary' ? props.cameraSecondaryTopic : props.cameraPrimaryTopic
))

const modeText = computed(() => {
  if (!props.connected) return '离线'
  if (props.isSettingPose) return '初始定位'
  if (props.isMapping) return '建图作业'
  if (props.isNavigating) return props.multiPointMode ? '多点导航' : '自主导航'
  return '待机监控'
})
const mapSize = computed(() => {
  const info = props.mapData?.info
  return info ? `${info.width} × ${info.height}` : '--'
})
const linearSpeed = computed(() => {
  const speed = props.odomData?.twist?.twist?.linear?.x
  return Number.isFinite(speed) ? Math.abs(speed).toFixed(2) : '0.00'
})
const enabledLayerCount = computed(() => Object.values(props.mapLayers).filter(Boolean).length)
const algorithmLabel = computed(() => {
  const config = props.robotConfig || {}
  const lidar = config.lidarType === '3d' ? '3D 雷达' : '2D 雷达'
  const algorithm = {
    slam_toolbox: 'SLAM Toolbox',
    cartographer: 'Cartographer',
    fast_lio: 'FAST-LIO',
    fast_lio_localization: 'FAST-LIO Localization',
    custom: config.algorithmPackage || '自定义算法'
  }[config.slamAlgorithm || 'slam_toolbox'] || config.slamAlgorithm
  return `${lidar} · ${algorithm}`
})
const interactionHint = computed(() => {
  if (!props.connected) return '连接机器人后可操作地图'
  if (props.isSettingPose) return '按住地图拖动，设置初始位置与朝向'
  if (props.isNavigating && props.multiPointMode) return '滚轮缩放 · 拖动平移 · 双击连续添加航点'
  if (props.isNavigating) return '滚轮缩放 · 拖动平移 · 双击设置导航目标'
  if (props.isMapping) return '滚轮缩放 · 拖动平移 · 实时查看建图结果'
  return '滚轮缩放 · 拖动平移 · 启动导航后设置目标'
})
</script>

<style scoped>
.inspection-workspace {
  display: grid;
  grid-template-columns: minmax(250px, 300px) minmax(440px, 1fr) minmax(280px, 320px);
  gap: 12px;
  height: 100%;
  min-height: 620px;
  padding: 12px;
  overflow: hidden;
}
.inspection-column {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  min-height: 0;
  padding-right: 2px;
  overflow-y: auto;
  scrollbar-gutter: stable;
}
.camera-switcher-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.camera-switch-pills {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  padding: 3px;
  border: 1px solid var(--border-color);
  border-radius: 9px;
  background: var(--bg-card);
}
.camera-switch-pills button {
  height: 29px;
  border: 0;
  border-radius: 6px;
  color: var(--text-muted);
  background: transparent;
  font-size: var(--text-xs);
  cursor: pointer;
  transition: var(--transition);
}
.camera-switch-pills button.active {
  color: var(--text-primary);
  background: var(--bg-elevated);
}
.inspection-center {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  min-height: 0;
}
.inspection-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  flex: 0 0 auto;
}
.inspection-metric {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  padding: 10px 11px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: rgba(15, 28, 46, 0.82);
}
.inspection-metric-icon {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  border-radius: 8px;
  color: var(--accent-primary);
  background: rgba(34, 211, 238, 0.08);
}
.inspection-metric > div:last-child { min-width: 0; }
.inspection-metric span {
  display: block;
  margin-bottom: 3px;
  color: var(--text-muted);
  font-size: var(--text-xs);
}
.inspection-metric strong {
  display: block;
  overflow: hidden;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 0.88rem;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.inspection-metric small {
  margin-left: 3px;
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-weight: 400;
}
.inspection-map {
  flex: 1;
  min-height: 360px;
}
.inspection-map-tools {
  flex: 0 0 auto;
  border-radius: var(--radius-md);
  box-shadow: none;
}
.map-tools-layers {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px 7px;
}
.map-tools-layers .layer-controls { flex: 1; gap: 6px; }
.map-tools-layers .layer-chip { padding: 5px 8px; }
.map-tools-layers > small {
  flex: 0 0 auto;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.map-tools-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 30px;
  padding: 0 12px 9px;
}
.map-legend {
  display: flex;
  align-items: center;
  gap: 11px;
  flex: 0 0 auto;
}
.map-legend span {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--text-muted);
  font-size: var(--text-xs);
}
.map-tools-footer p {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  min-width: 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
  text-align: right;
}
.map-tools-footer p.active { color: var(--accent-primary); }

.right-tab-card {
  display: flex;
  flex-direction: column;
}
.right-tabs {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
  padding: 8px;
  border-bottom: 1px solid var(--border-color);
  background: rgba(2, 8, 18, 0.25);
}
.right-tabs button {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 34px;
  border: 1px solid transparent;
  border-radius: 7px;
  color: var(--text-secondary);
  background: transparent;
  font-size: var(--text-xs);
  font-weight: 500;
  cursor: pointer;
  transition: var(--transition);
}
.right-tabs button:hover {
  color: var(--text-primary);
  background: var(--bg-soft);
}
.right-tabs button.active {
  border-color: rgba(34, 211, 238, 0.28);
  color: var(--accent-primary);
  background: rgba(34, 211, 238, 0.08);
}
.tab-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--success);
}
.tab-panel-body :deep(.control-section) {
  padding: 14px;
}
.algorithm-plan {
  margin: 12px 14px 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: 1.5;
}
.joystick-tab-wrap :deep(.card) {
  border: 0;
  background: transparent;
  box-shadow: none;
}
.joystick-tab-wrap :deep(.joystick-container) {
  padding: 14px;
}

@media (max-width: 1500px) {
  .inspection-workspace {
    grid-template-columns: minmax(234px, 268px) minmax(420px, 1fr) minmax(272px, 296px);
    gap: 10px;
  }
  .inspection-metric-icon { display: none; }
}
@media (max-width: 1240px) {
  .inspection-workspace {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    height: auto;
    min-height: 100%;
    overflow: visible;
  }
  .inspection-center { grid-column: 1 / -1; grid-row: 1; min-height: 600px; }
  .inspection-left { grid-column: 1; grid-row: 2; }
  .inspection-right { grid-column: 2; grid-row: 2; }
  .inspection-column { padding-right: 0; overflow: visible; }
  .inspection-map { min-height: 460px; }
  .inspection-metric-icon { display: grid; }
}
@media (max-width: 760px) {
  .inspection-workspace { grid-template-columns: minmax(0, 1fr); padding: 10px; }
  .inspection-center, .inspection-left, .inspection-right { grid-column: 1; }
  .inspection-left { grid-row: 2; }
  .inspection-right { grid-row: 3; }
  .map-tools-footer { align-items: flex-start; flex-direction: column; gap: 7px; }
}
</style>
