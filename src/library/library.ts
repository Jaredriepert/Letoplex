// The reader's view of the library: the bundled sample plus books imported
// into IndexedDB, each with a way to turn image paths into displayable URLs.
import forestJson from '../data/forest-of-echoes/book.json'
import { parseBook, type Book } from '../book/schema'
import { getAsset, listBooks, type StoredBook } from '../storage/db'

export type LoadedAsset = { url: string; release: () => void }

export type AssetSource = {
  /** Resolves an image path to a URL; call `release` when it's no longer shown. */
  load: (path: string) => Promise<LoadedAsset | null>
}

export type LibraryEntry = {
  book: Book
  builtin: boolean
  importedAt: number
  sizeBytes: number
  source: AssetSource
}

const forestUrls = import.meta.glob<string>('../data/forest-of-echoes/**/*.{png,jpg,jpeg,webp,gif,avif,svg}', {
  eager: true,
  query: '?url',
  import: 'default',
})

const bundledSource = (base: string, urls: Record<string, string>): AssetSource => ({
  load: async (path) => {
    const url = urls[base + path]
    return url ? { url, release: () => undefined } : null
  },
})

const storedSource = (bookId: string): AssetSource => ({
  load: async (path) => {
    const blob = await getAsset(bookId, path)
    if (!blob) {
      return null
    }
    const url = URL.createObjectURL(blob)
    return { url, release: () => URL.revokeObjectURL(url) }
  },
})

const buildBuiltinEntries = (): LibraryEntry[] => {
  const { book, issues } = parseBook(forestJson)
  if (!book) {
    throw new Error(`The bundled sample book is invalid: ${issues.map((issue) => issue.message).join(' ')}`)
  }
  return [{ book, builtin: true, importedAt: 0, sizeBytes: 0, source: bundledSource('../data/forest-of-echoes/', forestUrls) }]
}

export const builtinEntries = buildBuiltinEntries()

export const entryFromStored = (stored: StoredBook): LibraryEntry => ({
  ...stored,
  builtin: false,
  source: storedSource(stored.book.id),
})

/** Newest imports first, bundled books last. */
export const sortEntries = (entries: LibraryEntry[]) =>
  [...entries].sort((a, b) => Number(a.builtin) - Number(b.builtin) || b.importedAt - a.importedAt)

export const loadLibrary = async (): Promise<LibraryEntry[]> => {
  const stored = await listBooks()
  return sortEntries([...stored.map(entryFromStored), ...builtinEntries])
}

/** Picks an id not already in the library: `id`, `id-2`, `id-3`… */
export const uniqueBookId = (id: string, taken: Set<string>) => {
  let candidate = id
  for (let n = 2; taken.has(candidate); n++) {
    candidate = `${id}-${n}`
  }
  return candidate
}

export const formatBytes = (bytes: number) => {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}
