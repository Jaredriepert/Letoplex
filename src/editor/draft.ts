// The editor's book model and every editing operation, as pure functions.
// A draft holds an ordinary Book (the same model the reader uses), except
// that it may be incomplete: pages can lack images and the start page can be
// unset until the author fills them in. Export runs the real book.json parser
// over the result, so anything the editor produces is guaranteed readable.
import {
  BOOK_FORMAT,
  BOOK_SCHEMA_VERSION,
  DIRECTIONS,
  slugify,
  type Book,
  type Chapter,
  type Direction,
  type Page,
} from '../book/schema'

export type Draft = {
  id: string
  book: Book
  /** True once the author sets the book id by hand; otherwise it follows the title. */
  customId: boolean
  /** The library book this draft was opened from, if any. */
  sourceBookId: string | null
  createdAt: number
  updatedAt: number
}

export type Point = { x: number; y: number }

/** Warm, distinct chapter colours used on map tiles and lists. */
export const CHAPTER_COLORS = ['#b5552e', '#4f7a8c', '#7d8a3a', '#9a6a3a', '#7a5a8c', '#3a8a7a', '#a8456a', '#5f6b8a']

export const OPPOSITE: Record<Direction, Direction> = { up: 'down', down: 'up', left: 'right', right: 'left' }
export const STEP: Record<Direction, Point> = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } }

export const DRAFT_KEY_PREFIX = 'draft~'
/** Where a draft's images live in the assets store. */
export const draftStorageKey = (draftId: string) => DRAFT_KEY_PREFIX + draftId
/** Small preview image stored beside each page image; never exported. */
export const thumbPathFor = (imagePath: string) => `.thumbs/${imagePath}`

const cellKey = ({ x, y }: Point) => `${x},${y}`

export const newDraftId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

export const createDraft = (title = 'Untitled book'): Draft => {
  const now = Date.now()
  return {
    id: newDraftId(),
    book: {
      id: slugify(title),
      title,
      author: '',
      description: '',
      startPageId: '',
      cover: '',
      fit: 'contain',
      chapters: [{ id: 'chapter-1', title: 'Chapter 1', pageIds: [] }],
      pages: {},
    },
    customId: false,
    sourceBookId: null,
    createdAt: now,
    updatedAt: now,
  }
}

/** The id the book will be exported with. */
export const exportBookId = (draft: Draft) => (draft.customId ? slugify(draft.book.id) : slugify(draft.book.title || 'untitled-book'))

// ---------- Small immutable helpers ----------

const withPage = (book: Book, page: Page): Book => ({ ...book, pages: { ...book.pages, [page.id]: page } })

const withChapters = (book: Book, chapters: Chapter[]): Book => ({ ...book, chapters })

const uniqueId = (base: string, taken: (id: string) => boolean) => {
  let id = base
  for (let n = 2; taken(id); n++) {
    id = `${base}-${n}`
  }
  return id
}

export const occupiedCells = (book: Book) => {
  const cells = new Map<string, string>()
  for (const page of Object.values(book.pages)) {
    cells.set(cellKey(page.position), page.id)
  }
  return cells
}

export const pageAt = (book: Book, point: Point) => occupiedCells(book).get(cellKey(point)) ?? null

/** Nearest free grid cell, searching outward in rings from `point`. */
export const nearestFreeCell = (book: Book, point: Point): Point => {
  const cells = occupiedCells(book)
  if (!cells.has(cellKey(point))) {
    return point
  }
  for (let radius = 1; ; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue
        const candidate = { x: point.x + dx, y: point.y + dy }
        if (!cells.has(cellKey(candidate))) {
          return candidate
        }
      }
    }
  }
}

export const gridBounds = (book: Book) => {
  const pages = Object.values(book.pages)
  if (pages.length === 0) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0 }
  }
  const xs = pages.map((page) => page.position.x)
  const ys = pages.map((page) => page.position.y)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

const nextPageNumber = (book: Book) => Object.keys(book.pages).length + 1

const chapterOf = (book: Book, pageId: string) => book.chapters.find((chapter) => chapter.id === book.pages[pageId]?.chapterId)

const emptyLinks = (): Record<Direction, string | null> => ({ up: null, down: null, left: null, right: null })

// ---------- Pages ----------

export const addPage = (book: Book, at: Point, chapterId?: string): { book: Book; pageId: string } => {
  const chapter = book.chapters.find((item) => item.id === chapterId) ?? book.chapters[book.chapters.length - 1]
  const number = nextPageNumber(book)
  const pageId = uniqueId(`page-${number}`, (id) => Boolean(book.pages[id]))
  const page: Page = {
    id: pageId,
    title: `Page ${number}`,
    chapterId: chapter.id,
    image: '',
    description: '',
    position: nearestFreeCell(book, at),
    directions: emptyLinks(),
  }
  let next = withPage(book, page)
  next = withChapters(
    next,
    next.chapters.map((item) => (item.id === chapter.id ? { ...item, pageIds: [...item.pageIds, pageId] } : item)),
  )
  if (!next.startPageId) {
    next = { ...next, startPageId: pageId }
  }
  return { book: next, pageId }
}

/**
 * Adds one page per image, laid out left to right and linked in reading
 * order (each page's right goes to the next, and back again). Continues from
 * `afterPageId` when given, otherwise starts a new row under the map.
 */
export const addImagePages = (
  book: Book,
  images: Array<{ path: string; title?: string }>,
  options: { afterPageId?: string | null; chapterId?: string } = {},
): { book: Book; pageIds: string[] } => {
  let next = book
  const after = options.afterPageId ? book.pages[options.afterPageId] : null
  const bounds = gridBounds(book)
  let cursor: Point = after
    ? { x: after.position.x + 1, y: after.position.y }
    : { x: 0, y: Object.keys(book.pages).length === 0 ? 0 : bounds.maxY + 1 }
  let previousId = after?.id ?? null
  const chapterId = options.chapterId ?? (after ? after.chapterId : undefined)
  const pageIds: string[] = []

  for (const image of images) {
    // Walk right past occupied cells so a row never overwrites anything.
    while (pageAt(next, cursor)) {
      cursor = { x: cursor.x + 1, y: cursor.y }
    }
    const added = addPage(next, cursor, chapterId)
    next = updatePage(added.book, added.pageId, { image: image.path, ...(image.title ? { title: image.title } : {}) })
    if (previousId) {
      const previous = next.pages[previousId]
      if (!previous.directions.right) {
        next = setLink(next, previousId, 'right', added.pageId)
        next = setLink(next, added.pageId, 'left', previousId)
      }
    }
    pageIds.push(added.pageId)
    previousId = added.pageId
    cursor = { x: cursor.x + 1, y: cursor.y }
  }
  return { book: next, pageIds }
}

export const updatePage = (book: Book, pageId: string, patch: Partial<Pick<Page, 'title' | 'description' | 'image'>>): Book => {
  const page = book.pages[pageId]
  return page ? withPage(book, { ...page, ...patch }) : book
}

export const deletePage = (book: Book, pageId: string): Book => {
  const removed = book.pages[pageId]
  if (!removed) {
    return book
  }
  const pages: Record<string, Page> = {}
  for (const page of Object.values(book.pages)) {
    if (page.id === pageId) continue
    const directions = { ...page.directions }
    for (const direction of DIRECTIONS) {
      if (directions[direction] === pageId) directions[direction] = null
    }
    pages[page.id] = { ...page, directions }
  }
  const chapters = book.chapters.map((chapter) => ({ ...chapter, pageIds: chapter.pageIds.filter((id) => id !== pageId) }))
  const firstRemaining = chapters.flatMap((chapter) => chapter.pageIds)[0] ?? ''
  const coverStillUsed = Object.values(pages).some((page) => page.image === book.cover)
  return {
    ...book,
    pages,
    chapters,
    startPageId: book.startPageId === pageId ? firstRemaining : book.startPageId,
    cover: book.cover === removed.image && !coverStillUsed ? '' : book.cover,
  }
}

/** Moves a page to a grid cell, swapping with whatever is already there. */
export const movePage = (book: Book, pageId: string, to: Point): Book => {
  const page = book.pages[pageId]
  if (!page) {
    return book
  }
  const occupant = pageAt(book, to)
  let next = withPage(book, { ...page, position: to })
  if (occupant && occupant !== pageId) {
    next = withPage(next, { ...next.pages[occupant], position: page.position })
  }
  return next
}

/**
 * Moves several pages by the same offset, keeping their arrangement. Returns
 * the book unchanged if any page would land on a page outside the group.
 */
export const movePages = (book: Book, pageIds: string[], delta: Point): Book => {
  const moving = new Set(pageIds.filter((id) => book.pages[id]))
  if (moving.size === 0 || (delta.x === 0 && delta.y === 0)) {
    return book
  }
  const cells = occupiedCells(book)
  for (const id of moving) {
    const { x, y } = book.pages[id].position
    const occupant = cells.get(cellKey({ x: x + delta.x, y: y + delta.y }))
    if (occupant && !moving.has(occupant)) {
      return book
    }
  }
  const pages = { ...book.pages }
  for (const id of moving) {
    const { x, y } = pages[id].position
    pages[id] = { ...pages[id], position: { x: x + delta.x, y: y + delta.y } }
  }
  return { ...book, pages }
}

export const deletePages = (book: Book, pageIds: string[]): Book => pageIds.reduce(deletePage, book)

export const setPagesChapter = (book: Book, pageIds: string[], chapterId: string): Book =>
  pageIds.reduce((next, id) => setPageChapter(next, id, chapterId), book)

// ---------- Links ----------

export const setLink = (book: Book, pageId: string, direction: Direction, targetId: string | null): Book => {
  const page = book.pages[pageId]
  if (!page || (targetId && !book.pages[targetId]) || targetId === pageId) {
    return book
  }
  return withPage(book, { ...page, directions: { ...page.directions, [direction]: targetId } })
}

/** Makes the target of `direction` link back the opposite way. */
export const linkBack = (book: Book, pageId: string, direction: Direction): Book => {
  const targetId = book.pages[pageId]?.directions[direction]
  return targetId ? setLink(book, targetId, OPPOSITE[direction], pageId) : book
}

export type ConnectorState = 'none' | 'both' | 'forward' | 'back'

/** How two grid neighbours are linked; `direction` points from `fromId` to `toId`. */
export const connectorState = (book: Book, fromId: string, toId: string, direction: Direction): ConnectorState => {
  const forward = book.pages[fromId]?.directions[direction] === toId
  const back = book.pages[toId]?.directions[OPPOSITE[direction]] === fromId
  return forward && back ? 'both' : forward ? 'forward' : back ? 'back' : 'none'
}

const CONNECTOR_CYCLE: Record<ConnectorState, ConnectorState> = { none: 'both', both: 'forward', forward: 'back', back: 'none' }

/** Cycles a connector between neighbours: none → both ways → one way → other way → none. */
export const cycleConnector = (book: Book, fromId: string, toId: string, direction: Direction): Book => {
  const nextState = CONNECTOR_CYCLE[connectorState(book, fromId, toId, direction)]
  const back = OPPOSITE[direction]
  const fromTarget = nextState === 'both' || nextState === 'forward' ? toId : null
  const toTarget = nextState === 'both' || nextState === 'back' ? fromId : null
  let next = book
  // Only clear links that point at each other; never wipe an unrelated link.
  if (fromTarget || book.pages[fromId].directions[direction] === toId) next = setLink(next, fromId, direction, fromTarget)
  if (toTarget || book.pages[toId].directions[back] === fromId) next = setLink(next, toId, back, toTarget)
  return next
}

// ---------- Book and chapters ----------

export const updateBook = (book: Book, patch: Partial<Pick<Book, 'title' | 'author' | 'description' | 'fit' | 'cover' | 'id'>>): Book => ({
  ...book,
  ...patch,
})

export const setStartPage = (book: Book, pageId: string): Book => (book.pages[pageId] ? { ...book, startPageId: pageId } : book)

export const setPageChapter = (book: Book, pageId: string, chapterId: string): Book => {
  const page = book.pages[pageId]
  if (!page || page.chapterId === chapterId || !book.chapters.some((chapter) => chapter.id === chapterId)) {
    return book
  }
  const chapters = book.chapters.map((chapter) => {
    if (chapter.id === page.chapterId) return { ...chapter, pageIds: chapter.pageIds.filter((id) => id !== pageId) }
    if (chapter.id === chapterId) return { ...chapter, pageIds: [...chapter.pageIds, pageId] }
    return chapter
  })
  return withChapters(withPage(book, { ...page, chapterId }), chapters)
}

/** Makes a page the one its chapter opens on. */
export const makeChapterOpener = (book: Book, pageId: string): Book => {
  const chapter = chapterOf(book, pageId)
  if (!chapter) {
    return book
  }
  return withChapters(
    book,
    book.chapters.map((item) => (item.id === chapter.id ? { ...item, pageIds: [pageId, ...item.pageIds.filter((id) => id !== pageId)] } : item)),
  )
}

export const addChapter = (book: Book, title?: string): { book: Book; chapterId: string } => {
  const name = title?.trim() || `Chapter ${book.chapters.length + 1}`
  const chapterId = uniqueId(slugify(name), (id) => book.chapters.some((chapter) => chapter.id === id))
  return { book: withChapters(book, [...book.chapters, { id: chapterId, title: name, pageIds: [] }]), chapterId }
}

export const renameChapter = (book: Book, chapterId: string, title: string): Book =>
  withChapters(
    book,
    book.chapters.map((chapter) => (chapter.id === chapterId ? { ...chapter, title } : chapter)),
  )

export const moveChapter = (book: Book, chapterId: string, delta: -1 | 1): Book => {
  const index = book.chapters.findIndex((chapter) => chapter.id === chapterId)
  const target = index + delta
  if (index < 0 || target < 0 || target >= book.chapters.length) {
    return book
  }
  const chapters = [...book.chapters]
  ;[chapters[index], chapters[target]] = [chapters[target], chapters[index]]
  return withChapters(book, chapters)
}

/** Deletes a chapter, moving its pages to the end of the chapter before it (or after, for the first). */
export const deleteChapter = (book: Book, chapterId: string): Book => {
  const index = book.chapters.findIndex((chapter) => chapter.id === chapterId)
  if (index < 0 || book.chapters.length === 1) {
    return book
  }
  const removed = book.chapters[index]
  const heir = book.chapters[index === 0 ? 1 : index - 1]
  const pages = { ...book.pages }
  for (const id of removed.pageIds) {
    pages[id] = { ...pages[id], chapterId: heir.id }
  }
  const chapters = book.chapters
    .filter((chapter) => chapter.id !== chapterId)
    .map((chapter) => (chapter.id === heir.id ? { ...chapter, pageIds: [...chapter.pageIds, ...removed.pageIds] } : chapter))
  return { ...book, pages, chapters }
}

// ---------- Opening existing books ----------

/**
 * Gives every page its own grid cell. Older books often put every page at
 * (0, 0); overlapping pages are moved to the nearest free cell beside the
 * page that links to them, so the map still roughly follows the story.
 */
export const spreadOverlappingPages = (book: Book): Book => {
  let next: Book = { ...book, pages: {} }
  const order = [book.startPageId, ...book.chapters.flatMap((chapter) => chapter.pageIds)].filter(
    (id, index, all) => id && book.pages[id] && all.indexOf(id) === index,
  )
  for (const id of order) {
    const page = book.pages[id]
    let position = page.position
    if (pageAt(next, position)) {
      // Prefer the cell next to a page that links here.
      const source = Object.values(next.pages).find((other) => DIRECTIONS.some((direction) => other.directions[direction] === id))
      const direction = source ? DIRECTIONS.find((d) => source.directions[d] === id)! : 'right'
      const from = source?.position ?? position
      position = nearestFreeCell(next, { x: from.x + STEP[direction].x, y: from.y + STEP[direction].y })
    }
    next = withPage(next, { ...page, position })
  }
  return next
}

// ---------- Export ----------

/** Canonical v1 book.json content for a draft. */
export const toBookJson = (draft: Draft) => {
  const { book } = draft
  return {
    format: BOOK_FORMAT,
    version: BOOK_SCHEMA_VERSION,
    id: exportBookId(draft),
    title: book.title.trim(),
    ...(book.author.trim() ? { author: book.author.trim() } : {}),
    ...(book.description.trim() ? { description: book.description.trim() } : {}),
    startPageId: book.startPageId,
    ...(book.cover ? { cover: book.cover } : {}),
    ...(book.fit !== 'contain' ? { fit: book.fit } : {}),
    chapters: book.chapters
      .filter((chapter) => chapter.pageIds.length > 0)
      .map((chapter) => ({
        id: chapter.id,
        title: chapter.title.trim() || chapter.id,
        pages: chapter.pageIds.map((id) => {
          const page = book.pages[id]
          return {
            id: page.id,
            title: page.title.trim() || page.id,
            image: page.image,
            ...(page.description.trim() ? { description: page.description.trim() } : {}),
            position: page.position,
            directions: page.directions,
          }
        }),
      })),
  }
}

/** Every image path the draft uses (pages and cover). */
export const draftImagePaths = (book: Book) =>
  new Set([book.cover, ...Object.values(book.pages).map((page) => page.image)].filter(Boolean))

// ---------- Checks ----------

export type EditorIssue = {
  level: 'error' | 'warning' | 'info'
  message: string
  pageId?: string
  chapterId?: string
}

/** Pages a reader can reach from the start page. */
export const reachablePages = (book: Book) => {
  const seen = new Set<string>()
  const queue = book.pages[book.startPageId] ? [book.startPageId] : []
  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    for (const direction of DIRECTIONS) {
      const target = book.pages[id].directions[direction]
      if (target && !seen.has(target)) queue.push(target)
    }
  }
  return seen
}

/**
 * Problems an author should know about. Errors block export; warnings and
 * info don't. `storedImages` is the set of image paths actually saved.
 */
export const checkDraft = (book: Book, storedImages: Set<string>): EditorIssue[] => {
  const issues: EditorIssue[] = []
  const pages = book.chapters.flatMap((chapter) => chapter.pageIds.map((id) => book.pages[id]))

  if (!book.title.trim()) {
    issues.push({ level: 'error', message: 'Give the book a title.' })
  }
  if (pages.length === 0) {
    issues.push({ level: 'error', message: 'Add at least one page.' })
    return issues
  }
  if (!book.pages[book.startPageId]) {
    issues.push({ level: 'error', message: 'Choose a start page.' })
  }

  for (const page of pages) {
    if (!page.image) {
      issues.push({ level: 'error', message: `"${page.title}" has no picture.`, pageId: page.id })
    } else if (!storedImages.has(page.image)) {
      issues.push({ level: 'error', message: `"${page.title}"'s picture is missing. Add it again.`, pageId: page.id })
    }
  }
  if (book.cover && !storedImages.has(book.cover)) {
    issues.push({ level: 'error', message: 'The cover picture is missing. Choose another cover.' })
  }

  const reachable = reachablePages(book)
  if (book.pages[book.startPageId]) {
    for (const page of pages) {
      if (!reachable.has(page.id)) {
        issues.push({ level: 'warning', message: `"${page.title}" can't be reached from the start page.`, pageId: page.id })
      }
    }
  }

  for (const chapter of book.chapters) {
    if (chapter.pageIds.length === 0) {
      issues.push({ level: 'warning', message: `Chapter "${chapter.title}" has no pages and will be left out.`, chapterId: chapter.id })
    }
  }

  const endings = pages.filter((page) => DIRECTIONS.every((direction) => !page.directions[direction]))
  if (endings.length > 0) {
    issues.push({
      level: 'info',
      message:
        endings.length === 1
          ? `"${endings[0].title}" is an ending (no way forward).`
          : `${endings.length} pages are endings (no way forward).`,
      ...(endings.length === 1 ? { pageId: endings[0].id } : {}),
    })
  }

  return issues
}
