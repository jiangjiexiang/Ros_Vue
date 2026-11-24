<template>
  <div class="card scene3d-card">
    <div class="card-header scene3d-header">
      <div class="scene3d-title">
        <UiIcon name="layers" :size="18" />
        <div>
          <span>3D SLAM / POINTCLOUD</span>
          <strong>三维点云与导航场景</strong>
        </div>
      </div>

      <div class="scene3d-controls">
        <span class="pts-badge" :class="{ active: pointCount > 0 || mapPointCount > 0 }">
          {{
            mapPointCount > 0
              ? `地图 ${mapPointCount.toLocaleString()} 点 · 实时 ${pointCount} 点`
              : (pointCount > 0 ? `${pointCount} 点` : '等待点云')
          }}
        </span>
        <button
          type="button"
          class="btn-mini"
          :class="{ active: followRobot }"
          title="视角跟随机器狗移动"
          @click="followRobot = !followRobot"
        >
          跟随
        </button>
        <button type="button" class="btn-mini" @click="setTopView">俯视</button>
        <button type="button" class="btn-mini" @click="clearGlobalMap" title="清空累积 3D 点云地图">清空地图</button>
        <button type="button" class="btn-mini" @click="resetCamera">重置 3D</button>
        <button
          v-if="isNavigating"
          type="button"
          class="btn-mini btn-pose"
          :class="{ active: isSettingPose }"
          @click="emit('update:isSettingPose', !isSettingPose)"
        >
          <UiIcon name="crosshair" :size="13" />初始定位
        </button>
      </div>
    </div>

    <div class="scene3d-body">
      <div
        ref="stageRef"
        class="scene3d-stage"
        :style="{ cursor: isSettingPose ? 'crosshair' : 'grab' }"
        @pointerdown="onStagePointerDown"
        @pointermove="onStagePointerMove"
        @pointerup="onStagePointerUp"
        @dblclick="onStageDblClick"
      >
        <div v-if="!connected" class="scene3d-offline-banner">
          离线预览模式 · 连接机器狗或启动 Isaac 仿真后实时渲染 3D 点云与机器狗姿态
        </div>

        <div v-if="isSettingPose" class="scene3d-hint pose">
          在地面按住拖动箭头方向，松开后下发 3D 初始定位 (/initialpose)
        </div>
        <div v-else-if="isNavigating || multiPointMode" class="scene3d-hint goal">
          {{ multiPointMode ? '左键旋转 · 右键平移 · 双击地面连续添加 3D 航点' : '左键旋转 · 右键平移 · 双击地面设定 3D 导航目标' }}
        </div>

        <div class="scene3d-layer-bar">
          <label v-for="item in layerList" :key="item.key" class="layer-pill">
            <input v-model="localLayers[item.key]" type="checkbox">
            <span>{{ item.label }}</span>
          </label>
        </div>

        <div v-if="hoverWorld" class="scene3d-coords">
          X {{ hoverWorld.x.toFixed(2) }} m · Y {{ hoverWorld.y.toFixed(2) }} m
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import UiIcon from './UiIcon.vue'

const props = defineProps({
  connected: { type: Boolean, default: false },
  mapData: { type: Object, default: null },
  scanData: { type: Object, default: null },
  tfData: { type: Object, default: null },
  odomData: { type: Object, default: null },
  planData: { type: Object, default: null },
  pointCloudData: { type: Object, default: null },
  registeredCloudData: { type: Object, default: null },
  fastlioPathData: { type: Object, default: null },
  layers: { type: Object, default: () => ({}) },
  isMapping: { type: Boolean, default: false },
  isNavigating: { type: Boolean, default: false },
  isSettingPose: { type: Boolean, default: false },
  multiPointMode: { type: Boolean, default: false },
  waypoints: { type: Array, default: () => [] },
  activeWaypoint: { type: Object, default: null }
})

const emit = defineEmits([
  'update:isSettingPose',
  'goal-set',
  'waypoint-add',
  'initial-pose-set'
])

const stageRef = ref(null)
const followRobot = ref(false)
const pointCount = ref(0)
const mapPointCount = ref(0)
const hoverWorld = ref(null)

const VOXEL_SIZE = 0.14
const MAX_MAP_POINTS = 100000
const voxelKeys = new Set()
const mapPositions = new Float32Array(MAX_MAP_POINTS * 3)
const mapColors = new Float32Array(MAX_MAP_POINTS * 3)
const MAX_TRAIL_POINTS = 2000
const trailPositions = new Float32Array(MAX_TRAIL_POINTS * 3)
let trailCount = 0
let hasValidRegisteredMap = false
let hasCameraInitAnchor = false
const cameraInitPos = new THREE.Vector3()
const cameraInitQuat = new THREE.Quaternion()

const localLayers = reactive({
  grid: true,
  map: true,
  pointcloud: true,
  registered: true,
  scan: false,
  robot: true,
  path: true,
  goal: true
})

const layerList = [
  { key: 'grid', label: '网格' },
  { key: 'map', label: '2D地图' },
  { key: 'pointcloud', label: '实时扫描' },
  { key: 'registered', label: 'SLAM地图' },
  { key: 'path', label: '轨迹/规划' },
  { key: 'robot', label: '机器狗' }
]

let scene = null
let camera = null
let renderer = null
let controls = null
let animFrameId = null
let resizeObserver = null

let gridHelper = null
let originAxes = null
let mapMesh = null
let mapTexture = null
let liveCloudPoints = null
let regCloudPoints = null
let scanPoints = null
let robotGroup = null
let planLine = null
let trajLine = null
let waypointGroup = null
let poseArrow = null

const raycaster = new THREE.Raycaster()
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
const tfTree = Object.create(null)

let poseDragStart = null
let lastRobotPos = new THREE.Vector3()
let hasRobotPos = false

function composeTransform(a, b) {
  const pa = new THREE.Vector3(a.translation.x, a.translation.y, a.translation.z || 0)
  const qa = new THREE.Quaternion(a.rotation.x, a.rotation.y, a.rotation.z, a.rotation.w)
  const pb = new THREE.Vector3(b.translation.x, b.translation.y, b.translation.z || 0)
  const qb = new THREE.Quaternion(b.rotation.x, b.rotation.y, b.rotation.z, b.rotation.w)

  const pos = pb.clone().applyQuaternion(qa).add(pa)
  const quat = qa.clone().multiply(qb)
  return {
    translation: { x: pos.x, y: pos.y, z: pos.z },
    rotation: { x: quat.x, y: quat.y, z: quat.z, w: quat.w }
  }
}

function lookupTf(fromFrame, toFrame) {
  if (!fromFrame || !toFrame) return null
  if (fromFrame === toFrame) {
    return { translation: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }
  }
  const direct = tfTree[`${fromFrame}|${toFrame}`]
  if (direct) return direct

  // BFS up to depth 4 for chains like map -> odom -> base_link -> base_scan
  const queue = [{ frame: fromFrame, tf: { translation: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } } }]
  const visited = new Set([fromFrame])
  while (queue.length > 0) {
    const current = queue.shift()
    for (const key in tfTree) {
      const [parent, child] = key.split('|')
      if (parent !== current.frame || visited.has(child)) continue
      const composed = composeTransform(current.tf, tfTree[key])
      if (child === toFrame) return composed
      visited.add(child)
      queue.push({ frame: child, tf: composed })
    }
  }
  return null
}

function resolveFrameInMap(frameId) {
  const clean = (frameId || 'map').replace(/^\/+/, '')
  return (
    lookupTf('map', clean) ||
    lookupTf('camera_init', clean) ||
    lookupTf('odom', clean)
  )
}

function heightColorRGB(z) {
  // Smooth cyber gradient: -0.2m (cyan) -> 0.6m (emerald) -> 1.4m (amber) -> 2.4m (coral)
  const t = Math.max(0, Math.min(1, (z + 0.2) / 2.6))
  if (t < 0.33) {
    const k = t / 0.33
    return [0.13 + k * 0.08, 0.82 - k * 0.02, 0.93 - k * 0.33]
  }
  if (t < 0.66) {
    const k = (t - 0.33) / 0.33
    return [0.21 + k * 0.77, 0.80 - k * 0.05, 0.60 - k * 0.45]
  }
  const k = (t - 0.66) / 0.34
  return [0.98, 0.75 - k * 0.32, 0.15 + k * 0.35]
}

function createRobotModel() {
  const group = new THREE.Group()

  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x1e293b,
    metalness: 0.45,
    roughness: 0.35
  })
  const accentMat = new THREE.MeshStandardMaterial({
    color: 0x22d3ee,
    emissive: 0x0891b2,
    emissiveIntensity: 0.45,
    metalness: 0.3,
    roughness: 0.3
  })
  const legMat = new THREE.MeshStandardMaterial({
    color: 0x475569,
    metalness: 0.4,
    roughness: 0.5
  })

  // Torso
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.24, 0.14), bodyMat)
  torso.position.z = 0.28
  group.add(torso)

  // Top accent plate
  const topPlate = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.18, 0.02), accentMat)
  topPlate.position.set(0, 0, 0.36)
  group.add(topPlate)

  // Head / front sensor
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.16, 0.11), accentMat)
  head.position.set(0.30, 0, 0.30)
  group.add(head)

  // Top LiDAR puck
  const lidar = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.06, 18), accentMat)
  lidar.rotation.x = Math.PI / 2
  lidar.position.set(0.15, 0, 0.40)
  group.add(lidar)

  // 4 legs
  const legOffsets = [
    [0.20, 0.13],
    [0.20, -0.13],
    [-0.20, 0.13],
    [-0.20, -0.13]
  ]
  for (const [lx, ly] of legOffsets) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.02, 0.26, 8), legMat)
    leg.rotation.x = Math.PI / 2
    leg.position.set(lx, ly, 0.14)
    group.add(leg)
  }

  const localAxes = new THREE.AxesHelper(0.55)
  localAxes.position.z = 0.02
  group.add(localAxes)

  return group
}

function initThree() {
  const container = stageRef.value
  if (!container) return

  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x050c16)
  scene.fog = new THREE.FogExp2(0x050c16, 0.014)

  const width = Math.max(container.clientWidth, 300)
  const height = Math.max(container.clientHeight, 260)

  camera = new THREE.PerspectiveCamera(52, width / height, 0.05, 160)
  camera.up.set(0, 0, 1)
  camera.position.set(-7.5, -7.5, 6.8)

  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setSize(width, height)
  container.appendChild(renderer.domElement)

  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.maxPolarAngle = Math.PI * 0.485
  controls.minDistance = 1.5
  controls.maxDistance = 65
  controls.target.set(0, 0, 0.2)
  controls.update()

  // Lights
  scene.add(new THREE.AmbientLight(0xdbeafe, 0.85))
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.9)
  dirLight.position.set(8, -10, 16)
  scene.add(dirLight)

  // Grid on XY plane (Z-up)
  gridHelper = new THREE.GridHelper(40, 40, 0x1e3a5f, 0x0f2238)
  gridHelper.rotation.x = Math.PI / 2
  scene.add(gridHelper)

  originAxes = new THREE.AxesHelper(1.2)
  originAxes.position.z = 0.01
  scene.add(originAxes)

  // Live 3D pointcloud (bright current LiDAR sweep)
  const liveGeom = new THREE.BufferGeometry()
  liveCloudPoints = new THREE.Points(
    liveGeom,
    new THREE.PointsMaterial({ size: 0.085, color: 0x38bdf8, opacity: 0.95, transparent: true, sizeAttenuation: true })
  )
  liveCloudPoints.frustumCulled = false
  scene.add(liveCloudPoints)

  // Persistent accumulated 3D SLAM voxel map
  const regGeom = new THREE.BufferGeometry()
  regGeom.setAttribute('position', new THREE.BufferAttribute(mapPositions, 3))
  regGeom.setAttribute('color', new THREE.BufferAttribute(mapColors, 3))
  regGeom.setDrawRange(0, 0)
  regCloudPoints = new THREE.Points(
    regGeom,
    new THREE.PointsMaterial({ size: 0.095, vertexColors: true, opacity: 0.92, transparent: true, sizeAttenuation: true })
  )
  regCloudPoints.frustumCulled = false
  scene.add(regCloudPoints)

  // 2D LaserScan points
  const scanGeom = new THREE.BufferGeometry()
  scanPoints = new THREE.Points(
    scanGeom,
    new THREE.PointsMaterial({ size: 0.075, color: 0xfb7185, sizeAttenuation: true })
  )
  scanPoints.frustumCulled = false
  scene.add(scanPoints)

  // Robot 3D model
  robotGroup = createRobotModel()
  robotGroup.visible = false
  scene.add(robotGroup)

  // Plan & Trajectory lines
  planLine = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0x34d399 })
  )
  planLine.frustumCulled = false
  scene.add(planLine)

  trajLine = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0x38bdf8 })
  )
  trajLine.frustumCulled = false
  scene.add(trajLine)

  // Waypoints group
  waypointGroup = new THREE.Group()
  scene.add(waypointGroup)

  // Initial pose preview arrow
  poseArrow = new THREE.ArrowHelper(
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 0, 0.08),
    1.2,
    0xfbbf24,
    0.32,
    0.2
  )
  poseArrow.visible = false
  scene.add(poseArrow)

  syncLayerVisibility()

  const animate = () => {
    animFrameId = requestAnimationFrame(animate)
    controls.update()
    renderer.render(scene, camera)
  }
  animate()
}

function syncLayerVisibility() {
  if (!scene) return
  if (gridHelper) gridHelper.visible = localLayers.grid
  if (originAxes) originAxes.visible = localLayers.grid
  if (mapMesh) mapMesh.visible = localLayers.map
  if (liveCloudPoints) liveCloudPoints.visible = localLayers.pointcloud
  if (regCloudPoints) regCloudPoints.visible = localLayers.registered
  if (scanPoints) scanPoints.visible = localLayers.scan
  if (robotGroup) robotGroup.visible = localLayers.robot && hasRobotPos
  if (planLine) planLine.visible = localLayers.path
  if (trajLine) trajLine.visible = localLayers.path
  if (waypointGroup) waypointGroup.visible = localLayers.goal
}

function updateOccupancyMap(mapData) {
  if (!scene) return
  if (mapMesh) {
    scene.remove(mapMesh)
    mapMesh.geometry.dispose()
    mapMesh.material.dispose()
    mapTexture?.dispose()
    mapMesh = null
    mapTexture = null
  }
  if (!mapData?.info || !mapData?.data) return

  const { width, height, resolution, origin } = mapData.info
  if (!width || !height) return

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  const img = ctx.createImageData(width, height)
  const cells = mapData.data

  for (let y = 0; y < height; y++) {
    // Flip Y: ROS map row 0 is bottom (y_min), Canvas row 0 is top
    const srcRow = (height - 1 - y) * width
    const dstRow = y * width
    for (let x = 0; x < width; x++) {
      const v = cells[srcRow + x]
      const idx = (dstRow + x) * 4
      if (v === -1) {
        img.data[idx] = 10
        img.data[idx + 1] = 20
        img.data[idx + 2] = 35
        img.data[idx + 3] = 120
      } else if (v === 0) {
        img.data[idx] = 24
        img.data[idx + 1] = 44
        img.data[idx + 2] = 68
        img.data[idx + 3] = 210
      } else {
        img.data[idx] = 226
        img.data[idx + 1] = 232
        img.data[idx + 2] = 240
        img.data[idx + 3] = 245
      }
    }
  }
  ctx.putImageData(img, 0, 0)

  mapTexture = new THREE.CanvasTexture(canvas)
  mapTexture.magFilter = THREE.NearestFilter
  mapTexture.minFilter = THREE.LinearFilter

  const worldW = width * resolution
  const worldH = height * resolution
  const geom = new THREE.PlaneGeometry(worldW, worldH)
  const mat = new THREE.MeshBasicMaterial({
    map: mapTexture,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide
  })
  mapMesh = new THREE.Mesh(geom, mat)
  const ox = origin?.position?.x || 0
  const oy = origin?.position?.y || 0
  mapMesh.position.set(ox + worldW / 2, oy + worldH / 2, 0.004)
  mapMesh.visible = localLayers.map
  scene.add(mapMesh)
}

function decodeRosbridgeCloud(msg) {
  if (!msg || typeof msg.data !== 'string' || !Array.isArray(msg.fields) || !msg.point_step) {
    return null
  }
  const binary = atob(msg.data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const view = new DataView(bytes.buffer)
  const xField = msg.fields.find((f) => f.name === 'x')
  const yField = msg.fields.find((f) => f.name === 'y')
  const zField = msg.fields.find((f) => f.name === 'z')
  if (!xField || !yField || !zField) return null

  const littleEndian = !msg.is_bigendian
  const step = msg.point_step
  const total = Math.min(Math.floor(bytes.length / step), 60000)
  const positions = new Float32Array(total * 3)
  let count = 0
  for (let i = 0; i < total; i++) {
    const base = i * step
    const x = xField.datatype === 8 ? view.getFloat64(base + xField.offset, littleEndian) : view.getFloat32(base + xField.offset, littleEndian)
    const y = yField.datatype === 8 ? view.getFloat64(base + yField.offset, littleEndian) : view.getFloat32(base + yField.offset, littleEndian)
    const z = zField.datatype === 8 ? view.getFloat64(base + zField.offset, littleEndian) : view.getFloat32(base + zField.offset, littleEndian)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
    positions[count * 3] = x
    positions[count * 3 + 1] = y
    positions[count * 3 + 2] = z
    count += 1
  }
  return { positions: positions.subarray(0, count * 3), count }
}

function clearGlobalMap() {
  voxelKeys.clear()
  mapPointCount.value = 0
  hasValidRegisteredMap = false
  hasCameraInitAnchor = false
  trailCount = 0
  if (regCloudPoints) {
    regCloudPoints.geometry.setDrawRange(0, 0)
  }
  if (trajLine) {
    trajLine.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3))
  }
}

function appendToGlobalMap(positions, count, posVec, quat) {
  if (!regCloudPoints || count <= 0) return
  const pt = new THREE.Vector3()
  let added = 0
  const invVoxel = 1 / VOXEL_SIZE

  for (let i = 0; i < count; i++) {
    if (mapPointCount.value >= MAX_MAP_POINTS) break
    pt.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2])
    if (quat) pt.applyQuaternion(quat)
    if (posVec) pt.add(posVec)

    // Guard against diverged SLAM frames
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y) || !Number.isFinite(pt.z)) continue
    if (Math.abs(pt.x) > 250 || Math.abs(pt.y) > 250 || pt.z < -10 || pt.z > 60) continue

    const vx = Math.round(pt.x * invVoxel)
    const vy = Math.round(pt.y * invVoxel)
    const vz = Math.round(pt.z * invVoxel)
    const key = `${vx},${vy},${vz}`
    if (voxelKeys.has(key)) continue
    voxelKeys.add(key)

    const idx = mapPointCount.value * 3
    mapPositions[idx] = pt.x
    mapPositions[idx + 1] = pt.y
    mapPositions[idx + 2] = pt.z

    const [r, g, b] = heightColorRGB(pt.z)
    mapColors[idx] = r
    mapColors[idx + 1] = g
    mapColors[idx + 2] = b

    mapPointCount.value += 1
    added += 1
  }

  if (added > 0) {
    regCloudPoints.geometry.attributes.position.needsUpdate = true
    regCloudPoints.geometry.attributes.color.needsUpdate = true
    regCloudPoints.geometry.setDrawRange(0, mapPointCount.value)
  }
}

function updatePointCloudMesh(pointsObj, cloudMsg, isPrimary = false) {
  if (!pointsObj) return
  if (!cloudMsg) {
    if (isPrimary) {
      pointsObj.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3))
      pointCount.value = 0
    }
    return
  }

  let positions = cloudMsg.positions
  let count = cloudMsg.count
  if (!(positions instanceof Float32Array)) {
    const decoded = decodeRosbridgeCloud(cloudMsg)
    if (!decoded) return
    positions = decoded.positions
    count = decoded.count
  }

  const frameId = (cloudMsg.header?.frame_id || (isPrimary ? 'base_scan' : 'camera_init')).replace(/^\/+/, '')
  const isWorldFrame = frameId === 'map' || frameId === 'camera_init' || frameId === 'odom'
  const tf = isWorldFrame ? null : resolveFrameInMap(frameId)

  const posVec = new THREE.Vector3()
  const quat = new THREE.Quaternion()
  if (tf) {
    posVec.set(tf.translation.x, tf.translation.y, tf.translation.z || 0)
    quat.set(tf.rotation.x, tf.rotation.y, tf.rotation.z, tf.rotation.w)
  } else if (!isWorldFrame && hasRobotPos) {
    posVec.copy(robotGroup.position)
    posVec.z += 0.2
    quat.copy(robotGroup.quaternion)
  }

  if (isPrimary) {
    pointCount.value = count
    pointsObj.position.copy(posVec)
    pointsObj.quaternion.copy(quat)
    pointsObj.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    pointsObj.geometry.computeBoundingSphere()

    // Fallback accumulation from live /points if FAST-LIO registered cloud hasn't provided valid points
    if (!hasValidRegisteredMap && (tf || hasRobotPos)) {
      appendToGlobalMap(positions, count, posVec, quat)
    }
    return
  }

  // Registered cloud from FAST-LIO: check bounds before accepting into global voxel map
  let validCount = 0
  const checkLimit = Math.min(count, 30)
  for (let i = 0; i < checkLimit; i++) {
    const x = positions[i * 3]
    const y = positions[i * 3 + 1]
    const z = positions[i * 3 + 2]
    if (Math.abs(x) < 250 && Math.abs(y) < 250 && z > -10 && z < 60) validCount += 1
  }
  if (validCount > 0) {
    if (!hasCameraInitAnchor && hasRobotPos) {
      cameraInitPos.copy(robotGroup.position)
      cameraInitQuat.copy(robotGroup.quaternion)
      hasCameraInitAnchor = true
    }
    hasValidRegisteredMap = true
    if (tf) {
      appendToGlobalMap(positions, count, posVec, quat)
    } else if (hasCameraInitAnchor) {
      appendToGlobalMap(positions, count, cameraInitPos, cameraInitQuat)
    } else {
      appendToGlobalMap(positions, count, null, null)
    }
  } else if (count > 0) {
    hasValidRegisteredMap = false
  }
}

function updateLaserScan(scanMsg) {
  if (!scanPoints) return
  if (!scanMsg || !Array.isArray(scanMsg.ranges)) {
    scanPoints.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3))
    return
  }

  const tf = resolveFrameInMap(scanMsg.header?.frame_id || 'base_scan')
  if (tf) {
    scanPoints.position.set(tf.translation.x, tf.translation.y, tf.translation.z || 0)
    scanPoints.quaternion.set(tf.rotation.x, tf.rotation.y, tf.rotation.z, tf.rotation.w)
  } else if (hasRobotPos) {
    scanPoints.position.set(robotGroup.position.x, robotGroup.position.y, robotGroup.position.z + 0.2)
    scanPoints.quaternion.copy(robotGroup.quaternion)
  }

  const ranges = scanMsg.ranges
  const positions = new Float32Array(ranges.length * 3)
  let count = 0
  const rMin = scanMsg.range_min || 0.05
  const rMax = scanMsg.range_max || 20.0
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i]
    if (!Number.isFinite(r) || r < rMin || r > rMax) continue
    const angle = scanMsg.angle_min + i * scanMsg.angle_increment
    positions[count * 3] = r * Math.cos(angle)
    positions[count * 3 + 1] = r * Math.sin(angle)
    positions[count * 3 + 2] = 0
    count += 1
  }
  scanPoints.geometry.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, count * 3), 3))
}

function updateRobotPoseFromTfOrOdom() {
  if (!robotGroup) return
  const tf =
    lookupTf('map', 'base_link') ||
    lookupTf('map', 'base_footprint') ||
    lookupTf('camera_init', 'body') ||
    lookupTf('odom', 'base_link')

  let px = null
  let py = null
  let pz = 0
  let q = null

  if (tf) {
    px = tf.translation.x
    py = tf.translation.y
    pz = tf.translation.z || 0
    q = tf.rotation
  } else if (props.odomData?.pose?.pose) {
    const p = props.odomData.pose.pose.position
    px = p.x
    py = p.y
    pz = p.z || 0
    q = props.odomData.pose.pose.orientation
  }

  if (px === null || py === null) return

  // In Isaac Sim / ROS, base_link Z is already torso height (~0.32m) or 0m on 2D; clamp visually to ground if ~0
  const visualZ = pz > 0.08 ? Math.max(0, pz - 0.28) : 0
  const nextPos = new THREE.Vector3(px, py, visualZ)

  if (followRobot.value && hasRobotPos && camera && controls) {
    const delta = nextPos.clone().sub(lastRobotPos)
    camera.position.add(delta)
    controls.target.add(delta)
  }

  robotGroup.position.copy(nextPos)
  if (q) {
    robotGroup.quaternion.set(q.x, q.y, q.z, q.w)
  }
  lastRobotPos.copy(nextPos)
  hasRobotPos = true
  robotGroup.visible = localLayers.robot

  // Append to live SLAM trajectory trail if FAST-LIO path isn't active
  if (trajLine && (!props.fastlioPathData?.poses?.length)) {
    const lastIdx = (trailCount - 1) * 3
    const dist = trailCount === 0
      ? 1
      : Math.hypot(nextPos.x - trailPositions[lastIdx], nextPos.y - trailPositions[lastIdx + 1])
    if (dist > 0.08 && trailCount < MAX_TRAIL_POINTS) {
      const idx = trailCount * 3
      trailPositions[idx] = nextPos.x
      trailPositions[idx + 1] = nextPos.y
      trailPositions[idx + 2] = nextPos.z + 0.05
      trailCount += 1
      trajLine.geometry.setAttribute('position', new THREE.BufferAttribute(trailPositions.subarray(0, trailCount * 3), 3))
    }
  }
}

function updatePathLine(lineObj, pathMsg, zLift) {
  if (!lineObj) return
  const poses = pathMsg?.poses
  if (!Array.isArray(poses) || poses.length === 0) {
    lineObj.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3))
    return
  }
  const positions = new Float32Array(poses.length * 3)
  let count = 0
  for (let i = 0; i < poses.length; i++) {
    const p = poses[i].pose?.position || poses[i].position
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
    if (Math.abs(p.x) > 250 || Math.abs(p.y) > 250 || Math.abs(p.z || 0) > 60) continue
    positions[count * 3] = p.x
    positions[count * 3 + 1] = p.y
    positions[count * 3 + 2] = (p.z || 0) + zLift
    count += 1
  }
  if (count === 0) return
  if (lineObj === trajLine && pathMsg?.header?.frame_id?.includes('camera_init') && hasCameraInitAnchor) {
    lineObj.position.copy(cameraInitPos)
    lineObj.quaternion.copy(cameraInitQuat)
  } else {
    lineObj.position.set(0, 0, 0)
    lineObj.quaternion.identity()
  }
  lineObj.geometry.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, count * 3), 3))
}

function rebuildWaypoints() {
  if (!waypointGroup) return
  while (waypointGroup.children.length > 0) {
    const child = waypointGroup.children[0]
    waypointGroup.remove(child)
    child.geometry?.dispose()
    child.material?.dispose()
  }

  const all = [...(props.waypoints || [])]
  if (props.activeWaypoint) all.unshift(props.activeWaypoint)

  for (let i = 0; i < all.length; i++) {
    const wp = all[i]
    const isActive = i === 0 && props.activeWaypoint
    const color = isActive ? 0x34d399 : 0xfbbf24

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.18, 0.28, 24),
      new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide })
    )
    ring.position.set(wp.x, wp.y, 0.02)
    waypointGroup.add(ring)

    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, 0.65, 10),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 })
    )
    pillar.rotation.x = Math.PI / 2
    pillar.position.set(wp.x, wp.y, 0.34)
    waypointGroup.add(pillar)
  }
}

function pickGroundPoint(event) {
  if (!renderer || !camera) return null
  const rect = renderer.domElement.getBoundingClientRect()
  const ndc = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  )
  raycaster.setFromCamera(ndc, camera)
  const hit = new THREE.Vector3()
  return raycaster.ray.intersectPlane(groundPlane, hit) ? hit : null
}

function onStagePointerDown(event) {
  if (!props.isSettingPose || event.button !== 0) return
  const pt = pickGroundPoint(event)
  if (!pt) return
  poseDragStart = pt
  if (controls) controls.enabled = false
  poseArrow.position.set(pt.x, pt.y, 0.08)
  poseArrow.setDirection(new THREE.Vector3(1, 0, 0))
  poseArrow.visible = true
}

function onStagePointerMove(event) {
  const pt = pickGroundPoint(event)
  hoverWorld.value = pt ? { x: pt.x, y: pt.y } : null
  if (props.isSettingPose && poseDragStart && pt) {
    const dir = new THREE.Vector3(pt.x - poseDragStart.x, pt.y - poseDragStart.y, 0)
    if (dir.length() > 0.05) {
      poseArrow.setDirection(dir.normalize())
    }
  }
}

function onStagePointerUp(event) {
  if (!props.isSettingPose || !poseDragStart) return
  const pt = pickGroundPoint(event) || poseDragStart
  const dx = pt.x - poseDragStart.x
  const dy = pt.y - poseDragStart.y
  const yaw = Math.hypot(dx, dy) > 0.05 ? Math.atan2(dy, dx) : 0
  emit('initial-pose-set', { x: poseDragStart.x, y: poseDragStart.y, yaw })
  poseDragStart = null
  poseArrow.visible = false
  if (controls) controls.enabled = true
}

function onStageDblClick(event) {
  if (!props.connected || props.isSettingPose) return
  const pt = pickGroundPoint(event)
  if (!pt) return
  if (props.multiPointMode) {
    emit('waypoint-add', { x: pt.x, y: pt.y })
  } else {
    emit('goal-set', { x: pt.x, y: pt.y })
  }
}

function resetCamera() {
  if (!camera || !controls) return
  const target = hasRobotPos ? lastRobotPos : new THREE.Vector3(0, 0, 0.2)
  controls.target.set(target.x, target.y, 0.2)
  camera.position.set(target.x - 6.5, target.y - 6.5, 5.8)
  controls.update()
}

function setTopView() {
  if (!camera || !controls) return
  const target = hasRobotPos ? lastRobotPos : new THREE.Vector3(0, 0, 0)
  controls.target.set(target.x, target.y, 0)
  camera.position.set(target.x, target.y - 0.01, 14)
  controls.update()
}

watch(() => props.isSettingPose, (setting) => {
  if (controls) controls.enabled = !setting
  if (!setting && poseArrow) poseArrow.visible = false
})

watch(() => props.tfData, (newData) => {
  if (!newData?.transforms) return
  for (const tf of newData.transforms) {
    const key = `${tf.header.frame_id}|${tf.child_frame_id}`
    tfTree[key] = tf.transform
  }
  updateRobotPoseFromTfOrOdom()
  if (props.scanData) {
    const tf = resolveFrameInMap(props.scanData.header?.frame_id || 'base_scan')
    if (tf && scanPoints) {
      scanPoints.position.set(tf.translation.x, tf.translation.y, tf.translation.z || 0)
      scanPoints.quaternion.set(tf.rotation.x, tf.rotation.y, tf.rotation.z, tf.rotation.w)
    }
  }
})

watch(() => props.odomData, updateRobotPoseFromTfOrOdom)
watch(() => props.mapData, updateOccupancyMap)
watch(() => props.scanData, updateLaserScan)
watch(() => props.pointCloudData, (msg) => updatePointCloudMesh(liveCloudPoints, msg, true))
watch(() => props.registeredCloudData, (msg) => updatePointCloudMesh(regCloudPoints, msg, false))
watch(() => props.planData, (msg) => updatePathLine(planLine, msg, 0.06))
watch(() => props.fastlioPathData, (msg) => updatePathLine(trajLine, msg, 0.04))
watch([() => props.waypoints, () => props.activeWaypoint], rebuildWaypoints, { deep: true })
watch(localLayers, syncLayerVisibility, { deep: true })

function exportGlobalMapPoints() {
  return Array.from(mapPositions.subarray(0, mapPointCount.value * 3))
}

defineExpose({
  clearGlobalMap,
  exportGlobalMapPoints
})

onMounted(() => {
  initThree()
  if (props.mapData) updateOccupancyMap(props.mapData)
  if (props.scanData) updateLaserScan(props.scanData)
  if (props.pointCloudData) updatePointCloudMesh(liveCloudPoints, props.pointCloudData, true)
  if (props.registeredCloudData) updatePointCloudMesh(regCloudPoints, props.registeredCloudData, false)
  if (props.planData) updatePathLine(planLine, props.planData, 0.06)
  if (props.fastlioPathData) updatePathLine(trajLine, props.fastlioPathData, 0.04)
  updateRobotPoseFromTfOrOdom()
  rebuildWaypoints()

  resizeObserver = new ResizeObserver(() => {
    const container = stageRef.value
    if (!container || !renderer || !camera) return
    const w = Math.max(container.clientWidth, 1)
    const h = Math.max(container.clientHeight, 1)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h)
  })
  if (stageRef.value) resizeObserver.observe(stageRef.value)
})

onBeforeUnmount(() => {
  if (animFrameId) cancelAnimationFrame(animFrameId)
  resizeObserver?.disconnect()
  controls?.dispose()
  mapTexture?.dispose()
  renderer?.dispose()
  if (renderer?.domElement?.parentNode) {
    renderer.domElement.parentNode.removeChild(renderer.domElement)
  }
})
</script>

<style scoped>
.scene3d-card {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 360px;
}

.scene3d-header {
  gap: 10px;
  min-height: 50px;
  padding: 0 14px;
}

.scene3d-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.scene3d-title span {
  display: block;
  color: var(--accent-primary);
  font-family: var(--font-mono);
  font-size: 0.68rem;
  letter-spacing: 0.06em;
}

.scene3d-title strong {
  display: block;
  color: var(--text-primary);
  font-size: var(--text-sm);
  font-weight: 600;
}

.scene3d-controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.pts-badge {
  padding: 3px 8px;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  color: var(--text-muted);
  background: var(--bg-soft);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

.pts-badge.active {
  border-color: rgba(52, 211, 153, 0.3);
  color: var(--success);
  background: rgba(52, 211, 153, 0.08);
}

.btn-mini {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 9px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-secondary);
  background: var(--bg-soft);
  font-size: var(--text-xs);
  cursor: pointer;
}

.btn-mini:hover {
  border-color: var(--accent-primary);
  color: var(--accent-primary);
}

.btn-mini.active {
  border-color: rgba(34, 211, 238, 0.45);
  color: var(--accent-primary);
  background: rgba(34, 211, 238, 0.12);
}

.scene3d-body {
  position: relative;
  flex: 1;
  min-height: 0;
}

.scene3d-stage {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 360px;
  overflow: hidden;
  background: #050c16;
}

.scene3d-offline-banner {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 4;
  padding: 6px 12px;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  color: var(--text-secondary);
  background: rgba(7, 17, 31, 0.84);
  font-size: var(--text-xs);
  white-space: nowrap;
  pointer-events: none;
}

.scene3d-hint {
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 4;
  padding: 6px 11px;
  border-radius: 7px;
  font-size: var(--text-xs);
  pointer-events: none;
}

.scene3d-hint.goal {
  border: 1px solid rgba(34, 211, 238, 0.3);
  color: var(--accent-primary);
  background: rgba(7, 17, 31, 0.85);
}

.scene3d-hint.pose {
  border: 1px solid rgba(251, 191, 36, 0.35);
  color: var(--warning);
  background: rgba(7, 17, 31, 0.88);
}

.scene3d-layer-bar {
  position: absolute;
  left: 12px;
  bottom: 10px;
  z-index: 4;
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  padding: 5px 7px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: rgba(7, 17, 31, 0.82);
  backdrop-filter: blur(8px);
}

.layer-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 6px;
  border-radius: 5px;
  color: var(--text-secondary);
  font-size: var(--text-xs);
  cursor: pointer;
}

.layer-pill input {
  accent-color: var(--accent-primary);
}

.scene3d-coords {
  position: absolute;
  right: 12px;
  bottom: 10px;
  z-index: 4;
  padding: 5px 9px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-secondary);
  background: rgba(7, 17, 31, 0.82);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  pointer-events: none;
}
</style>
