// Local persistence in IndexedDB. Book metadata, page image blobs, reading
// progress, and the share-target inbox all live on the device; nothing is
// uploaded. Blob URLs are never stored: they are created per session.
//
// This module is also imported by the service worker, so it must not touch
// `window` or the DOM.
import type { Book } from '../book/schema'

const DB_NAME = 'graphic-adventure'
const DB_VERSION = 1

export type StoredBook = { book: Book; importedAt: number; sizeBytes: number }

export type Progress = {
  /** Highest chapter index the reader has reached. */
  unlockedChapterIndex: number
  /** Where "Continue" resumes. */
  lastPageId: string | null
  updatedAt: number
}

export type InboxItem = { id?: number; file: Blob; name: string; receivedAt: number }

let dbPromise: Promise<IDBDatabase> | null = null

const promisify = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

const openDb = () => {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      db.createObjectStore('books')
      // Keyed by [bookId, path] so a whole book's assets form one key range.
      db.createObjectStore('assets')
      db.createObjectStore('progress')
      db.createObjectStore('inbox', { keyPath: 'id', autoIncrement: true })
    }
    request.onsuccess = () => {
      const db = request.result
      // Another tab upgrading the schema: close so it isn't blocked.
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      resolve(db)
    }
    request.onerror = () => {
      dbPromise = null
      reject(request.error)
    }
  })
  return dbPromise
}

type StoreName = 'books' | 'assets' | 'progress' | 'inbox'

const withStore = async <T>(
  names: StoreName | StoreName[],
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> => {
  const db = await openDb()
  const tx = db.transaction(names, mode)
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('Storage transaction aborted'))
  })
  try {
    const result = await run(tx)
    await done
    return result
  } catch (error) {
    done.catch(() => undefined)
    try {
      tx.abort()
    } catch {
      // Already finished.
    }
    throw error
  }
}

/** Keys of every asset for a book: [bookId] < [bookId, any string] < [bookId, []]. */
const assetRange = (bookId: string) => IDBKeyRange.bound([bookId], [bookId, []])

export const listBooks = () =>
  withStore('books', 'readonly', (tx) => promisify(tx.objectStore('books').getAll() as IDBRequest<StoredBook[]>))

export const getAsset = (bookId: string, path: string) =>
  withStore('assets', 'readonly', (tx) => promisify(tx.objectStore('assets').get([bookId, path]) as IDBRequest<Blob | undefined>))

/** Saves a book and its images atomically, replacing any earlier copy. */
export const saveBook = (book: Book, assets: Map<string, Blob>) =>
  withStore(['books', 'assets'], 'readwrite', (tx) => {
    const assetStore = tx.objectStore('assets')
    assetStore.delete(assetRange(book.id))
    let sizeBytes = 0
    for (const [path, blob] of assets) {
      sizeBytes += blob.size
      assetStore.put(blob, [book.id, path])
    }
    const stored: StoredBook = { book, importedAt: Date.now(), sizeBytes }
    tx.objectStore('books').put(stored, book.id)
    return stored
  })

export const deleteBook = (bookId: string) =>
  withStore(['books', 'assets', 'progress'], 'readwrite', (tx) => {
    tx.objectStore('books').delete(bookId)
    tx.objectStore('assets').delete(assetRange(bookId))
    tx.objectStore('progress').delete(bookId)
  })

export const loadAllProgress = () =>
  withStore('progress', 'readonly', async (tx) => {
    const store = tx.objectStore('progress')
    const [keys, values] = await Promise.all([
      promisify(store.getAllKeys()),
      promisify(store.getAll() as IDBRequest<Progress[]>),
    ])
    return Object.fromEntries(keys.map((key, index) => [String(key), values[index]])) as Record<string, Progress>
  })

export const saveProgress = (bookId: string, progress: Progress) =>
  withStore('progress', 'readwrite', (tx) => {
    tx.objectStore('progress').put(progress, bookId)
  })

export const clearProgress = (bookId: string) =>
  withStore('progress', 'readwrite', (tx) => {
    tx.objectStore('progress').delete(bookId)
  })

export const addToInbox = (item: Omit<InboxItem, 'id'>) =>
  withStore('inbox', 'readwrite', (tx) => {
    tx.objectStore('inbox').add(item)
  })

/** Removes and returns everything waiting in the share-target inbox. */
export const takeInbox = () =>
  withStore(
    'inbox',
    'readwrite',
    (tx) =>
      new Promise<InboxItem[]>((resolve, reject) => {
        const store = tx.objectStore('inbox')
        const request = store.getAll() as IDBRequest<InboxItem[]>
        request.onsuccess = () => {
          // Clear inside the callback so the transaction can't auto-commit first.
          store.clear()
          resolve(request.result)
        }
        request.onerror = () => reject(request.error)
      }),
  )
