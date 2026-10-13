// Browser-side image handling for the editor: measuring, shrinking oversized
// images to what phones can show, and making small map thumbnails.

/** Phone screens are at most about this size in portrait; landscape swaps them. */
const LONG_EDGE = 1920
const SHORT_EDGE = 1080
/** Leave images alone unless they're meaningfully bigger than needed. */
const SLACK = 1.2
const BIG_FILE_BYTES = 1.5 * 1024 * 1024
const THUMB_EDGE = 240

export type ImageInfo = {
  file: File
  width: number
  height: number
  /** Animated GIFs and SVGs are kept as they are. */
  canOptimise: boolean
  /** Larger than phones need, so optimising is recommended. */
  oversized: boolean
}

const KEEP_AS_IS = new Set(['image/gif', 'image/svg+xml'])

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
}

export const extensionFor = (file: Blob & { name?: string }) =>
  EXTENSIONS[file.type] ?? file.name?.split('.').pop()?.toLowerCase() ?? 'png'

export const isSupportedImage = (file: File) => Boolean(EXTENSIONS[file.type]) || /\.(png|jpe?g|webp|gif|avif|svg)$/i.test(file.name)

const targetSize = (width: number, height: number) => {
  const long = Math.max(width, height)
  const short = Math.min(width, height)
  const scale = Math.min(1, LONG_EDGE / long, SHORT_EDGE / short)
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

const decode = async (file: Blob) => {
  try {
    return await createImageBitmap(file)
  } catch {
    throw new Error("This picture couldn't be opened. Try saving it as PNG or JPEG.")
  }
}

export const analyzeImage = async (file: File): Promise<ImageInfo> => {
  if (file.type === 'image/svg+xml') {
    return { file, width: 0, height: 0, canOptimise: false, oversized: false }
  }
  const bitmap = await decode(file)
  const { width, height } = bitmap
  bitmap.close()
  const canOptimise = !KEEP_AS_IS.has(file.type)
  const long = Math.max(width, height)
  const short = Math.min(width, height)
  const oversized = canOptimise && (long > LONG_EDGE * SLACK || short > SHORT_EDGE * SLACK || file.size > BIG_FILE_BYTES)
  return { file, width, height, canOptimise, oversized }
}

const encode = (canvas: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality))

/** Draws a bitmap at a new size and encodes it, preferring WebP. */
const render = async (bitmap: ImageBitmap, width: number, height: number, quality: number) => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('This browser could not process the picture.')
  }
  context.imageSmoothingQuality = 'high'
  context.drawImage(bitmap, 0, 0, width, height)
  // Browsers that can't encode WebP silently return PNG; use JPEG instead.
  const webp = await encode(canvas, 'image/webp', quality)
  const blob = webp?.type === 'image/webp' ? webp : await encode(canvas, 'image/jpeg', quality)
  canvas.width = 0 // Release the canvas memory promptly (matters on iOS).
  if (!blob) {
    throw new Error('This browser could not process the picture.')
  }
  return blob
}

/** Shrinks an image to phone size and re-encodes it (WebP, or JPEG as a fallback). */
export const optimiseImage = async (file: File) => {
  const bitmap = await decode(file)
  try {
    const size = targetSize(bitmap.width, bitmap.height)
    return await render(bitmap, size.width, size.height, 0.85)
  } finally {
    bitmap.close()
  }
}

/** A small preview for the editor's map and lists. Returns null for formats we keep as-is. */
export const makeThumbnail = async (blob: Blob): Promise<Blob | null> => {
  if (blob.type === 'image/svg+xml') {
    return null
  }
  try {
    const bitmap = await createImageBitmap(blob)
    try {
      const scale = Math.min(1, THUMB_EDGE / Math.max(bitmap.width, bitmap.height))
      return await render(bitmap, Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)), 0.75)
    } finally {
      bitmap.close()
    }
  } catch {
    return null
  }
}

/** A readable page title from a file name: "03_the-dark_forest.png" → "The dark forest". */
export const titleFromFileName = (name: string) => {
  const base = name
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/^\s*\d+\s*/, '')
    .trim()
  return base ? base[0].toUpperCase() + base.slice(1) : ''
}
