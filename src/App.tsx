import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import './App.css'
import { readArchive, readFromUrl, readPickedFiles, type BookPackage, type ImportResult } from './book/package'
import { chapterIndexOf, type Issue } from './book/schema'
import {
  BookActionsSheet,
  BusyOverlay,
  ConfirmLinkSheet,
  DuplicateSheet,
  ImportSheet,
  ReportSheet,
  Toast,
  type ToastMessage,
} from './components/Sheets'
import { builtinEntries, entryFromStored, loadLibrary, sortEntries, uniqueBookId, type LibraryEntry } from './library/library'
import { registerServiceWorker, requestPersistentStorage } from './pwa'
import { Chapters } from './screens/Chapters'
import { Library } from './screens/Library'
import { Reader } from './screens/Reader'
import {
  clearProgress,
  deleteBook,
  loadAllProgress,
  saveBook,
  saveProgress,
  takeInbox,
  type Progress,
} from './storage/db'

type Route =
  | { screen: 'library' }
  | { screen: 'chapters'; bookId: string }
  | { screen: 'reader'; bookId: string; pageId: string }

type SheetState =
  | { kind: 'import' }
  | { kind: 'report'; title: string; issues: Issue[] }
  | { kind: 'duplicate'; pkg: BookPackage; issues: Issue[]; existing: LibraryEntry }
  | { kind: 'link'; url: string }
  | { kind: 'actions'; bookId: string }
  | null

const LIBRARY: Route = { screen: 'library' }
const SAMPLE_PACKAGE_URL = `${import.meta.env.BASE_URL}samples/mosslight-mystery.gab`

/** Validates a route restored from `history.state` (it survives reloads). */
const readRoute = (state: unknown): Route | null => {
  if (!state || typeof state !== 'object') {
    return null
  }
  const route = state as Record<string, unknown>
  if (route.screen === 'library') {
    return LIBRARY
  }
  if (route.screen === 'chapters' && typeof route.bookId === 'string') {
    return { screen: 'chapters', bookId: route.bookId }
  }
  if (route.screen === 'reader' && typeof route.bookId === 'string' && typeof route.pageId === 'string') {
    return { screen: 'reader', bookId: route.bookId, pageId: route.pageId }
  }
  return null
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const isQuotaError = (error: unknown) =>
  error instanceof DOMException && (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')

const withoutKey = <T,>(record: Record<string, T>, key: string) => {
  const next = { ...record }
  delete next[key]
  return next
}

function App() {
  const [entries, setEntries] = useState<LibraryEntry[]>(builtinEntries)
  const [libraryLoading, setLibraryLoading] = useState(true)
  const [storageError, setStorageError] = useState(false)
  const [progress, setProgress] = useState<Record<string, Progress>>({})
  const [route, setRoute] = useState<Route>(() => readRoute(window.history.state) ?? LIBRARY)
  const [sheet, setSheet] = useState<SheetState>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const entriesRef = useRef(entries)
  const progressRef = useRef(progress)

  useEffect(() => {
    entriesRef.current = entries
    progressRef.current = progress
  }, [entries, progress])

  const routeBookId = route.screen === 'library' ? null : route.bookId
  const entry = routeBookId ? entries.find((item) => item.book.id === routeBookId) ?? null : null
  // A route restored from history can name a page that no longer exists
  // (e.g. the book was replaced); fall back to the start page.
  const readerPageId =
    route.screen === 'reader' && entry ? (entry.book.pages[route.pageId] ? route.pageId : entry.book.startPageId) : null

  // ---------- Progress ----------

  /** Records that a page was reached: unlocks its chapter and sets "Continue". */
  const recordVisit = useCallback((bookId: string, pageId: string) => {
    const book = entriesRef.current.find((item) => item.book.id === bookId)?.book
    if (!book?.pages[pageId]) {
      return
    }
    const current = progressRef.current[bookId]
    const unlockedChapterIndex = Math.max(current?.unlockedChapterIndex ?? 0, chapterIndexOf(book, pageId))
    if (current?.lastPageId === pageId && current.unlockedChapterIndex === unlockedChapterIndex) {
      return
    }
    const next: Progress = { unlockedChapterIndex, lastPageId: pageId, updatedAt: Date.now() }
    progressRef.current = { ...progressRef.current, [bookId]: next }
    setProgress(progressRef.current)
    saveProgress(bookId, next).catch(() => undefined)
  }, [])

  // ---------- Navigation (browser history, so Android back works) ----------

  const navigate = useCallback((next: Route, options: { replace?: boolean } = {}) => {
    // Dropping the query string also clears one-off ?import= / ?shared= params.
    const url = window.location.pathname
    if (options.replace) {
      window.history.replaceState(next, '', url)
    } else {
      window.history.pushState(next, '', url)
    }
    setRoute(next)
    if (next.screen === 'reader') {
      recordVisit(next.bookId, next.pageId)
    }
  }, [recordVisit])

  useEffect(() => {
    if (!readRoute(window.history.state)) {
      window.history.replaceState(LIBRARY, '')
    }
    const handlePop = (event: PopStateEvent) => {
      const next = readRoute(event.state) ?? LIBRARY
      setSheet(null)
      setRoute(next)
      if (next.screen === 'reader') {
        recordVisit(next.bookId, next.pageId)
      }
    }
    window.addEventListener('popstate', handlePop)
    return () => window.removeEventListener('popstate', handlePop)
  }, [recordVisit])

  useEffect(() => {
    document.title = entry ? `${entry.book.title} · Graphic Adventure` : 'Graphic Adventure'
  }, [entry])

  // Match the phone's status bar to the dark reading stage or the paper screens.
  const themeColor = route.screen === 'reader' && entry ? '#2a211b' : '#efe1cc'
  useEffect(() => {
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColor)
  }, [themeColor])

  // ---------- Toasts ----------

  const showToast = useCallback((text: string, action?: ToastMessage['action']) => {
    setToast({ id: Date.now(), text, action })
  }, [])

  const dismissToast = useCallback(() => setToast(null), [])

  useEffect(() => {
    registerServiceWorker({
      onUpdateReady: (apply) => showToast('A new version of the app is ready', { label: 'Update', run: apply }),
    })
  }, [showToast])

  // ---------- Import ----------

  const commitImport = async (pkg: BookPackage, issues: Issue[], mode: 'new' | 'replace' | 'copy') => {
    setSheet(null)
    let book = pkg.book
    if (mode === 'copy') {
      const id = uniqueBookId(book.id, new Set(entriesRef.current.map((item) => item.book.id)))
      book = { ...book, id, title: `${book.title} (${id.slice(book.id.length + 1)})` }
    }

    setBusy('Saving to this device…')
    try {
      const stored = await saveBook(book, pkg.assets)
      setEntries((previous) => sortEntries([entryFromStored(stored), ...previous.filter((item) => item.book.id !== book.id)]))
      void requestPersistentStorage()
      navigate({ screen: 'chapters', bookId: book.id })
      const notes = issues.filter((issue) => issue.level === 'warning')
      showToast(
        `Added "${book.title}" to your library`,
        notes.length > 0
          ? { label: `${notes.length} note${notes.length > 1 ? 's' : ''}`, run: () => setSheet({ kind: 'report', title: 'Import notes', issues: notes }) }
          : undefined,
      )
    } catch (error) {
      setSheet({
        kind: 'report',
        title: "This book couldn't be saved",
        issues: [
          {
            level: 'error',
            message: isQuotaError(error)
              ? "There isn't enough free storage on this device for this book. Remove a book or free up space, then try again."
              : `Saving failed: ${errorMessage(error)}`,
          },
        ],
      })
    } finally {
      setBusy(null)
    }
  }

  const runImport = async (read: () => Promise<ImportResult>) => {
    setSheet(null)
    setBusy('Opening book…')
    let result: ImportResult
    try {
      result = await read()
    } catch (error) {
      result = { ok: false, issues: [{ level: 'error', message: `Import failed: ${errorMessage(error)}` }] }
    } finally {
      setBusy(null)
    }

    if (!result.ok) {
      setSheet({ kind: 'report', title: "This book couldn't be added", issues: result.issues })
      return
    }

    const existing = entriesRef.current.find((item) => item.book.id === result.pkg.book.id)
    if (existing) {
      setSheet({ kind: 'duplicate', pkg: result.pkg, issues: result.issues, existing })
      return
    }
    await commitImport(result.pkg, result.issues, 'new')
  }

  // ---------- Startup: load library, then pick up books sent to the app ----------

  const handleIncoming = useEffectEvent(async () => {
    const params = new URLSearchParams(window.location.search)
    const importUrl = params.get('import')
    if (importUrl) {
      setSheet({ kind: 'link', url: importUrl })
    }

    // Files shared to the installed app (Android share sheet) wait in the inbox.
    try {
      for (const item of await takeInbox()) {
        await runImport(() => readArchive(item.file))
      }
    } catch {
      // No storage, so nothing could have been shared in.
    }

    // Files opened with the installed app (desktop file associations).
    window.launchQueue?.setConsumer(async (launch) => {
      for (const handle of launch.files ?? []) {
        const file = await handle.getFile()
        await runImport(() => readArchive(file))
      }
    })
  })

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const [loaded, savedProgress] = await Promise.all([loadLibrary(), loadAllProgress()])
        if (!cancelled) {
          setEntries(loaded)
          entriesRef.current = loaded
          setProgress(savedProgress)
        }
      } catch {
        if (!cancelled) {
          setStorageError(true)
        }
      }
      if (!cancelled) {
        setLibraryLoading(false)
        void handleIncoming()
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  // ---------- Library management ----------

  const resetProgress = async (bookId: string) => {
    setSheet(null)
    setProgress((previous) => withoutKey(previous, bookId))
    await clearProgress(bookId).catch(() => undefined)
    showToast('Progress cleared')
  }

  const removeBook = async (bookId: string) => {
    setSheet(null)
    try {
      await deleteBook(bookId)
      setEntries((previous) => previous.filter((item) => item.book.id !== bookId))
      setProgress((previous) => withoutKey(previous, bookId))
      showToast('Book removed from this device')
    } catch (error) {
      setSheet({ kind: 'report', title: "The book couldn't be removed", issues: [{ level: 'error', message: errorMessage(error) }] })
    }
  }

  const openReader = (bookId: string, pageId: string) => navigate({ screen: 'reader', bookId, pageId })

  // ---------- Render ----------

  const renderScreen = () => {
    if (route.screen === 'library' || !entry) {
      // While a restored deep link waits for the library, show plain paper.
      if (route.screen !== 'library' && libraryLoading) {
        return null
      }
      return (
        <Library
          entries={entries}
          progress={progress}
          loading={libraryLoading}
          storageError={storageError}
          onOpen={(bookId) => navigate({ screen: 'chapters', bookId })}
          onContinue={(bookId) => {
            const lastPageId = progress[bookId]?.lastPageId
            if (lastPageId) {
              openReader(bookId, lastPageId)
            }
          }}
          onImport={() => setSheet({ kind: 'import' })}
          onBookActions={(bookId) => setSheet({ kind: 'actions', bookId })}
        />
      )
    }

    if (route.screen === 'chapters') {
      return (
        <Chapters
          entry={entry}
          progress={progress[entry.book.id]}
          onBack={() => navigate(LIBRARY)}
          onRead={(pageId) => openReader(entry.book.id, pageId)}
        />
      )
    }

    return (
      <Reader
        entry={entry}
        pageId={readerPageId ?? entry.book.startPageId}
        onNavigate={(pageId) => openReader(entry.book.id, pageId)}
        onOpenChapters={() => navigate({ screen: 'chapters', bookId: entry.book.id })}
        onOpenLibrary={() => navigate(LIBRARY)}
      />
    )
  }

  const renderSheet = () => {
    switch (sheet?.kind) {
      case 'import':
        return (
          <ImportSheet
            onClose={() => setSheet(null)}
            onFiles={(files) => void runImport(() => readPickedFiles(files))}
            onUrl={(url) => void runImport(() => readFromUrl(url))}
            onSample={() => void runImport(() => readFromUrl(SAMPLE_PACKAGE_URL))}
          />
        )
      case 'report':
        return <ReportSheet title={sheet.title} issues={sheet.issues} onClose={() => setSheet(null)} />
      case 'duplicate':
        return (
          <DuplicateSheet
            title={sheet.existing.book.title}
            canReplace={!sheet.existing.builtin}
            onReplace={() => void commitImport(sheet.pkg, sheet.issues, 'replace')}
            onKeepBoth={() => void commitImport(sheet.pkg, sheet.issues, 'copy')}
            onCancel={() => setSheet(null)}
          />
        )
      case 'link':
        return (
          <ConfirmLinkSheet
            url={sheet.url}
            onConfirm={() => {
              const { url } = sheet
              navigate(route, { replace: true })
              void runImport(() => readFromUrl(url))
            }}
            onCancel={() => {
              navigate(route, { replace: true })
              setSheet(null)
            }}
          />
        )
      case 'actions': {
        const target = entries.find((item) => item.book.id === sheet.bookId)
        if (!target) {
          return null
        }
        return (
          <BookActionsSheet
            entry={target}
            hasProgress={Boolean(progress[target.book.id])}
            onClose={() => setSheet(null)}
            onResetProgress={() => void resetProgress(target.book.id)}
            onRemove={() => void removeBook(target.book.id)}
          />
        )
      }
      default:
        return null
    }
  }

  return (
    <div className={`app-shell ${route.screen === 'reader' && entry ? 'is-reading' : ''}`}>
      {renderScreen()}
      {renderSheet()}
      {busy && <BusyOverlay message={busy} />}
      {toast && <Toast key={toast.id} toast={toast} onDismiss={dismissToast} />}
    </div>
  )
}

export default App
