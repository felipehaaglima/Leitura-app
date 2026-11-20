const CACHE_PREFIX = 'margem-shell-'
const CACHE_NAME = CACHE_PREFIX + SHELL_VERSION
const SHELL_PAGE = '/index.html'
const staticPaths = new Set(SHELL_FILES)

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME)
    await cache.addAll(SHELL_FILES.map(path => new Request(path, { cache: 'reload' })))
  })())
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map(key => caches.delete(key)))
    await self.clients.claim()
  })())
})

async function appPage(request) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3500)
  try {
    const response = await fetch(request, { signal: controller.signal })
    if (response.status < 500) return response
  } catch {
    // The installed shell is used when the network cannot reach Margem.
  } finally {
    clearTimeout(timeout)
  }
  const cache = await caches.open(CACHE_NAME)
  return await cache.match(SHELL_PAGE) || Response.error()
}

async function staticFile(request, path) {
  const cache = await caches.open(CACHE_NAME)
  return await cache.match(path) || fetch(request)
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return

  if (event.request.mode === 'navigate' && (url.pathname === '/' || url.pathname === SHELL_PAGE)) {
    event.respondWith(appPage(event.request))
  } else if (staticPaths.has(url.pathname)) {
    event.respondWith(staticFile(event.request, url.pathname))
  }
})
