import { useEffect, useState } from 'react'
import { storedSource } from '../library/library'
import { draftStorageKey, thumbPathFor } from './draft'

/**
 * Object URL for a draft image while the component is mounted. Uses the
 * small thumbnail when `thumbnail` is set and one exists.
 */
export const useDraftImage = (draftId: string, imagePath: string, thumbnail = true) => {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!imagePath) {
      return undefined
    }
    const source = storedSource(draftStorageKey(draftId))
    let release: (() => void) | null = null
    let cancelled = false
    const load = async () => {
      const loaded = (thumbnail ? await source.load(thumbPathFor(imagePath)) : null) ?? (await source.load(imagePath))
      if (!loaded) return
      if (cancelled) {
        loaded.release()
        return
      }
      release = loaded.release
      setUrl(loaded.url)
    }
    void load().catch(() => undefined)
    return () => {
      cancelled = true
      release?.()
      setUrl(null)
    }
  }, [draftId, imagePath, thumbnail])

  return imagePath ? url : null
}
