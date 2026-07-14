import { errFields, log } from '../lib/log'

// Playground Slice A: the CatLayer walk-frame preload cache,
// generalized to arbitrary URL lists. Semantics are unchanged from
// the CatLayer original (which now wraps this with its per-cat
// key/URL mapping):
//   - one entry per caller-chosen key; idle → loading → ready|failed
//   - 'ready' only after EVERY url in the set loads (a cat/scene must
//     never swap to a rich frame set with a hole in it)
//   - first error fails the whole set, once, permanently for the
//     session (no retry storm against a 404ing asset)
//   - concurrent callers share the same in-flight promise

type ImageCacheEntry = {
  status: 'idle' | 'loading' | 'ready' | 'failed'
  images: HTMLImageElement[]
  promise: Promise<boolean> | null
}

let imageCache = new Map<string, ImageCacheEntry>()

export function preloadImageUrls(
  key: string,
  urls: readonly string[],
  logTag = 'catImageCache:preload-failed',
): Promise<boolean> {
  let cached = imageCache.get(key)
  if (!cached) {
    cached = { status: 'idle', images: [], promise: null }
    imageCache.set(key, cached)
  }
  if (cached.status === 'ready') return Promise.resolve(true)
  if (cached.status === 'failed') return Promise.resolve(false)
  if (cached.promise) return cached.promise
  // Empty set is vacuously ready (the CatLayer wrapper guards this at
  // its call site; generalized callers shouldn't have to).
  if (urls.length === 0) {
    cached.status = 'ready'
    return Promise.resolve(true)
  }

  cached.status = 'loading'
  cached.promise = new Promise<boolean>((resolve) => {
    let loaded = 0
    let settled = false

    const fail = (url: string, error?: unknown) => {
      if (settled) return
      settled = true
      cached.status = 'failed'
      log.warn(logTag, {
        key,
        url,
        reason: error ? 'image-construction-failed' : 'image-load-error',
        ...(error ? errFields(error) : {}),
      })
      resolve(false)
    }

    for (const url of urls) {
      try {
        const image = new Image()
        cached.images.push(image)
        image.onload = () => {
          if (settled) return
          loaded += 1
          if (loaded === urls.length) {
            settled = true
            cached.status = 'ready'
            resolve(true)
          }
        }
        image.onerror = () => fail(url)
        image.src = url
      } catch (error) {
        fail(url, error)
        break
      }
    }
  })
  return cached.promise
}

/** True once every URL registered under `key` has loaded. */
export function isImageSetReady(key: string): boolean {
  return imageCache.get(key)?.status === 'ready'
}

// Narrow test seam: module-scope image caches otherwise outlive each
// consumer render in Vitest. Production never calls this.
export function _resetImageCacheForTests(): void {
  for (const entry of imageCache.values()) {
    for (const image of entry.images) {
      image.onload = null
      image.onerror = null
    }
  }
  imageCache = new Map()
}
