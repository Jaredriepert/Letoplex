// Saves an imported package into storage one image at a time, so memory use
// stays flat no matter how large the book is.
import type { BookPackage } from '../book/package'
import type { Book } from '../book/schema'
import { commitBook, deleteAssets, putAsset, type StoredBook } from '../storage/db'

export type SaveProgress = { savedFiles: number; totalFiles: number; savedBytes: number; totalBytes: number }

export type SpaceCheck =
  | { status: 'ok' }
  /** The browser couldn't say how much room there is; go ahead and find out. */
  | { status: 'unknown' }
  | { status: 'short'; neededBytes: number; freeBytes: number }

/** Headroom for IndexedDB bookkeeping on top of the raw image bytes. */
const OVERHEAD_FACTOR = 1.05
const OVERHEAD_BYTES = 1024 * 1024

export const bytesNeeded = (pkg: BookPackage) => Math.ceil(pkg.totalBytes * OVERHEAD_FACTOR) + OVERHEAD_BYTES

/**
 * Compares a package's size with the space the browser says is free. While a
 * book is being replaced both copies exist for a moment, so the full size of
 * the new copy is always needed.
 */
export const checkSpace = async (pkg: BookPackage, estimate = () => navigator.storage?.estimate?.()): Promise<SpaceCheck> => {
  let result: StorageEstimate | undefined
  try {
    result = await estimate()
  } catch {
    return { status: 'unknown' }
  }
  if (result?.quota === undefined || result.usage === undefined) {
    return { status: 'unknown' }
  }
  const freeBytes = Math.max(0, result.quota - result.usage)
  const neededBytes = bytesNeeded(pkg)
  return neededBytes > freeBytes ? { status: 'short', neededBytes, freeBytes } : { status: 'ok' }
}

export class ImportCancelled extends Error {
  constructor() {
    super('Import cancelled')
  }
}

const newStorageKey = (bookId: string) => `${bookId}~${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/**
 * Copies every image into storage, then commits the book. If anything fails or
 * the import is cancelled, the partial copy is deleted and any earlier copy of
 * the book is left exactly as it was.
 */
export const savePackage = async (
  pkg: BookPackage,
  book: Book,
  { onProgress, signal }: { onProgress?: (progress: SaveProgress) => void; signal?: AbortSignal } = {},
): Promise<StoredBook> => {
  const storageKey = newStorageKey(book.id)
  const progress: SaveProgress = { savedFiles: 0, totalFiles: pkg.assets.size, savedBytes: 0, totalBytes: pkg.totalBytes }
  onProgress?.({ ...progress })

  try {
    for (const [path, file] of pkg.assets) {
      if (signal?.aborted) {
        throw new ImportCancelled()
      }
      const blob = await file.read()
      await putAsset(storageKey, path, blob)
      progress.savedFiles++
      progress.savedBytes += file.size
      onProgress?.({ ...progress })
    }
    if (signal?.aborted) {
      throw new ImportCancelled()
    }
    return await commitBook(book, storageKey, progress.savedBytes)
  } catch (error) {
    await deleteAssets(storageKey).catch(() => undefined)
    throw error
  }
}

/** Keeps the phone's screen on during a long import, where supported. */
export const holdWakeLock = async (): Promise<() => void> => {
  try {
    const lock = await navigator.wakeLock?.request('screen')
    return () => void lock?.release().catch(() => undefined)
  } catch {
    return () => undefined
  }
}
