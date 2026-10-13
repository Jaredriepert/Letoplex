import { crc32 as nodeCrc32 } from 'node:zlib'
import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { readArchive } from './package'
import { readZipEntry, readZipIndex } from './zip'
import { crc32Blob, createZip } from './zipWriter'

const files = [
  { path: 'book.json', data: new Blob(['{"hello":"world"}']) },
  { path: 'images/café.png', data: new Blob([new Uint8Array(70_000).map((_, i) => i % 251)]) },
  { path: 'empty.txt', data: new Blob([]) },
]

describe('createZip', () => {
  it('computes the same CRC-32 as zlib', async () => {
    const bytes = new Uint8Array(200_000).map((_, i) => (i * 7) % 256)
    expect(await crc32Blob(new Blob([bytes]))).toBe(nodeCrc32(bytes))
  })

  it('writes archives that standard tools read, with correct CRCs', async () => {
    const zip = await createZip(files)
    const unzipped = unzipSync(new Uint8Array(await zip.arrayBuffer()))
    expect(Object.keys(unzipped).sort()).toEqual(['book.json', 'empty.txt', 'images/café.png'])
    expect(strFromU8(unzipped['book.json'])).toBe('{"hello":"world"}')
    expect(unzipped['images/café.png'].length).toBe(70_000)
    for (const entry of await readZipIndex(zip)) {
      const data = await readZipEntry(zip, entry)
      const header = new DataView(await zip.slice(entry.localHeaderOffset, entry.localHeaderOffset + 30).arrayBuffer())
      expect(header.getUint32(14, true)).toBe(nodeCrc32(new Uint8Array(await data.arrayBuffer())))
    }
  })

  it('writes readable zip64 archives', async () => {
    const zip = await createZip(files, { forceZip64: true })
    const index = await readZipIndex(zip)
    expect(index.map((entry) => [entry.name, entry.size])).toEqual([
      ['book.json', 17],
      ['images/café.png', 70_000],
      ['empty.txt', 0],
    ])
    expect(await (await readZipEntry(zip, index[0])).text()).toBe('{"hello":"world"}')
  })

  it('round-trips a book package through the importer', async () => {
    const book = {
      format: 'letoplex-book',
      version: 1,
      title: 'Round Trip',
      startPageId: 'a',
      chapters: [{ id: 'c', title: 'C', pages: [{ id: 'a', image: 'images/a.png', directions: {} }] }],
    }
    const zip = await createZip([
      { path: 'book.json', data: new Blob([JSON.stringify(book)]) },
      { path: 'images/a.png', data: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]) },
    ])
    const result = await readArchive(zip)
    expect(result.ok).toBe(true)
  })

  it('reports progress and can be cancelled', async () => {
    const seen: number[] = []
    await createZip(files, { onProgress: (done) => seen.push(done) })
    expect(seen).toEqual([1, 2, 3])
    const controller = new AbortController()
    controller.abort()
    await expect(createZip(files, { signal: controller.signal })).rejects.toThrow('Export cancelled')
  })
})
