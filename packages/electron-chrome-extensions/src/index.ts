export * from './browser'
export { setSessionPartitionResolver } from './browser/partition'
export { patchActiveTabManifest, grantActiveTabHostAccess } from './browser/patch/active-tab-patch'
export { patchModuleServiceWorker } from './browser/patch/module-service-worker-patch'
export { wakeExtensionServiceWorker } from './browser/patch/service-worker-wake'
export { applyManifestPublicKey } from './browser/patch/manifest-key-patch'
export {
  patchExtensionCssMessages,
  substituteExtensionIdInCss,
} from './browser/patch/css-message-patch'
