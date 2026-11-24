<template>
  <main class="module-pending">
    <section class="card module-pending-card">
      <span class="module-pending-mark"><UiIcon name="layers" :size="24" /></span>
      <div>
        <h1>{{ route.meta.title }}</h1>
        <p>页面模块尚未接入，应用外壳与路由已就绪。</p>
      </div>
      <code>{{ route.meta.featureModule }}</code>
    </section>
  </main>
</template>

<script setup>
import { useRoute } from 'vue-router'
import UiIcon from '../components/UiIcon.vue'

const route = useRoute()
</script>
