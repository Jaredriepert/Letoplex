import { useRef } from 'react'
import { DIRECTIONS, type Book, type Direction } from '../book/schema'
import { OPPOSITE, type Point } from './draft'
import { NewChapterInline, NudgePad } from './GroupPanel'
import { useDraftImage } from './useDraftImage'

const LABELS: Record<Direction, string> = { up: 'Up', down: 'Down', left: 'Left', right: 'Right' }
const ARROWS: Record<Direction, string> = { up: '↑', down: '↓', left: '←', right: '→' }
const NEW_PAGE = '__new__'

type Props = {
  draftId: string
  book: Book
  pageId: string
  onClose: () => void
  onRename: (title: string) => void
  onDescribe: (description: string) => void
  onReplaceImage: (file: File) => void
  onSetChapter: (chapterId: string) => void
  onNewChapter: (title: string) => void
  onMakeOpener: () => void
  onMakeStart: () => void
  onMakeCover: () => void
  onLink: (direction: Direction, targetId: string | null) => void
  onLinkNew: (direction: Direction) => void
  onLinkBack: (direction: Direction) => void
  onNudge: (to: Point) => void
  onPreview: () => void
  onDelete: () => void
}

export function PagePanel(props: Props) {
  const { draftId, book, pageId } = props
  const page = book.pages[pageId]
  const fileRef = useRef<HTMLInputElement | null>(null)
  const preview = useDraftImage(draftId, page?.image ?? '', false)
  if (!page) {
    return null
  }

  const chapter = book.chapters.find((item) => item.id === page.chapterId)
  const isOpener = chapter?.pageIds[0] === page.id
  const isStart = book.startPageId === page.id
  const isCover = Boolean(page.image) && (book.cover ? book.cover === page.image : isStart)
  const others = book.chapters.flatMap((item) => item.pageIds).filter((id) => id !== page.id)

  return (
    <aside className="page-panel" aria-label={`Edit page ${page.title}`}>
      <div className="panel-header">
        <h2>{page.title || 'Untitled page'}</h2>
        <button type="button" className="icon-button" aria-label="Close page editor" onClick={props.onClose}>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="panel-body">
        <div className="page-picture">
          {preview ? <img src={preview} alt="" /> : <span>{page.image ? 'Loading…' : 'No picture yet'}</span>}
        </div>
        <div className="button-row">
          <button type="button" className="secondary-button" onClick={() => fileRef.current?.click()}>
            {page.image ? 'Replace picture' : 'Add picture'}
          </button>
          <button type="button" className="secondary-button" onClick={props.onPreview}>
            Preview from here
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) props.onReplaceImage(file)
          }}
        />

        <label className="field">
          <span>Title</span>
          <input value={page.title} onChange={(event) => props.onRename(event.target.value)} />
        </label>

        <label className="field">
          <span>Description</span>
          <textarea
            rows={3}
            value={page.description}
            placeholder="What happens on this page. Read aloud by screen readers and shown if the picture can't load."
            onChange={(event) => props.onDescribe(event.target.value)}
          />
        </label>

        <fieldset className="field-group">
          <legend>Where the reader can go</legend>
          {DIRECTIONS.map((direction) => {
            const targetId = page.directions[direction]
            const target = targetId ? book.pages[targetId] : null
            const linksBack = target?.directions[OPPOSITE[direction]] === page.id
            return (
              <div key={direction} className="direction-row">
                <label>
                  <span className="direction-label">
                    {ARROWS[direction]} {LABELS[direction]}
                  </span>
                  <select
                    value={targetId ?? ''}
                    onChange={(event) => {
                      const value = event.target.value
                      if (value === NEW_PAGE) props.onLinkNew(direction)
                      else props.onLink(direction, value || null)
                    }}
                  >
                    <option value="">Nothing (blocked)</option>
                    <option value={NEW_PAGE}>+ New page {LABELS[direction].toLowerCase()}</option>
                    {others.map((id) => (
                      <option key={id} value={id}>
                        {book.pages[id].title}
                      </option>
                    ))}
                  </select>
                </label>
                {target &&
                  (linksBack ? (
                    <span className="direction-note">{ARROWS[OPPOSITE[direction]]} links back</span>
                  ) : target.directions[OPPOSITE[direction]] ? (
                    <span className="direction-note">one way</span>
                  ) : (
                    <button type="button" className="link-button small" onClick={() => props.onLinkBack(direction)}>
                      Add way back
                    </button>
                  ))}
              </div>
            )
          })}
        </fieldset>

        <fieldset className="field-group">
          <legend>Story</legend>
          <label className="field">
            <span>Chapter</span>
            <select value={page.chapterId} onChange={(event) => props.onSetChapter(event.target.value)}>
              {book.chapters.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          <NewChapterInline onCreate={props.onNewChapter} />

          <div className="story-role">
            {isStart ? (
              <span className="pill">Book starts here</span>
            ) : (
              <button type="button" className="secondary-button" onClick={props.onMakeStart}>
                Make this the book's first page
              </button>
            )}
            <span className="muted small">Where "Start reading" begins the whole book.</span>
          </div>
          <div className="story-role">
            {isOpener ? (
              <span className="pill">First page of “{chapter?.title}”</span>
            ) : (
              <button type="button" className="secondary-button" onClick={props.onMakeOpener}>
                Make first page of this chapter
              </button>
            )}
            <span className="muted small">Where choosing this chapter on the chapter screen begins.</span>
          </div>
          {page.image && (
            <div className="story-role">
              {isCover ? (
                <span className="pill">Book cover</span>
              ) : (
                <button type="button" className="secondary-button" onClick={props.onMakeCover}>
                  Use as book cover
                </button>
              )}
            </div>
          )}
        </fieldset>

        <fieldset className="field-group">
          <legend>Move on the map</legend>
          <NudgePad onMove={(delta) => props.onNudge({ x: page.position.x + delta.x, y: page.position.y + delta.y })} />
        </fieldset>

        <button type="button" className="danger-button wide" onClick={props.onDelete}>
          Delete page
        </button>
      </div>
    </aside>
  )
}
