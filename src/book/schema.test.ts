import { describe, expect, it } from 'vitest'
import forestJson from '../data/forest-of-echoes/book.json'
import { chapterIndexOf, neighborPageIds, normalizePath, parseBook, referencedImages } from './schema'

const page = (id: string, directions: Record<string, string | null> = {}) => ({
  id,
  title: id.toUpperCase(),
  image: `img/${id}.png`,
  directions,
})

const v1 = (overrides: Record<string, unknown> = {}) => ({
  format: 'letoplex-book',
  version: 1,
  title: 'Test Book',
  startPageId: 'a',
  chapters: [
    { id: 'one', title: 'One', pages: [page('a', { right: 'b' }), page('b', { left: 'a', down: 'c' })] },
    { id: 'two', title: 'Two', pages: [page('c', { up: 'b' })] },
  ],
  ...overrides,
})

const errors = (raw: unknown) => parseBook(raw).issues.filter((issue) => issue.level === 'error').map((issue) => issue.message)

describe('parseBook', () => {
  it('parses a canonical v1 book with explicit chapter order', () => {
    const { book, issues } = parseBook(v1())
    expect(issues).toEqual([])
    expect(book?.id).toBe('test-book')
    expect(book?.chapters.map((chapter) => chapter.id)).toEqual(['one', 'two'])
    expect(book?.chapters[0].pageIds).toEqual(['a', 'b'])
    expect(book?.pages.c.chapterId).toBe('two')
    expect(book?.pages.a.directions).toEqual({ up: null, right: 'b', down: null, left: null })
    expect(book?.cover).toBe('img/a.png')
    expect(book?.fit).toBe('contain')
  })

  it('parses the bundled sample book without issues', () => {
    const { book, issues } = parseBook(forestJson)
    expect(issues).toEqual([])
    expect(Object.keys(book!.pages)).toHaveLength(6)
  })

  it('migrates the legacy flat pages layout, grouping by chapter label in order', () => {
    const { book, issues } = parseBook({
      title: 'Flat',
      startPageId: 'p1',
      pages: [
        { ...page('p1', { right: 'p2' }), chapter: 'Chapter 1' },
        { ...page('p2', { left: 'p1' }), chapter: 'Chapter 2' },
        { ...page('p3'), chapter: 'Chapter 1' },
      ],
    })
    expect(book?.chapters.map((chapter) => [chapter.title, chapter.pageIds])).toEqual([
      ['Chapter 1', ['p1', 'p3']],
      ['Chapter 2', ['p2']],
    ])
    expect(issues.some((issue) => issue.level === 'warning')).toBe(true)
  })

  it('reads unversioned nested chapters as v1 with a warning', () => {
    const { format: _format, version: _version, ...legacy } = v1()
    const { book, issues } = parseBook(legacy)
    expect(book).not.toBeNull()
    expect(issues).toHaveLength(1)
    expect(issues[0].level).toBe('warning')
  })

  it('rejects books from a newer schema version', () => {
    expect(errors(v1({ version: 2 }))[0]).toMatch(/newer version/)
  })

  it('rejects a missing start page', () => {
    expect(errors(v1({ startPageId: 'nope' }))).toContain('The start page "nope" doesn\'t exist.')
  })

  it('falls back to the first page when startPageId is absent', () => {
    const { book } = parseBook(v1({ startPageId: undefined }))
    expect(book?.startPageId).toBe('a')
  })

  it('rejects broken links', () => {
    const raw = v1({ chapters: [{ id: 'x', title: 'X', pages: [page('a', { left: 'ghost' })] }] })
    expect(errors(raw)).toContain('Page "a" links left to "ghost", which doesn\'t exist.')
  })

  it('rejects duplicate page ids', () => {
    const raw = v1({ chapters: [{ id: 'x', title: 'X', pages: [page('a'), page('a')] }] })
    expect(errors(raw)).toContain('Page id "a" is used more than once.')
  })

  it('rejects image paths that escape the package or point at URLs', () => {
    const raw = v1({
      chapters: [
        {
          id: 'x',
          title: 'X',
          pages: [
            { ...page('a'), image: '../secret.png' },
            { ...page('b'), image: 'https://example.com/b.png' },
            { ...page('c'), image: '' },
          ],
        },
      ],
    })
    const messages = errors(raw)
    expect(messages.some((message) => message.includes('../secret.png'))).toBe(true)
    expect(messages.some((message) => message.includes('https://example.com/b.png'))).toBe(true)
    expect(messages).toContain('Page "c" has no "image".')
  })

  it('rejects non-objects and books without chapters', () => {
    expect(errors(null)).toEqual(['book.json must contain a JSON object.'])
    expect(errors([])).toEqual(['book.json must contain a JSON object.'])
    expect(errors({ title: 'Nothing' })).toEqual(['book.json needs a "chapters" array.'])
    expect(errors(v1({ chapters: [] }))).toEqual(['The book has no pages.'])
  })

  it('still reads books made before the rename to Letoplex', () => {
    const { book, issues } = parseBook(v1({ format: 'graphic-adventure-book' }))
    expect(book).not.toBeNull()
    expect(issues).toEqual([])
  })

  it('rejects an unknown format marker', () => {
    expect(errors(v1({ format: 'something-else' }))[0]).toMatch(/Unknown book format/)
  })
})

describe('helpers', () => {
  it('normalizes package paths', () => {
    expect(normalizePath('./chapters\\one//a.png')).toBe('chapters/one/a.png')
    expect(normalizePath('/abs.png')).toBeNull()
    expect(normalizePath('a/../../b.png')).toBeNull()
    expect(normalizePath('data:image/png;base64,xx')).toBeNull()
    expect(normalizePath('  ')).toBeNull()
  })

  it('lists images, chapter indexes and neighbors', () => {
    const book = parseBook(v1({ cover: 'cover.png' })).book!
    expect(referencedImages(book)).toEqual(['cover.png', 'img/a.png', 'img/b.png', 'img/c.png'])
    expect(chapterIndexOf(book, 'c')).toBe(1)
    expect(chapterIndexOf(book, 'missing')).toBe(-1)
    expect(neighborPageIds(book, 'b')).toEqual(['c', 'a'])
  })
})
