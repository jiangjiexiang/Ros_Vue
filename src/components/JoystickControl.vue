<template>
  <section class="card">
    <div class="card-header">
      <span><UiIcon name="move" :size="17" />运动控制</span>
      <small>{{ commandRateHz }} HZ</small>
    </div>
    <div class="card-body joystick-container">
      <div class="joystick-status">
        <span><i :class="{ active: connected }"></i>{{ connected ? '控制已启用' : '等待连接' }}</span>
        <span>MAX {{ maxLinearSpeed }} m/s · {{ maxAngularSpeed }} rad/s</span>
      </div>

      <div class="joystick-canvas-wrapper" :class="{ disabled: !connected }">
        <canvas
          ref="canvasRef"
          :width="canvasSize"
          :height="canvasSize"
          @mousedown="onStart"
          @touchstart.prevent="onTouchStart"
        />
      </div>

      <div class="velocity-display">
        <div class="velocity-item">
          <span class="label">线速度 · m/s</span>
          <span class="value">{{ linearDisplay }}</span>
        </div>
        <div class="velocity-item">
          <span class="label">角速度 · rad/s</span>
          <span class="value">{{ angularDisplay }}</span>
        </div>
      </div>

      <button class="btn btn-secondary joystick-stop" :disabled="!connected" @click="stopMotion">
        <UiIcon name="stop" :size="15" />停止运动
      </button>
    </div>
  </section>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, onActivated, onDeactivated, watch } from 'vue'
import UiIcon from './UiIcon.vue'

const props = defineProps({
  connected: Boolean,
  maxLinearSpeed: { type: Number, default: 5 },
  maxAngularSpeed: { type: Number, default: 1.0 },
  commandRateHz: { type: Number, default: 10 }
})
const emit = defineEmits(['velocity-change', 'stop'])
const canvasSize = 220
const baseRadius = 90
const knobRadius = 28
const canvasRef = ref(null)
const knobX = ref(0)
const knobY = ref(0)
let isDragging = false
let animationId = null
let sendTimer = null

const linearDisplay = computed(() => (knobY.value * -props.maxLinearSpeed).toFixed(2))
const commandInterval = computed(() => 1000 / props.commandRateHz)
const angularDisplay = computed(() => (knobX.value * -props.maxAngularSpeed).toFixed(2))

function draw() {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  const cx = canvasSize / 2
  const cy = canvasSize / 2
  ctx.clearRect(0, 0, canvasSize, canvasSize)

  const outerGrad = ctx.createRadialGradient(cx, cy, 12, cx, cy, baseRadius)
  outerGrad.addColorStop(0, 'rgba(34, 211, 238, 0.055)')
  outerGrad.addColorStop(1, 'rgba(34, 211, 238, 0.015)')
  ctx.beginPath()
  ctx.arc(cx, cy, baseRadius, 0, Math.PI * 2)
  ctx.fillStyle = outerGrad
  ctx.fill()
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.24)'
  ctx.lineWidth = 1.5
  ctx.stroke()

  ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(cx, cy - baseRadius + 12)
  ctx.lineTo(cx, cy + baseRadius - 12)
  ctx.moveTo(cx - baseRadius + 12, cy)
  ctx.lineTo(cx + baseRadius - 12, cy)
  ctx.stroke()

  ctx.beginPath()
  ctx.arc(cx, cy, baseRadius - 18, 0, Math.PI * 2)
  ctx.setLineDash([2, 6])
  ctx.strokeStyle = 'rgba(34, 211, 238, 0.13)'
  ctx.stroke()
  ctx.setLineDash([])

  const handleX = cx + knobX.value * (baseRadius - knobRadius)
  const handleY = cy + knobY.value * (baseRadius - knobRadius)
  const knobGrad = ctx.createRadialGradient(handleX - 6, handleY - 7, 2, handleX, handleY, knobRadius)
  if (props.connected) {
    knobGrad.addColorStop(0, '#67e8f9')
    knobGrad.addColorStop(0.65, '#06b6d4')
    knobGrad.addColorStop(1, '#0369a1')
  } else {
    knobGrad.addColorStop(0, '#94a3b8')
    knobGrad.addColorStop(1, '#475569')
  }
  ctx.beginPath()
  ctx.arc(handleX, handleY, knobRadius, 0, Math.PI * 2)
  ctx.fillStyle = knobGrad
  ctx.fill()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)'
  ctx.stroke()

  if (isDragging) {
    ctx.beginPath()
    ctx.arc(handleX, handleY, knobRadius + 6, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.35)'
    ctx.lineWidth = 3
    ctx.stroke()
  }
}

function getCanvasPos(event) {
  const canvas = canvasRef.value
  if (!canvas) return { dx: 0, dy: 0 }
  const rect = canvas.getBoundingClientRect()
  const clientX = event.clientX ?? event.touches?.[0]?.clientX ?? 0
  const clientY = event.clientY ?? event.touches?.[0]?.clientY ?? 0
  const x = (clientX - rect.left) * (canvasSize / rect.width)
  const y = (clientY - rect.top) * (canvasSize / rect.height)
  let dx = (x - canvasSize / 2) / (baseRadius - knobRadius)
  let dy = (y - canvasSize / 2) / (baseRadius - knobRadius)
  const dist = Math.hypot(dx, dy)
  if (dist > 1) {
    dx /= dist
    dy /= dist
  }
  return { dx, dy }
}

function updateFromEvent(event) {
  const { dx, dy } = getCanvasPos(event)
  knobX.value = dx
  knobY.value = dy
  draw()
}

function onStart(event) {
  if (!props.connected) return
  isDragging = true
  updateFromEvent(event)
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onEnd)
}

function onMove(event) {
  if (isDragging) updateFromEvent(event)
}

function onEnd() {
  isDragging = false
  removePointerListeners()
  animateReturn()
}

function onTouchStart(event) {
  if (!props.connected) return
  isDragging = true
  updateFromEvent(event.touches[0])
  window.addEventListener('touchmove', onTouchMove, { passive: false })
  window.addEventListener('touchend', onEnd)
}

function onTouchMove(event) {
  if (!isDragging) return
  event.preventDefault()
  updateFromEvent(event.touches[0])
}

function removePointerListeners() {
  window.removeEventListener('mousemove', onMove)
  window.removeEventListener('mouseup', onEnd)
  window.removeEventListener('touchmove', onTouchMove)
  window.removeEventListener('touchend', onEnd)
}

function animateReturn() {
  if (animationId) cancelAnimationFrame(animationId)
  function step() {
    knobX.value *= 0.82
    knobY.value *= 0.82
    if (Math.abs(knobX.value) < 0.01 && Math.abs(knobY.value) < 0.01) {
      knobX.value = 0
      knobY.value = 0
      draw()
      return
    }
    draw()
    animationId = requestAnimationFrame(step)
  }
  step()
}

function stopMotion() {
  if (animationId) cancelAnimationFrame(animationId)
  isDragging = false
  removePointerListeners()
  knobX.value = 0
  knobY.value = 0
  draw()
  emit('stop')
  emit('velocity-change', { linearX: 0, angularZ: 0 })
}

function startSendLoop() {
  if (sendTimer) return
  sendTimer = setInterval(() => {
    emit('velocity-change', {
      linearX: knobY.value * -props.maxLinearSpeed,
      angularZ: knobX.value * -props.maxAngularSpeed
    })
  }, commandInterval.value)
}

function stopSendLoop() {
  if (sendTimer) clearInterval(sendTimer)
  sendTimer = null
}

watch(() => props.commandRateHz, () => {
  stopSendLoop()
  if (props.connected) startSendLoop()
})

watch(() => props.connected, (connected) => {
  if (connected) {
    startSendLoop()
    draw()
  } else {
    stopSendLoop()
    stopMotion()
  }
})

onMounted(() => {
  draw()
  if (props.connected) startSendLoop()
})

onActivated(() => {
  if (props.connected) startSendLoop()
  draw()
})

onDeactivated(() => {
  stopSendLoop()
  stopMotion()
})

onUnmounted(() => {
  stopSendLoop()
  stopMotion()
  removePointerListeners()
  if (animationId) cancelAnimationFrame(animationId)
})
</script>
