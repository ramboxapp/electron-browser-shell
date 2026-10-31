// An image given a `_favicon` URL, the way SafeInCloud's popup reads one: onto a canvas.
const imageIcon = (pageUrl, size, how) =>
  new Promise((resolve) => {
    const image = new Image()
    const timer = setTimeout(() => resolve({ error: 'timeout' }), 5000)
    image.onerror = () => {
      clearTimeout(timer)
      resolve({ error: 'error event' })
    }
    image.onload = () => {
      clearTimeout(timer)
      const canvas = new OffscreenCanvas(image.naturalWidth, image.naturalHeight)
      const context = canvas.getContext('2d')
      context.drawImage(image, 0, 0)
      const center = Math.floor(image.naturalWidth / 2)
      try {
        resolve({
          width: image.naturalWidth,
          height: image.naturalHeight,
          center: Array.from(context.getImageData(center, center, 1, 1).data),
        })
      } catch (error) {
        resolve({ error: `${error.name}: ${error.message}` })
      }
    }
    if (how === 'attribute') image.setAttribute('src', faviconUrl(pageUrl, size))
    else image.src = faviconUrl(pageUrl, size)
  })

const workerIcon = (pageUrl, size) =>
  chrome.runtime.sendMessage({ type: 'worker-fetch-icon', pageUrl, size })
