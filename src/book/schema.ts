// Canonical book model (schema v1) and the parser that turns untrusted
// book.json content into it. See docs/BOOK_FORMAT.md for the file format.

export const BOOK_FORMAT = 'letoplex-book'
/** Format markers from before the app was renamed to Letoplex; still read. */
export const LEGACY_BOOK_FORMATS = ['graphic-adventure-book']
export const BOOK_SCHEMA_VERSION = 1

/** File extension for book packages (a zip archive). Older `.gab` files still import. */
export const BOOK_EXTENSION = '.letoplex'

export type Direction = 'up' | 'down' | 'left' | 'right'
export const DIRECTIONS: Direction[] = ['up', 'right', 'down', 'left']

export type PageLinks = Record<Direction, string | null>

export type Page = {
  id: string
  title: string
  chapterId: string
  /** Package-relative image path, e.g. `chapters/chapter-1/intro.png`. */
  image: string
  description: string
  position: { x: number; y: number }
  directions: PageLinks
}

export type Chapter = {
  id: string
  title: string
  /** Pages in authored order; the first is where the chapter opens. */
  pageIds: string[]
}

export type ImageFit = 'contain' | 'cover'

export type Book = {
  id: string
  title: string
  author: string
  description: string
  startPageId: string
  /** Package-relative image path for the library card. */
  cover: string
  fit: ImageFit
  chapters: Chapter[]
  pages: Record<string, Page>
}

export type Issue = { level: 'error' | 'warning'; message: string }

export type ParseResult = { book: Book | null; issues: Issue[] }

export const slugify = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'book'

/**
 * Normalizes a package-relative path. Returns null for anything that could
 * escape the package or point elsewhere (absolute paths, URLs, `..`).
 */
export const normalizePath = (value: string): string | null => {
  const path = value.trim().replace(/\\/g, '/')
  if (!path || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('/')) {
    return null
  }

  const segments = path.split('/').filter((segment) => segment && segment !== '.')
  if (segments.length === 0 || segments.some((segment) => segment === '..')) {
    return null
  }

  return segments.join('/')
}

type RawRecord = Record<string, unknown>

const isRecord = (value: unknown): value is RawRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

const finiteNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

type RawChapter = { id: string; title: string; pages: unknown[] }

/** Reads the chapter list from any supported shape, oldest formats included. */
const readChapters = (raw: RawRecord, issues: Issue[]): RawChapter[] | null => {
  if (Array.isArray(raw.chapters)) {
    return raw.chapters.map((chapter, index) => {
      const record = isRecord(chapter) ? chapter : {}
      const title = text(record.title) || `Chapter ${index + 1}`
      return {
        id: text(record.id) || slugify(title),
        title,
        pages: Array.isArray(record.pages) ? record.pages : [],
      }
    })
  }

  // Legacy flat shape: one `pages` array where each page names its chapter.
  if (Array.isArray(raw.pages)) {
    issues.push({
      level: 'warning',
      message: 'This book uses the older flat "pages" layout. It was converted; re-export it with "chapters" when you can.',
    })
    const chapters: RawChapter[] = []
    for (const page of raw.pages) {
      const label = (isRecord(page) && text(page.chapter)) || 'Chapter 1'
      let chapter = chapters.find((entry) => entry.title === label)
      if (!chapter) {
        chapter = { id: slugify(label), title: label, pages: [] }
        chapters.push(chapter)
      }
      chapter.pages.push(page)
    }
    return chapters
  }

  return null
}

/**
 * Parses and validates book.json content. Never throws: problems are
 * reported as issues, and `book` is null whenever any error was found.
 */
export const parseBook = (raw: unknown): ParseResult => {
  const issues: Issue[] = []
  const error = (message: string) => issues.push({ level: 'error', message })
  const warn = (message: string) => issues.push({ level: 'warning', message })

  if (!isRecord(raw)) {
    error('book.json must contain a JSON object.')
    return { book: null, issues }
  }

  if (raw.format !== undefined && raw.format !== BOOK_FORMAT && !LEGACY_BOOK_FORMATS.includes(String(raw.format))) {
    error(`Unknown book format "${String(raw.format)}".`)
    return { book: null, issues }
  }

  const version = raw.version === undefined ? null : raw.version
  if (version !== null && typeof version !== 'number') {
    error('"version" must be a number.')
    return { book: null, issues }
  }
  if (version !== null && version > BOOK_SCHEMA_VERSION) {
    error(`This book needs a newer version of the app (book format v${version}, app supports v${BOOK_SCHEMA_VERSION}).`)
    return { book: null, issues }
  }
  if (version === null && Array.isArray(raw.chapters)) {
    warn('book.json has no "format"/"version" fields; it was read as format v1.')
  }

  const title = text(raw.title)
  if (!title) {
    warn('The book has no title.')
  }

  const rawChapters = readChapters(raw, issues)
  if (!rawChapters) {
    error('book.json needs a "chapters" array.')
    return { book: null, issues }
  }

  const chapters: Chapter[] = []
  const pages: Record<string, Page> = {}
  const chapterIds = new Set<string>()

  rawChapters.forEach((rawChapter, chapterIndex) => {
    let chapterId = rawChapter.id
    if (chapterIds.has(chapterId)) {
      chapterId = `${chapterId}-${chapterIndex + 1}`
      warn(`Chapter id "${rawChapter.id}" is used more than once; renamed to "${chapterId}".`)
    }
    chapterIds.add(chapterId)

    const chapter: Chapter = { id: chapterId, title: rawChapter.title, pageIds: [] }

    rawChapter.pages.forEach((rawPage, pageIndex) => {
      const where = `Page ${pageIndex + 1} of "${chapter.title}"`
      if (!isRecord(rawPage)) {
        error(`${where} is not an object.`)
        return
      }

      const id = text(rawPage.id)
      if (!id) {
        error(`${where} has no "id".`)
        return
      }
      if (pages[id]) {
        error(`Page id "${id}" is used more than once.`)
        return
      }

      const rawImage = text(rawPage.image)
      const image = rawImage ? normalizePath(rawImage) : null
      if (!rawImage) {
        error(`Page "${id}" has no "image".`)
      } else if (!image) {
        error(`Page "${id}" image "${rawImage}" must be a relative path inside the book package.`)
      }

      const rawLinks = isRecord(rawPage.directions) ? rawPage.directions : {}
      const directions = {} as PageLinks
      for (const direction of DIRECTIONS) {
        const target = rawLinks[direction]
        directions[direction] = typeof target === 'string' && target.trim() ? target.trim() : null
      }

      const position = isRecord(rawPage.position) ? rawPage.position : {}

      pages[id] = {
        id,
        title: text(rawPage.title) || id,
        chapterId,
        image: image ?? '',
        description: text(rawPage.description),
        position: { x: finiteNumber(position.x), y: finiteNumber(position.y) },
        directions,
      }
      chapter.pageIds.push(id)
    })

    if (chapter.pageIds.length === 0) {
      warn(`Chapter "${chapter.title}" has no pages and was skipped.`)
      return
    }
    chapters.push(chapter)
  })

  const pageIds = Object.keys(pages)
  if (pageIds.length === 0) {
    error('The book has no pages.')
    return { book: null, issues }
  }

  for (const page of Object.values(pages)) {
    for (const direction of DIRECTIONS) {
      const target = page.directions[direction]
      if (target && !pages[target]) {
        error(`Page "${page.id}" links ${direction} to "${target}", which doesn't exist.`)
      }
    }
  }

  let startPageId = text(raw.startPageId)
  if (!startPageId) {
    startPageId = chapters[0].pageIds[0]
    warn(`No "startPageId" was given; starting at "${startPageId}".`)
  } else if (!pages[startPageId]) {
    error(`The start page "${startPageId}" doesn't exist.`)
  }

  const rawCover = text(raw.cover)
  let cover = pages[startPageId]?.image ?? pages[pageIds[0]].image
  if (rawCover) {
    const normalizedCover = normalizePath(rawCover)
    if (normalizedCover) {
      cover = normalizedCover
    } else {
      error(`Cover image "${rawCover}" must be a relative path inside the book package.`)
    }
  }

  let fit: ImageFit = 'contain'
  if (raw.fit === 'cover' || raw.fit === 'contain') {
    fit = raw.fit
  } else if (raw.fit !== undefined) {
    warn(`Unknown "fit" value "${String(raw.fit)}"; using "contain".`)
  }

  if (issues.some((issue) => issue.level === 'error')) {
    return { book: null, issues }
  }

  return {
    book: {
      id: slugify(text(raw.id) || title || 'untitled-book'),
      title: title || 'Untitled Book',
      author: text(raw.author) || 'Unknown Author',
      description: text(raw.description),
      startPageId,
      cover,
      fit,
      chapters,
      pages,
    },
    issues,
  }
}

/** Every image path the book references (cover included), without duplicates. */
export const referencedImages = (book: Book) =>
  Array.from(new Set([book.cover, ...Object.values(book.pages).map((page) => page.image)]))

export const chapterIndexOf = (book: Book, pageId: string) => {
  const chapterId = book.pages[pageId]?.chapterId
  return book.chapters.findIndex((chapter) => chapter.id === chapterId)
}

/** Pages reachable in one move from the given page. */
export const neighborPageIds = (book: Book, pageId: string) => {
  const page = book.pages[pageId]
  if (!page) {
    return []
  }
  return DIRECTIONS.map((direction) => page.directions[direction]).filter((id): id is string => Boolean(id))
}
