import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Book, Direction } from '../book/schema'
import { IssueList, ProgressOverlay, Sheet, type ProgressInfo, type ToastMessage } from '../components/Sheets'
import {
  addChapter,
  addImagePages,
  addPage,
  checkDraft,
  cycleConnector,
  deleteChapter,
  deletePages,
  linkBack,
  makeChapterOpener,
  moveChapter,
  movePage,
  movePages,
  nearestFreeCell,
  OPPOSITE,
  renameChapter,
  setLink,
  setPageChapter,
  setPagesChapter,
  setStartPage,
  STEP,
  updateBook,
  updatePage,
  type Draft,
  type Point,
} from './draft'
import { analyzeImage, isSupportedImage, type ImageInfo } from './images'
import { GroupPanel } from './GroupPanel'
import { MapView, type SelectGesture } from './MapView'
import { PagePanel } from './PagePanel'
import { BookPanel, ChecksPanel, PagesList } from './Panels'
import { addImagesToDraft, exportDraft } from './service'
import { useEditor } from './useEditor'
import { useMediaQuery } from './useMediaQuery'
import './editor.css'

type Tab = 'map' | 'pages' | 'book' | 'check'

type Props = {
  draftId: string
  onBack: () => void
  onPreview: (draftId: string, pageId: string) => void
  onAddToLibrary: (draft: Draft) => void
  onDeleteDraft: (draftId: string) => void
  showToast: (text: string, action?: ToastMessage['action']) => void
}

type OptimisePrompt = { oversized: number; total: number; resolve: (choice: boolean | null) => void }

const canShareFiles = () => {
  try {
    return Boolean(navigator.canShare?.({ files: [new File([''], 'book.gab', { type: 'application/zip' })] }))
  } catch {
    return false
  }
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

export function Editor({ draftId, onBack, onPreview, onAddToLibrary, onDeleteDraft, showToast }: Props) {
  const editor = useEditor(draftId)
  const { draft, edit, getCurrent } = editor
  const [tab, setTab] = useState<Tab>('map')
  const [selection, setSelection] = useState<string[]>([])
  /** Touch-friendly multi-select: taps add/remove pages instead of opening one. */
  const [selectMode, setSelectMode] = useState(false)
  const [selectionPanelOpen, setSelectionPanelOpen] = useState(false)
  const panelCoversMap = useMediaQuery('(max-width: 959px)')
  const anchorRef = useRef<string | null>(null)
  const [progress, setProgress] = useState<ProgressInfo | null>(null)
  const [optimisePrompt, setOptimisePrompt] = useState<OptimisePrompt | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [report, setReport] = useState<{ title: string; messages: string[] } | null>(null)
  const pickerRef = useRef<HTMLInputElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const issues = useMemo(() => (draft ? checkDraft(draft.book, editor.storedImages) : []), [draft, editor.storedImages])
  const errorCount = issues.filter((issue) => issue.level === 'error').length
  // Pages can disappear (delete, undo), so only keep ids that still exist.
  const selectedIds = draft ? selection.filter((id) => draft.book.pages[id]) : []
  const selectedSet = new Set(selectedIds)
  /** The one page being edited, when exactly one is selected. */
  const selected = selectedIds.length === 1 ? selectedIds[0] : null

  const setSelectedId = useCallback((pageId: string | null) => {
    setSelection(pageId ? [pageId] : [])
    anchorRef.current = pageId
  }, [])

  const clearSelection = () => {
    setSelection([])
    setSelectMode(false)
    setSelectionPanelOpen(false)
  }

  /**
   * Plain click selects one page. Ctrl/Cmd-click (or select mode) adds or
   * removes a page. Shift-click selects a range in the Pages list, or adds
   * to the selection on the map.
   */
  const selectPage = (pageId: string, gesture: SelectGesture, listOrder?: string[]) => {
    const anchor = anchorRef.current
    setSelection((current) => {
      const valid = current.filter((id) => draft?.book.pages[id])
      if (gesture.range && listOrder && anchor && listOrder.includes(anchor)) {
        const [from, to] = [listOrder.indexOf(anchor), listOrder.indexOf(pageId)].sort((a, b) => a - b)
        return [...new Set([...valid, ...listOrder.slice(from, to + 1)])]
      }
      if (gesture.toggle || gesture.range || selectMode) {
        return valid.includes(pageId) ? valid.filter((id) => id !== pageId) : [...valid, pageId]
      }
      return [pageId]
    })
    if (!gesture.range) anchorRef.current = pageId
  }

  /**
   * Applies an edit computed from the newest book, and selects a page it
   * created. If something changed in between, the edit is recomputed.
   */
  const commit = useCallback(
    (compute: (book: Book) => { book: Book; select?: string | null }) => {
      const current = getCurrent()
      if (!current) return
      const result = compute(current.book)
      edit((book) => (book === current.book ? result.book : compute(book).book))
      if (result.select !== undefined) setSelectedId(result.select)
    },
    [edit, getCurrent, setSelectedId],
  )

  // ---------- Several pages at once ----------

  /** Moves a group by an offset; tells the author if another page is in the way. */
  const moveGroup = (pageIds: string[], delta: Point) => {
    const current = getCurrent()
    if (!current || (delta.x === 0 && delta.y === 0)) return
    const next = movePages(current.book, pageIds, delta)
    if (next === current.book) {
      showToast("Can't move there: another page is in the way")
      return
    }
    edit((book) => (book === current.book ? next : movePages(book, pageIds, delta)))
  }

  const dropPage = (pageId: string, to: Point) => {
    const page = getCurrent()?.book.pages[pageId]
    if (!page) return
    if (selectedSet.has(pageId) && selectedIds.length > 1) {
      moveGroup(selectedIds, { x: to.x - page.position.x, y: to.y - page.position.y })
    } else {
      edit((book) => movePage(book, pageId, to))
    }
  }

  const deleteSelected = (pageIds: string[]) => {
    const label = pageIds.length === 1 ? `"${draft?.book.pages[pageIds[0]]?.title ?? 'Page'}"` : `${pageIds.length} pages`
    edit((book) => deletePages(book, pageIds))
    clearSelection()
    showToast(`Deleted ${label}`, { label: 'Undo', run: editor.undo })
  }

  const moveToNewChapter = (pageIds: string[], title: string) =>
    edit((book) => {
      const added = addChapter(book, title)
      return setPagesChapter(added.book, pageIds, added.chapterId)
    })

  // ---------- Pictures ----------

  const askOptimise = (oversized: number, total: number) =>
    new Promise<boolean | null>((resolve) => setOptimisePrompt({ oversized, total, resolve }))

  const addPictures = async (files: File[], replacePageId?: string) => {
    if (!draft || files.length === 0) return
    const supported = files.filter(isSupportedImage)
    const skipped = files.filter((file) => !isSupportedImage(file)).map((file) => file.name)
    const infos: ImageInfo[] = []
    const unreadable: string[] = []
    let failure: string | null = null
    try {
      for (const [index, file] of supported.entries()) {
        setProgress({ heading: 'Reading pictures', done: index, total: supported.length, unit: 'pictures' })
        try {
          infos.push(await analyzeImage(file))
        } catch {
          unreadable.push(file.name)
        }
      }
      setProgress(null)

      let optimise = false
      const oversized = infos.filter((info) => info.oversized).length
      if (oversized > 0) {
        const choice = await askOptimise(oversized, infos.length)
        if (choice === null) return
        optimise = choice
      }

      if (infos.length > 0) {
        setProgress({ heading: optimise ? 'Optimising and saving pictures' : 'Saving pictures', done: 0, total: infos.length, unit: 'pictures' })
        const stored = await addImagesToDraft(draft.id, infos, {
          optimise,
          onProgress: (done, total) => setProgress((value) => (value ? { ...value, done, total } : value)),
        })
        editor.addStoredImages(stored.map((item) => item.path))
        if (replacePageId) {
          commit((book) => ({ book: updatePage(book, replacePageId, { image: stored[0].path }) }))
        } else {
          commit((book) => {
            const result = addImagePages(book, stored, { afterPageId: selected })
            return { book: result.book, select: result.pageIds[0] ?? null }
          })
          if (stored.length > 1) showToast(`Added ${stored.length} pages, linked left to right`)
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    } finally {
      setProgress(null)
    }

    const problems = [
      ...skipped.map((name) => `"${name}" isn't a picture type books can use (PNG, JPEG, WebP, GIF, AVIF or SVG).`),
      ...unreadable.map((name) => `"${name}" couldn't be opened. Try saving it as PNG or JPEG.`),
      ...(failure ? [`Saving pictures failed: ${failure}`] : []),
    ]
    if (problems.length > 0) setReport({ title: 'Some pictures were skipped', messages: problems })
  }

  // ---------- Page actions ----------

  const addBlankPage = (at?: Point) => {
    commit((book) => {
      const anchor = selected ? book.pages[selected] : null
      const point = at ?? (anchor ? { x: anchor.position.x + 1, y: anchor.position.y } : { x: 0, y: 0 })
      const added = addPage(book, point, anchor?.chapterId)
      let next = added.book
      // A new page right next to the selected one is linked to it both ways.
      if (anchor) {
        const position = next.pages[added.pageId].position
        const direction = (Object.keys(STEP) as Direction[]).find(
          (d) => anchor.position.x + STEP[d].x === position.x && anchor.position.y + STEP[d].y === position.y,
        )
        if (direction && !anchor.directions[direction]) {
          next = setLink(next, anchor.id, direction, added.pageId)
          next = setLink(next, added.pageId, OPPOSITE[direction], anchor.id)
        }
      }
      return { book: next, select: added.pageId }
    })
  }

  const linkNewPage = (pageId: string, direction: Direction) => {
    commit((book) => {
      const page = book.pages[pageId]
      const cell = nearestFreeCell(book, { x: page.position.x + STEP[direction].x, y: page.position.y + STEP[direction].y })
      const added = addPage(book, cell, page.chapterId)
      let next = setLink(added.book, pageId, direction, added.pageId)
      next = setLink(next, added.pageId, OPPOSITE[direction], pageId)
      return { book: next, select: added.pageId }
    })
  }

  const preview = (pageId?: string) => {
    const current = getCurrent()
    const start = pageId ?? (current?.book.pages[current.book.startPageId] ? current.book.startPageId : null)
    if (!current || !start) {
      showToast('Add a page first to preview the book')
      return
    }
    void editor.flush().then(() => onPreview(current.id, start))
  }

  // ---------- Export ----------

  const runExport = async (mode: 'download' | 'share') => {
    if (!draft) return
    setExportOpen(false)
    await editor.flush()
    const controller = new AbortController()
    abortRef.current = controller
    setProgress({
      heading: 'Preparing your book',
      done: 0,
      total: 1,
      unit: 'files',
      onCancel: () => {
        controller.abort()
        setProgress((value) => (value ? { ...value, cancelling: true } : value))
      },
    })
    try {
      const result = await exportDraft(getCurrent() ?? draft, {
        signal: controller.signal,
        onProgress: (done, total) => setProgress((value) => (value ? { ...value, done, total } : value)),
      })
      if (!result.ok) {
        setReport({ title: "The book couldn't be exported", messages: result.issues.map((issue) => issue.message) })
        return
      }
      const file = new File([result.blob], result.fileName, { type: 'application/zip' })
      if (mode === 'share') {
        try {
          await navigator.share({ files: [file], title: draft.book.title })
        } catch (error) {
          if (!(error instanceof DOMException && error.name === 'AbortError')) throw error
        }
        return
      }
      const url = URL.createObjectURL(file)
      const link = document.createElement('a')
      link.href = url
      link.download = result.fileName
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      showToast(`Saved ${result.fileName}`)
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setReport({ title: "The book couldn't be exported", messages: [error instanceof Error ? error.message : String(error)] })
      }
    } finally {
      abortRef.current = null
      setProgress(null)
    }
  }

  // ---------- Keyboard shortcuts (computers) ----------

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (isTyping(event.target) || progress || optimisePrompt || exportOpen) return
      const mod = event.ctrlKey || event.metaKey
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) editor.redo()
        else editor.undo()
      } else if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        editor.redo()
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedIds.length > 0) {
        event.preventDefault()
        deleteSelected(selectedIds)
      } else if (mod && event.key.toLowerCase() === 'a' && (tab === 'map' || tab === 'pages') && draft) {
        event.preventDefault()
        setSelection(Object.keys(draft.book.pages))
      } else if (event.key === 'Escape') {
        clearSelection()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  })

  // ---------- Render ----------

  if (editor.loadError) {
    return (
      <div className="editor-message">
        <p>{editor.loadError}</p>
        <button type="button" className="primary-button" onClick={onBack}>
          Back to Create
        </button>
      </div>
    )
  }
  if (!draft) {
    return <div className="editor-message">Opening draft…</div>
  }

  const { book } = draft
  const isEmpty = Object.keys(book.pages).length === 0
  const saveLabel = editor.saveState === 'error' ? "Couldn't save" : editor.saveState === 'saving' ? 'Saving…' : 'Saved'

  const pageOrder = book.chapters.flatMap((chapter) => chapter.pageIds)
  const onPagesView = tab === 'map' || tab === 'pages'
  // On phones the panel covers the map, so while picking pages it stays shut
  // until the author taps Edit on the selection bar.
  const holdPanel = selectMode && panelCoversMap && !selectionPanelOpen
  const showPanel = selectedIds.length > 0 && onPagesView && !holdPanel
  const closePanel = () => (selectMode && panelCoversMap ? setSelectionPanelOpen(false) : clearSelection())

  const addButtons = (
    <div className="editor-add-row">
      <button type="button" className="primary-button" onClick={() => pickerRef.current?.click()}>
        Add pictures
      </button>
      <button type="button" className="secondary-button" onClick={() => addBlankPage()}>
        Add blank page
      </button>
      {!isEmpty && (
        <button
          type="button"
          className={`${selectMode ? 'primary' : 'secondary'}-button`}
          aria-pressed={selectMode}
          onClick={() => (selectMode ? clearSelection() : setSelectMode(true))}
        >
          {selectMode ? 'Done selecting' : 'Select'}
        </button>
      )}
      {selectMode && (
        <button type="button" className="link-button small" onClick={() => setSelection(pageOrder)}>
          Select all
        </button>
      )}
      {selected && !selectMode && <span className="muted small">New pages go after “{book.pages[selected].title}”.</span>}
      {selectMode && <span className="muted small">Tap pages to select them.</span>}
    </div>
  )

  const tabs = (
    <nav className="editor-tabs" aria-label="Editor views">
      {(
        [
          ['map', 'Map'],
          ['pages', 'Pages'],
          ['book', 'Book'],
          ['check', errorCount ? `Check (${errorCount})` : 'Check'],
        ] as Array<[Tab, string]>
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          className={`editor-tab ${tab === id ? 'is-active' : ''} ${id === 'check' && errorCount ? 'has-errors' : ''}`}
          onClick={() => setTab(id)}
          aria-current={tab === id}
        >
          {label}
        </button>
      ))}
    </nav>
  )

  return (
    <div className={`editor-screen ${showPanel ? 'has-panel' : ''} ${holdPanel && onPagesView ? 'has-selection-bar' : ''}`}>
      <header className="editor-header">
        <button type="button" className="secondary-button compact" onClick={onBack} aria-label="Back to Create">
          ←<span className="hide-narrow"> Create</span>
        </button>
        <div className="editor-title">
          <strong>{book.title || 'Untitled book'}</strong>
          <span className={`save-state state-${editor.saveState}`}>{saveLabel}</span>
        </div>
        {tabs}
        <div className="editor-actions">
          <button type="button" className="icon-button" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!editor.canUndo} onClick={editor.undo}>
            ↶
          </button>
          <button type="button" className="icon-button" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!editor.canRedo} onClick={editor.redo}>
            ↷
          </button>
          <button type="button" className="secondary-button compact" aria-label="Preview" onClick={() => preview(selected ?? undefined)}>
            <span className="show-narrow" aria-hidden="true">
              ▶
            </span>
            <span className="hide-narrow">Preview</span>
          </button>
          <button type="button" className="primary-button compact" onClick={() => setExportOpen(true)}>
            Export
          </button>
        </div>
      </header>

      <input
        ref={pickerRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          void addPictures(files)
        }}
      />

      <main className={`editor-main ${tab === 'map' ? 'is-map' : ''}`}>
        {tab === 'map' && (
          <>
            {addButtons}
            {isEmpty && (
              <div className="editor-empty">
                <strong>Start your book</strong>
                <p>Add your page pictures. They're laid out in a row and linked in order, then you can add branches.</p>
              </div>
            )}
            <MapView
              draftId={draft.id}
              book={book}
              selected={selectedSet}
              onSelect={(pageId, gesture) => selectPage(pageId, gesture)}
              onClearSelection={() => setSelection([])}
              onAddAt={(point) => addBlankPage(point)}
              onCycleConnector={(from, to, direction) => edit((current) => cycleConnector(current, from, to, direction))}
              onDrop={dropPage}
            />
          </>
        )}
        {tab === 'pages' && (
          <>
            {addButtons}
            {isEmpty ? (
              <div className="editor-empty">
                <strong>No pages yet</strong>
                <p>Add pictures to create pages.</p>
              </div>
            ) : (
              <PagesList
                draftId={draft.id}
                book={book}
                selected={selectedSet}
                showChecks={selectMode || selectedIds.length > 1}
                onSelect={(pageId, gesture) => selectPage(pageId, gesture, pageOrder)}
              />
            )}
          </>
        )}
        {tab === 'book' && (
          <BookPanel
            draft={draft}
            onUpdate={(patch) => edit((current) => updateBook(current, patch), `book:${Object.keys(patch).join()}`)}
            onSetCustomId={(custom) => editor.setMeta({ customId: custom })}
            onSetStart={(pageId) => edit((current) => setStartPage(current, pageId))}
            onAddChapter={() => edit((current) => addChapter(current).book)}
            onRenameChapter={(chapterId, title) => edit((current) => renameChapter(current, chapterId, title), `chapter:${chapterId}`)}
            onMoveChapter={(chapterId, delta) => edit((current) => moveChapter(current, chapterId, delta))}
            onDeleteChapter={(chapterId) => edit((current) => deleteChapter(current, chapterId))}
            onDeleteDraft={() => onDeleteDraft(draft.id)}
          />
        )}
        {tab === 'check' && (
          <ChecksPanel
            issues={issues}
            book={book}
            onGoToPage={(pageId) => {
              setSelectedId(pageId)
              setTab('map')
            }}
            onGoToBook={() => setTab('book')}
          />
        )}
      </main>

      {holdPanel && onPagesView && (
        <div className="selection-bar" role="status">
          <span>
            {selectedIds.length === 0 ? 'Tap pages to select them' : `${selectedIds.length} selected`}
          </span>
          <button type="button" className="primary-button compact" disabled={selectedIds.length === 0} onClick={() => setSelectionPanelOpen(true)}>
            Edit
          </button>
          <button type="button" className="secondary-button compact" onClick={clearSelection}>
            Done
          </button>
        </div>
      )}

      {showPanel && selectedIds.length > 1 && (
        <GroupPanel
          book={book}
          pageIds={selectedIds}
          onClose={closePanel}
          onSetChapter={(chapterId) => edit((current) => setPagesChapter(current, selectedIds, chapterId))}
          onNewChapter={(title) => moveToNewChapter(selectedIds, title)}
          onMove={(delta) => moveGroup(selectedIds, delta)}
          onDelete={() => deleteSelected(selectedIds)}
        />
      )}

      {showPanel && selected && (
        <PagePanel
          draftId={draft.id}
          book={book}
          pageId={selected}
          onClose={closePanel}
          onRename={(title) => edit((current) => updatePage(current, selected, { title }), `title:${selected}`)}
          onDescribe={(description) => edit((current) => updatePage(current, selected, { description }), `description:${selected}`)}
          onReplaceImage={(file) => void addPictures([file], selected)}
          onSetChapter={(chapterId) => edit((current) => setPageChapter(current, selected, chapterId))}
          onNewChapter={(title) => moveToNewChapter([selected], title)}
          onMakeOpener={() => edit((current) => makeChapterOpener(current, selected))}
          onMakeStart={() => edit((current) => setStartPage(current, selected))}
          onMakeCover={() => edit((current) => updateBook(current, { cover: current.pages[selected].image }))}
          onLink={(direction, target) => edit((current) => setLink(current, selected, direction, target))}
          onLinkNew={(direction) => linkNewPage(selected, direction)}
          onLinkBack={(direction) => edit((current) => linkBack(current, selected, direction))}
          onNudge={(to) => edit((current) => movePage(current, selected, to))}
          onPreview={() => preview(selected)}
          onDelete={() => deleteSelected([selected])}
        />
      )}

      {optimisePrompt && (
        <Sheet title="Optimise for phones?" onClose={() => { optimisePrompt.resolve(null); setOptimisePrompt(null) }}>
          <div className="sheet-body">
            <p>
              {optimisePrompt.oversized === optimisePrompt.total
                ? optimisePrompt.total === 1
                  ? 'This picture is'
                  : `All ${optimisePrompt.total} pictures are`
                : `${optimisePrompt.oversized} of ${optimisePrompt.total} pictures are`}{' '}
              bigger than phone screens need. Optimising shrinks them to phone size, which keeps the book small enough for readers' phones. They'll
              still look sharp.
            </p>
            <button type="button" className="primary-button wide" onClick={() => { optimisePrompt.resolve(true); setOptimisePrompt(null) }}>
              Optimise for phones
              <small>Recommended</small>
            </button>
            <button type="button" className="secondary-button wide" onClick={() => { optimisePrompt.resolve(false); setOptimisePrompt(null) }}>
              Keep originals
              <small>Full quality, larger book</small>
            </button>
          </div>
        </Sheet>
      )}

      {exportOpen && (
        <Sheet title="Export" onClose={() => setExportOpen(false)}>
          <div className="sheet-body">
            {errorCount > 0 ? (
              <>
                <p>
                  Fix {errorCount === 1 ? 'one thing' : `${errorCount} things`} before this book can be exported.
                </p>
                <IssueList issues={issues.filter((issue) => issue.level === 'error').map((issue) => ({ level: 'error', message: issue.message }))} />
                <button type="button" className="primary-button wide" onClick={() => { setExportOpen(false); setTab('check') }}>
                  See what to fix
                </button>
              </>
            ) : (
              <>
                <button type="button" className="primary-button wide" onClick={() => void runExport('download')}>
                  Download .gab file
                  <small>Share it, back it up, or import it on another device</small>
                </button>
                {canShareFiles() && (
                  <button type="button" className="secondary-button wide" onClick={() => void runExport('share')}>
                    Share…
                    <small>Send with Messages, email, AirDrop, or Save to Files</small>
                  </button>
                )}
                <button
                  type="button"
                  className="secondary-button wide"
                  onClick={() => {
                    setExportOpen(false)
                    void editor.flush().then(() => {
                      const current = getCurrent()
                      if (current) onAddToLibrary(current)
                    })
                  }}
                >
                  Add to my library
                  <small>{draft.sourceBookId ? 'Update the copy in your library' : 'Read it on this device'}</small>
                </button>
              </>
            )}
          </div>
        </Sheet>
      )}

      {report && (
        <Sheet title={report.title} onClose={() => setReport(null)}>
          <div className="sheet-body">
            <IssueList issues={report.messages.map((message) => ({ level: 'error' as const, message }))} />
            <button type="button" className="primary-button wide" onClick={() => setReport(null)}>
              OK
            </button>
          </div>
        </Sheet>
      )}

      {progress && <ProgressOverlay progress={progress} />}
    </div>
  )
}
