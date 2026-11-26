<template>
  <div class="workspace-page">
    <div class="workspace-toolbar">
      <div class="workspace-mode-tabs" role="tablist" aria-label="工作台视图模式">
        <button
          type="button"
          role="tab"
          :aria-selected="viewMode === 'inspection'"
          :class="{ active: viewMode === 'inspection' }"
          @click="setViewMode('inspection')"
        >
          <UiIcon name="activity" :size="15" />
          <span>巡检工作台</span>
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="viewMode === 'monitor'"
          :class="{ active: viewMode === 'monitor' }"
          @click="setViewMode('monitor')"
        >
          <UiIcon name="robot" :size="15" />
          <span>遥控监控</span>
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="viewMode === 'cameras'"
          :class="{ active: viewMode === 'cameras' }"
          @click="setViewMode('cameras')"
        >
          <UiIcon name="camera" :size="15" />
          <span>机载相机</span>
        </button>
      </div>

      <div class="workspace-toolbar-right">
        <div v-if="viewMode !== 'cameras'" class="scene-dim-switch" role="group" aria-label="地图维度切换">
          <button
            type="button"
            :class="{ active: sceneMode === '2d' }"
            @click="sceneMode = '2d'"
          >
            2D 栅格
          </button>
          <button
            type="button"
            :class="{ active: sceneMode === '3d' }"
            @click="sceneMode = '3d'"
          >
            3D 场景
          </button>
        </div>

        <button
          type="button"
          class="keyboard-toggle-btn"
          :class="{ active: keyboardEnabled }"
          :disabled="!isConnected"
          :title="isConnected ? '开启或关闭页面 WASD 键盘遥控' : '请先连接机器狗'"
          @click="toggleKeyboard"
        >
          <UiIcon name="keyboard" :size="15" />
          <span>WASD 遥控：{{ keyboardEnabled ? '已开启' : '已关闭' }}</span>
        </button>

        <div v-if="keyboardEnabled" class="keyboard-live-keys" aria-label="当前按键状态">
          <kbd :class="{ pressed: keyboardState.w }">W</kbd>
          <kbd :class="{ pressed: keyboardState.a }">A</kbd>
          <kbd :class="{ pressed: keyboardState.s }">S</kbd>
          <kbd :class="{ pressed: keyboardState.d }">D</kbd>
        </div>
      </div>
    </div>

    <section v-if="viewMode === 'inspection'" class="inspection-page workspace-body">
      <InspectionWorkspace
        :robots="robots"
        :robotConfig="activeRobot"
        :activeRobotId="activeRobotId"
        :connectionState="connectionState"
        :hasRobotTopics="hasRobotTopics"
        :errorMessage="errorMessage"
        :connected="isConnected"
        :controlConfig="controlConfig"
        :mapData="mapData"
        :scanData="scanData"
        :tfData="tfData"
        :planData="planData"
        :odomData="odomData"
        :imuData="imuData"
        :pointCloudData="pointCloudData"
        :registeredCloudData="registeredCloudData"
        :fastlioPathData="fastlioPathData"
        :localizationData="localizationData"
        :localizationPathData="localizationPathData"
        :globalMapData="globalMapData"
        :sceneMode="sceneMode"
        :navFeedback="navFeedback"
        :batteryPercentage="batteryPercentage"
        :batteryVoltage="batteryVoltage"
        :mapLayers="mapLayers"
        :layerOptions="layerOptions"
        :cameraPrimary="cameraPrimary"
        :cameraPrimaryTopic="robotTopics.camera_primary"
        :mapsRevision="mapsRevision"
        :waypoints="waypointQueue"
        :activeWaypoint="activeWaypoint"
        :waypointCount="waypointCount"
        v-model:isMapping="mappingActive"
        v-model:isLocalizing="localizationActive"
        v-model:isNavigating="navigationActive"
        v-model:isSettingPose="isSettingPose"
        v-model:selectedMap="selectedScenePath"
        v-model:multiPointMode="multiPointMode"
        @connect="connectRobot"
        @mapping-restarted="() => { registeredCloudData = null; fastlioPathData = null }"
        @map-saved="mapsRevision++"
        @velocity-change="onVelocityChange"
        @stop-motion="onStopMotion"
        @goal-set="onGoalSet"
        @waypoint-add="onWaypointAdd"
        @waypoint-reached="onWaypointReached"
        @initial-pose-set="onInitialPoseSet"
        @clear-waypoints="clearWaypoints"
        @save-mission="saveWorkspaceMission"
        @mapping-started="onMappingStarted"
      />
    </section>

    <main v-else-if="viewMode === 'monitor'" class="console-body workspace-body">
      <aside class="left-panel panel-scroll">
        <ConnectionPanel
          :robots="robots"
          :activeRobotId="activeRobotId"
          :connectionState="connectionState"
          :hasTopics="hasRobotTopics"
          :errorMessage="errorMessage"
          @connect="connectRobot"
        />

        <JoystickControl
          :connected="isConnected"
          :maxLinearSpeed="controlConfig.max_linear_speed"
          :maxAngularSpeed="controlConfig.max_angular_speed"
          :commandRateHz="controlConfig.command_rate_hz"
          @velocity-change="onVelocityChange"
          @stop="onStopMotion"
        />

        <section class="card shortcut-card">
          <div class="shortcut-title">
            <UiIcon name="keyboard" :size="17" />
            <span>键盘控制</span>
          </div>
          <div class="key-grid" aria-label="WASD 控制说明">
            <span></span><kbd :class="{ pressed: keyboardState.w }">W</kbd><span></span>
            <kbd :class="{ pressed: keyboardState.a }">A</kbd>
            <kbd :class="{ pressed: keyboardState.s }">S</kbd>
            <kbd :class="{ pressed: keyboardState.d }">D</kbd>
          </div>
          <p>需先在上方开启“WASD 遥控”，松开按键或离开页面立即停车。</p>
        </section>
      </aside>

      <section class="center-panel">
        <div class="metrics-grid">
          <article class="metric-item">
            <div class="metric-icon"><UiIcon name="activity" :size="18" /></div>
            <div><span>运行状态</span><strong>{{ modeText }}</strong></div>
          </article>
          <article class="metric-item">
            <div class="metric-icon"><UiIcon name="link" :size="18" /></div>
            <div><span>可用话题</span><strong>{{ topics.length }} <small>个</small></strong></div>
          </article>
          <article class="metric-item">
            <div class="metric-icon"><UiIcon name="map" :size="18" /></div>
            <div><span>地图尺寸</span><strong>{{ mapSize }}</strong></div>
          </article>
          <article class="metric-item">
            <div class="metric-icon"><UiIcon name="move" :size="18" /></div>
            <div><span>底盘速度</span><strong>{{ linearSpeed }} <small>m/s</small></strong></div>
          </article>
        </div>

        <SlamScene3D
          v-if="sceneMode === '3d'"
          :connected="isConnected"
          :mapData="mapData"
          :scanData="scanData"
          :tfData="tfData"
          :odomData="odomData"
          :planData="planData"
          :pointCloudData="pointCloudData"
          :registeredCloudData="registeredCloudData"
          :fastlioPathData="fastlioPathData"
          :localizationData="localizationData"
          :localizationPathData="localizationPathData"
          :globalMapData="globalMapData"
          :layers="mapLayers"
          :isMapping="mappingActive"
          :isLocalizing="localizationActive"
          :isNavigating="navigationActive"
          v-model:isSettingPose="isSettingPose"
          :multiPointMode="multiPointMode"
          :waypoints="waypointQueue"
          :activeWaypoint="activeWaypoint"
          @goal-set="onGoalSet"
          @waypoint-add="onWaypointAdd"
          @initial-pose-set="onInitialPoseSet"
        />

        <SlamMap
          v-else
          ref="slamMapRef"
          :connected="isConnected"
          :mapData="mapData"
          :scanData="scanData"
          :tfData="tfData"
          :planData="planData"
          :layers="mapLayers"
          :isMapping="mappingActive"
          :isNavigating="navigationActive"
          v-model:isSettingPose="isSettingPose"
          :multiPointMode="multiPointMode"
          :waypoints="waypointQueue"
          :activeWaypoint="activeWaypoint"
          :navFeedback="navFeedback"
          @goal-set="onGoalSet"
          @waypoint-add="onWaypointAdd"
          @waypoint-reached="onWaypointReached"
          @initial-pose-set="onInitialPoseSet"
        />

        <div v-if="sceneMode === '2d'" class="workspace-footer">
          <span><i class="legend-dot robot"></i>机器狗位置</span>
          <span><i class="legend-dot scan"></i>激光扫描</span>
          <span><i class="legend-dot path"></i>规划路径</span>
          <span class="workspace-tip">滚轮缩放 · 拖动平移 · 双击设置目标</span>
        </div>
      </section>

      <aside class="right-panel panel-scroll">
        <BatteryStatus
          :percentage="batteryPercentage"
          :voltage="batteryVoltage"
          :connected="isConnected"
        />

        <TelemetryPanel
          :odomData="odomData"
          :imuData="imuData"
          :connected="isConnected"
        />

        <section class="card layer-card">
          <div class="card-header">
            <span><UiIcon name="layers" :size="17" />地图图层</span>
            <small>{{ Object.values(mapLayers).filter(Boolean).length }}/{{ layerOptions.length }}</small>
          </div>
          <div class="card-body">
            <div class="layer-controls">
              <label v-for="layer in layerOptions" :key="layer.key" class="layer-chip" :class="layer.key">
                <input type="checkbox" v-model="mapLayers[layer.key]">
                <span class="layer-check"></span>
                <span>{{ layer.label }}</span>
              </label>
            </div>
          </div>
        </section>
      </aside>
    </main>

    <main v-else class="cameras-workspace workspace-body">
      <section class="cameras-grid">
        <CameraPanel
          title="机器狗机载相机"
          :message="cameraPrimary"
          :connected="isConnected"
          :topic="cameraPrimary?.topic || robotTopics.camera_primary"
        />
      </section>

      <aside class="cameras-sidebar">
        <ConnectionPanel
          :robots="robots"
          :activeRobotId="activeRobotId"
          :connectionState="connectionState"
          :hasTopics="hasRobotTopics"
          :errorMessage="errorMessage"
          @connect="connectRobot"
        />
        <JoystickControl
          :connected="isConnected"
          :maxLinearSpeed="controlConfig.max_linear_speed"
          :maxAngularSpeed="controlConfig.max_angular_speed"
          :commandRateHz="controlConfig.command_rate_hz"
          @velocity-change="onVelocityChange"
          @stop="onStopMotion"
        />
        <BatteryStatus
          :percentage="batteryPercentage"
          :voltage="batteryVoltage"
          :connected="isConnected"
        />
        <TelemetryPanel
          :odomData="odomData"
          :imuData="imuData"
          :connected="isConnected"
        />
      </aside>
    </main>
  </div>
</template>

<script setup>
import { onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import BatteryStatus from '../components/BatteryStatus.vue'
import CameraPanel from '../components/CameraPanel.vue'
import ConnectionPanel from '../components/ConnectionPanel.vue'
import InspectionWorkspace from '../components/InspectionWorkspace.vue'
import JoystickControl from '../components/JoystickControl.vue'
import SlamMap from '../components/SlamMap.vue'
import SlamScene3D from '../components/SlamScene3D.vue'
import TelemetryPanel from '../components/TelemetryPanel.vue'
import UiIcon from '../components/UiIcon.vue'
import { useRobotStore } from '../stores/robotStore.js'
import { useRuntimeConfigStore } from '../stores/runtimeConfigStore.js'
import { useRosSessionStore } from '../stores/rosSessionStore.js'

const route = useRoute()
const router = useRouter()

const { robots, activeRobotId, activeRobot } = useRobotStore()
const { controlConfig } = useRuntimeConfigStore()
const {
  layerOptions,
  activeOperation,
  mapsRevision,
  selectedScenePath,
  mappingActive,
  localizationActive,
  navigationActive,
  isSettingPose,
  multiPointMode,
  waypointQueue,
  activeWaypoint,
  waypointCount,
  topics,
  robotTopics,
  batteryPercentage,
  batteryVoltage,
  mapData,
  scanData,
  tfData,
  odomData,
  imuData,
  pointCloudData,
  registeredCloudData,
  fastlioPathData,
  localizationData,
  localizationPathData,
  globalMapData,
  planData,
  cameraPrimary,
  navFeedback,
  mapLayers,
  connectionState,
  hasRobotTopics,
  errorMessage,
  isConnected,
  modeText,
  mapSize,
  linearSpeed,
  keyboardEnabled,
  keyboardState,
  setKeyboardEnabled,
  connectRobot,
  onVelocityChange,
  onGoalSet,
  onWaypointAdd,
  onWaypointReached,
  clearWaypoints,
  onInitialPoseSet,
  onStopMotion
} = useRosSessionStore()

const slamMapRef = ref(null)
const viewMode = ref(resolveInitialMode(route.query.mode))
const sceneMode = ref(activeRobot.value?.lidarType === '2d' ? '2d' : '3d')

function resolveInitialMode(queryMode) {
  if (queryMode === 'monitor' || queryMode === 'cameras') return queryMode
  return 'inspection'
}

function setViewMode(mode) {
  viewMode.value = mode
  if (route.path === '/inspection') {
    router.replace({ path: '/inspection', query: mode === 'inspection' ? {} : { mode } })
  }
}

function toggleKeyboard() {
  setKeyboardEnabled(!keyboardEnabled.value)
}

function onMappingStarted() {
  activeOperation.value = 'mapping'
  slamMapRef.value?.resetView()
}

function saveWorkspaceMission() {
  const points = [...(activeWaypoint.value ? [activeWaypoint.value] : []), ...waypointQueue.value]
  if (!points.length) return
  const mapPath = selectedScenePath.value
  const mapName = mapPath ? mapPath.split('/').pop().replace(/\.ya?ml$/i, '') : ''
  const draft = {
    name: mapName ? `${mapName}巡检任务` : '新建巡检任务',
    robotId: activeRobot.value?.id || '',
    robotName: activeRobot.value?.name || '',
    map: { id: mapPath, name: mapName, path: mapPath, source: mapPath ? 'api' : '', isDemo: false },
    waypoints: points.map((point, index) => ({
      name: `巡检点 ${index + 1}`,
      pose: { x: point.x, y: point.y, yaw: 0 },
      actions: ['photo'],
      dwellSeconds: 8
    }))
  }
  localStorage.setItem('robot-console-inspection-draft-v1', JSON.stringify(draft))
  router.push('/missions/new')
}

watch(() => route.query.mode, (queryMode) => {
  viewMode.value = resolveInitialMode(queryMode)
})

watch(isConnected, (connected) => {
  if (!connected) setKeyboardEnabled(false)
})

onBeforeUnmount(() => {
  setKeyboardEnabled(false)
})
</script>

<style scoped>
.workspace-page {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.workspace-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border-color);
  background: rgba(11, 22, 38, 0.72);
  flex: 0 0 auto;
}

.workspace-mode-tabs {
  display: inline-flex;
  gap: 4px;
  padding: 3px;
  border: 1px solid var(--border-color);
  border-radius: 9px;
  background: rgba(2, 8, 18, 0.36);
}

.workspace-mode-tabs button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border: 0;
  border-radius: 6px;
  color: var(--text-secondary);
  background: transparent;
  font-size: var(--text-sm);
  cursor: pointer;
  transition: var(--transition);
}

.workspace-mode-tabs button:hover {
  color: var(--text-primary);
}

.workspace-mode-tabs button.active {
  color: var(--text-primary);
  background: var(--bg-elevated);
}

.workspace-mode-tabs button.active svg {
  color: var(--accent-primary);
}

.workspace-toolbar-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.scene-dim-switch {
  display: inline-flex;
  gap: 3px;
  padding: 3px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: rgba(2, 8, 18, 0.36);
}

.scene-dim-switch button {
  height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: 5px;
  color: var(--text-muted);
  background: transparent;
  font-size: var(--text-xs);
  font-weight: 500;
  cursor: pointer;
  transition: var(--transition);
}

.scene-dim-switch button.active {
  color: var(--accent-primary);
  background: rgba(34, 211, 238, 0.12);
}

.keyboard-toggle-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-secondary);
  background: var(--bg-soft);
  font-size: var(--text-xs);
  cursor: pointer;
  transition: var(--transition);
}

.keyboard-toggle-btn.active {
  border-color: rgba(34, 211, 238, 0.45);
  color: var(--accent-primary);
  background: rgba(34, 211, 238, 0.1);
}

.keyboard-live-keys {
  display: inline-flex;
  gap: 4px;
}

.keyboard-live-keys kbd,
.key-grid kbd.pressed {
  display: inline-grid;
  place-items: center;
  min-width: 24px;
  height: 24px;
  padding: 0 5px;
  border: 1px solid var(--border-strong);
  border-radius: 5px;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  font-family: var(--font-mono);
  font-size: 0.72rem;
}

.keyboard-live-keys kbd.pressed,
.key-grid kbd.pressed {
  border-color: var(--accent-primary);
  color: var(--bg-primary);
  background: var(--accent-primary);
}

.workspace-body {
  flex: 1;
  min-height: 0;
}

.cameras-workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 310px;
  gap: 14px;
  padding: 16px;
  overflow: auto;
}

.cameras-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 14px;
  align-content: start;
}

.cameras-sidebar {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

@media (max-width: 1180px) {
  .cameras-workspace {
    grid-template-columns: 1fr;
  }
  .cameras-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 720px) {
  .workspace-toolbar {
    flex-wrap: wrap;
    padding: 10px 12px;
  }
}
</style>
