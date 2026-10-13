import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildPackage, readArchive, readPickedFiles } from './package'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const bookJson = (pages = [{ id: 'a', image: 'pages/a.png', directions: {} }]) =>
  JSON.stringify({ format: 'graphic-adventure-book', version: 1, title: 'Zip Book', startPageId: 'a', chapters: [{ id: 'c', title: 'C', pages }] })

const zipBlob = (files: Record<string, Uint8Array>) => new Blob([zipSync(files)])

const messages = (result: Awaited<ReturnType<typeof buildPackage>>) => result.issues.map((issue) => issue.message)

describe('readArchive', () => {
  it('imports the generated Mosslight .gab fixture end to end', async () => {
    const bytes = readFileSync(join(__dirname, '../../import-test-books/mosslight-mystery.gab'))
    const result = await readArchive(new Blob([bytes]))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.pkg.book.title).toBe('Mosslight Mystery')
    expect(result.pkg.book.chapters).toHaveLength(2)
    expect(result.pkg.assets.size).toBe(4)
    const image = result.pkg.assets.get('chapters/chapter-1/page-1.png')!
    expect(image.type).toBe('image/png')
    expect(new Uint8Array(await image.slice(0, 8).arrayBuffer())).toEqual(PNG)
  })

  it('finds book.json inside a top-level folder', async () => {
    const result = await readArchive(zipBlob({ 'my-book/book.json': strToU8(bookJson()), 'my-book/pages/a.png': PNG }))
    expect(result.ok).toBe(true)
  })

  it('ignores macOS metadata entries', async () => {
    const result = await readArchive(
      zipBlob({ '__MACOSX/my-book/._book.json': strToU8('junk'), 'book.json': strToU8(bookJson()), 'pages/a.png': PNG }),
    )
    expect(result.ok).toBe(true)
  })

  it('reports missing images', async () => {
    const result = await readArchive(zipBlob({ 'book.json': strToU8(bookJson()) }))
    expect(result.ok).toBe(false)
    expect(messages(result)).toContain('Missing image: "pages/a.png".')
  })

  it('reports invalid JSON', async () => {
    const result = await readArchive(zipBlob({ 'book.json': strToU8('{ nope') }))
    expect(result.ok).toBe(false)
    expect(messages(result)[0]).toMatch(/isn't valid JSON/)
  })

  it('reports a package without book.json', async () => {
    const result = await readArchive(zipBlob({ 'readme.txt': strToU8('hi') }))
    expect(messages(result)[0]).toMatch(/No book.json/)
  })

  it('rejects files that are not zip archives', async () => {
    const result = await readArchive(new Blob(['just text']))
    expect(messages(result)[0]).toMatch(/isn't a book package/)
  })

  it('rejects unsupported image types', async () => {
    const result = await readArchive(
      zipBlob({ 'book.json': strToU8(bookJson([{ id: 'a', image: 'pages/a.bmp', directions: {} }])), 'pages/a.bmp': PNG }),
    )
    expect(messages(result)[0]).toMatch(/isn't a supported image type/)
  })
})

describe('readPickedFiles', () => {
  const file = (path: string, data: BlobPart) => {
    const result = new File([data], path.split('/').pop()!)
    Object.defineProperty(result, 'webkitRelativePath', { value: path })
    return result
  }

  it('maps folder picks by relative path, not basename', async () => {
    const result = await readPickedFiles([
      file('my-book/book.json', bookJson([
        { id: 'a', image: 'one/page.png', directions: { right: 'b' } },
        { id: 'b', image: 'two/page.png', directions: {} },
      ])),
      file('my-book/one/page.png', PNG),
      file('my-book/two/page.png', new Uint8Array([...PNG, 1])),
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.pkg.assets.get('one/page.png')!.size).toBe(8)
    expect(result.pkg.assets.get('two/page.png')!.size).toBe(9)
  })

  it('treats a single non-json file as an archive', async () => {
    const result = await readPickedFiles([new File([zipSync({ 'book.json': strToU8(bookJson()), 'pages/a.png': PNG })], 'b.gab')])
    expect(result.ok).toBe(true)
  })
})
