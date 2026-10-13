// Reads a book package (a .letoplex/.zip archive, an older .gab, or a picked folder) into a
// validated Book plus lazy handles to its images. Nothing large is loaded
// here: images are only read, one at a time, when they're saved.
import { normalizePath, parseBook, referencedImages, type Book, type Issue } from './schema'
import { readZipEntry, readZipIndex, ZipError } from './zip'

/** A file inside a package that hasn't been read yet. */
export type PackageFile = { size: number; read: () => Promise<Blob> }

export type BookPackage = {
  book: Book
  assets: Map<string, PackageFile>
  /** Total bytes of all referenced images once stored. */
  totalBytes: number
}

export type ImportResult =
  | { ok: true; pkg: BookPackage; issues: Issue[] }
  | { ok: false; issues: Issue[] }

/** Single images above this are almost certainly a mistake (or an attack). */
export const MAX_FILE_BYTES = 64 * 1024 * 1024
/** book.json is read into memory, so keep it sane. */
const MAX_BOOK_JSON_BYTES = 16 * 1024 * 1024

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  svg: 'image/svg+xml',
}

export const imageTypeFor = (path: string) => IMAGE_TYPES[path.split('.').pop()?.toLowerCase() ?? '']

const fail = (message: string, issues: Issue[] = []): ImportResult => ({
  ok: false,
  issues: [...issues, { level: 'error', message }],
})

const isIgnoredEntry = (path: string) =>
  path.split('/').some((segment) => segment.startsWith('.') || segment === '__MACOSX')

/** Gives a blob the right MIME type so SVG and friends render from object URLs. */
const withType = (blob: Blob, type: string) => (blob.type === type ? blob : blob.slice(0, blob.size, type))

/**
 * Builds a package from a path → file map. The shallowest `book.json` marks
 * the package root, so archives with or without a top-level folder both work.
 */
export const buildPackage = async (entries: Map<string, PackageFile>): Promise<ImportResult> => {
  const bookJsonPaths = Array.from(entries.keys())
    .filter((path) => path === 'book.json' || path.endsWith('/book.json'))
    .sort((a, b) => a.split('/').length - b.split('/').length)

  if (bookJsonPaths.length === 0) {
    return fail('No book.json was found. A book package needs a book.json file at its top level.')
  }

  const bookJsonPath = bookJsonPaths[0]
  const prefix = bookJsonPath.slice(0, -'book.json'.length)
  const bookJsonFile = entries.get(bookJsonPath)!
  if (bookJsonFile.size > MAX_BOOK_JSON_BYTES) {
    return fail('book.json is too large.')
  }

  let raw: unknown
  try {
    raw = JSON.parse(await (await bookJsonFile.read()).text())
  } catch (error) {
    if (error instanceof ZipError) {
      return fail(`book.json couldn't be read: ${error.message}`)
    }
    return fail(`book.json isn't valid JSON (${error instanceof Error ? error.message : 'parse error'}).`)
  }

  const { book, issues } = parseBook(raw)
  if (!book) {
    return { ok: false, issues }
  }

  const assets = new Map<string, PackageFile>()
  const missing: string[] = []
  let totalBytes = 0
  for (const path of referencedImages(book)) {
    const type = imageTypeFor(path)
    if (!type) {
      issues.push({ level: 'error', message: `"${path}" isn't a supported image type (use PNG, JPEG, WebP, GIF, AVIF or SVG).` })
      continue
    }
    const file = entries.get(prefix + path)
    if (!file) {
      missing.push(path)
      continue
    }
    if (file.size > MAX_FILE_BYTES) {
      issues.push({ level: 'error', message: `"${path}" is ${Math.round(file.size / 1024 / 1024)} MB; images must be under 64 MB.` })
      continue
    }
    totalBytes += file.size
    assets.set(path, { size: file.size, read: async () => withType(await file.read(), type) })
  }

  if (missing.length > 0) {
    const shown = missing.slice(0, 5).map((path) => `"${path}"`).join(', ')
    const more = missing.length > 5 ? ` and ${missing.length - 5} more` : ''
    issues.push({ level: 'error', message: `Missing image${missing.length > 1 ? 's' : ''}: ${shown}${more}.` })
  }

  if (issues.some((issue) => issue.level === 'error')) {
    return { ok: false, issues }
  }

  return { ok: true, pkg: { book, assets, totalBytes }, issues }
}

/** Reads a single .letoplex/.zip (or older .gab) archive without loading it into memory. */
export const readArchive = async (blob: Blob): Promise<ImportResult> => {
  let index
  try {
    index = await readZipIndex(blob)
  } catch (error) {
    if (error instanceof ZipError && error.message === 'Not a zip archive.') {
      return fail("That file isn't a book package. Choose a .letoplex or .zip file that contains book.json.")
    }
    return fail(error instanceof ZipError ? error.message : "The package couldn't be opened; the archive may be damaged.")
  }

  const entries = new Map<string, PackageFile>()
  for (const entry of index) {
    const path = entry.name.endsWith('/') ? null : normalizePath(entry.name)
    if (path && !isIgnoredEntry(path)) {
      entries.set(path, { size: entry.size, read: () => readZipEntry(blob, entry) })
    }
  }
  return buildPackage(entries)
}

/**
 * Reads whatever the file picker returned: one archive, a folder selection
 * (files carry `webkitRelativePath`), or loose files that include book.json.
 */
export const readPickedFiles = async (files: File[]): Promise<ImportResult> => {
  if (files.length === 0) {
    return fail('No files were selected.')
  }

  if (files.length === 1 && files[0].name !== 'book.json') {
    return readArchive(files[0])
  }

  const entries = new Map<string, PackageFile>()
  for (const file of files) {
    // Folder picks report "my-book/chapters/x.png"; loose picks only a name.
    const path = normalizePath(file.webkitRelativePath || file.name)
    if (path && !isIgnoredEntry(path)) {
      entries.set(path, { size: file.size, read: async () => file })
    }
  }

  const result = await buildPackage(entries)
  if (!result.ok && !files.some((file) => file.webkitRelativePath)) {
    result.issues.push({
      level: 'warning',
      message: 'Your browser did not report folder paths. Importing a .letoplex or .zip package is more reliable.',
    })
  }
  return result
}

/**
 * Downloads a package from a link (e.g. one an author shared). The browser
 * keeps large downloads on disk, so this doesn't need the whole book in memory.
 */
export const readFromUrl = async (url: string): Promise<ImportResult> => {
  let response: Response
  try {
    response = await fetch(url)
  } catch {
    return fail("The book couldn't be downloaded. Check the link and your connection; the host may also block downloads from other sites.")
  }
  if (!response.ok) {
    return fail(`The book couldn't be downloaded (server responded ${response.status}).`)
  }
  return readArchive(await response.blob())
}
