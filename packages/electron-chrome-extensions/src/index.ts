export * from './browser'
export { setSessionPartitionResolver } from './browser/partition'
export { patchActiveTabManifest, grantActiveTabHostAccess } from './browser/patch/active-tab-patch'
export {
  patchModuleServiceWorker,
  willPatchModuleServiceWorker,
} from './browser/patch/module-service-worker-patch'
export { wakeExtensionServiceWorker } from './browser/patch/service-worker-wake'
export { applyManifestPublicKey } from './browser/patch/manifest-key-patch'
export {
  patchExtensionCssMessages,
  substituteExtensionIdInCss,
} from './browser/patch/css-message-patch'
export {
  patchContentScriptStorage,
  CONTENT_SCRIPT_STORAGE_SHIM_FILE,
} from './browser/patch/content-script-storage-patch'
export {
  patchExtensionLocale,
  localeCandidates,
  resolveExtensionMessages,
} from './browser/patch/locale-patch'
export { formatExtensionMessage, CRX_I18N_KEY } from './shared/i18n-format'
