// Page-side PWA helpers: service worker registration and storage persistence.
import { registerSW } from 'virtual:pwa-register'

type UpdateHandlers = {
  /** A new version is waiting; call `apply` to reload into it. */
  onUpdateReady: (apply: () => void) => void
}

let registered = false

export const registerServiceWorker = ({ onUpdateReady }: UpdateHandlers) => {
  // Service workers need a secure context (https or localhost).
  if (registered || !('serviceWorker' in navigator) || !window.isSecureContext) {
    return
  }
  registered = true
  const updateSW = registerSW({
    onNeedRefresh: () => onUpdateReady(() => void updateSW(true)),
  })
}

/** Asks the browser not to evict our data under storage pressure. */
export const requestPersistentStorage = async () => {
  try {
    if (await navigator.storage?.persisted?.()) {
      return true
    }
    return (await navigator.storage?.persist?.()) ?? false
  } catch {
    return false
  }
}

export const isIos = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1)

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true
