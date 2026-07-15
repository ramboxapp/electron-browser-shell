export * from './browser'
export { setSessionPartitionResolver } from './browser/partition'
export { patchActiveTabManifest, grantActiveTabHostAccess } from './browser/patch/active-tab-patch'
export { patchModuleServiceWorker } from './browser/patch/module-service-worker-patch'
export { wakeExtensionServiceWorker } from './browser/patch/service-worker-wake'
export {
  patchExtensionCssMessages,
  substituteExtensionIdInCss,
} from './browser/patch/css-message-patch'
