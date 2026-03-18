<template>
  <div class="card map-card">
    <div class="card-header">
      <div class="header-left">
        SLAM 栅格地图
      </div>
      <div class="header-right">
        <!-- 导航特有控件 -->
        <template v-if="isNavigating">
          <span class="nav-status-mini">导航中</span>
          <button class="btn-mini btn-mini-pose" :class="{ 'active': isSettingPose }" @click="togglePoseMode">
            设置初始位置
          </button>
        </template>

        <button v-if="isMapping" class="btn-mini btn-mini-save" @click="openSaveDialog" :disabled="isSaving">
          {{ isSaving ? '保存中...' : '保存地图' }}
        </button>
        <button v-if="hasMap || isLidar3DMode" class="btn-mini" @click="resetView">重置视图</button>
      </div>
    </div>
    <div class="card-body">
      <div 
        v-if="shouldShowCanvas" 
        class="map-canvas-container"
        ref="containerRef"
        @wheel.prevent="onWheel"
        @mousedown="onMouseDown"
        @mousemove="onMouseMove"
        @mouseup="onMouseUp"
        @mouseleave="onMouseUp"
        @touchstart.passive="onTouchStart"
        @touchmove.prevent="onTouchMove"
        @touchend="onMouseUp"
        @dblclick="onDblClick"
        :style="{ cursor: canvasCursor }"
      >
        <canvas ref="mapCanvasRef" />
        <div class="map-info">
          <span v-if="isLidar3DMode">3D点云 | Yaw: {{ lidarYawDeg }}° | Pitch: {{ lidarPitchDeg }}° | Zoom: {{ lidarDistance.toFixed(1) }}</span>
          <span v-else-if="mapInfo">{{ mapInfo.width }} × {{ mapInfo.height }} | 缩放: {{ (scale * 100).toFixed(0) }}%</span>
          <span v-else>无地图模式 | 缩放: {{ (scale * 100).toFixed(0) }}%</span>
        </div>
        
        <!-- 悬浮操作提示 -->
        <div v-if="isNavigating && !isSettingPose && !isLidar3DMode" class="map-overlay-hint hint-goal">
          {{ multiPointMode ? '双击地图可连续添加航点' : '双击地图设定导航目标点' }}
        </div>
        <div v-if="isSettingPose && !isLidar3DMode" class="map-overlay-hint hint-pose">
          按住地图拖动以设定初始位置和朝向
        </div>

        <!-- 导航实时反馈面板 -->
        <div v-if="isNavigating && !isLidar3DMode" class="map-overlay-feedback">
          <div class="feedback-item">
            <span class="fb-label">剩余距离</span>
            <span class="fb-value">{{ formattedDistance }}</span>
          </div>
          <div class="feedback-item">
            <span class="fb-label">预计时间</span>
            <span class="fb-value">{{ formattedETA }}</span>
          </div>
          <div v-if="!hasNavFeedback" class="fb-waiting">等待导航反馈...</div>
        </div>
      </div>
      <div v-else class="map-placeholder">
        <p v-if="!connected">请先连接机器人</p>
        <p v-else>等待地图或雷达数据...</p>
      </div>

      <!-- 保存状态提示 -->
      <div v-if="saveMsg" class="save-toast" :class="saveSuccess ? 'save-toast-ok' : 'save-toast-err'">
        {{ saveMsg }}
      </div>
      
      <!-- 初始位置设置成功提示 -->
      <div v-if="settingMsg" class="save-toast save-toast-ok">
        {{ settingMsg }}
      </div>

      <!-- 单点导航到达提示 -->
      <div v-if="arriveMsg" class="save-toast save-toast-ok">
        {{ arriveMsg }}
      </div>
    </div>

    <!-- 保存地图对话框 -->
    <Teleport to="body">
      <div v-if="showSaveDialog" class="modal-overlay" @click.self="showSaveDialog = false">
        <div class="modal-box">
          <h3 class="modal-title">保存地图</h3>
          <p class="modal-desc">请输入要保存的地图名称：</p>
          <input
            ref="mapNameInputRef"
            v-model="mapNameInput"
            class="modal-input"
            type="text"
            placeholder="例如: my_room_map"
            @keydown.enter="confirmSave"
            @keydown.esc="showSaveDialog = false"
            maxlength="64"
          />
          <div class="modal-actions">
            <button class="btn-modal-cancel" @click="showSaveDialog = false">取消</button>
            <button class="btn-modal-confirm" @click="confirmSave" :disabled="!mapNameInput.trim()">确认保存</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue'

const props = defineProps({
  connected: Boolean,
  mapData: Object,
  scanData: Object,
  lidarData: Object,
  tfData: Object,
  planData: Object,
  isMapping: Boolean,
  isNavigating: Boolean,
  isSettingPose: Boolean,
  multiPointMode: Boolean,
  waypoints: {
    type: Array,
    default: () => []
  },
  activeWaypoint: {
    type: Object,
    default: null
  },
  navFeedback: Object,
  layers: {
    type: Object,
    default: () => ({ map: true, scan: true, lidar: true, robot: true, path: true, goal: true })
  }
})

// === 保存地图 ===
const showSaveDialog = ref(false)
const mapNameInput = ref('')
const mapNameInputRef = ref(null)
const isSaving = ref(false)
const saveMsg = ref('')
const saveSuccess = ref(false)
const API_BASE = `http://${window.location.hostname}:3000/api`

// === 导航 ===
const goalPoint = ref(null)  // { x, y } in world (map) coords
const navPathPoints = ref([])  // Array of { x, y }

// === 初始位置 ===
const poseAnchor = ref(null)  // { x, y } 按下位置 (世界坐标)
const poseDrag = ref(null)    // { x, y } 拖动尾端 (世界坐标)
const settingMsg = ref('')
const arriveMsg = ref('')
const singleGoalReachedNotified = ref(false)

const emit = defineEmits(['goal-set', 'waypoint-add', 'waypoint-reached', 'initial-pose-set', 'update:isSettingPose'])
const waypointReachThreshold = 0.10
const reachedWaypointKey = ref('')

// === 导航反馈计算 ===
const formattedETA = computed(() => {
  if (!props.navFeedback || !props.navFeedback.estimated_time_remaining) return '-- s'
  const time = props.navFeedback.estimated_time_remaining
  const totalSeconds = time.sec + time.nanosec / 1e9
  if (totalSeconds < 0 || totalSeconds > 3600) return '-- s' // 过滤异常值
  return totalSeconds.toFixed(1) + ' s'
})

const formattedDistance = computed(() => {
  const feedbackDistance = props.navFeedback?.distance_remaining

  let poseDistance = null
  const target = props.multiPointMode ? props.activeWaypoint : goalPoint.value
  if (robotPose.value && target) {
    const dx = robotPose.value.x - target.x
    const dy = robotPose.value.y - target.y
    poseDistance = Math.sqrt(dx * dx + dy * dy)
  }

  const candidates = []
  if (typeof feedbackDistance === 'number' && Number.isFinite(feedbackDistance)) {
    candidates.push(feedbackDistance)
  }
  if (typeof poseDistance === 'number' && Number.isFinite(poseDistance)) {
    candidates.push(poseDistance)
  }
  if (candidates.length === 0) return '-- m'

  // 非常接近目标时显示 0，避免浮点抖动
  const minDistance = Math.min(...candidates)
  if (minDistance <= 0.03) return '0.00 m'
  return minDistance.toFixed(2) + ' m'
})

const hasNavFeedback = computed(() => {
  if (typeof props.navFeedback?.distance_remaining === 'number') return true
  const target = props.multiPointMode ? props.activeWaypoint : goalPoint.value
  return !!(robotPose.value && target)
})

function togglePoseMode() {
  emit('update:isSettingPose', !props.isSettingPose)
}

async function openSaveDialog() {
  mapNameInput.value = ''
  saveMsg.value = ''
  showSaveDialog.value = true
  await nextTick()
  mapNameInputRef.value?.focus()
}

async function confirmSave() {
  const name = mapNameInput.value.trim()
  if (!name) return
  showSaveDialog.value = false
  isSaving.value = true
  saveMsg.value = ''
  try {
    const res = await fetch(`${API_BASE}/save_map`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mapName: name })
    })
    const data = await res.json()
    saveSuccess.value = data.success
    saveMsg.value = data.success ? `地图已保存: ${name}` : `${data.error}`
  } catch (err) {
    saveSuccess.value = false
    saveMsg.value = '无法连接到本地控制服务'
  } finally {
    isSaving.value = false
    setTimeout(() => { saveMsg.value = '' }, 5000)
  }
}

const containerRef = ref(null)
const mapCanvasRef = ref(null)
const mapInfo = ref(null)

// 离屏 Canvas，用于存储渲染好的地图图像
let offscreenCanvas = null

// 视图变换状态
const scale = ref(1.0)
const offsetX = ref(0)
const offsetY = ref(0)

// 机器人与雷达状态
const robotPose = ref(null) // { x, y, yaw } in map frame
const laserPoints = ref([]) // Array of { x, y } in map frame
const pointCloudPoints = ref([]) // Array of { x, y, z } in lidar frame
const sensorOffset = ref({ x: 0, y: 0, yaw: 0 }) // { x, y, yaw } from base_link to sensor

// 3D 点云视角状态（仿 RViz 交互）
const lidarYaw = ref(0.8)
const lidarPitch = ref(0.55)
const lidarDistance = ref(8)
const lidarCenter = ref({ x: 0, y: 0, z: 0 })
const lidarPointSize = ref(2.2)
const lidarPanX = ref(0)
const lidarPanY = ref(0)

// 交互状态
let isDragging = false
let lastMouseX = 0
let lastMouseY = 0
let lidarDragMode = null // 'rotate' | 'pan'

const shouldShowCanvas = computed(() => {
  return props.connected && (props.mapData || props.scanData || props.tfData || (props.layers.lidar && props.lidarData))
})

const isLidar3DMode = computed(() => Boolean(props.layers.lidar && props.lidarData))
const lidarYawDeg = computed(() => Math.round((lidarYaw.value * 180) / Math.PI))
const lidarPitchDeg = computed(() => Math.round((lidarPitch.value * 180) / Math.PI))
const canvasCursor = computed(() => {
  if (isLidar3DMode.value) return isDragging ? 'grabbing' : 'grab'
  if (props.isSettingPose) return 'crosshair'
  if (props.isNavigating) return 'crosshair'
  return isDragging ? 'grabbing' : 'grab'
})
const ROBOT_MARKER_COLOR = '#00d4ff'

const hasMap = computed(() => {
  return props.mapData && props.mapData.info && props.mapData.data
})

/**
 * 获取当前的坐标系信息。如果有地图用地图的，没有则用虚拟的。
 */
function getEffectiveMapInfo() {
  if (props.mapData && props.mapData.info) {
    return props.mapData.info
  }
  // 虚拟坐标系：500x500 像素，0.05米分辨率 (25m x 25m 区域)
  // 原点设在中心 (12.5m, 12.5m)
  return {
    width: 500,
    height: 500,
    resolution: 0.05,
    origin: {
      position: { x: -12.5, y: -12.5, z: 0 }
    }
  }
}

/**
 * 将 OccupancyGrid 原始数据生成图像到离屏 Canvas
 */
function updateOffscreenCanvas(occupancyGrid) {
  const info = occupancyGrid.info
  const data = occupancyGrid.data
  const width = info.width
  const height = info.height

  if (!width || !height || !data || data.length === 0) return

  if (!offscreenCanvas) {
    offscreenCanvas = document.createElement('canvas')
  }
  offscreenCanvas.width = width
  offscreenCanvas.height = height

  const ctx = offscreenCanvas.getContext('2d')
  const imageData = ctx.createImageData(width, height)
  const pixels = imageData.data

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rosIdx = y * width + x
      const val = data[rosIdx]
      const canvasIdx = ((height - 1 - y) * width + x) * 4
      
      let r, g, b
      if (val === -1) { r = 60; g = 60; b = 65 }
      else if (val === 0) { r = 240; g = 240; b = 245 }
      else if (val === 100) { r = 30; g = 30; b = 40 }
      else {
        const intensity = 255 - Math.round((val / 100) * 180)
        r = g = b = intensity
      }
      pixels[canvasIdx] = r
      pixels[canvasIdx + 1] = g
      pixels[canvasIdx + 2] = b
      pixels[canvasIdx + 3] = 255
    }
  }
  ctx.putImageData(imageData, 0, 0)
  
  mapInfo.value = { width, height, resolution: info.resolution }
  
  if (scale.value === 1.0 && offsetX.value === 0) {
    autoFit()
  } else {
    requestDraw()
  }
}

/**
 * 转换世界坐标 (米) 到地图图像像素坐标

 */
function worldToPixel(wx, wy) {
  const info = getEffectiveMapInfo()
  const origin = info.origin.position
  const ori = info.origin.orientation
  const res = info.resolution
  
  // 1. 相对于 origin 的平移偏移 (米)
  let dx = wx - origin.x
  let dy = wy - origin.y
  
  // 2. 处理地图原点本身可能有旋转的情况 (虽然大多数地图原点不旋转)
  if (ori && (Math.abs(ori.z) > 0.001 || Math.abs(ori.w - 1) > 0.001)) {
    const mapYaw = Math.atan2(2 * (ori.w * ori.z + ori.x * ori.y), 1 - 2 * (ori.y * ori.y + ori.z * ori.z))
    const cosY = Math.cos(-mapYaw)
    const sinY = Math.sin(-mapYaw)
    const tx = dx * cosY - dy * sinY
    const ty = dx * sinY + dy * cosY
    dx = tx
    dy = ty
  }
  
  // 3. 转换为像素，并处理 Y 轴翻转 (ROS Y 向上, Canvas Y 向下)
  return {
    x: dx / res,
    y: (info.height - 1) - (dy / res)
  }
}

let isDrawPending = false
function requestDraw() {
  if (!isDrawPending) {
    isDrawPending = true
    requestAnimationFrame(() => {
      draw()
      isDrawPending = false
    })
  }
}

function drawGoalMarker(ctx, waypoint, index, color) {
  const gp = worldToPixel(waypoint.x, waypoint.y)
  const r = 8 / scale.value
  ctx.strokeStyle = color
  ctx.lineWidth = 2 / scale.value
  ctx.beginPath()
  ctx.arc(gp.x, gp.y, r, 0, Math.PI * 2)
  ctx.stroke()

  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(gp.x, gp.y, r * 0.45, 0, Math.PI * 2)
  ctx.fill()

  const label = String(index + 1)
  ctx.font = `${12 / scale.value}px var(--font-mono)`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#ffffff'
  ctx.fillText(label, gp.x, gp.y)
}

function colorForLidarPoint() {
  return '#ff3b30'
}

function projectLidarPoint(point) {
  const cx = point.x - lidarCenter.value.x
  const cy = point.y - lidarCenter.value.y
  const cz = point.z - lidarCenter.value.z

  const cyaw = Math.cos(lidarYaw.value)
  const syaw = Math.sin(lidarYaw.value)
  const cp = Math.cos(lidarPitch.value)
  const sp = Math.sin(lidarPitch.value)

  const x1 = cx * cyaw - cy * syaw
  const y1 = cx * syaw + cy * cyaw
  const z1 = cz

  const y2 = y1 * cp - z1 * sp
  const z2 = y1 * sp + z1 * cp

  const f = 700 / (lidarDistance.value * 100)
  const denom = Math.max(0.2, lidarDistance.value - z2 * f)
  const s = 320 / denom
  return { x: x1 * s, y: y2 * s, depth: z2, size: Math.max(1.2, lidarPointSize.value * (1.2 - Math.min(1, Math.max(0, z2 / (lidarDistance.value + 1))))) }
}

function drawLidar3D(ctx, canvasWidth, canvasHeight) {
  const bg = ctx.createLinearGradient(0, 0, 0, canvasHeight)
  bg.addColorStop(0, '#08121d')
  bg.addColorStop(1, '#05080d')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, canvasWidth, canvasHeight)

  ctx.save()
  ctx.translate(canvasWidth / 2 + lidarPanX.value, canvasHeight / 2 + lidarPanY.value)
  const total = pointCloudPoints.value.length
  const targetRenderPoints = isDragging ? 6000 : 12000
  const stride = Math.max(1, Math.ceil(total / targetRenderPoints))
  ctx.fillStyle = colorForLidarPoint()
  for (let i = 0; i < total; i += stride) {
    const pr = projectLidarPoint(pointCloudPoints.value[i])
    if (!Number.isFinite(pr.x) || !Number.isFinite(pr.y) || !Number.isFinite(pr.depth)) continue
    const size = Math.max(1, pr.size)
    ctx.fillRect(pr.x - size * 0.5, pr.y - size * 0.5, size, size)
  }

  if (props.layers.robot !== false) {
    // 在 3D 点云中叠加机器人基座参考点，便于区分机器人位置
    const ox = sensorOffset.value.x || 0
    const oy = sensorOffset.value.y || 0
    const oyaw = sensorOffset.value.yaw || 0
    const c = Math.cos(oyaw)
    const s = Math.sin(oyaw)
    const robotInLidar = {
      x: -(c * ox + s * oy),
      y: s * ox - c * oy,
      z: 0
    }
    const rp = projectLidarPoint(robotInLidar)
    if (Number.isFinite(rp.x) && Number.isFinite(rp.y)) {
      const r = Math.max(3, 3 / Math.max(0.7, Math.min(2, lidarDistance.value * 0.15)))
      ctx.beginPath()
      ctx.fillStyle = ROBOT_MARKER_COLOR
      ctx.arc(rp.x, rp.y, r, 0, Math.PI * 2)
      ctx.fill()
      ctx.beginPath()
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1.5
      ctx.arc(rp.x, rp.y, r + 2, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
  ctx.restore()
}

/**
 * 绘图逻辑
 */
function draw() {
  const canvas = mapCanvasRef.value
  const container = containerRef.value
  if (!canvas || !container) return

  canvas.width = container.clientWidth
  canvas.height = container.clientHeight
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  if (isLidar3DMode.value) {
    drawLidar3D(ctx, canvas.width, canvas.height)
    return
  }

  const isMapVisible = props.layers.map && offscreenCanvas
  const isScanVisible = props.layers.scan && laserPoints.value.length > 0
  const isRobotVisible = props.layers.robot && robotPose.value

  ctx.save()
  ctx.translate(offsetX.value, offsetY.value)
  ctx.scale(scale.value, scale.value)
  ctx.imageSmoothingEnabled = false 
  
  // 1. 画地图 (如果有)
  if (isMapVisible) {
    ctx.drawImage(offscreenCanvas, 0, 0)
  } else if (!offscreenCanvas) {
    // 画一个淡紫色的十字准星表示虚拟原点
    ctx.strokeStyle = 'rgba(99, 102, 241, 0.2)'
    ctx.lineWidth = 1 / scale.value
    const center = worldToPixel(0, 0)
    ctx.beginPath()
    ctx.moveTo(center.x - 20/scale.value, center.y)
    ctx.lineTo(center.x + 20/scale.value, center.y)
    ctx.moveTo(center.x, center.y - 20/scale.value)
    ctx.lineTo(center.x, center.y + 20/scale.value)
    ctx.stroke()
  }

  // 2. 画雷达点 (红色)
  if (isScanVisible) {
    ctx.fillStyle = '#ff4444'
    for (const p of laserPoints.value) {
      const pix = worldToPixel(p.x, p.y)
      ctx.beginPath()
      ctx.arc(pix.x, pix.y, 1.5 / scale.value, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // 3. 画机器人（独立高亮颜色箭头）
  if (isRobotVisible) {
    const pix = worldToPixel(robotPose.value.x, robotPose.value.y)
    ctx.save()
    ctx.translate(pix.x, pix.y)
    ctx.rotate(-robotPose.value.yaw)
    
    ctx.fillStyle = ROBOT_MARKER_COLOR
    ctx.beginPath()
    ctx.moveTo(8 / scale.value, 0)
    ctx.lineTo(-6 / scale.value, -6 / scale.value)
    ctx.lineTo(-6 / scale.value, 6 / scale.value)
    ctx.closePath()
    ctx.fill()
    
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 1 / scale.value
    ctx.stroke()
    ctx.restore()
  }

  // 4. 画导航路径 (绿色折线)
  if (props.layers.path !== false && navPathPoints.value.length > 1) {
    ctx.strokeStyle = 'rgba(52, 211, 153, 0.8)'
    ctx.lineWidth = 2 / scale.value
    ctx.setLineDash([6 / scale.value, 3 / scale.value])
    ctx.beginPath()
    const first = worldToPixel(navPathPoints.value[0].x, navPathPoints.value[0].y)
    ctx.moveTo(first.x, first.y)
    for (let i = 1; i < navPathPoints.value.length; i++) {
      const pt = worldToPixel(navPathPoints.value[i].x, navPathPoints.value[i].y)
      ctx.lineTo(pt.x, pt.y)
    }
    ctx.stroke()
    ctx.setLineDash([])
  }

  // 5. 画目标点 / 航点
  if (props.layers.goal !== false) {
    if (props.multiPointMode) {
      if (props.activeWaypoint) {
        drawGoalMarker(ctx, props.activeWaypoint, 0, '#f97316')
      }
      for (let i = 0; i < props.waypoints.length; i++) {
        drawGoalMarker(ctx, props.waypoints[i], i + (props.activeWaypoint ? 1 : 0), '#a78bfa')
      }
    } else if (goalPoint.value) {
      const gp = worldToPixel(goalPoint.value.x, goalPoint.value.y)
      const r = 8 / scale.value
      ctx.strokeStyle = '#a78bfa'
      ctx.lineWidth = 2 / scale.value
      ctx.beginPath()
      ctx.arc(gp.x, gp.y, r, 0, Math.PI * 2)
      ctx.stroke()
      ctx.fillStyle = 'rgba(167, 139, 250, 0.4)'
      ctx.beginPath()
      ctx.arc(gp.x, gp.y, r * 0.5, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = '#a78bfa'
      ctx.lineWidth = 1.5 / scale.value
      const cross = 14 / scale.value
      ctx.beginPath()
      ctx.moveTo(gp.x - cross, gp.y)
      ctx.lineTo(gp.x + cross, gp.y)
      ctx.moveTo(gp.x, gp.y - cross)
      ctx.lineTo(gp.x, gp.y + cross)
      ctx.stroke()
    }
  }

  // 6. 画初始位置箭头 (黄色)
  if (poseAnchor.value) {
    const ap = worldToPixel(poseAnchor.value.x, poseAnchor.value.y)
    const r = 8 / scale.value
    // 圆圈
    ctx.strokeStyle = '#fbbf24'
    ctx.fillStyle = 'rgba(251, 191, 36, 0.3)'
    ctx.lineWidth = 2 / scale.value
    ctx.beginPath()
    ctx.arc(ap.x, ap.y, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    // 方向箭头
    if (poseDrag.value) {
      const dp = worldToPixel(poseDrag.value.x, poseDrag.value.y)
      const dx = dp.x - ap.x
      const dy = dp.y - ap.y
      const len = Math.sqrt(dx * dx + dy * dy)
      if (len > 2) {
        const ux = dx / len
        const uy = dy / len
        const arrowLen = Math.max(len, 20 / scale.value)
        const ex = ap.x + ux * arrowLen
        const ey = ap.y + uy * arrowLen
        // 主轴线
        ctx.strokeStyle = '#fbbf24'
        ctx.lineWidth = 2.5 / scale.value
        ctx.beginPath()
        ctx.moveTo(ap.x, ap.y)
        ctx.lineTo(ex, ey)
        ctx.stroke()
        // 箭头头部
        const hw = 6 / scale.value
        const hl = 10 / scale.value
        ctx.fillStyle = '#fbbf24'
        ctx.beginPath()
        ctx.moveTo(ex, ey)
        ctx.lineTo(ex - ux * hl - uy * hw, ey - uy * hl + ux * hw)
        ctx.lineTo(ex - ux * hl + uy * hw, ey - uy * hl - ux * hw)
        ctx.closePath()
        ctx.fill()
      }
    }
  }

  ctx.restore()
}

// 监听图层配置变化
watch(() => props.layers, () => {
  requestDraw()
}, { deep: true })

// 监听导航路径变化
watch(() => props.planData, (newData) => {
  if (!newData || !newData.poses) {
    navPathPoints.value = []
    return
  }
  navPathPoints.value = newData.poses.map(p => ({ x: p.position.x, y: p.position.y }))
  requestDraw()
}, { deep: true })

// ==================== TF 树管理 ====================
// ROS 2 的 TF 树通常是: map -> odom -> base_link -> base_scan
// /tf 话题分别发布各段变换，我们需要缓存并组合它们

const tfTree = {}  // { 'parent|child': { translation, rotation } }
const MAX_POINTCLOUD_POINTS = 12000

function quatToYaw(q) {
  return Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z))
}

/** 组合两个 TF: parent->middle + middle->child = parent->child */
function composeTf(tfA, tfB) {
  // tfA: parent -> middle,  tfB: middle -> child
  const yawA = quatToYaw(tfA.rotation)
  const cosA = Math.cos(yawA)
  const sinA = Math.sin(yawA)
  return {
    x: tfA.translation.x + (tfB.translation.x * cosA - tfB.translation.y * sinA),
    y: tfA.translation.y + (tfB.translation.x * sinA + tfB.translation.y * cosA),
    yaw: yawA + quatToYaw(tfB.rotation)
  }
}

/** 从 TF 树中查找从 fromFrame 到 toFrame 的变换（最多 3 层链式查找） */
function lookupTf(fromFrame, toFrame) {
  // 直接路径
  const directKey = `${fromFrame}|${toFrame}`
  if (tfTree[directKey]) {
    const tf = tfTree[directKey]
    return { x: tf.translation.x, y: tf.translation.y, yaw: quatToYaw(tf.rotation) }
  }
  
  // 两段路径: fromFrame -> middle -> toFrame
  for (const key in tfTree) {
    const [parent, child] = key.split('|')
    if (parent === fromFrame) {
      const secondKey = `${child}|${toFrame}`
      if (tfTree[secondKey]) {
        return composeTf(tfTree[key], tfTree[secondKey])
      }
    }
  }
  
  return null
}

// 处理 TF 数据：缓存所有变换段，然后组合查询
watch(() => props.tfData, (newData) => {
  if (!newData || !newData.transforms) return
  
  // 1. 将所有收到的 TF 存入树
  for (const tf of newData.transforms) {
    const key = `${tf.header.frame_id}|${tf.child_frame_id}`
    tfTree[key] = tf.transform
  }
  
  // 2. 查找机器人在地图坐标系中的位置 (map -> base_link)
  //    支持链: map -> odom -> base_link 或 map -> odom -> base_footprint
  let pose = lookupTf('map', 'base_link')
  if (!pose) pose = lookupTf('map', 'base_footprint')
  // 无地图时退回到 odom 坐标系
  if (!pose) pose = lookupTf('odom', 'base_link')
  if (!pose) pose = lookupTf('odom', 'base_footprint')
  
  if (pose) {
    robotPose.value = pose
  }

  // 3. 寻找传感器偏移 (base_link -> laser/base_scan)
  const scanFrame = props.scanData?.header?.frame_id || 'base_scan'
  let sOffset = lookupTf('base_link', scanFrame)
  if (!sOffset) sOffset = lookupTf('base_footprint', scanFrame)
  if (sOffset) {
    sensorOffset.value = sOffset
  }

  requestDraw()
  if (props.lidarData) {
    updatePointCloudPoints()
  }
}, { deep: true })

// 处理雷达数据：计算打击点坐标
watch(() => props.scanData, (newData) => {
  if (!newData || !newData.ranges) return
  
  const points = []
  const pose = robotPose.value || { x: 0, y: 0, yaw: 0 }
  const offset = sensorOffset.value || { x: 0, y: 0, yaw: 0 }
  
  // 1. 计算传感器在地图坐标系中的绝对位置和朝向
  // 传感器在机器人的位置 = robotPose + rotated(sensorOffset)
  const cosR = Math.cos(pose.yaw)
  const sinR = Math.sin(pose.yaw)
  const sensorX = pose.x + (offset.x * cosR - offset.y * sinR)
  const sensorY = pose.y + (offset.x * sinR + offset.y * cosR)
  const sensorYaw = pose.yaw + offset.yaw
  
  // 2. 将雷达测距点转换为地图坐标
  for (let i = 0; i < newData.ranges.length; i++) {
    const r = newData.ranges[i]
    if (r < newData.range_min || r > newData.range_max || isNaN(r)) continue
    
    const angle = newData.angle_min + i * newData.angle_increment
    const totalAngle = sensorYaw + angle
    points.push({
      x: sensorX + r * Math.cos(totalAngle),
      y: sensorY + r * Math.sin(totalAngle)
    })
  }
  laserPoints.value = points
  requestDraw()
}, { deep: true })

function updatePointCloudPoints() {
  const pc = props.lidarData
  if (!pc) {
    pointCloudPoints.value = []
    return
  }

  const points = []
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  if (Array.isArray(pc.points) && pc.points.length > 0) {
    const stride = Math.max(1, Math.ceil(pc.points.length / MAX_POINTCLOUD_POINTS))
    for (let i = 0; i < pc.points.length; i += stride) {
      const p = pc.points[i]
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) continue
      points.push({ x: p.x, y: p.y, z: p.z })
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y)
      maxY = Math.max(maxY, p.y)
      minZ = Math.min(minZ, p.z)
      maxZ = Math.max(maxZ, p.z)
    }
    pointCloudPoints.value = points
    if (points.length > 0) {
      lidarCenter.value = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 }
    }
    return
  }

  if (!pc.data || !pc.fields || !pc.point_step) {
    pointCloudPoints.value = []
    return
  }

  const fields = new Map()
  for (const f of pc.fields) fields.set(f.name, f)
  const fieldX = fields.get('x')
  const fieldY = fields.get('y')
  const fieldZ = fields.get('z')
  if (!fieldX || !fieldY || fieldX.datatype !== 7 || fieldY.datatype !== 7 || (fieldZ && fieldZ.datatype !== 7)) {
    pointCloudPoints.value = []
    return
  }

  const data = pc.data
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const step = pc.point_step
  const totalPoints = pc.width * pc.height || Math.floor(data.byteLength / step)
  const stride = Math.max(1, Math.ceil(totalPoints / MAX_POINTCLOUD_POINTS))
  const little = !pc.is_bigendian
  for (let i = 0; i < totalPoints; i += stride) {
    const base = i * step
    if (base + step > data.byteLength) break
    const x = view.getFloat32(base + fieldX.offset, little)
    const y = view.getFloat32(base + fieldY.offset, little)
    const z = fieldZ ? view.getFloat32(base + fieldZ.offset, little) : 0
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
    points.push({ x, y, z })
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
    minZ = Math.min(minZ, z)
    maxZ = Math.max(maxZ, z)
  }

  pointCloudPoints.value = points
  if (points.length > 0) {
    lidarCenter.value = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 }
  }
}

watch(() => props.lidarData, () => {
  updatePointCloudPoints()
  requestDraw()
})

function autoFit() {
  if (!offscreenCanvas || !containerRef.value) return
  const container = containerRef.value
  const cw = container.clientWidth
  const ch = container.clientHeight
  const mw = offscreenCanvas.width
  const mh = offscreenCanvas.height

  if (cw === 0 || ch === 0) return

  // 计算缩放：使图像完整放入容器，且充满其中一个维度
  const s = Math.min(cw / mw, ch / mh)
  scale.value = s
  offsetX.value = (cw - mw * s) / 2
  offsetY.value = (ch - mh * s) / 2
  requestDraw()
}

function resetView() {
  if (isLidar3DMode.value) {
    lidarYaw.value = 0.8
    lidarPitch.value = 0.55
    lidarDistance.value = 8
    lidarPanX.value = 0
    lidarPanY.value = 0
    requestDraw()
    return
  }
  autoFit()
}

// ---- 事件处理 ----
function onWheel(e) {
  if (isLidar3DMode.value) {
    const delta = Math.sign(e.deltaY)
    lidarDistance.value = Math.max(3, Math.min(20, lidarDistance.value + delta * 0.4))
    requestDraw()
    return
  }

  const zoomSpeed = 0.1
  const oldScale = scale.value
  const delta = -Math.sign(e.deltaY)
  const newScale = Math.max(0.1, Math.min(20, oldScale * (1 + delta * zoomSpeed)))
  
  // 获取鼠标在 Canvas 上的相对坐标
  const rect = containerRef.value.getBoundingClientRect()
  const mouseX = e.clientX - rect.left
  const mouseY = e.clientY - rect.top

  // 以鼠标位置为中心缩放
  offsetX.value = mouseX - (mouseX - offsetX.value) * (newScale / oldScale)
  offsetY.value = mouseY - (mouseY - offsetY.value) * (newScale / oldScale)
  
  scale.value = newScale
  requestDraw()
}

function onMouseDown(e) {
  if (isLidar3DMode.value) {
    const isTouchLike = typeof e.button !== 'number'
    if (isTouchLike) {
      lidarDragMode = 'rotate'
    } else if (e.button === 0) {
      lidarDragMode = 'rotate'
    } else if (e.button === 1) {
      lidarDragMode = 'pan'
      e.preventDefault()
    } else {
      return
    }
    isDragging = true
    lastMouseX = e.clientX
    lastMouseY = e.clientY
    return
  }

  if (props.isSettingPose) {
    // 初始位置模式: 记录按下点，禁止地图拖动
    const rect = containerRef.value.getBoundingClientRect()
    const cx = (e.clientX - rect.left - offsetX.value) / scale.value
    const cy = (e.clientY - rect.top - offsetY.value) / scale.value
    const info = getEffectiveMapInfo()
    poseAnchor.value = {
      x: info.origin.position.x + cx * info.resolution,
      y: info.origin.position.y + (info.height - 1 - cy) * info.resolution
    }
    poseDrag.value = null
    requestDraw()
    return
  }
  isDragging = true
  lastMouseX = e.clientX
  lastMouseY = e.clientY
}

function onMouseMove(e) {
  if (isLidar3DMode.value) {
    if (!isDragging) return
    const dx = e.clientX - lastMouseX
    const dy = e.clientY - lastMouseY
    if (lidarDragMode === 'pan') {
      e.preventDefault()
      lidarPanX.value += dx
      lidarPanY.value += dy
    } else {
      // 与 RViz 交互方向保持一致：拖动画面向左，视角向左转
      lidarYaw.value -= dx * 0.01
      lidarPitch.value = Math.max(-1.2, Math.min(1.2, lidarPitch.value - dy * 0.01))
    }
    lastMouseX = e.clientX
    lastMouseY = e.clientY
    requestDraw()
    return
  }

  if (props.isSettingPose && poseAnchor.value) {
    const rect = containerRef.value.getBoundingClientRect()
    const cx = (e.clientX - rect.left - offsetX.value) / scale.value
    const cy = (e.clientY - rect.top - offsetY.value) / scale.value
    const info = getEffectiveMapInfo()
    poseDrag.value = {
      x: info.origin.position.x + cx * info.resolution,
      y: info.origin.position.y + (info.height - 1 - cy) * info.resolution
    }
    draw()
    return
  }
  if (!isDragging) return
  const dx = e.clientX - lastMouseX
  const dy = e.clientY - lastMouseY
  offsetX.value += dx
  offsetY.value += dy
  lastMouseX = e.clientX
  lastMouseY = e.clientY
  draw()
}

function onMouseUp(e) {
  if (isLidar3DMode.value) {
    isDragging = false
    lidarDragMode = null
    return
  }

  if (props.isSettingPose && poseAnchor.value) {
    let yaw = 0
    if (poseDrag.value) {
      const dx = poseDrag.value.x - poseAnchor.value.x
      const dy = poseDrag.value.y - poseAnchor.value.y
      if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
        yaw = Math.atan2(dy, dx)
      }
    }
    emit('initial-pose-set', { x: poseAnchor.value.x, y: poseAnchor.value.y, yaw })
    emit('update:isSettingPose', false) // 自动退出设置模式
    
    // 显示成功提示
    settingMsg.value = '初始位置设置成功'
    setTimeout(() => { settingMsg.value = '' }, 3000)

    // 清除预览
    poseAnchor.value = null
    poseDrag.value = null
    draw()
    return
  }
  isDragging = false
}

// 双击设定导航目标点
function onDblClick(e) {
  if (isLidar3DMode.value) return
  if (!props.isNavigating) return
  if (props.isSettingPose) return
  const rect = containerRef.value.getBoundingClientRect()
  const canvasX = (e.clientX - rect.left - offsetX.value) / scale.value
  const canvasY = (e.clientY - rect.top - offsetY.value) / scale.value
  // 将 Canvas 像素坐标转换回世界坐标
  const info = getEffectiveMapInfo()
  const res = info.resolution
  const origin = info.origin.position
  const wx = origin.x + canvasX * res
  const wy = origin.y + (info.height - 1 - canvasY) * res
  if (props.multiPointMode) {
    emit('waypoint-add', { x: wx, y: wy })
  } else {
    singleGoalReachedNotified.value = false
    goalPoint.value = { x: wx, y: wy }
    emit('goal-set', { x: wx, y: wy })
  }
  draw()
}

// 触摸支持
let initialPinchDist = 0
let lastPinchCenter = { x: 0, y: 0 }

function getPinchDist(e) {
  const dx = e.touches[0].clientX - e.touches[1].clientX
  const dy = e.touches[0].clientY - e.touches[1].clientY
  return Math.sqrt(dx * dx + dy * dy)
}

function getPinchCenter(e) {
  return {
    x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
    y: (e.touches[0].clientY + e.touches[1].clientY) / 2
  }
}

function onTouchStart(e) {
  if (e.touches.length === 1) {
    onMouseDown(e.touches[0])
  } else if (e.touches.length === 2) {
    isDragging = false // 缩放时停止拖动
    initialPinchDist = getPinchDist(e)
    lastPinchCenter = getPinchCenter(e)
  }
}

function onTouchMove(e) {
  if (e.touches.length === 1) {
    onMouseMove(e.touches[0])
  } else if (e.touches.length === 2) {
    if (isLidar3DMode.value) {
      const dist = getPinchDist(e)
      const zoomFactor = dist / initialPinchDist
      lidarDistance.value = Math.max(3, Math.min(20, lidarDistance.value / Math.max(0.6, Math.min(1.4, zoomFactor))))
      initialPinchDist = dist
      requestDraw()
      return
    }

    const dist = getPinchDist(e)
    const center = getPinchCenter(e)
    const rect = containerRef.value.getBoundingClientRect()
    
    const zoomFactor = dist / initialPinchDist
    const oldScale = scale.value
    const newScale = Math.max(0.1, Math.min(20, oldScale * zoomFactor))
    
    // 以双指中心缩放
    const cx = center.x - rect.left
    const cy = center.y - rect.top
    
    offsetX.value = cx - (cx - offsetX.value) * (newScale / oldScale)
    offsetY.value = cy - (cy - offsetY.value) * (newScale / oldScale)
    
    scale.value = newScale
    initialPinchDist = dist
    draw()
  }
}

// 监听窗口大小变化
window.addEventListener('resize', () => {
  draw()
})

watch(() => props.mapData, (newData) => {
  if (newData && newData.info && newData.data) {
    updateOffscreenCanvas(newData)
  }
}, { deep: true })

watch(() => props.multiPointMode, (enabled) => {
  if (enabled) {
    goalPoint.value = null
  }
  requestDraw()
})

watch(() => [props.waypoints, props.activeWaypoint, props.multiPointMode], () => {
  requestDraw()
}, { deep: true })

watch(() => props.activeWaypoint, (wp) => {
  if (!wp) {
    reachedWaypointKey.value = ''
    return
  }
  reachedWaypointKey.value = `${wp.x.toFixed(3)}_${wp.y.toFixed(3)}`
}, { deep: true })

watch(() => [robotPose.value, props.activeWaypoint, props.multiPointMode, props.isNavigating], () => {
  if (!props.isNavigating || !props.multiPointMode) return
  if (!robotPose.value || !props.activeWaypoint) return
  const dx = robotPose.value.x - props.activeWaypoint.x
  const dy = robotPose.value.y - props.activeWaypoint.y
  const dist = Math.sqrt(dx * dx + dy * dy)
  if (dist <= waypointReachThreshold && reachedWaypointKey.value) {
    reachedWaypointKey.value = ''
    emit('waypoint-reached')
  }
}, { deep: true })

watch(() => [props.isNavigating, props.multiPointMode, goalPoint.value, robotPose.value, props.navFeedback], () => {
  if (!props.isNavigating || props.multiPointMode || !goalPoint.value || singleGoalReachedNotified.value) return

  let reached = false
  const feedbackDistance = props.navFeedback?.distance_remaining
  if (typeof feedbackDistance === 'number' && Number.isFinite(feedbackDistance) && feedbackDistance <= 0.10) {
    reached = true
  }

  if (!reached && robotPose.value) {
    const dx = robotPose.value.x - goalPoint.value.x
    const dy = robotPose.value.y - goalPoint.value.y
    const dist = Math.sqrt(dx * dx + dy * dy)
    if (dist <= 0.10) reached = true
  }

  if (reached) {
    singleGoalReachedNotified.value = true
    goalPoint.value = null
    requestDraw()
    arriveMsg.value = '已到达导航点'
    setTimeout(() => { arriveMsg.value = '' }, 2500)
  }
}, { deep: true })

watch(() => [props.isNavigating, props.multiPointMode], ([navigating, multi]) => {
  if (!navigating || multi) {
    singleGoalReachedNotified.value = false
  }
})

onMounted(() => {
  if (props.mapData) updateOffscreenCanvas(props.mapData)
})

defineExpose({
  resetView,
  clearGoal: () => { goalPoint.value = null; navPathPoints.value = []; draw() },
  clearPose: () => { poseAnchor.value = null; poseDrag.value = null; draw() }
})

</script>

<style scoped>
.header-left {
  display: flex;
  align-items: center;
}
.header-right {
  display: flex;
  align-items: center;
  gap: 6px;
}
.btn-mini {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: #fff;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-mini:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.2);
}
.btn-mini:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-mini-save {
  background: rgba(52, 211, 153, 0.15);
  border-color: rgba(52, 211, 153, 0.4);
  color: #34d399;
}
.btn-mini-save:hover:not(:disabled) {
  background: rgba(52, 211, 153, 0.3);
}
.btn-mini-pose {
  background: rgba(251, 191, 36, 0.15);
  border-color: rgba(251, 191, 36, 0.4);
  color: #fbbf24;
}
.btn-mini-pose:hover {
  background: rgba(251, 191, 36, 0.3);
}
.btn-mini-pose.active {
  background: rgba(251, 191, 36, 0.3);
  border-color: #fbbf24;
  animation: pose-pulse 1.2s ease-in-out infinite;
}
@keyframes pose-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(251, 191, 36, 0.4); }
  50% { box-shadow: 0 0 0 4px rgba(251, 191, 36, 0); }
}
.nav-status-mini {
  color: #34d399;
  font-size: 11px;
  font-weight: bold;
  margin-right: 4px;
}
.map-card :deep(.card-body) {
  padding: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}
.map-canvas-container {
  width: 100%;
  height: min(68vh, 620px);
  min-height: 360px;
  max-height: 620px;
  flex: none;
  position: relative;
  overflow: hidden;
  background: #000;
  cursor: grab;
}
.map-canvas-container:active {
  cursor: grabbing;
}

@media (max-width: 900px) {
  .map-canvas-container {
    height: min(52vh, 460px);
    min-height: 280px;
  }
}
canvas {
  display: block;
}

.map-info {
  position: absolute;
  bottom: 12px;
  left: 12px;
  background: rgba(0, 0, 0, 0.6);
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 0.7rem;
  color: var(--text-secondary);
  pointer-events: none;
}
.map-overlay-hint {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  padding: 6px 14px;
  border-radius: 20px;
  font-size: 0.8rem;
  font-weight: 500;
  pointer-events: none;
  animation: fadein-down 0.3s ease;
  backdrop-filter: blur(4px);
}
.hint-goal {
  color: #a78bfa;
  background: rgba(99, 102, 241, 0.25);
  border: 1px solid rgba(99, 102, 241, 0.4);
}
.hint-pose {
  color: #fbbf24;
  background: rgba(251, 191, 36, 0.25);
  border: 1px solid rgba(251, 191, 36, 0.4);
}

.map-overlay-feedback {
  position: absolute;
  top: 56px;
  right: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 150px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid rgba(99, 102, 241, 0.35);
  background: rgba(15, 23, 42, 0.8);
  backdrop-filter: blur(4px);
  z-index: 5;
}

.feedback-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.fb-label {
  font-size: 0.72rem;
  color: var(--text-secondary);
}

.fb-value {
  font-size: 0.78rem;
  font-family: var(--font-mono);
  color: #e2e8f0;
}

.fb-waiting {
  font-size: 0.72rem;
  color: #94a3b8;
  text-align: right;
}
@keyframes fadein-down {
  from { opacity: 0; transform: translate(-50%, -10px); }
  to   { opacity: 1; transform: translate(-50%, 0); }
}

/* 保存提示 */
.save-toast {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  padding: 7px 18px;
  border-radius: 20px;
  font-size: 13px;
  font-weight: 500;
  pointer-events: none;
  animation: fadein 0.2s ease;
  white-space: nowrap;
  z-index: 10;
}
.save-toast-ok  { background: rgba(16,185,129,0.85); color: #fff; }
.save-toast-err { background: rgba(239,68,68,0.85);  color: #fff; }
@keyframes fadein { from { opacity:0; transform:translateX(-50%) translateY(6px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }

/* Modal */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(4px);
}
.modal-box {
  background: #1e2130;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 14px;
  padding: 28px 32px;
  min-width: 340px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.5);
  animation: modal-in 0.18s ease;
}
@keyframes modal-in {
  from { transform: scale(0.92); opacity: 0; }
  to   { transform: scale(1);    opacity: 1; }
}
.modal-title { font-size: 1.1rem; font-weight: 700; color: #e2e8f0; margin: 0 0 8px; }
.modal-desc  { font-size: 0.85rem; color: #9ca3af; margin: 0 0 14px; }
.modal-input {
  width: 100%; box-sizing: border-box;
  background: rgba(255,255,255,0.07);
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: 8px; padding: 10px 12px;
  color: #e2e8f0; font-size: 0.95rem; outline: none;
  transition: border-color 0.2s;
}
.modal-input:focus { border-color: #6366f1; }
.modal-actions { display: flex; gap: 10px; margin-top: 16px; justify-content: flex-end; }
.btn-modal-cancel {
  background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.15);
  color: #9ca3af; padding: 8px 18px;
  border-radius: 8px; cursor: pointer; font-size: 0.9rem;
  transition: all 0.2s;
}
.btn-modal-cancel:hover { background: rgba(255,255,255,0.15); }
.btn-modal-confirm {
  background: linear-gradient(135deg, #4f46e5, #6366f1);
  border: none; color: #fff; padding: 8px 20px;
  border-radius: 8px; cursor: pointer;
  font-size: 0.9rem; font-weight: 600;
  transition: all 0.2s;
}
.btn-modal-confirm:hover:not(:disabled) { background: linear-gradient(135deg, #6366f1, #818cf8); }
.btn-modal-confirm:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
