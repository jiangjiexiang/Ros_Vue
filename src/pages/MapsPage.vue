<template>
  <main class="task-page">
    <nav class="task-tabs">
      <button :class="{ active: activeOperation === 'maps' }" @click="activeOperation = 'maps'">
        <UiIcon name="layers" :size="19" />
        <span><strong>地图与场景</strong><small>编辑栅格、切换和管理场景</small></span>
      </button>
      <button :class="{ active: activeOperation === 'mapping' }" @click="activeOperation = 'mapping'">
        <UiIcon name="map" :size="19" />
        <span><strong>建图任务</strong><small>启动 SLAM 并保存环境地图</small></span>
        <i v-if="mappingActive"></i>
      </button>
      <button :class="{ active: activeOperation === 'navigation' }" @click="activeOperation = 'navigation'">
        <UiIcon name="route" :size="19" />
        <span><strong>导航任务</strong><small>选择场景、定位并设置目标</small></span>
        <i v-if="navigationActive"></i>
      </button>
    </nav>

    <section v-if="activeOperation === 'maps'" class="card task-map-manager">
      <MapManager @changed="mapsRevision++" @select="selectScene" />
    </section>

    <div v-else class="task-layout">
      <section class="card task-control-panel">
        <div class="operations-heading">
          <h2>{{ activeOperation === 'mapping' ? '建图任务' : '导航任务' }}</h2>
          <span class="operation-state" :class="{ active: mappingActive || navigationActive }">
            {{ mappingActive ? '建图中' : navigationActive ? '导航中' : '待机' }}
          </span>
        </div>
        <MappingControl
          v-show="activeOperation === 'mapping'"
          :connected="isConnected"
          :simulationScene="activeRobot?.simulationScene || ''"
          v-model:isMapping="mappingActive"
          @mappingStarted="onMappingStarted"
        />
        <NavigationControl
          v-show="activeOperation === 'navigation'"
          :connected="isConnected"
          :mapsRevision="mapsRevision"
          :simulationScene="activeRobot?.simulationScene || ''"
          v-model:selectedMap="selectedScenePath"
          v-model:isNavigating="navigationActive"
          v-model:isSettingPose="isSettingPose"
          v-model:multiPointMode="multiPointMode"
          :waypointCount="waypointCount"
          @navigationStarted="activeOperation = 'navigation'"
          @clear-waypoints="clearWaypoints"
          @save-mission="saveWorkspaceMission"
        />
      </section>

      <SlamMap
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
    </div>
  </main>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import MapManager from '../components/MapManager.vue'
import MappingControl from '../components/MappingControl.vue'
import NavigationControl from '../components/NavigationControl.vue'
import SlamMap from '../components/SlamMap.vue'
import UiIcon from '../components/UiIcon.vue'
import { useRobotStore } from '../stores/robotStore.js'
import { useRosSessionStore } from '../stores/rosSessionStore.js'

const router = useRouter()
const slamMapRef = ref(null)

const { activeRobot } = useRobotStore()
const {
  activeOperation,
  mapsRevision,
  selectedScenePath,
  mappingActive,
  navigationActive,
  isSettingPose,
  multiPointMode,
  waypointQueue,
  activeWaypoint,
  waypointCount,
  mapData,
  scanData,
  tfData,
  planData,
  navFeedback,
  mapLayers,
  isConnected,
  onGoalSet,
  onWaypointAdd,
  onWaypointReached,
  clearWaypoints,
  onInitialPoseSet
} = useRosSessionStore()

function selectScene(map) {
  selectedScenePath.value = map.path
  activeOperation.value = 'navigation'
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
</script>
