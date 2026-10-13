import { useSyncExternalStore } from 'react'

/** Live result of a CSS media query, e.g. whether the page panel is full screen. */
export const useMediaQuery = (query: string) =>
  useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    () => window.matchMedia(query).matches,
  )
