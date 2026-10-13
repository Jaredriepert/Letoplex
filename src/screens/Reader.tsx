import { useCallback, useEffect, useRef, useState, type ComponentProps, type PointerEvent as ReactPointerEvent } from 'react'
import { DIRECTIONS, chapterIndexOf, type Direction } from '../book/schema'
import type { LibraryEntry } from '../library/library'
import { usePageImage } from '../library/useImages'
import { readFlag, writeFlag } from '../storage/prefs'

type Props = {
  entry: LibraryEntry
  pageId: string
  onNavigate: (pageId: string) => void
  onOpenChapters: () => void
  onOpenLibrary: () => void
  /** Set when previewing a draft: replaces Chapters/Library with "Back to editor". */
  onExitPreview?: () => void
}

type Zoom = { scale: number; x: number; y: number }
type Point = { x: number; y: number }

type Gesture =
  | { mode: 'idle' }
  | { mode: 'swipe' | 'pan'; start: Point; startTime: number; startZoom: Zoom; moved: boolean }
  | { mode: 'pinch'; startDistance: number; startMid: Point; startZoom: Zoom }

const NO_ZOOM: Zoom = { scale: 1, x: 0, y: 0 }
const MAX_ZOOM = 4
const DOUBLE_TAP_ZOOM = 2.5
const SWIPE_DISTANCE = 40
const TAP_SLOP = 10
const DOUBLE_TAP_MS = 280
/** Tap zones as a fraction of the screen, with a floor so they stay finger-sized. */
const EDGE_FRACTION_X = 0.22
const EDGE_FRACTION_Y = 0.16
const EDGE_MIN_PX = 56
const COACH_FLAG = 'reader-coach-seen'

const ARROW_LABEL: Record<Direction, string> = { up: 'Go up', down: 'Go down', left: 'Go left', right: 'Go right' }
const KEY_DIRECTION: Record<string, Direction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }

/**
 * Swipes drag the page like paper: moving your finger left brings in the page
 * to the right. Edge taps and arrows move toward the side you touch.
 */
const directionForSwipe = (dx: number, dy: number): Direction =>
  Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'right' : 'left') : dy < 0 ? 'down' : 'up'

const clampZoom = (zoom: Zoom, width: number, height: number): Zoom => {
  const scale = Math.min(MAX_ZOOM, Math.max(1, zoom.scale))
  const maxX = ((scale - 1) * width) / 2
  const maxY = ((scale - 1) * height) / 2
  return { scale, x: Math.min(maxX, Math.max(-maxX, zoom.x)), y: Math.min(maxY, Math.max(-maxY, zoom.y)) }
}

/**
 * A button that acts on touch release rather than `click`. Chrome treats a
 * tap shortly after a swipe as "stop the fling" and drops its click, which
 * made arrows ignore the first tap after swiping. Click still handles mouse
 * and keyboard; the timestamp stops a touch from firing twice.
 */
function PressButton({ onPress, ...props }: Omit<ComponentProps<'button'>, 'onClick' | 'onPointerUp'> & { onPress: () => void }) {
  const touchHandledAt = useRef(0)
  return (
    <button
      type="button"
      {...props}
      onPointerUp={(event) => {
        if (event.pointerType === 'mouse') {
          return
        }
        const rect = event.currentTarget.getBoundingClientRect()
        if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) {
          touchHandledAt.current = Date.now()
          onPress()
        }
      }}
      onClick={() => {
        if (Date.now() - touchHandledAt.current > 800) {
          onPress()
        }
      }}
    />
  )
}

function Chevron({ direction }: { direction: Direction }) {
  const rotation = { up: 0, right: 90, down: 180, left: 270 }[direction]
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" style={{ transform: `rotate(${rotation}deg)` }}>
      <path d="M5 15l7-7 7 7" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function Reader({ entry, pageId, onNavigate, onOpenChapters, onOpenLibrary, onExitPreview }: Props) {
  const { book } = entry
  const page = book.pages[pageId]
  const chapterIndex = chapterIndexOf(book, pageId)
  const chapter = book.chapters[chapterIndex]
  const image = usePageImage(entry, pageId)

  const stageRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const pointersRef = useRef(new Map<number, Point>())
  const gestureRef = useRef<Gesture>({ mode: 'idle' })
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null)
  const tapTimerRef = useRef<number | undefined>(undefined)

  // Zoom belongs to a page, so moving to another page starts unzoomed.
  const [zoomState, setZoomState] = useState<{ pageId: string; zoom: Zoom }>({ pageId, zoom: NO_ZOOM })
  const zoom = zoomState.pageId === pageId ? zoomState.zoom : NO_ZOOM
  const setZoom = (next: Zoom) => setZoomState({ pageId, zoom: next })
  const [chromeVisible, setChromeVisible] = useState(true)
  const [menuOpen, setMenuOpen] = useState(false)
  const [coachOpen, setCoachOpen] = useState(() => !readFlag(COACH_FLAG))
  const [zoomAnimated, setZoomAnimated] = useState(false)
  // The slide-in direction only applies to the page it was set for, so
  // browser back/forward (which skip `move`) just fade.
  const [entrance, setEntrance] = useState<{ pageId: string; from: Direction } | null>(null)
  const [nudge, setNudge] = useState<Direction | null>(null)
  const [announcement, setAnnouncement] = useState('')

  const animateZoomTo = (next: Zoom) => {
    setZoomAnimated(true)
    setZoom(next)
  }

  useEffect(() => () => window.clearTimeout(tapTimerRef.current), [])

  const move = useCallback(
    (direction: Direction) => {
      const target = page?.directions[direction]
      if (!target) {
        setNudge(direction)
        setAnnouncement(`No path ${direction} from here.`)
        return
      }
      setEntrance({ pageId: target, from: direction })
      setAnnouncement('')
      gestureRef.current = { mode: 'idle' }
      onNavigate(target)
    },
    [page, onNavigate],
  )

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        return
      }
      const direction = KEY_DIRECTION[event.key]
      if (direction && !menuOpen && !coachOpen) {
        event.preventDefault()
        move(direction)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [move, menuOpen, coachOpen])

  useEffect(() => {
    if (!menuOpen) {
      return undefined
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [menuOpen])

  const stageSize = () => {
    const rect = stageRef.current?.getBoundingClientRect()
    return rect ? { rect, width: rect.width, height: rect.height } : null
  }

  /** Point relative to the stage centre, which is the zoom origin. */
  const centered = (x: number, y: number): Point => {
    const size = stageSize()
    return size ? { x: x - size.rect.left - size.width / 2, y: y - size.rect.top - size.height / 2 } : { x: 0, y: 0 }
  }

  const edgeDirection = (clientX: number, clientY: number): Direction | null => {
    const size = stageSize()
    if (!size) {
      return null
    }
    const x = clientX - size.rect.left
    const y = clientY - size.rect.top
    const edgeX = Math.max(EDGE_MIN_PX, size.width * EDGE_FRACTION_X)
    const edgeY = Math.max(EDGE_MIN_PX, size.height * EDGE_FRACTION_Y)
    // In a corner, the side the finger is proportionally closer to wins.
    const candidates: Array<[Direction, number]> = [
      ['left', x / edgeX],
      ['right', (size.width - x) / edgeX],
      ['up', y / edgeY],
      ['down', (size.height - y) / edgeY],
    ]
    const [direction, closeness] = candidates.sort((a, b) => a[1] - b[1])[0]
    return closeness < 1 ? direction : null
  }

  const toggleZoomAt = (clientX: number, clientY: number) => {
    const size = stageSize()
    if (!size) {
      return
    }
    if (zoom.scale > 1) {
      animateZoomTo(NO_ZOOM)
      return
    }
    const point = centered(clientX, clientY)
    animateZoomTo(clampZoom({ scale: DOUBLE_TAP_ZOOM, x: point.x * (1 - DOUBLE_TAP_ZOOM), y: point.y * (1 - DOUBLE_TAP_ZOOM) }, size.width, size.height))
  }

  const handleTap = (clientX: number, clientY: number) => {
    const direction = zoom.scale > 1 ? null : edgeDirection(clientX, clientY)
    if (direction) {
      move(direction)
      return
    }

    // Centre taps: single toggles the controls, double toggles zoom.
    const now = Date.now()
    const last = lastTapRef.current
    if (last && now - last.time < DOUBLE_TAP_MS && Math.hypot(clientX - last.x, clientY - last.y) < 30) {
      window.clearTimeout(tapTimerRef.current)
      lastTapRef.current = null
      toggleZoomAt(clientX, clientY)
      return
    }
    lastTapRef.current = { time: now, x: clientX, y: clientY }
    window.clearTimeout(tapTimerRef.current)
    tapTimerRef.current = window.setTimeout(() => setChromeVisible((visible) => !visible), DOUBLE_TAP_MS)
  }

  const beginSinglePointer = (point: Point) => {
    gestureRef.current = {
      mode: zoom.scale > 1 ? 'pan' : 'swipe',
      start: point,
      startTime: Date.now(),
      startZoom: zoom,
      moved: false,
    }
  }

  const beginPinch = () => {
    const [a, b] = Array.from(pointersRef.current.values())
    gestureRef.current = {
      mode: 'pinch',
      startDistance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      startMid: centered((a.x + b.x) / 2, (a.y + b.y) / 2),
      startZoom: zoom,
    }
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setZoomAnimated(false)
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointersRef.current.size === 2) {
      beginPinch()
    } else if (pointersRef.current.size === 1) {
      beginSinglePointer({ x: event.clientX, y: event.clientY })
    }
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) {
      return
    }
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const gesture = gestureRef.current
    const size = stageSize()
    if (!size) {
      return
    }

    if (gesture.mode === 'pinch' && pointersRef.current.size >= 2) {
      const [a, b] = Array.from(pointersRef.current.values())
      const scale = Math.min(MAX_ZOOM, Math.max(1, gesture.startZoom.scale * (Math.hypot(a.x - b.x, a.y - b.y) / gesture.startDistance)))
      const mid = centered((a.x + b.x) / 2, (a.y + b.y) / 2)
      // Keep the content that was under the fingers under the fingers.
      const ratio = scale / gesture.startZoom.scale
      setZoom(
        clampZoom(
          { scale, x: mid.x - (gesture.startMid.x - gesture.startZoom.x) * ratio, y: mid.y - (gesture.startMid.y - gesture.startZoom.y) * ratio },
          size.width,
          size.height,
        ),
      )
      return
    }

    if (gesture.mode === 'swipe' || gesture.mode === 'pan') {
      const dx = event.clientX - gesture.start.x
      const dy = event.clientY - gesture.start.y
      if (Math.hypot(dx, dy) > TAP_SLOP) {
        gesture.moved = true
      }
      if (gesture.mode === 'pan') {
        setZoom(clampZoom({ ...gesture.startZoom, x: gesture.startZoom.x + dx, y: gesture.startZoom.y + dy }, size.width, size.height))
      }
    }
  }

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) {
      return
    }
    pointersRef.current.delete(event.pointerId)
    const gesture = gestureRef.current

    if (gesture.mode === 'pinch') {
      if (zoom.scale < 1.05) {
        animateZoomTo(NO_ZOOM)
      }
      const remaining = Array.from(pointersRef.current.values())[0]
      // Lifting one finger of a pinch continues as a pan, never a swipe.
      gestureRef.current = remaining
        ? { mode: 'pan', start: remaining, startTime: Date.now(), startZoom: zoom, moved: true }
        : { mode: 'idle' }
      return
    }

    if (pointersRef.current.size > 0 || gesture.mode === 'idle') {
      return
    }
    gestureRef.current = { mode: 'idle' }
    if (event.type === 'pointercancel') {
      return
    }

    const dx = event.clientX - gesture.start.x
    const dy = event.clientY - gesture.start.y
    if (!gesture.moved) {
      if (Date.now() - gesture.startTime < 500) {
        handleTap(event.clientX, event.clientY)
      }
      return
    }
    if (gesture.mode === 'swipe' && Math.max(Math.abs(dx), Math.abs(dy)) > SWIPE_DISTANCE) {
      move(directionForSwipe(dx, dy))
    }
  }

  const goToChapterStart = () => {
    setMenuOpen(false)
    if (chapter) {
      onNavigate(chapter.pageIds[0])
    }
  }

  const goToBookStart = () => {
    setMenuOpen(false)
    onNavigate(book.startPageId)
  }

  const dismissCoach = () => {
    setCoachOpen(false)
    writeFlag(COACH_FLAG)
  }

  if (!page) {
    return null
  }

  const available = DIRECTIONS.filter((direction) => page.directions[direction])
  const isZoomed = zoom.scale > 1
  const enterFrom = entrance?.pageId === pageId ? entrance.from : null

  return (
    <div className={`reader-screen ${chromeVisible ? '' : 'chrome-hidden'}`}>
      <div
        ref={stageRef}
        className="page-stage"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onContextMenu={(event) => event.preventDefault()}
      >
        <div key={pageId} className={`page-motion ${enterFrom ? `enter-from-${enterFrom}` : 'enter-fade'}`}>
          <div className={`page-nudge ${nudge ? `nudge-${nudge}` : ''}`} onAnimationEnd={() => setNudge(null)}>
            <div
              className={`page-zoom ${zoomAnimated ? 'is-settling' : ''}`}
              style={{ transform: `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.scale})` }}
            >
              {image?.status === 'ready' && image.url && (
                <img
                  className="page-image"
                  src={image.url}
                  alt={page.description || page.title}
                  draggable={false}
                  style={{ objectFit: book.fit }}
                />
              )}
            </div>
          </div>
        </div>

        {(!image || image.status === 'loading') && <div className="page-loading" aria-label="Loading page" />}
        {image?.status === 'error' && (
          <div className="page-error" role="status">
            <strong>This page's picture couldn't be loaded.</strong>
            <span>{page.description || 'You can still move on using the arrows.'}</span>
          </div>
        )}
      </div>

      <div className="reader-topbar">
        <div className="page-overlay-banner">
          <span>
            {onExitPreview && <b className="preview-pill">Preview</b>}
            {chapter?.title}
          </span>
          <h2>{page.title}</h2>
        </div>

        <div className="menu-wrap" ref={menuRef}>
          <PressButton
            className="menu-button"
            aria-label="Reader menu"
            aria-expanded={menuOpen}
            onPress={() => setMenuOpen((open) => !open)}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
          </PressButton>

          {menuOpen && (
            <div className="menu-dropdown" role="menu">
              <div className="menu-book-name">{book.title}</div>
              {onExitPreview ? (
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onExitPreview() }}>
                  Back to editor
                </button>
              ) : (
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onOpenChapters() }}>
                  Chapters
                </button>
              )}
              <button type="button" role="menuitem" onClick={goToChapterStart}>
                Restart this chapter
              </button>
              <button type="button" role="menuitem" onClick={goToBookStart}>
                Back to the beginning
              </button>
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setCoachOpen(true) }}>
                How to read
              </button>
              {!onExitPreview && (
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onOpenLibrary() }}>
                  Library
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {!isZoomed &&
        available.map((direction) => (
          <PressButton
            // Keyed by page too, so every available arrow re-plays its pulse on
            // arrival. Keyed by direction alone, arrows shared with the previous
            // page kept their element and only new ones pulsed.
            key={`${pageId}-${direction}`}
            className={`direction-hint hint-${direction}`}
            aria-label={`${ARROW_LABEL[direction]}: ${book.pages[page.directions[direction]!]?.title ?? ''}`}
            onPress={() => move(direction)}
          >
            <Chevron direction={direction} />
          </PressButton>
        ))}

      {available.length === 0 && chromeVisible && (
        <div className="end-card">
          <strong>The end of this path</strong>
          <button type="button" className="primary-button" onClick={onExitPreview ?? onOpenChapters}>
            {onExitPreview ? 'Back to editor' : 'Chapters'}
          </button>
        </div>
      )}

      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>

      {coachOpen && (
        <div className="coach" role="dialog" aria-modal="true" aria-labelledby="coach-title">
          <div className="coach-card">
            <h2 id="coach-title">How to read</h2>
            <ul>
              <li><b>Swipe</b> the page, or <b>tap near an edge</b>, to move that way.</li>
              <li><b>Arrows</b> at the edges show which ways the story goes.</li>
              <li><b>Pinch</b> or <b>double-tap</b> to zoom into the art.</li>
              <li><b>Tap the middle</b> to hide or show the controls.</li>
            </ul>
            <button type="button" className="primary-button" onClick={dismissCoach} autoFocus>
              Start reading
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
