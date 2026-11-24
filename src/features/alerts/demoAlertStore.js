import { useInspectionStore } from '../../stores/inspectionStore.js'

const {
  alerts: alertSession,
  acknowledgeAlert,
  resolveAlert
} = useInspectionStore()

export { alertSession, acknowledgeAlert, resolveAlert }
