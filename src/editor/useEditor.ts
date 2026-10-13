import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { Book } from '../book/schema'
import { getDraft, saveDraft } from '../storage/db'
import type { Draft } from './draft'
import { pruneDraftAssets, storedDraftImages } from './service'

const HISTORY_LIMIT = 80
const SAVE_DELAY_MS = 500

/** Edits with the same key within this window share one undo step (e.g. typing a title). */
const COALESCE_MS = 1200

type State = { draft: Draft | null; past: Book[]; future: Book[]; lastKey?: string; lastAt?: number }

type Action =
  | { type: 'load'; draft: Draft }
  | { type: 'edit'; change: (book: Book) => Book; coalesce?: string; at: number }
  | { type: 'meta'; patch: Partial<Pick<Draft, 'customId'>> }
  | { type: 'undo' }
  | { type: 'redo' }

const reducer = (state: State, action: Action): State => {
  const { draft } = state
  if (action.type === 'load') {
    return { draft: action.draft, past: [], future: [] }
  }
  if (!draft) {
    return state
  }
  switch (action.type) {
    case 'edit': {
      const book = action.change(draft.book)
      if (book === draft.book) return state
      const merge = action.coalesce && action.coalesce === state.lastKey && action.at - (state.lastAt ?? 0) < COALESCE_MS
      return {
        draft: { ...draft, book, updatedAt: action.at },
        past: merge ? state.past : [...state.past.slice(-HISTORY_LIMIT + 1), draft.book],
        future: [],
        lastKey: action.coalesce,
        lastAt: action.at,
      }
    }
    case 'meta':
      return { ...state, draft: { ...draft, ...action.patch, updatedAt: Date.now() } }
    case 'undo': {
      const previous = state.past.at(-1)
      if (!previous) return state
      return { draft: { ...draft, book: previous, updatedAt: Date.now() }, past: state.past.slice(0, -1), future: [draft.book, ...state.future] }
    }
    case 'redo': {
      const [next, ...rest] = state.future
      if (!next) return state
      return { draft: { ...draft, book: next, updatedAt: Date.now() }, past: [...state.past, draft.book], future: rest }
    }
  }
}

export type SaveState = 'saved' | 'saving' | 'error'

/** Loads a draft, tracks edits with undo/redo, and autosaves to the device. */
export const useEditor = (draftId: string) => {
  const [state, dispatch] = useReducer(reducer, { draft: null, past: [], future: [] })
  const [storedImages, setStoredImages] = useState<Set<string>>(new Set())
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  /** `updatedAt` of the version last written to storage. */
  const [savedAt, setSavedAt] = useState(0)
  const lastSaved = useRef<Draft | null>(null)
  const latest = useRef<Draft | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const draft = await getDraft(draftId)
        if (!draft) {
          throw new Error('This draft no longer exists.')
        }
        // Images from pages deleted last session (kept for undo) can go now.
        await pruneDraftAssets(draft).catch(() => undefined)
        const images = await storedDraftImages(draft.id)
        if (!cancelled) {
          lastSaved.current = draft
          latest.current = draft
          setSavedAt(draft.updatedAt)
          setStoredImages(images)
          dispatch({ type: 'load', draft })
        }
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error))
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [draftId])

  const flush = useCallback(async () => {
    const draft = latest.current
    if (!draft || draft === lastSaved.current) {
      return
    }
    try {
      await saveDraft(draft)
      lastSaved.current = draft
      setSavedAt(draft.updatedAt)
      setSaveFailed(false)
    } catch {
      setSaveFailed(true)
    }
  }, [])

  // Autosave shortly after edits stop.
  useEffect(() => {
    latest.current = state.draft
    if (!state.draft || state.draft === lastSaved.current) {
      return undefined
    }
    const timer = window.setTimeout(() => void flush(), SAVE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [state.draft, flush])

  // Save straight away when the app is hidden or the editor closes.
  useEffect(() => {
    const handleHide = () => document.visibilityState === 'hidden' && void flush()
    document.addEventListener('visibilitychange', handleHide)
    window.addEventListener('pagehide', handleHide)
    return () => {
      document.removeEventListener('visibilitychange', handleHide)
      window.removeEventListener('pagehide', handleHide)
      void flush()
    }
  }, [flush])

  const edit = useCallback(
    (change: (book: Book) => Book, coalesce?: string) => dispatch({ type: 'edit', change, coalesce, at: Date.now() }),
    [],
  )
  /** The newest draft, for async work that finishes after several renders. */
  const getCurrent = useCallback(() => latest.current, [])
  const setMeta = useCallback((patch: Partial<Pick<Draft, 'customId'>>) => dispatch({ type: 'meta', patch }), [])
  const undo = useCallback(() => dispatch({ type: 'undo' }), [])
  const redo = useCallback(() => dispatch({ type: 'redo' }), [])
  const addStoredImages = useCallback((paths: string[]) => setStoredImages((previous) => new Set([...previous, ...paths])), [])

  return {
    draft: state.draft,
    loadError,
    saveState: (saveFailed ? 'error' : state.draft && state.draft.updatedAt !== savedAt ? 'saving' : 'saved') as SaveState,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    storedImages,
    edit,
    getCurrent,
    setMeta,
    undo,
    redo,
    flush,
    addStoredImages,
  }
}
