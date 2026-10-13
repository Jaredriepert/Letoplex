import { useState, type DragEvent, type ReactNode } from 'react'
import { DIRECTIONS, type Book, type Direction, type Page } from '../book/schema'
import { CHAPTER_COLORS, STEP, connectorState, gridBounds, occupiedCells, type ConnectorState, type Point } from './draft'
import { useDraftImage } from './useDraftImage'

/** How a page was picked: plain click, or with a key held to add to the selection. */
export type SelectGesture = { toggle: boolean; range: boolean }

type Props = {
  draftId: string
  book: Book
  selected: Set<string>
  onSelect: (pageId: string, gesture: SelectGesture) => void
  onClearSelection: () => void
  onAddAt: (point: Point) => void
  onCycleConnector: (fromId: string, toId: string, direction: Direction) => void
  /** A page was dropped on a cell; the editor moves it (or its whole selection). */
  onDrop: (pageId: string, to: Point) => void
}

const CONNECTOR_GLYPH: Record<'right' | 'down', Record<ConnectorState, string>> = {
  right: { none: '', both: '⇄', forward: '→', back: '←' },
  down: { none: '', both: '⇅', forward: '↓', back: '↑' },
}

const CONNECTOR_LABEL: Record<ConnectorState, string> = {
  none: 'not linked',
  both: 'linked both ways',
  forward: 'linked one way',
  back: 'linked one way (back)',
}

function Tile({
  draftId,
  page,
  book,
  selected,
  chapterColor,
  onSelect,
}: {
  draftId: string
  page: Page
  book: Book
  selected: boolean
  chapterColor: string
  onSelect: (gesture: SelectGesture) => void
}) {
  const url = useDraftImage(draftId, page.image)
  // Links to pages that aren't next door are shown as small markers on the edge.
  const farLinks = DIRECTIONS.filter((direction) => {
    const target = page.directions[direction] ? book.pages[page.directions[direction]!] : null
    if (!target) return false
    return target.position.x !== page.position.x + STEP[direction].x || target.position.y !== page.position.y + STEP[direction].y
  })
  const isEnding = DIRECTIONS.every((direction) => !page.directions[direction])

  return (
    <button
      type="button"
      className={`map-tile ${selected ? 'is-selected' : ''}`}
      style={{ '--chapter': chapterColor } as Record<string, string>}
      draggable
      onDragStart={(event: DragEvent) => {
        event.dataTransfer.setData('text/x-page-id', page.id)
        event.dataTransfer.effectAllowed = 'move'
      }}
      onClick={(event) => onSelect({ toggle: event.ctrlKey || event.metaKey, range: event.shiftKey })}
      aria-pressed={selected}
      aria-label={`${page.title}${book.startPageId === page.id ? ', start page' : ''}${page.image ? '' : ', no picture'}`}
    >
      <span className="map-tile-image">{url ? <img src={url} alt="" draggable={false} /> : <span className="map-tile-empty">{page.image ? '…' : 'No picture'}</span>}</span>
      <span className="map-tile-title">{page.title}</span>
      {book.startPageId === page.id && <span className="map-badge badge-start">Start</span>}
      {isEnding && <span className="map-badge badge-end">End</span>}
      {farLinks.map((direction) => (
        <span
          key={direction}
          className={`map-far-link far-${direction}`}
          title={`${direction} → ${book.pages[page.directions[direction]!].title}`}
          aria-hidden="true"
        >
          ↗
        </span>
      ))}
    </button>
  )
}

export function MapView({ draftId, book, selected, onSelect, onClearSelection, onAddAt, onCycleConnector, onDrop }: Props) {
  // Start smaller on phones so more of the story fits on screen.
  const [zoom, setZoom] = useState(() => (window.innerWidth < 600 ? 0.8 : 1))
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const cells = occupiedCells(book)
  const bounds = gridBounds(book)
  const empty = Object.keys(book.pages).length === 0
  // One ring of empty cells around the pages, for adding and moving.
  const minX = empty ? 0 : bounds.minX - 1
  const maxX = empty ? 2 : bounds.maxX + 1
  const minY = empty ? 0 : bounds.minY - 1
  const maxY = empty ? 1 : bounds.maxY + 1
  const columns = maxX - minX + 1
  const rows = maxY - minY + 1
  const chapterColor = (chapterId: string) =>
    CHAPTER_COLORS[Math.max(0, book.chapters.findIndex((chapter) => chapter.id === chapterId)) % CHAPTER_COLORS.length]

  const items: ReactNode[] = []
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const key = `${x},${y}`
      const pageId = cells.get(key)
      const gridColumn = (x - minX) * 2 + 1
      const gridRow = (y - minY) * 2 + 1
      const dropProps = {
        onDragOver: (event: DragEvent) => {
          if (event.dataTransfer.types.includes('text/x-page-id')) {
            event.preventDefault()
            setDropTarget(key)
          }
        },
        onDragLeave: () => setDropTarget((current) => (current === key ? null : current)),
        onDrop: (event: DragEvent) => {
          event.preventDefault()
          setDropTarget(null)
          const dragged = event.dataTransfer.getData('text/x-page-id')
          if (dragged) onDrop(dragged, { x, y })
        },
      }

      items.push(
        <div key={key} className={`map-cell ${dropTarget === key ? 'is-drop-target' : ''}`} style={{ gridColumn, gridRow }} {...dropProps}>
          {pageId ? (
            <Tile
              draftId={draftId}
              page={book.pages[pageId]}
              book={book}
              selected={selected.has(pageId)}
              chapterColor={chapterColor(book.pages[pageId].chapterId)}
              onSelect={(gesture) => onSelect(pageId, gesture)}
            />
          ) : (
            <button type="button" className="map-add" onClick={() => onAddAt({ x, y })} aria-label={`Add a page here (${x}, ${y})`}>
              +
            </button>
          )}
        </div>,
      )

      // Connectors to the right and below, between neighbouring pages.
      for (const direction of ['right', 'down'] as const) {
        const neighbour = cells.get(`${x + STEP[direction].x},${y + STEP[direction].y}`)
        if (!pageId || !neighbour) continue
        const state = connectorState(book, pageId, neighbour, direction)
        items.push(
          <button
            key={`${key}-${direction}`}
            type="button"
            className={`map-connector connector-${direction} state-${state}`}
            style={direction === 'right' ? { gridColumn: gridColumn + 1, gridRow } : { gridColumn, gridRow: gridRow + 1 }}
            onClick={() => onCycleConnector(pageId, neighbour, direction)}
            title={`${book.pages[pageId].title} and ${book.pages[neighbour].title}: ${CONNECTOR_LABEL[state]}. Click to change.`}
            aria-label={`Link between ${book.pages[pageId].title} and ${book.pages[neighbour].title}: ${CONNECTOR_LABEL[state]}`}
          >
            {CONNECTOR_GLYPH[direction][state]}
          </button>,
        )
      }
    }
  }

  return (
    <div className="map-view">
      <div className="map-toolbar">
        <span className="map-hint">
          Tap + to add a page. Tap between pages to link them.
          <span className="hide-touch"> Ctrl- or Shift-click to select several.</span>
        </span>
        <div className="zoom-controls">
          <button type="button" className="icon-button" aria-label="Zoom out" onClick={() => setZoom((value) => Math.max(0.6, value - 0.2))}>
            −
          </button>
          <button type="button" className="icon-button" aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(1.6, value + 0.2))}>
            +
          </button>
        </div>
      </div>
      <div className="map-scroll" onClick={(event) => event.target === event.currentTarget && onClearSelection()}>
        <div
          className="map-grid"
          style={{
            '--cell': `${Math.round(120 * zoom)}px`,
            gridTemplateColumns: `repeat(${columns - 1}, var(--cell) var(--gap)) var(--cell)`,
            gridTemplateRows: `repeat(${rows - 1}, var(--cell) var(--gap)) var(--cell)`,
          } as Record<string, string>}
        >
          {items}
        </div>
      </div>
    </div>
  )
}
