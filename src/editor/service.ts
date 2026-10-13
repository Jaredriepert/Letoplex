// Connects drafts to storage: saving images, copying library books into
// drafts, and turning drafts into packages for the library or a .letoplex file.
import type { BookPackage, ImportResult, PackageFile } from '../book/package'
import { BOOK_EXTENSION, parseBook, slugify } from '../book/schema'
import { createZip } from '../book/zipWriter'
import { storedSource, type LibraryEntry } from '../library/library'
import { deleteAsset, getAsset, listAssetPaths, putAsset, saveDraft } from '../storage/db'
import {
  createDraft,
  draftImagePaths,
  draftStorageKey,
  spreadOverlappingPages,
  thumbPathFor,
  toBookJson,
  type Draft,
} from './draft'
import { extensionFor, makeThumbnail, optimiseImage, titleFromFileName, type ImageInfo } from './images'

export type Progress = (done: number, total: number) => void

const shortId = () => Math.random().toString(36).slice(2, 7)

/** Stores an image (and its thumbnail) in a draft, returning its package path. */
const storeImage = async (draftId: string, blob: Blob, baseName: string) => {
  const key = draftStorageKey(draftId)
  const path = `images/${slugify(baseName).slice(0, 40)}-${shortId()}.${extensionFor(blob)}`
  await putAsset(key, path, blob)
  const thumbnail = await makeThumbnail(blob)
  if (thumbnail) {
    await putAsset(key, thumbPathFor(path), thumbnail)
  }
  return path
}

/**
 * Saves picked images into a draft, optimising the oversized ones when asked.
 * Returns the stored paths (with titles from the file names), in pick order.
 */
export const addImagesToDraft = async (
  draftId: string,
  images: ImageInfo[],
  { optimise, onProgress }: { optimise: boolean; onProgress?: Progress },
) => {
  const results: Array<{ path: string; title: string }> = []
  for (const [index, info] of images.entries()) {
    const blob = optimise && info.oversized ? await optimiseImage(info.file) : info.file
    const path = await storeImage(draftId, blob, info.file.name.replace(/\.[^.]+$/, '') || 'page')
    results.push({ path, title: titleFromFileName(info.file.name) })
    onProgress?.(index + 1, images.length)
  }
  return results
}

/** A reader entry for previewing a draft with the real reader. */
export const draftEntry = (draft: Draft): LibraryEntry => ({
  book: draft.book,
  builtin: false,
  importedAt: draft.updatedAt,
  sizeBytes: 0,
  source: storedSource(draftStorageKey(draft.id)),
})

/** Copies a library book (bundled or imported) into a new draft for editing. */
export const draftFromLibraryBook = async (entry: LibraryEntry, onProgress?: Progress) => {
  const draft: Draft = {
    ...createDraft(entry.book.title),
    book: spreadOverlappingPages(entry.book),
    customId: true,
    sourceBookId: entry.builtin ? null : entry.book.id,
  }
  if (entry.builtin) {
    // A copy of the sample is a new book, not an update to the sample.
    draft.book = { ...draft.book, id: `${entry.book.id}-copy`, title: `${entry.book.title} (my copy)` }
  }
  const key = draftStorageKey(draft.id)
  const paths = [...draftImagePaths(entry.book)]
  for (const [index, path] of paths.entries()) {
    const loaded = await entry.source.load(path)
    if (loaded) {
      try {
        const blob = await (await fetch(loaded.url)).blob()
        await putAsset(key, path, blob)
        const thumbnail = await makeThumbnail(blob)
        if (thumbnail) {
          await putAsset(key, thumbPathFor(path), thumbnail)
        }
      } finally {
        loaded.release()
      }
    }
    onProgress?.(index + 1, paths.length)
  }
  await saveDraft(draft)
  return draft
}

/** Image paths actually saved for a draft (thumbnails excluded). */
export const storedDraftImages = async (draftId: string) =>
  new Set((await listAssetPaths(draftStorageKey(draftId))).filter((path) => !path.startsWith('.thumbs/')))

/** Deletes images the draft no longer uses (e.g. after deleting pages). */
export const pruneDraftAssets = async (draft: Draft) => {
  const key = draftStorageKey(draft.id)
  const used = draftImagePaths(draft.book)
  const keep = new Set([...used, ...[...used].map(thumbPathFor)])
  for (const path of await listAssetPaths(key)) {
    if (!keep.has(path)) {
      await deleteAsset(key, path)
    }
  }
}

/**
 * Validates a draft with the real book.json parser and gathers its images.
 * Anything that passes here imports cleanly elsewhere.
 */
export const packageDraft = async (draft: Draft): Promise<ImportResult> => {
  const json = toBookJson(draft)
  const { book, issues } = parseBook(JSON.parse(JSON.stringify(json)))
  if (!book) {
    return { ok: false, issues }
  }
  const key = draftStorageKey(draft.id)
  const assets = new Map<string, PackageFile>()
  let totalBytes = 0
  for (const path of draftImagePaths(book)) {
    const blob = await getAsset(key, path)
    if (!blob) {
      return { ok: false, issues: [...issues, { level: 'error', message: `The picture "${path}" is missing. Add it again.` }] }
    }
    totalBytes += blob.size
    assets.set(path, { size: blob.size, read: async () => blob })
  }
  const pkg: BookPackage = { book, assets, totalBytes }
  return { ok: true, pkg, issues }
}

/** Builds the .letoplex file for a draft. */
export const exportDraft = async (draft: Draft, options: { onProgress?: Progress; signal?: AbortSignal } = {}) => {
  const result = await packageDraft(draft)
  if (!result.ok) {
    return result
  }
  const files = [{ path: 'book.json', data: new Blob([JSON.stringify(toBookJson(draft), null, 2)], { type: 'application/json' }) }]
  for (const [path, file] of result.pkg.assets) {
    files.push({ path, data: await file.read() })
  }
  const blob = await createZip(files, options)
  const fileName = `${slugify(draft.book.title || 'book')}${BOOK_EXTENSION}`
  return { ok: true as const, blob, fileName, issues: result.issues }
}
