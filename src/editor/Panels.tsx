import { useState } from 'react'
import { DIRECTIONS, slugify, type Book, type ImageFit } from '../book/schema'
import { CHAPTER_COLORS, exportBookId, type Draft, type EditorIssue } from './draft'
import type { SelectGesture } from './MapView'
import { useDraftImage } from './useDraftImage'

const ARROWS = { up: '↑', down: '↓', left: '←', right: '→' } as const

// ---------- Pages list ----------

function PageRow({
  draftId,
  book,
  pageId,
  selected,
  showCheck,
  onSelect,
}: {
  draftId: string
  book: Book
  pageId: string
  selected: boolean
  showCheck: boolean
  onSelect: (gesture: SelectGesture) => void
}) {
  const page = book.pages[pageId]
  const url = useDraftImage(draftId, page.image)
  const links = DIRECTIONS.filter((direction) => page.directions[direction])
  return (
    <li>
      <button
        type="button"
        className={`page-row ${selected ? 'is-selected' : ''}`}
        aria-pressed={selected}
        onClick={(event) => onSelect({ toggle: event.ctrlKey || event.metaKey, range: event.shiftKey })}
      >
        {showCheck && <span className={`row-check ${selected ? 'is-checked' : ''}`} aria-hidden="true">{selected ? '✓' : ''}</span>}
        <span className="page-row-thumb">{url ? <img src={url} alt="" /> : <span>{page.image ? '…' : '?'}</span>}</span>
        <span className="page-row-text">
          <strong>
            {page.title}
            {book.startPageId === page.id && <span className="pill small">Start</span>}
            {!page.image && <span className="pill small warn">No picture</span>}
          </strong>
          <span className="page-row-links">
            {links.length === 0
              ? 'Ending'
              : links.map((direction) => `${ARROWS[direction]} ${book.pages[page.directions[direction]!].title}`).join('   ')}
          </span>
        </span>
      </button>
    </li>
  )
}

export function PagesList({
  draftId,
  book,
  selected,
  showChecks,
  onSelect,
}: {
  draftId: string
  book: Book
  selected: Set<string>
  /** Show tick boxes (select mode, or several pages chosen). */
  showChecks: boolean
  onSelect: (pageId: string, gesture: SelectGesture) => void
}) {
  return (
    <div className="pages-list">
      {book.chapters.map((chapter, index) => (
        <section key={chapter.id}>
          <h3 style={{ borderColor: CHAPTER_COLORS[index % CHAPTER_COLORS.length] }}>
            {chapter.title} <small>{chapter.pageIds.length} pages</small>
          </h3>
          {chapter.pageIds.length === 0 ? (
            <p className="muted">No pages in this chapter yet.</p>
          ) : (
            <ul>
              {chapter.pageIds.map((id) => (
                <PageRow
                  key={id}
                  draftId={draftId}
                  book={book}
                  pageId={id}
                  selected={selected.has(id)}
                  showCheck={showChecks}
                  onSelect={(gesture) => onSelect(id, gesture)}
                />
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  )
}

// ---------- Book settings and chapters ----------

type BookPanelProps = {
  draft: Draft
  onUpdate: (patch: Partial<Pick<Book, 'title' | 'author' | 'description' | 'fit' | 'cover' | 'id'>>) => void
  onSetCustomId: (custom: boolean) => void
  onSetStart: (pageId: string) => void
  onAddChapter: () => void
  onRenameChapter: (chapterId: string, title: string) => void
  onMoveChapter: (chapterId: string, delta: -1 | 1) => void
  onDeleteChapter: (chapterId: string) => void
  onDeleteDraft: () => void
}

export function BookPanel(props: BookPanelProps) {
  const { draft } = props
  const { book } = draft
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmChapter, setConfirmChapter] = useState<string | null>(null)
  const pageIds = book.chapters.flatMap((chapter) => chapter.pageIds)
  const imagePages = pageIds.filter((id) => book.pages[id].image)

  return (
    <div className="book-panel">
      <section className="panel-section">
        <h3>Details</h3>
        <label className="field">
          <span>Title</span>
          <input value={book.title} onChange={(event) => props.onUpdate({ title: event.target.value })} />
        </label>
        <label className="field">
          <span>Author</span>
          <input value={book.author} placeholder="Your name" onChange={(event) => props.onUpdate({ author: event.target.value })} />
        </label>
        <label className="field">
          <span>Description</span>
          <textarea rows={3} value={book.description} placeholder="A sentence or two shown before reading." onChange={(event) => props.onUpdate({ description: event.target.value })} />
        </label>
      </section>

      <section className="panel-section">
        <h3>Reading</h3>
        <label className="field">
          <span>Start page</span>
          <select value={book.startPageId} onChange={(event) => props.onSetStart(event.target.value)} disabled={pageIds.length === 0}>
            {pageIds.length === 0 && <option value="">Add a page first</option>}
            {pageIds.map((id) => (
              <option key={id} value={id}>
                {book.pages[id].title}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Cover</span>
          <select value={book.cover} onChange={(event) => props.onUpdate({ cover: event.target.value })}>
            <option value="">Start page picture</option>
            {imagePages.map((id) => (
              <option key={id} value={book.pages[id].image}>
                {book.pages[id].title}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="field">
          <span>Page pictures</span>
          <div className="choice-row">
            {(['contain', 'cover'] as ImageFit[]).map((fit) => (
              <label key={fit} className="choice">
                <input type="radio" name="fit" checked={book.fit === fit} onChange={() => props.onUpdate({ fit })} />
                {fit === 'contain' ? 'Show the whole picture' : 'Fill the screen (edges may be cut)'}
              </label>
            ))}
          </div>
        </fieldset>
      </section>

      <section className="panel-section">
        <h3>Chapters</h3>
        <p className="muted">Readers unlock chapters as they reach them. Order here is the order on the chapter screen.</p>
        <ol className="chapter-editor">
          {book.chapters.map((chapter, index) => (
            <li key={chapter.id}>
              <div className="chapter-edit-row">
                <span className="chapter-swatch" style={{ background: CHAPTER_COLORS[index % CHAPTER_COLORS.length] }} />
                <input aria-label={`Chapter ${index + 1} title`} value={chapter.title} onChange={(event) => props.onRenameChapter(chapter.id, event.target.value)} />
                <span className="muted small">{chapter.pageIds.length}p</span>
                <button type="button" className="icon-button" aria-label="Move chapter up" disabled={index === 0} onClick={() => props.onMoveChapter(chapter.id, -1)}>
                  ↑
                </button>
                <button type="button" className="icon-button" aria-label="Move chapter down" disabled={index === book.chapters.length - 1} onClick={() => props.onMoveChapter(chapter.id, 1)}>
                  ↓
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Delete chapter"
                  disabled={book.chapters.length === 1}
                  onClick={() => (chapter.pageIds.length === 0 ? props.onDeleteChapter(chapter.id) : setConfirmChapter(chapter.id))}
                >
                  ×
                </button>
              </div>
              {confirmChapter === chapter.id && (
                <div className="confirm-row">
                  <p>
                    Delete “{chapter.title}”? Its {chapter.pageIds.length} pages move to “{book.chapters[index === 0 ? 1 : index - 1].title}”.
                  </p>
                  <button type="button" className="danger-button" onClick={() => { setConfirmChapter(null); props.onDeleteChapter(chapter.id) }}>
                    Delete chapter
                  </button>
                  <button type="button" className="link-button" onClick={() => setConfirmChapter(null)}>
                    Keep it
                  </button>
                </div>
              )}
            </li>
          ))}
        </ol>
        <button type="button" className="secondary-button" onClick={props.onAddChapter}>
          + Add chapter
        </button>
      </section>

      <section className="panel-section">
        <h3>Advanced</h3>
        <label className="field">
          <span>Book ID</span>
          <input
            value={draft.customId ? book.id : exportBookId(draft)}
            onChange={(event) => {
              props.onSetCustomId(true)
              props.onUpdate({ id: event.target.value })
            }}
            onBlur={(event) => props.onUpdate({ id: slugify(event.target.value) })}
          />
        </label>
        <p className="muted small">
          Readers' apps use this to recognise new versions of the same book. {draft.customId ? '' : 'It follows the title until you change it.'}
          {draft.customId && (
            <button type="button" className="link-button small" onClick={() => props.onSetCustomId(false)}>
              Follow the title again
            </button>
          )}
        </p>
      </section>

      <section className="panel-section">
        {confirmDelete ? (
          <div className="confirm-row">
            <p>Delete this draft and its pictures from this device? Books you've added to your library or exported aren't affected.</p>
            <button type="button" className="danger-button wide" onClick={props.onDeleteDraft}>
              Yes, delete draft
            </button>
            <button type="button" className="link-button" onClick={() => setConfirmDelete(false)}>
              Keep it
            </button>
          </div>
        ) : (
          <button type="button" className="secondary-button wide" onClick={() => setConfirmDelete(true)}>
            Delete draft
          </button>
        )}
      </section>
    </div>
  )
}

// ---------- Checks ----------

export function ChecksPanel({
  issues,
  book,
  onGoToPage,
  onGoToBook,
}: {
  issues: EditorIssue[]
  book: Book
  onGoToPage: (pageId: string) => void
  onGoToBook: () => void
}) {
  const errors = issues.filter((issue) => issue.level === 'error')
  const order = { error: 0, warning: 1, info: 2 }
  const sorted = [...issues].sort((a, b) => order[a.level] - order[b.level])

  return (
    <div className="checks-panel">
      <p className={`check-summary ${errors.length ? 'has-errors' : 'is-ready'}`}>
        {errors.length
          ? `${errors.length} thing${errors.length === 1 ? '' : 's'} to fix before this book can be exported.`
          : `Ready to export. ${Object.keys(book.pages).length} pages in ${book.chapters.filter((chapter) => chapter.pageIds.length).length} chapter(s).`}
      </p>
      {sorted.length > 0 && (
        <ul className="issue-list">
          {sorted.map((issue, index) => (
            <li key={index} className={`issue-${issue.level === 'info' ? 'warning' : issue.level}`}>
              <span className="issue-tag">{issue.level === 'error' ? 'Fix' : issue.level === 'warning' ? 'Check' : 'Note'}</span>
              {issue.message}{' '}
              {issue.pageId ? (
                <button type="button" className="link-button small" onClick={() => onGoToPage(issue.pageId!)}>
                  Go to page
                </button>
              ) : issue.chapterId || !issue.pageId ? (
                issue.level !== 'info' && (
                  <button type="button" className="link-button small" onClick={onGoToBook}>
                    Open book settings
                  </button>
                )
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
