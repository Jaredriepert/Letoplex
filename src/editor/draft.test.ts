import { describe, expect, it } from 'vitest'
import forestJson from '../data/forest-of-echoes/book.json'
import { parseBook } from '../book/schema'
import {
  addChapter,
  addImagePages,
  addPage,
  checkDraft,
  connectorState,
  createDraft,
  cycleConnector,
  deleteChapter,
  deletePage,
  deletePages,
  draftImagePaths,
  exportBookId,
  linkBack,
  makeChapterOpener,
  movePage,
  movePages,
  moveChapter,
  setLink,
  setPageChapter,
  setPagesChapter,
  spreadOverlappingPages,
  toBookJson,
  type Draft,
} from './draft'

const withImages = (count: number) => {
  const draft = createDraft('My Story')
  const images = Array.from({ length: count }, (_, i) => ({ path: `images/${i}.png` }))
  const { book, pageIds } = addImagePages(draft.book, images)
  return { draft: { ...draft, book }, pageIds }
}

describe('adding pages', () => {
  it('lays image pages out in a row, linked both ways, and sets the start page', () => {
    const { draft, pageIds } = withImages(3)
    const [a, b, c] = pageIds.map((id) => draft.book.pages[id])
    expect([a.position, b.position, c.position]).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }])
    expect(a.directions.right).toBe(b.id)
    expect(b.directions.left).toBe(a.id)
    expect(c.directions.right).toBeNull()
    expect(draft.book.startPageId).toBe(a.id)
    expect(draft.book.chapters[0].pageIds).toEqual(pageIds)
  })

  it('continues after a selected page, stepping around occupied cells', () => {
    const { draft, pageIds } = withImages(2)
    // Put something in the way at (2, 0).
    const blocked = addPage(draft.book, { x: 2, y: 0 })
    const { book, pageIds: added } = addImagePages(blocked.book, [{ path: 'images/x.png' }], { afterPageId: pageIds[1] })
    expect(book.pages[added[0]].position).toEqual({ x: 3, y: 0 })
    expect(book.pages[pageIds[1]].directions.right).toBe(added[0])
  })

  it('starts a new row below existing pages when nothing is selected', () => {
    const { draft } = withImages(2)
    const { book, pageIds } = addImagePages(draft.book, [{ path: 'images/y.png' }])
    expect(book.pages[pageIds[0]].position).toEqual({ x: 0, y: 1 })
  })

  it('never puts two pages in one cell', () => {
    const draft = createDraft()
    let book = draft.book
    for (let i = 0; i < 5; i++) book = addPage(book, { x: 0, y: 0 }).book
    const cells = Object.values(book.pages).map((page) => `${page.position.x},${page.position.y}`)
    expect(new Set(cells).size).toBe(5)
  })
})

describe('links', () => {
  it('cycles a connector through both, forward, back and none', () => {
    const draft = createDraft()
    let book = addPage(draft.book, { x: 0, y: 0 }).book
    book = addPage(book, { x: 1, y: 0 }).book
    const [a, b] = Object.keys(book.pages)
    const states = []
    for (let i = 0; i < 4; i++) {
      book = cycleConnector(book, a, b, 'right')
      states.push(connectorState(book, a, b, 'right'))
    }
    expect(states).toEqual(['both', 'forward', 'back', 'none'])
  })

  it('turning a connector off keeps a link that points somewhere else', () => {
    const draft = createDraft()
    let book = addPage(draft.book, { x: 0, y: 0 }).book
    book = addPage(book, { x: 1, y: 0 }).book
    book = addPage(book, { x: 5, y: 5 }).book
    const [a, b, far] = Object.keys(book.pages)
    // b links back to a, but a's right goes to a distant page: state is "back".
    book = setLink(book, b, 'left', a)
    book = setLink(book, a, 'right', far)
    expect(connectorState(book, a, b, 'right')).toBe('back')
    book = cycleConnector(book, a, b, 'right') // back → none
    expect(book.pages[b].directions.left).toBeNull()
    expect(book.pages[a].directions.right).toBe(far)
  })

  it('links back, and refuses self-links and unknown targets', () => {
    const { draft, pageIds } = withImages(1)
    let book = addPage(draft.book, { x: 0, y: 3 }).book
    const other = Object.keys(book.pages).find((id) => id !== pageIds[0])!
    book = setLink(book, pageIds[0], 'down', other)
    book = linkBack(book, pageIds[0], 'down')
    expect(book.pages[other].directions.up).toBe(pageIds[0])
    expect(setLink(book, pageIds[0], 'up', pageIds[0])).toBe(book)
    expect(setLink(book, pageIds[0], 'up', 'nope')).toBe(book)
  })
})

describe('editing', () => {
  it('deleting a page clears links to it and moves the start page', () => {
    const { draft, pageIds } = withImages(3)
    const book = deletePage(draft.book, pageIds[0])
    expect(book.pages[pageIds[0]]).toBeUndefined()
    expect(book.pages[pageIds[1]].directions.left).toBeNull()
    expect(book.startPageId).toBe(pageIds[1])
    expect(book.chapters[0].pageIds).toEqual(pageIds.slice(1))
  })

  it('moving onto another page swaps them', () => {
    const { draft, pageIds } = withImages(2)
    const book = movePage(draft.book, pageIds[0], { x: 1, y: 0 })
    expect(book.pages[pageIds[0]].position).toEqual({ x: 1, y: 0 })
    expect(book.pages[pageIds[1]].position).toEqual({ x: 0, y: 0 })
  })

  it('moves a group together, and refuses to land on other pages', () => {
    const { draft, pageIds } = withImages(4)
    const group = [pageIds[0], pageIds[1]]
    const down = movePages(draft.book, group, { x: 0, y: 1 })
    expect(group.map((id) => down.pages[id].position)).toEqual([{ x: 0, y: 1 }, { x: 1, y: 1 }])
    expect(down.pages[pageIds[2]].position).toEqual({ x: 2, y: 0 })
    // Sliding right by one overlaps itself, which is fine.
    const right = movePages(draft.book, group, { x: 1, y: 0 })
    expect(right).toBe(draft.book) // page 3 is in the way at (2, 0)
    const shuffled = movePages(down, group, { x: 1, y: 0 })
    expect(group.map((id) => shuffled.pages[id].position)).toEqual([{ x: 1, y: 1 }, { x: 2, y: 1 }])
  })

  it('sets the chapter of several pages and deletes several pages', () => {
    const { draft, pageIds } = withImages(3)
    const { book: withChapter, chapterId } = addChapter(draft.book, 'Part Two')
    const moved = setPagesChapter(withChapter, [pageIds[1], pageIds[2]], chapterId)
    expect(moved.chapters[1].pageIds).toEqual([pageIds[1], pageIds[2]])
    const deleted = deletePages(moved, [pageIds[0], pageIds[2]])
    expect(Object.keys(deleted.pages)).toEqual([pageIds[1]])
    expect(deleted.startPageId).toBe(pageIds[1])
  })

  it('manages chapters', () => {
    const { draft, pageIds } = withImages(3)
    let { book, chapterId } = addChapter(draft.book, 'The Bridge')
    book = setPageChapter(book, pageIds[2], chapterId)
    expect(book.chapters[1].pageIds).toEqual([pageIds[2]])
    expect(book.pages[pageIds[2]].chapterId).toBe(chapterId)
    book = makeChapterOpener(book, pageIds[1])
    expect(book.chapters[0].pageIds).toEqual([pageIds[1], pageIds[0]])
    book = moveChapter(book, chapterId, -1)
    expect(book.chapters.map((chapter) => chapter.id)).toEqual([chapterId, 'chapter-1'])
    book = deleteChapter(book, chapterId)
    expect(book.chapters).toHaveLength(1)
    expect(book.pages[pageIds[2]].chapterId).toBe('chapter-1')
    expect(deleteChapter(book, 'chapter-1')).toBe(book) // never delete the last chapter
  })

  it('spreads pages that share a cell, keeping the first in place', () => {
    const parsed = parseBook({
      ...forestJson,
      chapters: forestJson.chapters.map((chapter) => ({ ...chapter, pages: chapter.pages.map((page) => ({ ...page, position: { x: 0, y: 0 } })) })),
    }).book!
    const book = spreadOverlappingPages(parsed)
    const cells = Object.values(book.pages).map((page) => `${page.position.x},${page.position.y}`)
    expect(new Set(cells).size).toBe(cells.length)
    expect(book.pages.intro.position).toEqual({ x: 0, y: 0 })
  })
})

describe('export and checks', () => {
  const storedFor = (draft: Draft) => draftImagePaths(draft.book)

  it('round-trips through the real book.json parser without issues', () => {
    const { draft } = withImages(3)
    const finished: Draft = { ...draft, book: { ...draft.book, author: 'Me' } }
    expect(checkDraft(finished.book, storedFor(finished)).filter((issue) => issue.level === 'error')).toEqual([])
    const { book, issues } = parseBook(JSON.parse(JSON.stringify(toBookJson(finished))))
    expect(issues).toEqual([])
    expect(book?.id).toBe('my-story')
    expect(Object.keys(book!.pages)).toHaveLength(3)
  })

  it('round-trips the bundled sample unchanged in structure', () => {
    const parsed = parseBook(forestJson).book!
    const draft: Draft = { ...createDraft(), book: parsed, customId: true }
    const again = parseBook(JSON.parse(JSON.stringify(toBookJson(draft)))).book!
    expect(again.chapters).toEqual(parsed.chapters)
    expect(again.pages).toEqual(parsed.pages)
  })

  it('uses the title for the id unless the author set one', () => {
    const draft = createDraft('The Long Night!')
    expect(exportBookId(draft)).toBe('the-long-night')
    expect(exportBookId({ ...draft, customId: true, book: { ...draft.book, id: 'Custom ID' } })).toBe('custom-id')
  })

  it('reports blocking problems and helpful warnings', () => {
    const empty = createDraft()
    expect(checkDraft(empty.book, new Set()).map((issue) => issue.message)).toContain('Add at least one page.')

    const { draft, pageIds } = withImages(2)
    let book = addPage(draft.book, { x: 4, y: 4 }).book // no image, unreachable
    book = addChapter(book, 'Empty').book
    const issues = checkDraft(book, new Set(['images/0.png'])) // images/1.png not stored
    const lone = Object.keys(book.pages).find((id) => !pageIds.includes(id))!
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: 'error', pageId: lone }),
        expect.objectContaining({ level: 'error', pageId: pageIds[1], message: expect.stringContaining('missing') }),
        expect.objectContaining({ level: 'warning', pageId: lone, message: expect.stringContaining("can't be reached") }),
        expect.objectContaining({ level: 'warning', chapterId: 'empty' }),
      ]),
    )
  })
})
