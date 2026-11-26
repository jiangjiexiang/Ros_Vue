import { defineAsyncComponent } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import ModulePendingPage from './layout/ModulePendingPage.vue'

const featureModules = import.meta.glob([
  './features/**/*.vue',
  '!./features/maps/MapsPage.vue'
])

const pageModules = import.meta.glob('./pages/*.vue')

function featureComponent(modulePath) {
  return defineAsyncComponent(() => {
    const load = featureModules[`./features/${modulePath}`]
    return load ? load() : Promise.resolve(ModulePendingPage)
  })
}

function pageComponent(moduleName) {
  return defineAsyncComponent(() => {
    const load = pageModules[`./pages/${moduleName}`]
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

function appRoute(path, name, title, nav, pageFile) {
  return {
    path,
    name,
    component: pageComponent(pageFile),
    meta: { title, nav }
  }
}

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/overview' },
    featureRoute('/overview', 'overview', '巡检总览', 'overview', 'overview/OverviewPage.vue'),
    appRoute('/inspection', 'inspection', '实时工作台', 'inspection', 'WorkspacePage.vue'),
    { path: '/monitor', redirect: '/inspection?mode=monitor' },
    featureRoute('/missions', 'missions', '巡检任务', 'missions', 'missions/MissionListPage.vue'),
    featureRoute('/missions/new', 'mission-create', '新建巡检任务', 'missions', 'missions/MissionEditorPage.vue'),
    featureRoute('/missions/:id/edit', 'mission-edit', '编辑巡检任务', 'missions', 'missions/MissionEditorPage.vue'),
    featureRoute('/missions/:id/run', 'mission-run', '执行巡检任务', 'missions', 'missions/MissionRunPage.vue'),
    appRoute('/maps', 'maps', '地图场景', 'maps', 'MapsPage.vue'),
    appRoute('/simulation', 'simulation', '仿真测试', 'simulation', 'SimulationPage.vue'),
    featureRoute('/records', 'records', '巡检记录', 'records', 'records/RecordsPage.vue'),
    featureRoute('/records/:id', 'record-detail', '巡检记录详情', 'records', 'records/RecordDetailPage.vue'),
    featureRoute('/alerts', 'alerts', '告警中心', 'alerts', 'alerts/AlertsPage.vue'),
    appRoute('/robots', 'robots', '机器狗管理', 'robots', 'RobotsPage.vue'),
    appRoute('/settings', 'settings', '系统配置', 'settings', 'SettingsPage.vue'),
    { path: '/:pathMatch(.*)*', redirect: '/overview' }
  ],
  scrollBehavior: () => ({ top: 0 })
})

router.afterEach((to) => {
  document.title = `${to.meta.title || '巡检总览'} · QuadPatrol 四足智巡平台`
})

export default router
