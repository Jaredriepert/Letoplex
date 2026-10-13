import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { BookPackage, PackageFile } from '../book/package'
import { parseBook, type Book } from '../book/schema'
import { createDraft, draftStorageKey } from '../editor/draft'
import { deleteBook, deleteDraft, getAsset, listBooks, putAsset, removeOrphanAssets, saveDraft, storageKeyOf } from '../storage/db'
import { checkSpace, ImportCancelled, savePackage } from './importer'

const makeBook = (id: string, images: string[]): Book =>
  parseBook({
    format: 'graphic-adventure-book',
    version: 1,
    id,
    title: id,
    startPageId: 'p0',
    chapters: [{ id: 'c', title: 'C', pages: images.map((image, index) => ({ id: `p${index}`, image })) }],
  }).book!

const makePackage = (book: Book, content: string, failOn?: string): BookPackage => {
  const assets = new Map<string, PackageFile>()
  let totalBytes = 0
  for (const page of Object.values(book.pages)) {
    const blob = new Blob([`${content}:${page.image}`], { type: 'image/png' })
    totalBytes += blob.size
    assets.set(page.image, {
      size: blob.size,
      read: async () => {
        if (page.image === failOn) throw new Error('disk read failed')
        return blob
      },
    })
  }
  return { book, assets, totalBytes }
}

const stored = async (id: string) => (await listBooks()).find((item) => item.book.id === id)
const assetText = async (key: string, path: string) => (await getAsset(key, path))?.text()

beforeEach(async () => {
  for (const item of await listBooks()) await deleteBook(item.book.id)
})

describe('savePackage', () => {
  it('saves every image and reports progress per file', async () => {
    const book = makeBook('alpha', ['a.png', 'b.png', 'c.png'])
    const seen: number[] = []
    const result = await savePackage(makePackage(book, 'v1'), book, { onProgress: (p) => seen.push(p.savedFiles) })
    expect(seen).toEqual([0, 1, 2, 3])
    expect(await assetText(storageKeyOf(result), 'b.png')).toBe('v1:b.png')
    expect((await stored('alpha'))?.sizeBytes).toBe(result.sizeBytes)
  })

  it('leaves the existing copy untouched when a replacement fails part-way', async () => {
    const book = makeBook('beta', ['a.png', 'b.png'])
    const first = await savePackage(makePackage(book, 'old'), book)
    await expect(savePackage(makePackage(book, 'new', 'b.png'), book)).rejects.toThrow('disk read failed')

    const current = await stored('beta')
    expect(storageKeyOf(current!)).toBe(storageKeyOf(first))
    expect(await assetText(storageKeyOf(first), 'a.png')).toBe('old:a.png')
    // The half-written replacement was cleaned up.
    expect(await removeOrphanAssets()).toBe(0)
  })

  it('swaps to the new copy and frees the old images on success', async () => {
    const book = makeBook('gamma', ['a.png'])
    const first = await savePackage(makePackage(book, 'old'), book)
    const second = await savePackage(makePackage(book, 'new'), book)
    expect(storageKeyOf(second)).not.toBe(storageKeyOf(first))
    expect(await assetText(storageKeyOf(second), 'a.png')).toBe('new:a.png')
    expect(await getAsset(storageKeyOf(first), 'a.png')).toBeUndefined()
  })

  it('cancels cleanly', async () => {
    const book = makeBook('delta', ['a.png', 'b.png'])
    const controller = new AbortController()
    const pending = savePackage(makePackage(book, 'x'), book, {
      signal: controller.signal,
      onProgress: (p) => p.savedFiles === 1 && controller.abort(),
    })
    await expect(pending).rejects.toBeInstanceOf(ImportCancelled)
    expect(await stored('delta')).toBeUndefined()
    expect(await removeOrphanAssets()).toBe(0)
  })
})

describe('removeOrphanAssets', () => {
  it('removes images no book points to and keeps live ones', async () => {
    const book = makeBook('live', ['a.png'])
    const saved = await savePackage(makePackage(book, 'x'), book)
    await putAsset('crashed~1', 'a.png', new Blob(['orphan']))
    await putAsset('crashed~1', 'b.png', new Blob(['orphan']))
    await putAsset('crashed~2', 'a.png', new Blob(['orphan']))

    expect(await removeOrphanAssets()).toBe(2)
    expect(await getAsset('crashed~1', 'b.png')).toBeUndefined()
    expect(await assetText(storageKeyOf(saved), 'a.png')).toBe('x:a.png')
  })

  it('keeps images that belong to an editor draft', async () => {
    const draft = createDraft('Draft book')
    await saveDraft(draft)
    await putAsset(draftStorageKey(draft.id), 'images/a.png', new Blob(['draft image']))
    await putAsset('draft~deleted-draft', 'images/a.png', new Blob(['orphan']))
    expect(await removeOrphanAssets()).toBe(1)
    expect(await assetText(draftStorageKey(draft.id), 'images/a.png')).toBe('draft image')
    await deleteDraft(draft.id)
    expect(await getAsset(draftStorageKey(draft.id), 'images/a.png')).toBeUndefined()
  })

  it('deleting a book removes its images', async () => {
    const book = makeBook('gone', ['a.png'])
    const saved = await savePackage(makePackage(book, 'x'), book)
    await deleteBook('gone')
    expect(await getAsset(storageKeyOf(saved), 'a.png')).toBeUndefined()
  })
})

describe('checkSpace', () => {
  const pkg = { totalBytes: 100 * 1024 * 1024 } as BookPackage

  it('flags packages larger than the free space', async () => {
    const result = await checkSpace(pkg, async () => ({ quota: 80 * 1024 * 1024, usage: 10 * 1024 * 1024 }))
    expect(result.status).toBe('short')
    if (result.status === 'short') expect(result.freeBytes).toBe(70 * 1024 * 1024)
  })

  it('passes when there is room, and is unknown when the browser cannot say', async () => {
    expect((await checkSpace(pkg, async () => ({ quota: 10 * 1024 ** 3, usage: 0 }))).status).toBe('ok')
    expect((await checkSpace(pkg, async () => ({}))).status).toBe('unknown')
    expect((await checkSpace(pkg, async () => Promise.reject(new Error('nope')))).status).toBe('unknown')
  })
})
