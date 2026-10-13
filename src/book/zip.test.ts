import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { inflateBlob, readZipEntry, readZipIndex, ZipError } from './zip'

const text = async (blob: Blob) => new TextDecoder().decode(await blob.arrayBuffer())

/** Hand-built zip64 archive of stored entries (fflate doesn't write zip64). */
const zip64Archive = (files: Record<string, string>) => {
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = encoder.encode(name)
    const data = encoder.encode(content)
    const local = new DataView(new ArrayBuffer(30 + nameBytes.length + 20))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 45, true)
    local.setUint32(18, 0xffffffff, true)
    local.setUint32(22, 0xffffffff, true)
    local.setUint16(26, nameBytes.length, true)
    local.setUint16(28, 20, true)
    new Uint8Array(local.buffer).set(nameBytes, 30)
    local.setUint16(30 + nameBytes.length, 0x0001, true)
    local.setUint16(32 + nameBytes.length, 16, true)
    local.setBigUint64(34 + nameBytes.length, BigInt(data.length), true)
    local.setBigUint64(42 + nameBytes.length, BigInt(data.length), true)

    const entry = new DataView(new ArrayBuffer(46 + nameBytes.length + 28))
    entry.setUint32(0, 0x02014b50, true)
    entry.setUint16(4, 45, true)
    entry.setUint16(6, 45, true)
    entry.setUint32(20, 0xffffffff, true)
    entry.setUint32(24, 0xffffffff, true)
    entry.setUint16(28, nameBytes.length, true)
    entry.setUint16(30, 28, true)
    entry.setUint32(42, 0xffffffff, true)
    new Uint8Array(entry.buffer).set(nameBytes, 46)
    const extra = 46 + nameBytes.length
    entry.setUint16(extra, 0x0001, true)
    entry.setUint16(extra + 2, 24, true)
    entry.setBigUint64(extra + 4, BigInt(data.length), true)
    entry.setBigUint64(extra + 12, BigInt(data.length), true)
    entry.setBigUint64(extra + 20, BigInt(offset), true)

    parts.push(new Uint8Array(local.buffer), data)
    central.push(new Uint8Array(entry.buffer))
    offset += local.byteLength + data.length
  }

  const directorySize = central.reduce((sum, part) => sum + part.length, 0)
  const zip64Eocd = new DataView(new ArrayBuffer(56))
  zip64Eocd.setUint32(0, 0x06064b50, true)
  zip64Eocd.setBigUint64(4, 44n, true)
  zip64Eocd.setBigUint64(24, BigInt(central.length), true)
  zip64Eocd.setBigUint64(32, BigInt(central.length), true)
  zip64Eocd.setBigUint64(40, BigInt(directorySize), true)
  zip64Eocd.setBigUint64(48, BigInt(offset), true)

  const locator = new DataView(new ArrayBuffer(20))
  locator.setUint32(0, 0x07064b50, true)
  locator.setBigUint64(8, BigInt(offset + directorySize), true)
  locator.setUint32(16, 1, true)

  const eocd = new DataView(new ArrayBuffer(22))
  eocd.setUint32(0, 0x06054b50, true)
  eocd.setUint16(8, 0xffff, true)
  eocd.setUint16(10, 0xffff, true)
  eocd.setUint32(12, 0xffffffff, true)
  eocd.setUint32(16, 0xffffffff, true)

  return new Blob([...parts, ...central, zip64Eocd.buffer, locator.buffer, eocd.buffer] as BlobPart[])
}

describe('readZipIndex / readZipEntry', () => {
  it('reads stored and deflated entries', async () => {
    const repeated = 'page '.repeat(5000)
    const archive = new Blob([
      zipSync({ 'stored.txt': [strToU8('plain'), { level: 0 }], 'deflated.txt': [strToU8(repeated), { level: 9 }] }),
    ])
    const entries = await readZipIndex(archive)
    const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry]))
    expect(byName['stored.txt'].method).toBe(0)
    expect(byName['deflated.txt'].method).toBe(8)
    expect(byName['deflated.txt'].compressedSize).toBeLessThan(byName['deflated.txt'].size)
    expect(await text(await readZipEntry(archive, byName['stored.txt']))).toBe('plain')
    expect(await text(await readZipEntry(archive, byName['deflated.txt'], 'text/plain'))).toBe(repeated)
  })

  it('reads zip64 archives', async () => {
    const archive = zip64Archive({ 'book.json': '{"a":1}', 'img/one.png': 'PNGDATA' })
    const entries = await readZipIndex(archive)
    expect(entries.map((entry) => [entry.name, entry.size])).toEqual([
      ['book.json', 7],
      ['img/one.png', 7],
    ])
    expect(await text(await readZipEntry(archive, entries[1]))).toBe('PNGDATA')
  })

  it('rejects non-zip data and truncated archives', async () => {
    await expect(readZipIndex(new Blob(['hello']))).rejects.toThrow('Not a zip archive.')
    const archive = zipSync({ 'a.txt': strToU8('x'.repeat(100)) }, { level: 0 })
    // Lose the start of the file: the index now points past what's there.
    const truncated = new Blob([archive.slice(60)])
    await expect(readZipIndex(truncated)).rejects.toBeInstanceOf(ZipError)
  })

  it('refuses entries that inflate beyond their declared size', async () => {
    const archive = new Blob([zipSync({ 'bomb.txt': strToU8('a'.repeat(100_000)) }, { level: 9 })])
    const [entry] = await readZipIndex(archive)
    await expect(readZipEntry(archive, { ...entry, size: 10 })).rejects.toThrow(/larger than its declared size/)
  })

  it('rejects encrypted and unknown-method entries', async () => {
    const archive = new Blob([zipSync({ 'a.txt': strToU8('x') }, { level: 0 })])
    const [entry] = await readZipIndex(archive)
    await expect(readZipEntry(archive, { ...entry, encrypted: true })).rejects.toThrow(/password-protected/)
    await expect(readZipEntry(archive, { ...entry, method: 14 })).rejects.toThrow(/compression method/)
  })

  it('inflates with the fallback decoder too', async () => {
    const archive = new Blob([zipSync({ 'a.txt': strToU8('fallback '.repeat(300_000)) }, { level: 6 })])
    const [entry] = await readZipIndex(archive)
    const header = new DataView(await archive.slice(entry.localHeaderOffset, entry.localHeaderOffset + 30).arrayBuffer())
    const start = entry.localHeaderOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true)
    const raw = archive.slice(start, start + entry.compressedSize)
    const inflated = await inflateBlob(raw, entry.size, { forceFallback: true })
    expect(inflated.size).toBe(entry.size)
    await expect(inflateBlob(raw, 100, { forceFallback: true })).rejects.toThrow(/larger than its declared size/)
  })
})
