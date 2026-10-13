# Graphic Adventure App

A local-first reader for illustrated, branching stories, built for phones. Readers import a book package, then swipe or tap through pages along the directions the author linked. Books and progress stay on the device; there is no server or account.

## What it does

- **Library** of imported books plus a built-in sample, with *Continue* where you left off.
- **Import** a `.gab`/`.zip` package from Files or Downloads, a book folder (desktop), a link, or the Android share sheet. Duplicate detection offers replace or keep both. Broken packages get a readable list of problems.
- **Saved on the device** in IndexedDB: books, page images and reading progress survive reloads and restarts.
- **Reader** with swipes, edge taps, direction arrows, pinch and double-tap zoom, a tap to hide controls, keyboard arrows, and dead-end feedback. Only the current page and its neighbours are loaded.
- **Back button** steps back through pages, and a reload returns to the same page.
- **Installable PWA**: home-screen install, full-screen reading, offline app shell, update prompt, and on Android, open/share `.gab` files into the app.

## Run locally

```bash
npm install
npm run dev          # http://localhost:5173
npm run dev:phone    # also reachable from a phone on the same Wi-Fi
```

| Script | Purpose |
| --- | --- |
| `npm run build` | Type-check and build to `dist/` (includes the service worker) |
| `npm run preview` / `preview:phone` | Serve the production build |
| `npm test` | Unit tests (schema, validation, package reading) |
| `npm run lint` | oxlint |
| `npm run fixtures` | Regenerate sample/test book images, the test `.gab`, and app icons |

## Share it with other people

Push to `main` on GitHub with Pages set to **GitHub Actions** (Settings → Pages). `.github/workflows/deploy-pages.yml` lints, tests, builds and publishes. Readers open the URL on their phone and can install it from there. Details and the real-device checklist are in [docs/MOBILE_TESTING.md](docs/MOBILE_TESTING.md).

## Book packages

A book is a `book.json` plus images, zipped and renamed `.gab`. The format, validation rules and older layouts are documented in [docs/BOOK_FORMAT.md](docs/BOOK_FORMAT.md). Try `import-test-books/mosslight-mystery.gab`.

## Code map

| Path | What's there |
| --- | --- |
| `src/book/schema.ts` | Canonical book model, `book.json` parser, validation, legacy migration |
| `src/book/package.ts` | Reading `.gab`/`.zip`/folders/links into a validated book + image blobs |
| `src/storage/db.ts` | IndexedDB: books, assets, progress, share inbox |
| `src/library/` | Library entries (bundled + stored) and image loading/unloading hooks |
| `src/screens/` | Library, Chapters and Reader screens |
| `src/components/Sheets.tsx` | Import, error, duplicate, link and book-action sheets; toasts |
| `src/sw.ts`, `src/pwa.ts` | Service worker (offline + share target) and page-side PWA helpers |
| `src/data/forest-of-echoes/` | The bundled sample book, in the canonical format |

See [PROJECT_SCOPE.md](PROJECT_SCOPE.md) for goals and roadmap.
