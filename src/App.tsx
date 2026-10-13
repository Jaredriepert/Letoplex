import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import './App.css'
import { readArchive, readFromUrl, readPickedFiles, type BookPackage, type ImportResult } from './book/package'
import { chapterIndexOf, type Book, type Issue } from './book/schema'
import {
  BookActionsSheet,
  BusyOverlay,
  ConfirmLinkSheet,
  DuplicateSheet,
  ImportSheet,
  ProgressOverlay,
  ReportSheet,
  SaveProgressOverlay,
  SpaceSheet,
  StorageSheet,
  Toast,
  type ProgressInfo,
  type SaveStatus,
  type ToastMessage,
} from './components/Sheets'
import { createDraft, type Draft } from './editor/draft'
import { Editor } from './editor/Editor'
import { draftEntry, draftFromLibraryBook, packageDraft } from './editor/service'
import { checkSpace, holdWakeLock, ImportCancelled, savePackage } from './library/importer'
import {
  builtinEntries,
  entryFromStored,
  loadLibrary,
  sortEntries,
  uniqueBookId,
  visibleBuiltinEntries,
  type LibraryEntry,
} from './library/library'
import { readHiddenBuiltins, writeHiddenBuiltins } from './storage/prefs'
import { registerServiceWorker, requestPersistentStorage } from './pwa'
import { Chapters } from './screens/Chapters'
import { Create } from './screens/Create'
import { Library, type HomeTab } from './screens/Library'
import { Reader } from './screens/Reader'
import {
  clearProgress,
  deleteBook,
  deleteDraft,
  getDraft,
  loadAllProgress,
  saveDraft,
  removeOrphanAssets,
  listInbox,
  removeFromInbox,
  saveProgress,
  type Progress,
} from './storage/db'

type Route =
  | { screen: 'library' }
  | { screen: 'chapters'; bookId: string }
  | { screen: 'reader'; bookId: string; pageId: string }
  | { screen: 'create' }
  | { screen: 'editor'; draftId: string }
  | { screen: 'preview'; draftId: string; pageId: string }

/** A validated package waiting to be saved, with its final id and title. */
type PendingImport = { pkg: BookPackage; issues: Issue[]; book: Book }

type SheetState =
  | { kind: 'import' }
  | { kind: 'report'; title: string; issues: Issue[] }
  | { kind: 'duplicate'; pkg: BookPackage; issues: Issue[]; existing: LibraryEntry }
  | { kind: 'link'; url: string }
  | { kind: 'actions'; bookId: string }
  | { kind: 'space'; pending: PendingImport; neededBytes: number; freeBytes: number }
  | { kind: 'storage'; pending: PendingImport | null; message?: string }
  | null

const LIBRARY: Route = { screen: 'library' }
const CREATE: Route = { screen: 'create' }
const SAMPLE_PACKAGE_URL = `${import.meta.env.BASE_URL}samples/mosslight-mystery.letoplex`

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
  if (route.screen === 'create') {
    return CREATE
  }
  if (route.screen === 'editor' && typeof route.draftId === 'string') {
    return { screen: 'editor', draftId: route.draftId }
  }
  if (route.screen === 'preview' && typeof route.draftId === 'string' && typeof route.pageId === 'string') {
    return { screen: 'preview', draftId: route.draftId, pageId: route.pageId }
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
  const [entries, setEntries] = useState<LibraryEntry[]>(visibleBuiltinEntries)
  const [hiddenBuiltinCount, setHiddenBuiltinCount] = useState(() => readHiddenBuiltins().length)
  const [libraryLoading, setLibraryLoading] = useState(true)
  const [storageError, setStorageError] = useState(false)
  const [progress, setProgress] = useState<Record<string, Progress>>({})
  const [route, setRoute] = useState<Route>(() => readRoute(window.history.state) ?? LIBRARY)
  const [sheet, setSheet] = useState<SheetState>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<SaveStatus | null>(null)
  const saveAbortRef = useRef<AbortController | null>(null)
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const entriesRef = useRef(entries)
  const progressRef = useRef(progress)

  useEffect(() => {
    entriesRef.current = entries
    progressRef.current = progress
  }, [entries, progress])

  const routeBookId = route.screen === 'chapters' || route.screen === 'reader' ? route.bookId : null
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
    document.title = entry ? `${entry.book.title} · Letoplex` : 'Letoplex'
  }, [entry])

  // ---------- Drafts and preview ----------

  const [previewDraft, setPreviewDraft] = useState<Draft | null>(null)
  const previewEntry = useMemo(() => (previewDraft ? draftEntry(previewDraft) : null), [previewDraft])
  /** True when the preview was opened from the editor in this session (so Back returns there). */
  const previewFromEditorRef = useRef(false)
  const [draftsVersion, setDraftsVersion] = useState(0)
  const [appProgress, setAppProgress] = useState<ProgressInfo | null>(null)

  // A preview restored by a reload needs its draft loaded.
  useEffect(() => {
    if (route.screen !== 'preview' || previewDraft?.id === route.draftId) {
      return undefined
    }
    let cancelled = false
    getDraft(route.draftId)
      .then((draft) => {
        if (cancelled) return
        if (draft) setPreviewDraft(draft)
        else navigate(CREATE, { replace: true })
      })
      .catch(() => !cancelled && navigate(CREATE, { replace: true }))
    return () => {
      cancelled = true
    }
  }, [route, previewDraft, navigate])

  const openPreview = async (draftId: string, pageId: string) => {
    const draft = await getDraft(draftId)
    if (!draft) return
    setPreviewDraft(draft)
    previewFromEditorRef.current = true
    navigate({ screen: 'preview', draftId, pageId })
  }

  const exitPreview = (draftId: string) => {
    if (previewFromEditorRef.current) {
      previewFromEditorRef.current = false
      window.history.back()
    } else {
      navigate({ screen: 'editor', draftId }, { replace: true })
    }
  }

  // Match the phone's status bar to the dark reading stage or the paper screens.
  const themeColor = (route.screen === 'reader' && entry) || route.screen === 'preview' ? '#2a211b' : '#efe1cc'
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

  /** Copies the pages into storage with a progress bar, then opens the book. */
  const savePending = async ({ pkg, issues, book }: PendingImport) => {
    setSheet(null)
    const controller = new AbortController()
    saveAbortRef.current = controller
    setSaveStatus({ title: book.title, savedFiles: 0, totalFiles: pkg.assets.size, savedBytes: 0, totalBytes: pkg.totalBytes, cancelling: false })
    const releaseWakeLock = await holdWakeLock()
    try {
      const stored = await savePackage(pkg, book, {
        signal: controller.signal,
        onProgress: (progress) => setSaveStatus((status) => (status ? { ...status, ...progress } : status)),
      })
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
      if (error instanceof ImportCancelled) {
        showToast('Import cancelled. Nothing was changed.')
      } else if (isQuotaError(error)) {
        setSheet({ kind: 'storage', pending: { pkg, issues, book }, message: 'The device ran out of space while saving. Nothing was changed. Remove a book to make room, then continue.' })
      } else {
        setSheet({ kind: 'report', title: "This book couldn't be saved", issues: [{ level: 'error', message: `Saving failed: ${errorMessage(error)}. Nothing was changed.` }] })
      }
    } finally {
      releaseWakeLock()
      saveAbortRef.current = null
      setSaveStatus(null)
    }
  }

  /** Checks free space first; if it looks short, lets the user free some or try anyway. */
  const startSave = async (pending: PendingImport) => {
    setSheet(null)
    const space = await checkSpace(pending.pkg)
    if (space.status === 'short') {
      setSheet({ kind: 'space', pending, neededBytes: space.neededBytes, freeBytes: space.freeBytes })
      return
    }
    await savePending(pending)
  }

  const commitImport = async (pkg: BookPackage, issues: Issue[], mode: 'new' | 'replace' | 'copy') => {
    let book = pkg.book
    if (mode === 'copy') {
      const id = uniqueBookId(book.id, new Set(entriesRef.current.map((item) => item.book.id)))
      book = { ...book, id, title: `${book.title} (${id.slice(book.id.length + 1)})` }
    }
    await startSave({ pkg, issues, book })
  }

  const cancelSave = () => {
    saveAbortRef.current?.abort()
    setSaveStatus((status) => (status ? { ...status, cancelling: true } : status))
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
    // Each is removed only after its import has run, so closing the app
    // part-way leaves it there for next time.
    try {
      for (const item of await listInbox()) {
        await runImport(() => readArchive(item.file))
        if (item.id !== undefined) await removeFromInbox(item.id)
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
        // Clear out images from imports that were interrupted last time.
        // This must finish before any new import starts writing.
        await removeOrphanAssets().catch(() => undefined)
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

  const setBuiltinHidden = (bookId: string, hidden: boolean) => {
    const ids = new Set(readHiddenBuiltins())
    if (hidden) {
      ids.add(bookId)
    } else {
      ids.delete(bookId)
    }
    writeHiddenBuiltins([...ids])
    setHiddenBuiltinCount(ids.size)
    const builtin = builtinEntries.find((item) => item.book.id === bookId)
    setEntries((previous) => {
      const others = previous.filter((item) => item.book.id !== bookId)
      return hidden || !builtin ? others : sortEntries([...others, builtin])
    })
  }

  const restoreBuiltins = () => {
    writeHiddenBuiltins([])
    setHiddenBuiltinCount(0)
    setEntries((previous) =>
      sortEntries([...previous.filter((item) => !item.builtin), ...builtinEntries]),
    )
  }

  const removeBook = async (bookId: string, options: { keepSheet?: boolean } = {}) => {
    if (!options.keepSheet) {
      setSheet(null)
    }
    // Built-in books take no storage; removing just hides them (progress is kept).
    if (entriesRef.current.find((item) => item.book.id === bookId)?.builtin) {
      setBuiltinHidden(bookId, true)
      showToast('Sample book removed from your library', { label: 'Undo', run: () => setBuiltinHidden(bookId, false) })
      return
    }
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

  // ---------- Create ----------

  const switchTab = (tab: HomeTab) => navigate(tab === 'create' ? CREATE : LIBRARY, { replace: true })

  const startNewDraft = async () => {
    try {
      const draft = createDraft()
      await saveDraft(draft)
      navigate({ screen: 'editor', draftId: draft.id })
    } catch (error) {
      setSheet({ kind: 'report', title: "A new draft couldn't be created", issues: [{ level: 'error', message: errorMessage(error) }] })
    }
  }

  /** Opens a library book (or the sample) in the editor as a new draft. */
  const copyToDraft = async (target: LibraryEntry) => {
    setSheet(null)
    setAppProgress({ heading: `Copying “${target.book.title}” into Create`, done: 0, total: 1, unit: 'pictures' })
    try {
      const draft = await draftFromLibraryBook(target, (done, total) => setAppProgress((value) => (value ? { ...value, done, total } : value)))
      setDraftsVersion((version) => version + 1)
      navigate({ screen: 'editor', draftId: draft.id })
    } catch (error) {
      setSheet({
        kind: 'report',
        title: "The book couldn't be opened for editing",
        issues: [{ level: 'error', message: isQuotaError(error) ? 'There isn’t enough free storage on this device.' : errorMessage(error) }],
      })
    } finally {
      setAppProgress(null)
    }
  }

  const removeDraft = async (draftId: string) => {
    try {
      await deleteDraft(draftId)
      setDraftsVersion((version) => version + 1)
      if (route.screen === 'editor' || route.screen === 'preview') {
        navigate(CREATE, { replace: true })
      }
      showToast('Draft deleted')
    } catch (error) {
      setSheet({ kind: 'report', title: "The draft couldn't be deleted", issues: [{ level: 'error', message: errorMessage(error) }] })
    }
  }

  // ---------- Render ----------

  const renderScreen = () => {
    if (route.screen === 'create') {
      return (
        <Create
          refreshKey={draftsVersion}
          onSwitchTab={switchTab}
          onNewDraft={() => void startNewDraft()}
          onCopySample={() => builtinEntries[0] && void copyToDraft(builtinEntries[0])}
          onOpenDraft={(draftId) => navigate({ screen: 'editor', draftId })}
          onDeleteDraft={(draftId) => void removeDraft(draftId)}
        />
      )
    }

    if (route.screen === 'editor') {
      return (
        <Editor
          key={route.draftId}
          draftId={route.draftId}
          onBack={() => navigate(CREATE)}
          onPreview={(draftId, pageId) => void openPreview(draftId, pageId)}
          onAddToLibrary={(draft) => void runImport(() => packageDraft(draft))}
          onDeleteDraft={(draftId) => void removeDraft(draftId)}
          showToast={showToast}
        />
      )
    }

    if (route.screen === 'preview') {
      if (!previewEntry || previewDraft?.id !== route.draftId) {
        return null
      }
      const pageId = previewEntry.book.pages[route.pageId] ? route.pageId : previewEntry.book.startPageId
      if (!previewEntry.book.pages[pageId]) {
        return null
      }
      return (
        <Reader
          entry={previewEntry}
          pageId={pageId}
          // Page turns replace the history entry, so Back returns to the editor.
          onNavigate={(next) => navigate({ screen: 'preview', draftId: route.draftId, pageId: next }, { replace: true })}
          onOpenChapters={() => exitPreview(route.draftId)}
          onOpenLibrary={() => exitPreview(route.draftId)}
          onExitPreview={() => exitPreview(route.draftId)}
        />
      )
    }

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
          hiddenSampleCount={hiddenBuiltinCount}
          onRestoreSamples={restoreBuiltins}
          onManageStorage={() => setSheet({ kind: 'storage', pending: null })}
          onSwitchTab={switchTab}
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
            onEdit={() => void copyToDraft(target)}
          />
        )
      }
      case 'space':
        return (
          <SpaceSheet
            title={sheet.pending.book.title}
            neededBytes={sheet.neededBytes}
            freeBytes={sheet.freeBytes}
            onFreeUp={() => setSheet({ kind: 'storage', pending: sheet.pending })}
            onTryAnyway={() => void savePending(sheet.pending)}
            onCancel={() => setSheet(null)}
          />
        )
      case 'storage':
        return (
          <StorageSheet
            entries={entries}
            pendingTitle={sheet.pending?.book.title ?? null}
            message={sheet.message}
            onRemove={(bookId) => void removeBook(bookId, { keepSheet: true })}
            onContinuePending={() => sheet.pending && void startSave(sheet.pending)}
            onClose={() => setSheet(null)}
          />
        )
      default:
        return null
    }
  }

  return (
    <div className={`app-shell ${(route.screen === 'reader' && entry) || route.screen === 'preview' ? 'is-reading' : ''}`}>
      {renderScreen()}
      {renderSheet()}
      {busy && <BusyOverlay message={busy} />}
      {saveStatus && <SaveProgressOverlay status={saveStatus} onCancel={cancelSave} />}
      {appProgress && <ProgressOverlay progress={appProgress} />}
      {/* Toasts would cover a sheet's buttons, so they wait until it closes. */}
      {toast && !sheet && <Toast key={toast.id} toast={toast} onDismiss={dismissToast} />}
    </div>
  )
}

export default App
