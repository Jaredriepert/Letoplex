// Local persistence in IndexedDB. Book metadata, page image blobs, reading
// progress, and the share-target inbox all live on the device; nothing is
// uploaded. Blob URLs are never stored: they are created per session.
//
// This module is also imported by the service worker, so it must not touch
// `window` or the DOM.
import type { Book } from '../book/schema'
import { DRAFT_KEY_PREFIX, type Draft } from '../editor/draft'

const DB_NAME = 'graphic-adventure'
const DB_VERSION = 2

export type StoredBook = {
  book: Book
  importedAt: number
  sizeBytes: number
  /**
   * Which asset key range holds this book's images. Each import writes to a
   * fresh key so a replacement never touches the old copy until it's complete.
   * Books saved before this existed use their book id.
   */
  storageKey?: string
}

export const storageKeyOf = (stored: StoredBook) => stored.storageKey ?? stored.book.id

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
    request.onupgradeneeded = (event) => {
      const db = request.result
      if (event.oldVersion < 1) {
        db.createObjectStore('books')
        // Keyed by [storageKey, path] so one book's (or draft's) images form one key range.
        db.createObjectStore('assets')
        db.createObjectStore('progress')
        db.createObjectStore('inbox', { keyPath: 'id', autoIncrement: true })
      }
      if (event.oldVersion < 2) {
        db.createObjectStore('drafts')
      }
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

type StoreName = 'books' | 'assets' | 'progress' | 'inbox' | 'drafts'

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

/** Every asset under a storage key: [key] < [key, any string] < [key, []]. */
const assetRange = (storageKey: string) => IDBKeyRange.bound([storageKey], [storageKey, []])

export const listBooks = () =>
  withStore('books', 'readonly', (tx) => promisify(tx.objectStore('books').getAll() as IDBRequest<StoredBook[]>))

export const getAsset = (storageKey: string, path: string) =>
  withStore('assets', 'readonly', (tx) => promisify(tx.objectStore('assets').get([storageKey, path]) as IDBRequest<Blob | undefined>))

/** Stores one image. Imports call this once per image so memory stays flat. */
export const putAsset = (storageKey: string, path: string, blob: Blob) =>
  withStore('assets', 'readwrite', (tx) => {
    tx.objectStore('assets').put(blob, [storageKey, path])
  })

/** Deletes every image under a storage key (e.g. a cancelled import). */
export const deleteAssets = (storageKey: string) =>
  withStore('assets', 'readwrite', (tx) => {
    tx.objectStore('assets').delete(assetRange(storageKey))
  })

/**
 * Makes an import live once all its images are stored: points the book at
 * the new storage key and, in the same transaction, drops the old copy's
 * images. Until this runs, any earlier copy of the book is untouched.
 */
export const commitBook = (book: Book, storageKey: string, sizeBytes: number) =>
  withStore(
    ['books', 'assets'],
    'readwrite',
    (tx) =>
      new Promise<StoredBook>((resolve, reject) => {
        const books = tx.objectStore('books')
        const request = books.get(book.id) as IDBRequest<StoredBook | undefined>
        request.onsuccess = () => {
          const previous = request.result
          if (previous && storageKeyOf(previous) !== storageKey) {
            tx.objectStore('assets').delete(assetRange(storageKeyOf(previous)))
          }
          const stored: StoredBook = { book, importedAt: Date.now(), sizeBytes, storageKey }
          books.put(stored, book.id)
          resolve(stored)
        }
        request.onerror = () => reject(request.error)
      }),
  )

export const deleteBook = (bookId: string) =>
  withStore(
    ['books', 'assets', 'progress'],
    'readwrite',
    (tx) =>
      new Promise<void>((resolve, reject) => {
        const books = tx.objectStore('books')
        const request = books.get(bookId) as IDBRequest<StoredBook | undefined>
        request.onsuccess = () => {
          tx.objectStore('assets').delete(assetRange(request.result ? storageKeyOf(request.result) : bookId))
          books.delete(bookId)
          tx.objectStore('progress').delete(bookId)
          resolve()
        }
        request.onerror = () => reject(request.error)
      }),
  )

/**
 * Deletes images that no book points to: leftovers from an import that was
 * interrupted (tab closed, phone restarted) before it was committed. Only run
 * this when no import is in progress, e.g. at startup.
 */
export const removeOrphanAssets = () =>
  withStore(
    ['books', 'assets', 'drafts'],
    'readwrite',
    (tx) =>
      new Promise<number>((resolve, reject) => {
        const booksRequest = tx.objectStore('books').getAll() as IDBRequest<StoredBook[]>
        const draftsRequest = tx.objectStore('drafts').getAllKeys()
        booksRequest.onerror = () => reject(booksRequest.error)
        draftsRequest.onerror = () => reject(draftsRequest.error)
        // Requests in one transaction complete in order, so drafts are ready here.
        draftsRequest.onsuccess = () => {
          const live = new Set([
            ...booksRequest.result.map(storageKeyOf),
            ...draftsRequest.result.map((draftId) => DRAFT_KEY_PREFIX + String(draftId)),
          ])
          const assets = tx.objectStore('assets')
          let removed = 0
          const cursorRequest = assets.openKeyCursor()
          cursorRequest.onerror = () => reject(cursorRequest.error)
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result
            if (!cursor) {
              resolve(removed)
              return
            }
            const storageKey = String((cursor.key as IDBValidKey[])[0])
            if (!live.has(storageKey)) {
              assets.delete(assetRange(storageKey))
              removed++
            }
            // Jump past this key's whole range instead of visiting every image.
            cursor.continue([storageKey, []])
          }
        }
      }),
  )

/** Paths of every asset stored under a key (no image data is loaded). */
export const listAssetPaths = (storageKey: string) =>
  withStore('assets', 'readonly', async (tx) => {
    const keys = await promisify(tx.objectStore('assets').getAllKeys(assetRange(storageKey)))
    return keys.map((key) => String((key as IDBValidKey[])[1]))
  })

export const deleteAsset = (storageKey: string, path: string) =>
  withStore('assets', 'readwrite', (tx) => {
    tx.objectStore('assets').delete([storageKey, path])
  })

// ---------- Drafts ----------

export const listDrafts = () => withStore('drafts', 'readonly', (tx) => promisify(tx.objectStore('drafts').getAll() as IDBRequest<Draft[]>))

export const getDraft = (draftId: string) =>
  withStore('drafts', 'readonly', (tx) => promisify(tx.objectStore('drafts').get(draftId) as IDBRequest<Draft | undefined>))

export const saveDraft = (draft: Draft) =>
  withStore('drafts', 'readwrite', (tx) => {
    tx.objectStore('drafts').put(draft, draft.id)
  })

export const deleteDraft = (draftId: string) =>
  withStore(['drafts', 'assets'], 'readwrite', (tx) => {
    tx.objectStore('drafts').delete(draftId)
    tx.objectStore('assets').delete(assetRange(DRAFT_KEY_PREFIX + draftId))
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
