// Generates real PNG fixtures for the sample book and the import test
// package. Pure Node (zlib only) so it runs anywhere:
//   node scripts/generate-fixtures.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { zipSync } from 'fflate'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---------- PNG encoding ----------

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

const crc32 = (buf) => {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

const encodePng = (canvas) => {
  const { width, height, pixels } = canvas
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // RGB
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0
    pixels.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------- Tiny raster canvas ----------

const hex = (value) => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16))
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t))

const createCanvas = (width, height) => ({ width, height, pixels: Buffer.alloc(width * height * 3) })

const setPixel = (c, x, y, rgb, alpha = 1) => {
  if (x < 0 || y < 0 || x >= c.width || y >= c.height) return
  const i = (y * c.width + x) * 3
  for (let k = 0; k < 3; k++) c.pixels[i + k] = Math.round(c.pixels[i + k] + (rgb[k] - c.pixels[i + k]) * alpha)
}

const verticalGradient = (c, top, bottom) => {
  for (let y = 0; y < c.height; y++) {
    const rgb = mix(hex(top), hex(bottom), y / (c.height - 1))
    for (let x = 0; x < c.width; x++) setPixel(c, x, y, rgb)
  }
}

const fillRect = (c, x0, y0, w, h, color, alpha = 1) => {
  const rgb = hex(color)
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(c.height, y0 + h); y++)
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(c.width, x0 + w); x++) setPixel(c, x, y, rgb, alpha)
}

const fillCircle = (c, cx, cy, r, color, alpha = 1) => {
  const rgb = hex(color)
  for (let y = Math.floor(cy - r); y <= cy + r; y++)
    for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      const d = Math.hypot(x - cx, y - cy)
      if (d <= r) setPixel(c, x, y, rgb, alpha * Math.min(1, r - d + 0.5))
    }
}

const fillPolygon = (c, points, color, alpha = 1) => {
  const rgb = hex(color)
  const ys = points.map((p) => p[1])
  for (let y = Math.max(0, Math.floor(Math.min(...ys))); y <= Math.min(c.height - 1, Math.max(...ys)); y++) {
    const xs = []
    for (let i = 0; i < points.length; i++) {
      const [x1, y1] = points[i]
      const [x2, y2] = points[(i + 1) % points.length]
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1))
    }
    xs.sort((a, b) => a - b)
    for (let i = 0; i + 1 < xs.length; i += 2)
      for (let x = Math.ceil(xs[i]); x <= xs[i + 1]; x++) setPixel(c, x, y, rgb, alpha)
  }
}

const fillBand = (c, baseY, amplitude, wavelength, phase, color, alpha = 1) => {
  const rgb = hex(color)
  for (let x = 0; x < c.width; x++) {
    const top = Math.round(baseY + Math.sin((x / wavelength) * Math.PI * 2 + phase) * amplitude)
    for (let y = Math.max(0, top); y < c.height; y++) setPixel(c, x, y, rgb, alpha)
  }
}

// 5x7 bitmap font, enough for captions.
const GLYPH_ROWS = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
  '-': ['.....', '.....', '.....', '.###.', '.....', '.....', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ',': ['.....', '.....', '.....', '.....', '.##..', '..#..', '.#...'],
  "'": ['..#..', '..#..', '.....', '.....', '.....', '.....', '.....'],
  '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
}
const GLYPHS = Object.fromEntries(Object.entries(GLYPH_ROWS).map(([ch, rows]) => [ch, rows.join('')]))

const drawText = (c, text, x0, y0, scale, color) => {
  const rgb = hex(color)
  let x = x0
  for (const ch of text.toUpperCase()) {
    const glyph = GLYPHS[ch] ?? GLYPHS['?']
    for (let gy = 0; gy < 7; gy++)
      for (let gx = 0; gx < 5; gx++)
        if (glyph[gy * 5 + gx] === '#')
          for (let sy = 0; sy < scale; sy++)
            for (let sx = 0; sx < scale; sx++) setPixel(c, x + gx * scale + sx, y0 + gy * scale + sy, rgb)
    x += 6 * scale
  }
}

const wrap = (text, maxChars) => {
  const lines = []
  let line = ''
  for (const word of text.split(/\s+/)) {
    if ((line + ' ' + word).trim().length > maxChars) {
      lines.push(line)
      line = word
    } else {
      line = (line + ' ' + word).trim()
    }
  }
  if (line) lines.push(line)
  return lines
}

// ---------- Scene painting ----------

const W = 540
const H = 960
const INK = '#2d2017'
const PAPER = '#fbf3e4'

const motifs = {
  lantern: (c, p) => {
    fillRect(c, W * 0.62, H * 0.42, 8, 150, INK)
    fillRect(c, W * 0.62 - 22, H * 0.42 - 50, 52, 56, INK)
    fillRect(c, W * 0.62 - 16, H * 0.42 - 44, 40, 44, p.accent)
  },
  trees: (c) => {
    for (let i = 0; i < 7; i++) {
      const x = 30 + i * 80 + (i % 2) * 20
      const base = H * 0.66 + (i % 3) * 18
      fillPolygon(c, [[x, base - 230 + (i % 2) * 40], [x - 50, base], [x + 50, base]], '#1f3b2c')
      fillRect(c, x - 6, base, 12, 30, INK)
    }
  },
  bridge: (c) => {
    fillRect(c, 0, H * 0.55, W * 0.38, 18, INK)
    fillRect(c, W * 0.55, H * 0.55, W * 0.45, 18, INK)
    for (let x = 10; x < W; x += 48) if (x < W * 0.36 || x > W * 0.56) fillRect(c, x, H * 0.55 - 40, 8, 40, INK)
    fillRect(c, W * 0.4, H * 0.58, W * 0.14, 12, INK, 0.6)
  },
  river: (c) => {
    fillBand(c, H * 0.62, 10, 160, 0, '#2c5f73')
    fillBand(c, H * 0.7, 8, 120, 1, '#3c7f94', 0.7)
    fillPolygon(c, [[W * 0.3, H * 0.66], [W * 0.62, H * 0.66], [W * 0.56, H * 0.7], [W * 0.36, H * 0.7]], INK)
  },
  cabin: (c, p) => {
    fillRect(c, W * 0.25, H * 0.48, W * 0.5, H * 0.18, '#5b3a24')
    fillPolygon(c, [[W * 0.2, H * 0.48], [W * 0.5, H * 0.34], [W * 0.8, H * 0.48]], INK)
    fillRect(c, W * 0.44, H * 0.56, W * 0.12, H * 0.1, INK)
    fillRect(c, W * 0.3, H * 0.52, 50, 40, p.accent)
  },
  altar: (c, p) => {
    fillPolygon(c, [[W * 0.28, H * 0.68], [W * 0.72, H * 0.68], [W * 0.64, H * 0.54], [W * 0.36, H * 0.54]], '#4a3b33')
    fillCircle(c, W * 0.5, H * 0.46, 34, p.accent)
    fillCircle(c, W * 0.5, H * 0.46, 18, '#fff1c9')
  },
  hill: (c, p) => {
    fillBand(c, H * 0.5, 40, 700, 2.4, '#4a5a3a')
    fillRect(c, W * 0.6, H * 0.36, 6, 80, INK)
    fillCircle(c, W * 0.6 + 3, H * 0.36, 16, p.accent)
  },
  fog: (c) => {
    for (let i = 0; i < 5; i++) fillBand(c, H * (0.4 + i * 0.07), 14, 220 + i * 40, i, '#d9d4c7', 0.25)
  },
  door: (c, p) => {
    fillRect(c, W * 0.38, H * 0.44, W * 0.24, H * 0.22, INK)
    fillCircle(c, W * 0.5, H * 0.44, W * 0.12, INK)
    fillRect(c, W * 0.41, H * 0.46, W * 0.18, H * 0.2, p.accent, 0.8)
  },
  signal: (c, p) => {
    fillPolygon(c, [[W * 0.15, H * 0.68], [W * 0.3, H * 0.4], [W * 0.38, H * 0.68]], '#3b342f')
    fillPolygon(c, [[W * 0.55, H * 0.68], [W * 0.7, H * 0.3], [W * 0.82, H * 0.68]], '#3b342f')
    for (let r = 20; r < 120; r += 30) fillCircle(c, W * 0.7, H * 0.3, r, p.accent, 0.12)
    fillCircle(c, W * 0.7, H * 0.3, 10, p.accent)
  },
}

const paintPage = (page) => {
  const c = createCanvas(W, H)
  verticalGradient(c, page.sky[0], page.sky[1])
  fillCircle(c, W * 0.22, H * 0.16, 46, page.moon, 0.9)
  fillBand(c, H * 0.62, 26, 420, 0.7, page.ground[0])
  for (const name of page.motifs) motifs[name](c, page)
  fillBand(c, H * 0.74, 14, 300, 2, page.ground[1])

  // Comic caption box with the page text.
  const lines = wrap(page.caption, 24)
  const boxH = 40 + lines.length * 32
  fillRect(c, 24, H - boxH - 36, W - 48, boxH, INK)
  fillRect(c, 30, H - boxH - 30, W - 60, boxH - 12, PAPER)
  lines.forEach((line, i) => drawText(c, line, 48, H - boxH - 12 + i * 32, 3, INK))

  // Page tag in the corner, helpful when verifying navigation on a device.
  fillRect(c, W - 120, 28, 96, 44, PAPER)
  drawText(c, page.tag, W - 108, 36, 4, INK)
  return encodePng(c)
}

// ---------- Books ----------

const forest = {
  dir: join(root, 'src', 'data', 'forest-of-echoes'),
  book: {
    format: 'letoplex-book',
    version: 1,
    id: 'forest-of-echoes',
    title: 'Forest of Echoes',
    author: 'Story Forge Studio',
    description: 'A short branching walk through a whispering forest.',
    startPageId: 'intro',
    chapters: [
      { id: 'chapter-1', title: 'The Lantern Gate', pages: [] },
      { id: 'chapter-2', title: 'The Ember Altar', pages: [] },
    ],
  },
  pages: [
    { chapter: 0, id: 'intro', title: 'The Lantern Gate', tag: '1', position: [0, 0], directions: { down: 'river', right: 'forest' },
      description: 'A stone gate stands in the fog. A single lantern glows beside the path.',
      sky: ['#2b2a3a', '#a2774a'], moon: '#f6d98a', ground: ['#3b3328', '#2a2219'], accent: '#f3c162', motifs: ['fog', 'lantern'] },
    { chapter: 0, id: 'forest', title: 'Whispering Trees', tag: '2', position: [1, 0], directions: { down: 'cabin', left: 'intro', right: 'bridge' },
      description: 'The path opens into a forest. The branches sway as if listening.',
      sky: ['#23362c', '#6f8a5e'], moon: '#e8e2b0', ground: ['#2c3b2a', '#1d2a1c'], accent: '#e9d27a', motifs: ['trees'] },
    { chapter: 0, id: 'bridge', title: 'The Broken Bridge', tag: '3', position: [2, 0], directions: { down: 'altar', left: 'forest' },
      description: 'A cracked bridge crosses a deep ravine. A bell rings far away.',
      sky: ['#2a3546', '#8aa3b5'], moon: '#f1efe4', ground: ['#3a3a3a', '#262626'], accent: '#c7d6e0', motifs: ['bridge'] },
    { chapter: 0, id: 'river', title: 'Moonlit River', tag: '4', position: [0, 1], directions: { up: 'intro', right: 'altar' },
      description: 'A silver river threads through the dark. A boat waits at the shore.',
      sky: ['#1e2738', '#4e6b7d'], moon: '#eef3f2', ground: ['#283238', '#1b2328'], accent: '#a9d1dc', motifs: ['river'] },
    { chapter: 0, id: 'cabin', title: 'The Hollow Cabin', tag: '5', position: [1, 1], directions: { up: 'forest', right: 'altar' },
      description: 'Inside the hut you find a map and a stack of old letters.',
      sky: ['#352a24', '#8b6b52'], moon: '#f4dcb0', ground: ['#3d3127', '#2b2219'], accent: '#f0a85a', motifs: ['trees', 'cabin'] },
    { chapter: 1, id: 'altar', title: 'The Ember Altar', tag: '6', position: [2, 1], directions: { up: 'bridge', left: 'river' },
      description: 'A red ember rises from the stone. The story has only just begun.',
      sky: ['#3a1d17', '#a2512c'], moon: '#f7c7a0', ground: ['#3b2420', '#261512'], accent: '#e2622b', motifs: ['altar'] },
  ],
}

const mosslight = {
  dir: join(root, 'import-test-books', 'mosslight-mystery'),
  book: {
    format: 'letoplex-book',
    version: 1,
    id: 'mosslight-mystery',
    title: 'Mosslight Mystery',
    author: 'Test Import Kit',
    description: 'A four-page test package with two chapters and a branch.',
    startPageId: 'page-1',
    chapters: [
      { id: 'chapter-1', title: 'The Hill', pages: [] },
      { id: 'chapter-2', title: 'The Ruins', pages: [] },
    ],
  },
  pages: [
    { chapter: 0, id: 'page-1', title: 'The Lantern on the Hill', tag: 'M1', position: [0, 0], directions: { right: 'page-2' },
      description: 'A lantern flickers above the hill as the fog rolls in.',
      sky: ['#26303a', '#7d8c84'], moon: '#efe9cf', ground: ['#3a4433', '#262e22'], accent: '#f2c76b', motifs: ['hill', 'fog'] },
    { chapter: 0, id: 'page-2', title: 'The Fog Turns', tag: 'M2', position: [1, 0], directions: { left: 'page-1', right: 'page-3' },
      description: 'The path bends and the mist begins to whisper.',
      sky: ['#2f3434', '#9a9a8a'], moon: '#f2efe2', ground: ['#3b3d33', '#272921'], accent: '#d8d0a8', motifs: ['trees', 'fog'] },
    { chapter: 1, id: 'page-3', title: 'The Whispering Door', tag: 'M3', position: [0, 1], directions: { up: 'page-4', left: 'page-2' },
      description: 'A hidden door glows softly beneath the roots of the woods.',
      sky: ['#1f2a25', '#56705f'], moon: '#dfe8d2', ground: ['#2b3527', '#1c241a'], accent: '#c9a65a', motifs: ['trees', 'door'] },
    { chapter: 1, id: 'page-4', title: 'The Last Signal', tag: 'M4', position: [1, 1], directions: { down: 'page-3' },
      description: 'A final signal flickers from the ruins beyond the trees.',
      sky: ['#211d2a', '#6a5a6e'], moon: '#ece3ee', ground: ['#2f2a30', '#1e1a20'], accent: '#e48a4f', motifs: ['signal'] },
  ],
}

const writeBook = ({ dir, book, pages }) => {
  const files = {}
  for (const page of pages) {
    const chapter = book.chapters[page.chapter]
    const image = `chapters/${chapter.id}/${page.id}.png`
    const png = paintPage({ ...page, caption: page.description })
    mkdirSync(dirname(join(dir, image)), { recursive: true })
    writeFileSync(join(dir, image), png)
    files[image] = new Uint8Array(png)
    chapter.pages.push({
      id: page.id,
      title: page.title,
      image,
      description: page.description,
      position: { x: page.position[0], y: page.position[1] },
      directions: { up: null, down: null, left: null, right: null, ...page.directions },
    })
  }
  const json = JSON.stringify(book, null, 2) + '\n'
  writeFileSync(join(dir, 'book.json'), json)
  files['book.json'] = new TextEncoder().encode(json)
  console.log(`wrote ${relative(root, dir)} (${pages.length} pages)`)
  return files
}

writeBook(forest)
const mossFiles = writeBook(mosslight)

// Single-file package (.letoplex is a zip archive) for phone import testing.
const archive = zipSync(mossFiles, { level: 0 })
for (const target of [join(root, 'import-test-books', 'mosslight-mystery.letoplex'), join(root, 'public', 'samples', 'mosslight-mystery.letoplex')]) {
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, archive)
  console.log(`wrote ${relative(root, target)}`)
}

// App icons are made from design/icon-source.png by scripts/make-icons.ps1.
