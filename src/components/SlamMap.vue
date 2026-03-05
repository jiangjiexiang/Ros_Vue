<template>
  <div class="card map-card">
    <div class="card-header">
      <div class="header-left">
        SLAM 栅格地图
      </div>
      <div class="header-right" v-if="hasMap">
        <button class="btn-mini" @click="resetView">重置视图</button>
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
      >
        <canvas ref="mapCanvasRef" />
        <div class="map-info">
          <span v-if="mapInfo">{{ mapInfo.width }} × {{ mapInfo.height }} | 缩放: {{ (scale * 100).toFixed(0) }}%</span>
          <span v-else>无地图模式 | 缩放: {{ (scale * 100).toFixed(0) }}%</span>
        </div>
      </div>
      <div v-else class="map-placeholder">
        <p v-if="!connected">请先连接机器人</p>
        <p v-else>等待地图或雷达数据...</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue'

const props = defineProps({
  connected: Boolean,
  mapData: Object,
  scanData: Object,
  tfData: Object,
  layers: {
    type: Object,
    default: () => ({ map: true, scan: true, robot: true })
  }
})

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
const sensorOffset = ref({ x: 0, y: 0, yaw: 0 }) // { x, y, yaw } from base_link to sensor

// 交互状态
let isDragging = false
let lastMouseX = 0
let lastMouseY = 0

const shouldShowCanvas = computed(() => {
  return props.connected && (props.mapData || props.scanData || props.tfData)
})

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
    draw()
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

  // 3. 画机器人 (蓝色箭头)
  if (isRobotVisible) {
    const pix = worldToPixel(robotPose.value.x, robotPose.value.y)
    ctx.save()
    ctx.translate(pix.x, pix.y)
    ctx.rotate(-robotPose.value.yaw)
    
    ctx.fillStyle = '#6366f1'
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

  ctx.restore()
}

// 监听图层配置变化
watch(() => props.layers, () => {
  draw()
}, { deep: true })

// 处理 TF 数据：提取机器人位置和传感器偏移
watch(() => props.tfData, (newData) => {
  if (!newData || !newData.transforms) return
  
  // 1. 寻找机器人位置 (map -> base_link)
  // 优先级: map -> base_link > map -> base_footprint > map -> odom
  let robotTf = newData.transforms.find(tf => 
    tf.header.frame_id === 'map' && tf.child_frame_id === 'base_link'
  )
  if (!robotTf) {
    robotTf = newData.transforms.find(tf => 
      tf.header.frame_id === 'map' && tf.child_frame_id === 'base_footprint'
    )
  }
  if (!robotTf) {
    robotTf = newData.transforms.find(tf => 
      tf.header.frame_id === 'map' && tf.child_frame_id === 'odom'
    )
  }
  // 最后的兜底：不限 frame_id 找 base_link
  if (!robotTf) {
    robotTf = newData.transforms.find(tf => 
      tf.child_frame_id === 'base_link' || tf.child_frame_id === 'base_footprint'
    )
  }

  if (robotTf) {
    const trans = robotTf.transform.translation
    const rot = robotTf.transform.rotation
    robotPose.value = {
      x: trans.x,
      y: trans.y,
      yaw: Math.atan2(2 * (rot.w * rot.z + rot.x * rot.y), 1 - 2 * (rot.y * rot.y + rot.z * rot.z))
    }
  }

  // 2. 寻找传感器偏移 (base_link -> laser/base_scan)
  const scanFrame = props.scanData?.header?.frame_id || 'base_scan'
  const sensorTf = newData.transforms.find(tf => 
    (tf.header.frame_id === 'base_link' || tf.header.frame_id === 'base_footprint') && 
    tf.child_frame_id === scanFrame
  )
  if (sensorTf) {
    const trans = sensorTf.transform.translation
    const rot = sensorTf.transform.rotation
    sensorOffset.value = {
      x: trans.x,
      y: trans.y,
      yaw: Math.atan2(2 * (rot.w * rot.z + rot.x * rot.y), 1 - 2 * (rot.y * rot.y + rot.z * rot.z))
    }
  }

  if (robotTf || sensorTf) {
    draw()
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
  draw()
}, { deep: true })

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
  draw()
}

function resetView() {
  autoFit()
}

// ---- 事件处理 ----
function onWheel(e) {
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
  draw()
}

function onMouseDown(e) {
  isDragging = true
  lastMouseX = e.clientX
  lastMouseY = e.clientY
}

function onMouseMove(e) {
  if (!isDragging) return
  const dx = e.clientX - lastMouseX
  const dy = e.clientY - lastMouseY
  offsetX.value += dx
  offsetY.value += dy
  lastMouseX = e.clientX
  lastMouseY = e.clientY
  draw()
}

function onMouseUp() {
  isDragging = false
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

onMounted(() => {
  if (props.mapData) updateOffscreenCanvas(props.mapData)
})
</script>

<style scoped>
.header-left {
  display: flex;
  align-items: center;
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
.btn-mini:hover {
  background: rgba(255, 255, 255, 0.2);
}
.map-card :deep(.card-body) {
  padding: 0;
  display: flex;
  flex-direction: column;
}
.map-canvas-container {
  width: 100%;
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
  background: #000;
  cursor: grab;
}
.map-canvas-container:active {
  cursor: grabbing;
}
canvas {
  display: block;
}
</style>
