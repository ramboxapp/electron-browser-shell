// Shared by the page and the worker: what a `_favicon` answer is, measured without hanging.
self.describeIcon = async (blob) => {
  const bitmap = await createImageBitmap(blob)
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const context = canvas.getContext('2d')
  context.drawImage(bitmap, 0, 0)
  const center = Math.floor(bitmap.width / 2)
  return {
    width: bitmap.width,
    height: bitmap.height,
    center: Array.from(context.getImageData(center, center, 1, 1).data),
  }
}

self.faviconUrl = (pageUrl, size) => {
  const url = new URL(chrome.runtime.getURL('/_favicon/'))
  if (pageUrl !== undefined) url.searchParams.set('pageUrl', pageUrl)
  if (size !== undefined) url.searchParams.set('size', String(size))
  return url.toString()
}

self.fetchIcon = async (pageUrl, size) => {
  try {
    const response = await fetch(faviconUrl(pageUrl, size), { signal: AbortSignal.timeout(5000) })
    return { status: response.status, ...(await describeIcon(await response.blob())) }
  } catch (error) {
    return { error: `${error.name}: ${error.message}` }
  }
}
