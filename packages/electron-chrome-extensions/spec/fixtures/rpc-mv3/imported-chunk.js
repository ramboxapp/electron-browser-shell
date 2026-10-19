/*
  A chunk the service worker pulls in with importScripts during its initial evaluation.

  This is how Dashlane loads its crypto: background-service-worker.js does
  importScripts('preload-async-chunks.js'), which in turn importScripts the argon2, libsodium and
  opaque chunks inside a try. A failure there is swallowed and the extension simply never works.
*/
self.__crxImportedChunk = 'loaded'
