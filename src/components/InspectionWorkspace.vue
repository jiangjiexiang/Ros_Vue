<template>
  <main class="inspection-workspace">
    <aside class="inspection-column inspection-left" aria-label="实时相机与机器人连接">
      <CameraPanel
        title="机器狗机载相机"
        :message="cameraPrimary"
        :connected="connected"
        :topic="cameraPrimary?.topic || cameraPrimaryTopic"
      />
      <ConnectionPanel
        :robots="robots"
        :activeRobotId="activeRobotId"
        :connectionState="connectionState"
        :errorMessage="errorMessage"
        @connect="emit('connect', $event)"
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
      <section class="card inspection-control-card">
        <div class="card-header">
          <span><UiIcon name="route" :size="17" />导航与航点</span>
          <small :class="{ running: isNavigating }">{{ isNavigating ? '运行中' : '待机' }}</small>
        </div>
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
      </section>

      <section class="card inspection-control-card">
        <div class="card-header">
          <span><UiIcon name="map" :size="17" />建图操作</span>
          <small :class="{ running: isMapping }">{{ isMapping ? '运行中' : '待机' }}</small>
        </div>
        <p class="algorithm-plan">{{ algorithmLabel }} · 启动命令在系统配置中管理</p>
        <MappingControl
          :connected="connected"
          :isMapping="isMapping"
          @update:isMapping="emit('update:isMapping', $event)"
          @mappingStarted="emit('mapping-started')"
        />
      </section>

      <JoystickControl
        :connected="connected"
        :maxLinearSpeed="controlConfig.max_linear_speed ?? 0.5"
        :maxAngularSpeed="controlConfig.max_angular_speed ?? 1.0"
        :commandRateHz="controlConfig.command_rate_hz ?? 10"
        @velocity-change="emit('velocity-change', $event)"
        @stop="emit('stop-motion')"
      />

      <BatteryStatus
        :percentage="batteryPercentage"
        :voltage="batteryVoltage"
        :connected="connected"
      />
    </aside>
  </main>
</template>

<script setup>
import { computed } from 'vue'
import BatteryStatus from './BatteryStatus.vue'
import CameraPanel from './CameraPanel.vue'
import ConnectionPanel from './ConnectionPanel.vue'
import JoystickControl from './JoystickControl.vue'
import MappingControl from './MappingControl.vue'
import NavigationControl from './NavigationControl.vue'
import SlamMap from './SlamMap.vue'
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
  cameraPrimaryTopic: { type: String, default: '' }
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
  grid-template-columns: minmax(230px, 280px) minmax(440px, 1fr) minmax(270px, 310px);
  gap: 12px;
  height: 100%;
  min-height: 660px;
  padding: 14px;
  overflow: hidden;
}
.inspection-column {
  display: flex;
  flex-direction: column;
  gap: 11px;
  min-width: 0;
  min-height: 0;
  padding-right: 2px;
  overflow-y: auto;
  scrollbar-gutter: stable;
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
  padding: 11px;
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
  background: rgba(34, 211, 238, 0.07);
}
.inspection-metric > div:last-child {
  min-width: 0;
}
.inspection-metric span {
  display: block;
  margin-bottom: 4px;
  color: var(--text-muted);
  font-size: 0.61rem;
}
.inspection-metric strong {
  display: block;
  overflow: hidden;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 0.77rem;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.inspection-metric small {
  margin-left: 3px;
  color: var(--text-muted);
  font-size: 0.57rem;
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
  padding: 10px 12px 8px;
}
.map-tools-layers .layer-controls {
  flex: 1;
  gap: 6px;
}
.map-tools-layers .layer-chip {
  padding: 5px 7px;
}
.map-tools-layers > small {
  flex: 0 0 auto;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 0.58rem;
}
.map-tools-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 31px;
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
  font-size: 0.59rem;
}
.map-tools-footer p {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  min-width: 0;
  color: var(--text-muted);
  font-size: 0.6rem;
  line-height: 1.5;
  text-align: right;
}
.map-tools-footer p svg {
  flex: 0 0 auto;
}
.map-tools-footer p.active {
  color: var(--accent-primary);
}
.inspection-control-card .card-header {
  min-height: 42px;
}
.inspection-control-card :deep(.control-section) {
  padding: 13px;
}
.inspection-control-card :deep(.control-description) {
  margin-bottom: 11px;
  font-size: 0.65rem;
}
.algorithm-plan {
  margin: 0 13px 10px;
  color: var(--text-muted);
  font-size: 0.6rem;
  line-height: 1.5;
}
.inspection-control-card small.running {
  color: var(--success);
}
.inspection-right :deep(.joystick-container) {
  padding: 12px;
}
.inspection-right :deep(.joystick-canvas-wrapper) {
  width: min(200px, 100%);
  height: auto;
  aspect-ratio: 1;
}

@media (max-width: 1500px) {
  .inspection-workspace {
    grid-template-columns: minmax(224px, 254px) minmax(420px, 1fr) minmax(264px, 288px);
    gap: 10px;
    padding: 12px;
  }
  .inspection-metric {
    padding: 9px;
  }
  .inspection-metric-icon {
    display: none;
  }
}

@media (max-width: 1240px) {
  .inspection-workspace {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    height: auto;
    min-height: 100%;
    overflow: visible;
  }
  .inspection-center {
    grid-column: 1 / -1;
    grid-row: 1;
    min-height: 620px;
  }
  .inspection-left {
    grid-column: 1;
    grid-row: 2;
  }
  .inspection-right {
    grid-column: 2;
    grid-row: 2;
  }
  .inspection-column {
    padding-right: 0;
    overflow: visible;
  }
  .inspection-map {
    min-height: 480px;
  }
  .inspection-metric-icon {
    display: grid;
  }
}

@media (max-width: 760px) {
  .inspection-workspace {
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
    padding: 10px;
  }
  .inspection-center,
  .inspection-left,
  .inspection-right {
    grid-column: 1;
  }
  .inspection-center {
    min-height: 580px;
  }
  .inspection-left {
    grid-row: 2;
  }
  .inspection-right {
    grid-row: 3;
  }
  .inspection-map {
    min-height: 430px;
  }
  .map-tools-footer {
    align-items: flex-start;
    flex-direction: column;
    gap: 7px;
  }
  .map-tools-footer p {
    justify-content: flex-start;
    text-align: left;
  }
}

@media (max-width: 480px) {
  .inspection-workspace {
    padding: 8px;
  }
  .inspection-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .inspection-metric-icon {
    display: grid;
  }
  .inspection-center {
    min-height: 650px;
  }
  .inspection-map {
    min-height: 400px;
  }
  .map-tools-layers {
    align-items: flex-start;
  }
  .map-legend {
    gap: 9px;
  }
}
</style>
