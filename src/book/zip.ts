// Random-access zip reading. Instead of loading a whole archive into memory,
// we read its central directory (the index at the end of the file) and then
// pull out one entry at a time with Blob.slice. Stored (uncompressed) entries,
// which is how images are usually packed, are never copied into memory at all.
import { Inflate } from 'fflate'

export type ZipEntry = {
  name: string
  /** Uncompressed size in bytes, as declared by the archive. */
  size: number
  compressedSize: number
  method: number
  localHeaderOffset: number
  encrypted: boolean
}

export class ZipError extends Error {}

const EOCD_SIGNATURE = 0x06054b50
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const ZIP64_EOCD_SIGNATURE = 0x06064b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const STORED = 0
const DEFLATED = 8

const view = async (blob: Blob, start: number, end: number) => new DataView(await blob.slice(start, end).arrayBuffer())

const u64 = (data: DataView, offset: number) => {
  const value = data.getBigUint64(offset, true)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ZipError('The archive is too large to read.')
  }
  return Number(value)
}

/** Reads the archive's index. Throws ZipError for anything that isn't a readable zip. */
export const readZipIndex = async (blob: Blob): Promise<ZipEntry[]> => {
  // The end-of-central-directory record is in the last 22 bytes plus an
  // optional comment of up to 64 KB.
  const tailStart = Math.max(0, blob.size - (22 + 0xffff))
  const tail = await view(blob, tailStart, blob.size)
  let eocd = -1
  for (let offset = tail.byteLength - 22; offset >= 0; offset--) {
    if (tail.getUint32(offset, true) === EOCD_SIGNATURE) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) {
    throw new ZipError('Not a zip archive.')
  }

  let entryCount = tail.getUint16(eocd + 10, true)
  let directorySize = tail.getUint32(eocd + 12, true)
  let directoryOffset = tail.getUint32(eocd + 16, true)

  // Zip64: archives over 4 GB or with more than 65,535 entries.
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    const locator = eocd - 20
    if (locator < 0 || tail.getUint32(locator, true) !== ZIP64_LOCATOR_SIGNATURE) {
      throw new ZipError('The archive index is damaged.')
    }
    const zip64Offset = u64(tail, locator + 8)
    const zip64 = await view(blob, zip64Offset, zip64Offset + 56)
    if (zip64.getUint32(0, true) !== ZIP64_EOCD_SIGNATURE) {
      throw new ZipError('The archive index is damaged.')
    }
    entryCount = u64(zip64, 32)
    directorySize = u64(zip64, 40)
    directoryOffset = u64(zip64, 48)
  }

  if (directoryOffset + directorySize > blob.size) {
    throw new ZipError('The archive is incomplete; it may not have finished downloading.')
  }

  const directory = await view(blob, directoryOffset, directoryOffset + directorySize)
  const decoder = new TextDecoder()
  const entries: ZipEntry[] = []
  let offset = 0
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > directory.byteLength || directory.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw new ZipError('The archive index is damaged.')
    }
    const flags = directory.getUint16(offset + 8, true)
    const method = directory.getUint16(offset + 10, true)
    let compressedSize = directory.getUint32(offset + 20, true)
    let size = directory.getUint32(offset + 24, true)
    const nameLength = directory.getUint16(offset + 28, true)
    const extraLength = directory.getUint16(offset + 30, true)
    const commentLength = directory.getUint16(offset + 32, true)
    let localHeaderOffset = directory.getUint32(offset + 42, true)
    const name = decoder.decode(new Uint8Array(directory.buffer, directory.byteOffset + offset + 46, nameLength))

    // Zip64 extra field: 64-bit values appear only for fields that overflowed.
    let extra = offset + 46 + nameLength
    const extraEnd = extra + extraLength
    while (extra + 4 <= extraEnd) {
      const id = directory.getUint16(extra, true)
      const length = directory.getUint16(extra + 2, true)
      if (id === 0x0001) {
        let field = extra + 4
        if (size === 0xffffffff) {
          size = u64(directory, field)
          field += 8
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = u64(directory, field)
          field += 8
        }
        if (localHeaderOffset === 0xffffffff) {
          localHeaderOffset = u64(directory, field)
        }
      }
      extra += 4 + length
    }

    entries.push({ name, size, compressedSize, method, localHeaderOffset, encrypted: (flags & 1) === 1 })
    offset = extraEnd + commentLength
  }
  return entries
}

const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const nativeInflate = async (compressed: Blob, expectedSize: number): Promise<Blob | null> => {
  let stream: DecompressionStream
  try {
    stream = new DecompressionStream('deflate-raw')
  } catch {
    return null // Older browsers without deflate-raw support.
  }
  const reader = compressed.stream().pipeThrough(stream).getReader()
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    total += value.byteLength
    if (total > expectedSize) {
      await reader.cancel()
      throw new ZipError('An archive entry is larger than its declared size.')
    }
    chunks.push(value)
  }
  return new Blob(chunks)
}

const fallbackInflate = async (compressed: Blob, expectedSize: number): Promise<Blob> => {
  const chunks: Uint8Array[] = []
  let total = 0
  const inflater = new Inflate((chunk) => {
    total += chunk.byteLength
    if (total > expectedSize) {
      throw new ZipError('An archive entry is larger than its declared size.')
    }
    chunks.push(chunk)
  })
  const step = 1024 * 1024
  for (let start = 0; start < compressed.size; start += step) {
    const end = Math.min(compressed.size, start + step)
    inflater.push(new Uint8Array(await compressed.slice(start, end).arrayBuffer()), end === compressed.size)
    await yieldToBrowser() // Keep the page responsive between chunks.
  }
  return new Blob(chunks as Uint8Array<ArrayBuffer>[])
}

/** Inflates raw deflate data, refusing output larger than `expectedSize`. */
export const inflateBlob = async (compressed: Blob, expectedSize: number, options: { forceFallback?: boolean } = {}) => {
  const native = options.forceFallback ? null : await nativeInflate(compressed, expectedSize)
  return native ?? fallbackInflate(compressed, expectedSize)
}

/** Extracts one entry. Stored entries are a zero-copy slice of the archive. */
export const readZipEntry = async (blob: Blob, entry: ZipEntry, type = ''): Promise<Blob> => {
  if (entry.encrypted) {
    throw new ZipError(`"${entry.name}" is password-protected.`)
  }
  const header = await view(blob, entry.localHeaderOffset, entry.localHeaderOffset + 30)
  if (header.getUint32(0, true) !== LOCAL_SIGNATURE) {
    throw new ZipError('The archive is damaged.')
  }
  const dataStart = entry.localHeaderOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true)
  const data = blob.slice(dataStart, dataStart + entry.compressedSize)
  if (data.size !== entry.compressedSize) {
    throw new ZipError('The archive is incomplete; it may not have finished downloading.')
  }

  if (entry.method === STORED) {
    return data.slice(0, data.size, type)
  }
  if (entry.method === DEFLATED) {
    const inflated = await inflateBlob(data, entry.size)
    if (inflated.size !== entry.size) {
      throw new ZipError(`"${entry.name}" is damaged.`)
    }
    return inflated.slice(0, inflated.size, type)
  }
  throw new ZipError(`"${entry.name}" uses a compression method this app can't read. Re-create the package with standard zip settings.`)
}
