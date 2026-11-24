import { defineAsyncComponent } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import ModulePendingPage from './layout/ModulePendingPage.vue'

const featureModules = import.meta.glob([
  './features/**/*.vue',
  '!./features/maps/MapsPage.vue'
])
const LegacyRoute = { render: () => null }

function featureComponent(modulePath) {
  return defineAsyncComponent(() => {
    const load = featureModules[`./features/${modulePath}`]
    return load ? load() : Promise.resolve(ModulePendingPage)
  })
}

function featureRoute(path, name, title, nav, modulePath) {
  return {
    path,
    name,
    component: featureComponent(modulePath),
    props: true,
    meta: { title, nav, featureModule: `src/features/${modulePath}` }
  }
}

function legacyRoute(path, name, title) {
  return {
    path,
    name,
    component: LegacyRoute,
    meta: { title, nav: name, legacyView: name }
  }
}

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/overview' },
    featureRoute('/overview', 'overview', '总览', 'overview', 'overview/OverviewPage.vue'),
    legacyRoute('/inspection', 'inspection', '巡检工作台'),
    legacyRoute('/monitor', 'monitor', '单机监控'),
    featureRoute('/missions', 'missions', '巡检任务', 'missions', 'missions/MissionListPage.vue'),
    featureRoute('/missions/new', 'mission-create', '新建巡检任务', 'missions', 'missions/MissionEditorPage.vue'),
    featureRoute('/missions/:id/edit', 'mission-edit', '编辑巡检任务', 'missions', 'missions/MissionEditorPage.vue'),
    featureRoute('/missions/:id/run', 'mission-run', '执行巡检任务', 'missions', 'missions/MissionRunPage.vue'),
    legacyRoute('/maps', 'maps', '地图场景'),
    featureRoute('/records', 'records', '巡检记录', 'records', 'records/RecordsPage.vue'),
    featureRoute('/records/:id', 'record-detail', '巡检记录详情', 'records', 'records/RecordDetailPage.vue'),
    featureRoute('/alerts', 'alerts', '告警中心', 'alerts', 'alerts/AlertsPage.vue'),
    legacyRoute('/robots', 'robots', '机器狗管理'),
    legacyRoute('/settings', 'settings', '系统配置'),
    { path: '/:pathMatch(.*)*', redirect: '/overview' }
  ],
  scrollBehavior: () => ({ top: 0 })
})

router.afterEach((to) => {
  document.title = `${to.meta.title || '总览'} · 四足巡检平台`
})

export default router
