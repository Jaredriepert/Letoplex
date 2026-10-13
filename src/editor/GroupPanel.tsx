import { useState } from 'react'
import { DIRECTIONS, type Book, type Direction } from '../book/schema'
import { STEP, type Point } from './draft'

const ARROWS: Record<Direction, string> = { up: '↑', down: '↓', left: '←', right: '→' }

/** "+ New chapter" that expands into a name field. */
export function NewChapterInline({ onCreate }: { onCreate: (title: string) => void }) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  if (!open) {
    return (
      <button type="button" className="link-button small" onClick={() => setOpen(true)}>
        + New chapter
      </button>
    )
  }
  const submit = () => {
    onCreate(title.trim())
    setTitle('')
    setOpen(false)
  }
  return (
    <div className="new-chapter-inline">
      <input
        autoFocus
        aria-label="New chapter name"
        placeholder="Chapter name"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit()
          if (event.key === 'Escape') setOpen(false)
        }}
      />
      <button type="button" className="secondary-button compact" onClick={submit}>
        Add
      </button>
      <button type="button" className="link-button small" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </div>
  )
}

/** Directional move pad, shared by the page and group panels. */
export function NudgePad({ onMove }: { onMove: (delta: Point) => void }) {
  return (
    <div className="nudge-pad">
      {DIRECTIONS.map((direction) => (
        <button key={direction} type="button" className={`icon-button nudge-${direction}`} aria-label={`Move ${direction}`} onClick={() => onMove(STEP[direction])}>
          {ARROWS[direction]}
        </button>
      ))}
    </div>
  )
}

type Props = {
  book: Book
  pageIds: string[]
  onClose: () => void
  onSetChapter: (chapterId: string) => void
  onNewChapter: (title: string) => void
  onMove: (delta: Point) => void
  onDelete: () => void
}

/** Shown when several pages are selected: change them all at once. */
export function GroupPanel({ book, pageIds, onClose, onSetChapter, onNewChapter, onMove, onDelete }: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const chapters = new Set(pageIds.map((id) => book.pages[id].chapterId))
  const common = chapters.size === 1 ? [...chapters][0] : ''

  return (
    <aside className="page-panel" aria-label={`${pageIds.length} pages selected`}>
      <div className="panel-header">
        <h2>{pageIds.length} pages selected</h2>
        <button type="button" className="icon-button" aria-label="Clear selection" onClick={onClose}>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="panel-body">
        <p className="muted small group-titles">{pageIds.map((id) => book.pages[id].title).join(', ')}</p>

        <fieldset className="field-group">
          <legend>Chapter</legend>
          <label className="field">
            <span className="sr-only">Chapter for all selected pages</span>
            <select value={common} onChange={(event) => event.target.value && onSetChapter(event.target.value)}>
              {!common && <option value="">Mixed chapters…</option>}
              {book.chapters.map((chapter) => (
                <option key={chapter.id} value={chapter.id}>
                  {chapter.title}
                </option>
              ))}
            </select>
          </label>
          <NewChapterInline onCreate={onNewChapter} />
        </fieldset>

        <fieldset className="field-group">
          <legend>Move together</legend>
          <p className="muted small">Or drag any selected page on the map. Pages can't be moved on top of other pages.</p>
          <NudgePad onMove={onMove} />
        </fieldset>

        {confirmDelete ? (
          <div className="confirm-row">
            <p>Delete these {pageIds.length} pages? You can undo this.</p>
            <button type="button" className="danger-button wide" onClick={onDelete}>
              Delete {pageIds.length} pages
            </button>
            <button type="button" className="link-button" onClick={() => setConfirmDelete(false)}>
              Keep them
            </button>
          </div>
        ) : (
          <button type="button" className="danger-button wide" onClick={() => setConfirmDelete(true)}>
            Delete {pageIds.length} pages
          </button>
        )}
      </div>
    </aside>
  )
}
