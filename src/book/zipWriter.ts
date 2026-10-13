// Writes a standard zip archive as a Blob made of references to the input
// blobs, so images already in storage are never copied into memory. Entries
// are stored uncompressed (images are already compressed). Each entry's CRC
// is computed by streaming it once. Zip64 is used automatically when sizes
// or offsets exceed the classic 4 GB / 65,535-entry limits.

export type ZipInput = { path: string; data: Blob }

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

const crcUpdate = (crc: number, bytes: Uint8Array) => {
  let c = crc
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return c
}

/** CRC-32 of a blob, read in chunks. */
export const crc32Blob = async (blob: Blob) => {
  let crc = 0xffffffff
  const reader = blob.stream().getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    crc = crcUpdate(crc, value)
  }
  return (crc ^ 0xffffffff) >>> 0
}

const MAX32 = 0xffffffff
const MAX16 = 0xffff

const dosDateTime = (date: Date) => ({
  time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  date: ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
})

const setU64 = (view: DataView, offset: number, value: number) => view.setBigUint64(offset, BigInt(value), true)

export const createZip = async (
  files: ZipInput[],
  options: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal; forceZip64?: boolean; date?: Date } = {},
): Promise<Blob> => {
  const encoder = new TextEncoder()
  const { time, date } = dosDateTime(options.date ?? new Date())
  const parts: BlobPart[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const [index, file] of files.entries()) {
    if (options.signal?.aborted) {
      throw new DOMException('Export cancelled', 'AbortError')
    }
    const name = encoder.encode(file.path)
    const size = file.data.size
    const crc = await crc32Blob(file.data)
    const bigSize = options.forceZip64 || size >= MAX32
    const bigOffset = options.forceZip64 || offset >= MAX32
    const version = bigSize || bigOffset ? 45 : 20

    const localExtra = bigSize ? 20 : 0
    const local = new DataView(new ArrayBuffer(30 + name.length + localExtra))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, version, true)
    local.setUint16(6, 0x0800, true) // UTF-8 names
    local.setUint16(8, 0, true) // stored
    local.setUint16(10, time, true)
    local.setUint16(12, date, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, bigSize ? MAX32 : size, true)
    local.setUint32(22, bigSize ? MAX32 : size, true)
    local.setUint16(26, name.length, true)
    local.setUint16(28, localExtra, true)
    new Uint8Array(local.buffer).set(name, 30)
    if (bigSize) {
      local.setUint16(30 + name.length, 0x0001, true)
      local.setUint16(32 + name.length, 16, true)
      setU64(local, 34 + name.length, size)
      setU64(local, 42 + name.length, size)
    }

    const centralExtra = (bigSize ? 16 : 0) + (bigOffset ? 8 : 0)
    const entry = new DataView(new ArrayBuffer(46 + name.length + (centralExtra ? 4 + centralExtra : 0)))
    entry.setUint32(0, 0x02014b50, true)
    entry.setUint16(4, 45, true)
    entry.setUint16(6, version, true)
    entry.setUint16(8, 0x0800, true)
    entry.setUint16(10, 0, true)
    entry.setUint16(12, time, true)
    entry.setUint16(14, date, true)
    entry.setUint32(16, crc, true)
    entry.setUint32(20, bigSize ? MAX32 : size, true)
    entry.setUint32(24, bigSize ? MAX32 : size, true)
    entry.setUint16(28, name.length, true)
    entry.setUint16(30, centralExtra ? 4 + centralExtra : 0, true)
    entry.setUint32(42, bigOffset ? MAX32 : offset, true)
    new Uint8Array(entry.buffer).set(name, 46)
    if (centralExtra) {
      let at = 46 + name.length
      entry.setUint16(at, 0x0001, true)
      entry.setUint16(at + 2, centralExtra, true)
      at += 4
      if (bigSize) {
        setU64(entry, at, size)
        setU64(entry, at + 8, size)
        at += 16
      }
      if (bigOffset) setU64(entry, at, offset)
    }

    parts.push(local.buffer, file.data)
    central.push(new Uint8Array(entry.buffer))
    offset += local.byteLength + size
    options.onProgress?.(index + 1, files.length)
  }

  const directorySize = central.reduce((sum, item) => sum + item.length, 0)
  const directoryOffset = offset
  const needZip64 = options.forceZip64 || files.length >= MAX16 || directoryOffset >= MAX32 || directorySize >= MAX32
  const tail: ArrayBuffer[] = []

  if (needZip64) {
    const record = new DataView(new ArrayBuffer(56))
    record.setUint32(0, 0x06064b50, true)
    setU64(record, 4, 44)
    record.setUint16(12, 45, true)
    record.setUint16(14, 45, true)
    setU64(record, 24, files.length)
    setU64(record, 32, files.length)
    setU64(record, 40, directorySize)
    setU64(record, 48, directoryOffset)
    const locator = new DataView(new ArrayBuffer(20))
    locator.setUint32(0, 0x07064b50, true)
    setU64(locator, 8, directoryOffset + directorySize)
    locator.setUint32(16, 1, true)
    tail.push(record.buffer, locator.buffer)
  }

  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, needZip64 ? MAX16 : files.length, true)
  end.setUint16(10, needZip64 ? MAX16 : files.length, true)
  end.setUint32(12, needZip64 ? MAX32 : directorySize, true)
  end.setUint32(16, needZip64 ? MAX32 : directoryOffset, true)
  tail.push(end.buffer)

  return new Blob([...parts, ...(central as Uint8Array<ArrayBuffer>[]), ...tail], { type: 'application/zip' })
}
