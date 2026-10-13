// Reads a book package (a .gab/.zip archive or a picked folder) into a
// validated Book plus its image blobs. Browser file access stays in here so
// screens only deal with the result.
import { unzip, type Unzipped } from 'fflate'
import { normalizePath, parseBook, referencedImages, type Book, type Issue } from './schema'

export type BookPackage = { book: Book; assets: Map<string, Blob> }

export type ImportResult =
  | { ok: true; pkg: BookPackage; issues: Issue[] }
  | { ok: false; issues: Issue[] }

/** Limits protect phones from huge or malicious archives. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024
export const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024

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

/**
 * Builds a package from a path → blob map. The shallowest `book.json` marks
 * the package root, so archives with or without a top-level folder both work.
 */
export const buildPackage = async (entries: Map<string, Blob>): Promise<ImportResult> => {
  const bookJsonPaths = Array.from(entries.keys())
    .filter((path) => path === 'book.json' || path.endsWith('/book.json'))
    .sort((a, b) => a.split('/').length - b.split('/').length)

  if (bookJsonPaths.length === 0) {
    return fail('No book.json was found. A book package needs a book.json file at its top level.')
  }

  const bookJsonPath = bookJsonPaths[0]
  const prefix = bookJsonPath.slice(0, -'book.json'.length)

  let raw: unknown
  try {
    raw = JSON.parse(await entries.get(bookJsonPath)!.text())
  } catch (error) {
    return fail(`book.json isn't valid JSON (${error instanceof Error ? error.message : 'parse error'}).`)
  }

  const { book, issues } = parseBook(raw)
  if (!book) {
    return { ok: false, issues }
  }

  const assets = new Map<string, Blob>()
  const missing: string[] = []
  for (const path of referencedImages(book)) {
    const type = imageTypeFor(path)
    if (!type) {
      issues.push({ level: 'error', message: `"${path}" isn't a supported image type (use PNG, JPEG, WebP, GIF, AVIF or SVG).` })
      continue
    }
    const blob = entries.get(prefix + path)
    if (!blob) {
      missing.push(path)
      continue
    }
    // Re-type the blob so SVG and friends render correctly from object URLs.
    assets.set(path, blob.type === type ? blob : new Blob([blob], { type }))
  }

  if (missing.length > 0) {
    const shown = missing.slice(0, 5).map((path) => `"${path}"`).join(', ')
    const more = missing.length > 5 ? ` and ${missing.length - 5} more` : ''
    issues.push({ level: 'error', message: `Missing image${missing.length > 1 ? 's' : ''}: ${shown}${more}.` })
  }

  if (issues.some((issue) => issue.level === 'error')) {
    return { ok: false, issues }
  }

  return { ok: true, pkg: { book, assets }, issues }
}

const unzipAsync = (data: Uint8Array) =>
  new Promise<Unzipped>((resolve, reject) => {
    let total = 0
    let tooLarge = ''
    unzip(
      data,
      {
        filter: (file) => {
          if (file.name.endsWith('/') || isIgnoredEntry(file.name)) {
            return false
          }
          total += file.originalSize
          if (file.originalSize > MAX_FILE_BYTES || total > MAX_PACKAGE_BYTES) {
            tooLarge ||= file.name
            return false
          }
          return true
        },
      },
      (error, files) => {
        if (tooLarge) {
          reject(new Error(`The package is too large to import ("${tooLarge}" exceeds the size limit).`))
        } else if (error) {
          reject(error)
        } else {
          resolve(files)
        }
      },
    )
  })

const isZip = async (blob: Blob) => {
  const header = new Uint8Array(await blob.slice(0, 4).arrayBuffer())
  return header[0] === 0x50 && header[1] === 0x4b && header[2] === 0x03 && header[3] === 0x04
}

/** Reads a single .gab/.zip archive. */
export const readArchive = async (blob: Blob): Promise<ImportResult> => {
  if (blob.size > MAX_PACKAGE_BYTES) {
    return fail('The package is too large to import.')
  }
  if (!(await isZip(blob))) {
    return fail("That file isn't a book package. Choose a .gab or .zip file that contains book.json.")
  }

  let files: Unzipped
  try {
    files = await unzipAsync(new Uint8Array(await blob.arrayBuffer()))
  } catch (error) {
    return fail(error instanceof Error && error.message.includes('too large') ? error.message : "The package couldn't be opened; the archive may be damaged.")
  }

  const entries = new Map<string, Blob>()
  for (const [name, bytes] of Object.entries(files)) {
    const path = normalizePath(name)
    if (path) {
      entries.set(path, new Blob([bytes as Uint8Array<ArrayBuffer>], { type: imageTypeFor(path) ?? '' }))
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

  const entries = new Map<string, Blob>()
  let total = 0
  for (const file of files) {
    // Folder picks report "my-book/chapters/x.png"; loose picks only a name.
    const path = normalizePath(file.webkitRelativePath || file.name)
    if (!path || isIgnoredEntry(path)) {
      continue
    }
    total += file.size
    if (total > MAX_PACKAGE_BYTES) {
      return fail('The folder is too large to import.')
    }
    entries.set(path, file)
  }

  const result = await buildPackage(entries)
  if (!result.ok && !files.some((file) => file.webkitRelativePath)) {
    result.issues.push({
      level: 'warning',
      message: 'Your browser did not report folder paths. Importing a .gab or .zip package is more reliable.',
    })
  }
  return result
}

/** Downloads a package from a link (e.g. one an author shared). */
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
  const declaredSize = Number(response.headers.get('content-length') ?? 0)
  if (declaredSize > MAX_PACKAGE_BYTES) {
    return fail('The package is too large to import.')
  }
  return readArchive(await response.blob())
}
