import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { neighborPageIds } from '../book/schema'
import type { LibraryEntry } from './library'

type Slot = {
  url: string | null
  failed: boolean
  disposed: boolean
  release: () => void
  ready: Promise<void>
}

const createSlot = (entry: LibraryEntry, path: string, preload: boolean): Slot => {
  const slot: Slot = { url: null, failed: false, disposed: false, release: () => undefined, ready: Promise.resolve() }
  slot.ready = entry.source
    .load(path)
    .then(async (loaded) => {
      if (!loaded) {
        slot.failed = true
        return
      }
      if (slot.disposed) {
        loaded.release()
        return
      }
      slot.url = loaded.url
      slot.release = loaded.release
      if (preload) {
        // Decode ahead of time so swiping to a neighbor doesn't flash.
        const image = new Image()
        image.src = loaded.url
        await image.decode().catch(() => undefined)
      }
    })
    .catch(() => {
      slot.failed = true
    })
  return slot
}

const disposeSlot = (slot: Slot) => {
  slot.disposed = true
  slot.release()
}

export type PageImageState = { pageId: string; url: string | null; status: 'loading' | 'ready' | 'error' }

/**
 * Keeps only the current page's image and its direct neighbors loaded.
 * Everything else is released (object URLs revoked) as the reader moves.
 */
export const usePageImage = (entry: LibraryEntry | null, pageId: string | null): PageImageState | null => {
  const [state, setState] = useState<PageImageState | null>(null)
  const slotsRef = useRef(new Map<string, Slot>())

  // Also a layout effect, so switching books releases the old images before
  // the effect below loads the new ones.
  useLayoutEffect(() => {
    const slots = slotsRef.current
    return () => {
      slots.forEach(disposeSlot)
      slots.clear()
    }
  }, [entry])

  // Layout effect: an already-preloaded neighbor shows on the very next paint.
  useLayoutEffect(() => {
    const page = entry && pageId ? entry.book.pages[pageId] : null
    if (!entry || !page) {
      return undefined
    }

    const book = entry.book
    const wanted = new Set([page.image, ...neighborPageIds(book, page.id).map((id) => book.pages[id].image)])
    const slots = slotsRef.current
    for (const [path, slot] of slots) {
      if (!wanted.has(path)) {
        disposeSlot(slot)
        slots.delete(path)
      }
    }
    for (const path of wanted) {
      if (!slots.has(path)) {
        slots.set(path, createSlot(entry, path, path !== page.image))
      }
    }

    const slot = slots.get(page.image)!
    let cancelled = false
    const publish = () => {
      if (!cancelled) {
        setState({ pageId: page.id, url: slot.url, status: slot.failed ? 'error' : slot.url ? 'ready' : 'loading' })
      }
    }
    publish()
    void slot.ready.then(publish)

    return () => {
      cancelled = true
    }
  }, [entry, pageId])

  return state?.pageId === pageId ? state : null
}

/** A single image (e.g. a cover) loaded for as long as the component is mounted. */
export const useAssetUrl = (entry: LibraryEntry, path: string) => {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let release: (() => void) | null = null
    let cancelled = false
    entry.source
      .load(path)
      .then((loaded) => {
        if (!loaded) {
          return
        }
        if (cancelled) {
          loaded.release()
          return
        }
        release = loaded.release
        setUrl(loaded.url)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      release?.()
      setUrl(null)
    }
  }, [entry, path])

  return url
}
