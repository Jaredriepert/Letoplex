# Letoplex: Project Scope and Roadmap

## Purpose

Letoplex is a local-first reader for illustrated, branching stories and comic-style books. A reader imports a book package from their device, chooses a chapter, and navigates page-to-page using the directions authored for that book.

The app also includes a book editor (the **Create** tab). It creates packages that the reader can preview and import, and stays a distinct authoring mode rather than complicating the reading flow.

**Naming:** the project was originally called "Graphic Adventure". User-facing names, the `.letoplex` extension and the `letoplex-book` format marker replaced it. Two internal names deliberately keep the old spelling so existing users don't lose data: the IndexedDB database `graphic-adventure` and the localStorage prefix `graphic-adventure:`. The old `.gab` extension and `graphic-adventure-book` format marker are still accepted on import.

This document is the project-level context for maintainers and AI agents. It describes the observed implementation and intended direction; roadmap items are not claims about features that already exist.

## Product Goals

- Make reading an interactive graphic story simple and immersive, especially on phones.
- Keep books and reading data local to the user's device; the current product has no server or account requirement.
- Support branching navigation rather than assuming every story is a linear sequence.
- Make the book package understandable, portable, and suitable for large page images.
- Preserve a warm, tactile comic-book visual identity: soft paper and ink colors, the bundled Special Elite font, and no neon or glowing effects.
- Eventually let authors create, validate, preview, and export books using the same book model as the reader.

## Non-Goals and Boundaries

- No cloud library, accounts, synchronization service, or backend is currently in scope.
- The app is a React web app installable as a PWA, not a native iOS or Android application. Native packaging is a later decision, not an existing capability.
- Do not make the reader's core flow depend on the editor. The reader only imports `.letoplex` packages and never needs drafts.
- Persistence, offline install and on-demand image loading are implemented and covered by automated checks, but have **not yet passed the real-device checklist** in [docs/MOBILE_TESTING.md](docs/MOBILE_TESTING.md). Don't describe them as device-verified until that's done.

## User Experience

### Reader flow

1. The library opens to **My Books**, offers **Add a book**, and shows **Continue** on books with progress.
2. Selecting a book opens its chapter selector with Continue / Start reading.
3. The reader displays the current page full-screen, with the chapter and page title at the upper left and a menu in the corner.
4. Swipes (drag-the-paper convention: finger left → `right` page), edge taps, arrow buttons and keyboard arrows navigate according to the current page's directional links. Browser back steps back through pages.
5. Chapter access progresses as the reader reaches pages in later chapters. The reader can return to the chapter selector or library.

### Visual and interaction direction

- Mobile-first, full-bleed reading surface with safe-area and viewport handling.
- Warm paper palette and bundled Special Elite typography.
- Touch-friendly swipe and edge-tap controls; no visual frame around the reading image.
- Keep authoring controls and denser editing workflows out of the reader screen.

## Current Implementation

The codebase is a Vite + React 19 + TypeScript PWA. [src/App.tsx](src/App.tsx) owns routing (browser history), library/progress state and the import pipeline. Screens are in [src/screens/](src/screens/), sheets/toasts in [src/components/](src/components/), the book model and package reading in [src/book/](src/book/), persistence in [src/storage/](src/storage/), and the service worker in [src/sw.ts](src/sw.ts). See the README code map.

Implemented in the current source:

- One canonical, versioned book schema (v1), documented in [docs/BOOK_FORMAT.md](docs/BOOK_FORMAT.md), with migration of the two older JSON layouts and validation that reports every problem.
- Import from `.letoplex`/`.zip` archives (primary, works on phones), folders (relative-path mapping via `webkitRelativePath`), links (`?import=` deep links ask before downloading), the Android share sheet (manifest `share_target`), and desktop "open with" (`file_handlers`). Size limits guard against huge archives.
- Streaming import: archives are read through their zip index ([src/book/zip.ts](src/book/zip.ts), zip64 supported) and images are copied into storage one at a time ([src/library/importer.ts](src/library/importer.ts)), so memory stays flat for multi-GB books. There's a progress bar with cancel, and a wake lock keeps the screen on.
- Space check before saving ("needs X, about Y free") with *Free up space* (Storage sheet listing books by size) or *Try anyway*. Running out mid-save rolls back cleanly.
- Each import writes under a fresh storage key and is committed atomically at the end, so a failed or cancelled replacement never damages the existing copy. Leftovers from interrupted imports are removed at startup.
- Duplicate handling (replace or keep both), readable error/notes sheets, and remove from the ⋯ menu for every book (the built-in sample is hidden and can be restored).
- IndexedDB persistence of books, page image blobs and progress (unlocked chapter and last page). `navigator.storage.persist()` is requested after the first import. Remove-book and start-over actions.
- On-demand images: only the current page and its direct neighbours have object URLs; others are revoked. Neighbours are pre-decoded. Image-load failure state.
- Reader: swipe, edge-tap zones sized for fingers, direction arrows, dead-end nudge, end-of-path card, pinch/double-tap zoom with pan, tap-to-hide controls, keyboard arrows, first-run "How to read" guide, slide transitions (reduced-motion aware). Pages use `contain` fit by default (`fit: "cover"` per book).
- History-based navigation: back steps through pages; reload restores the screen and page.
- PWA: manifest and icons, offline app-shell precache, update prompt, install hint (Android prompt, iOS instructions), status-bar colour per screen.
- Real PNG fixtures for the bundled sample and the Mosslight test package, generated by `npm run fixtures`.
- Unit tests for schema/validation/migration/package reading (`npm test`); GitHub Pages deploy workflow.

Not implemented or not yet verified:

- The real-device checklist in [docs/MOBILE_TESTING.md](docs/MOBILE_TESTING.md) hasn't been run. Behaviour was checked in a phone-sized headless Chrome, not on Safari or real hardware.
- Large-book import was stress-tested on desktop Chrome only (602 MB). Phone import speed, and behaviour when the OS suspends a backgrounded tab mid-import, still need device checks.
- The editor hasn't had real-device checks (items E1–E7 in the testing doc), especially photo-library picking and the share sheet on iOS.
- A native wrapper.

## Book Package and Data Model

The book format is a key contract shared by importing, reading, and future authoring. It should be stabilized before building substantial editor functionality.

The canonical model is defined in [src/book/schema.ts](src/book/schema.ts) and documented in [docs/BOOK_FORMAT.md](docs/BOOK_FORMAT.md): `book.json` with `format: "letoplex-book"`, `version: 1`, an ordered `chapters` array, and pages carrying an id, title, image path, description, position and four nullable directions. In memory, a `Book` holds ordered chapters (with page id lists) and a page record keyed by id.

`parseBook` also accepts the two pre-v1 layouts (nested chapters without a version; a flat `pages` array with `chapter` labels) and converts them with a warning. Books with a newer `version` are rejected. Don't add another format; evolve the schema by bumping `version` and adding a migration in `parseBook`.

The bundled sample ([src/data/forest-of-echoes/](src/data/forest-of-echoes/)) and the test package ([import-test-books/mosslight-mystery](import-test-books/mosslight-mystery)) both use v1.

Package layout:

```text
my-book/
  book.json
  chapters/
    chapter-1/
      page-intro.jpg
      page-forest.jpg
```

Book JSON image paths should be relative to the package root. Page IDs must be unique, the start page must exist, and each non-null directional target must refer to an existing page. Chapter ordering should be explicit rather than depending on incidental object or file ordering.

### Import risks (resolved)

- Assets are keyed by normalized package-relative path (`webkitRelativePath` for folders, archive entry names for zips). Browsers that don't expose folder paths get a warning suggesting `.letoplex`/`.zip`.
- Images render through `<img>` elements fed by object URLs (or bundled asset URLs). CSS gradients are no longer part of the page model.
- Object URLs are created on demand and revoked when pages scroll out of the neighbour window, covers unmount, or a book is replaced/removed.
- Invalid JSON, missing assets, duplicate ids, broken links, unsafe paths and unsupported file types produce a listed error sheet; nothing is added to the library.

## Recommended Roadmap

> **Status (Oct 2026):** Phase 0 is done. Phase 1 is implemented, but its real-device exit check is still outstanding. Phase 2's editor MVP is built and passes its exit criteria in automated browser tests (create → validate → preview → export → re-import); device checks are pending. Undo/redo, one Phase 3 item, came early. Phase 4's PWA items are implemented early because they were the main blocker for phone users; the native-wrapper decision is still open.

### Phase 0: Stabilize the book contract and prove import

1. Define and document one canonical, versioned `book.json` schema, including metadata, explicit chapter order, page order/positions, image paths, start page, and directional links.
2. Align the TypeScript sample, public sample package, and test package with that schema.
3. Add real small test images and verify directory import in the running app on supported desktop and mobile browsers.
4. Fix relative asset path mapping and CSS image rendering; validate missing or malformed assets gracefully.
5. Add focused tests for normalization and schema validation, including broken links and missing start pages.

**Exit criteria:** a real multi-chapter package imports, all page art displays, branching links navigate correctly, and invalid packages produce a useful error without crashing.

### Phase 1: Make reading dependable

1. Persist the library and reading progress locally, with a deliberate browser-storage strategy and clear removal/reset behavior.
2. Avoid retaining unnecessary decoded image memory. Load the current page on demand and consider preloading only likely neighboring pages; revoke object URLs when no longer needed.
3. Verify gestures, safe areas, orientation, browser back behavior, and import support on current iOS Safari and Android Chrome devices.
4. Add reader states for unavailable images, empty books, and import/loading progress.

**Exit criteria:** imported books and progress behave predictably across reloads, large books do not require all page images to be loaded at once, and the main reading flow passes real-device checks.

### Phase 2: Build a separate editor mode MVP

Keep the editor in the same product and repository, but give it a distinct screen/route and state flow. Share the canonical book types, validation, and reader preview instead of duplicating book rules.

Initial authoring capabilities:

- Create a book and edit its title, author, and cover/start page.
- Add, rename, reorder, and remove chapters and pages.
- Add page images and edit page titles/descriptions.
- Arrange pages on a grid and edit their directional links, with visible targets and broken-link warnings.
- Preview the draft in the existing reader without publishing/exporting first.
- Save a recoverable local draft and export a reader-compatible package.

Favor a desktop-oriented grid/canvas workflow, while keeping basic navigation and forms usable on smaller screens. Do not rely on writing to arbitrary local folders: browser file-write support is inconsistent, especially on mobile. Export a `.letoplex` archive (the format the reader already imports); `fflate` is already a dependency.

**Exit criteria:** an author can create a small branching book, pass validation, preview every route, export it, and import that export into the reader with images and links intact.

**As built:** the editor is a separate route reached from the **Create** tab, open on phones as well as computers. Its model is the reader's `Book` plus draft metadata, and every edit is a pure function in [src/editor/draft.ts](src/editor/draft.ts). Export runs the real `parseBook` over the output, so the editor can't produce a book the reader rejects. Drafts and their images live in IndexedDB (`drafts` store; images under `draft~<id>` keys, which orphan cleanup treats as live). The editor is described for authors in [docs/CREATING_BOOKS.md](docs/CREATING_BOOKS.md).

### Phase 3: Improve authoring and sharing

- ~~Undo/redo~~ (done) and basic keyboard controls (done). Still open: duplicate/reorder tools, multi-select, and clearer branch visualisation (e.g. drawn arrows for long-distance links) based on actual author needs.
- Add package metadata and compatibility handling without breaking older books.
- Consider optional share workflows only after local package round-tripping is solid.

### Phase 4: Distribution decision

- Evaluate installable PWA behavior for home-screen access and offline app-shell caching.
- Consider Capacitor or another native wrapper only if browser APIs or store distribution become important requirements. Keep the book schema and core reader behavior independent of the wrapper.

## Architecture Guidance for Future Agents

- Keep a single canonical domain model and share it across reader, importer, editor, validator, and exporter.
- Separate file/package I/O from screen components. Keep browser-specific access behind a small adapter so browser limitations are explicit.
- Treat imported book data as untrusted input. Validate before adding it to the library or using links and asset paths.
- Keep imported local media URLs separate from persisted metadata. Blob URLs are session resources and should not be stored as durable book paths.
- Preserve local-first behavior and do not add a server, accounts, or cloud dependency without an explicit product decision.
- Keep the reader mobile-first and visually consistent with the established warm comic-book direction. Authoring may use denser desktop layouts, but should still feel like the same product.
- Prefer focused tests for normalization, validation, navigation, import/export round-tripping, and progress behavior. Run `npm run build` and `npm run lint` after code changes.
- Do not treat README milestones or this roadmap as proof that a feature is implemented. Verify the source and runtime behavior.

## Key Files

- [src/book/schema.ts](src/book/schema.ts): canonical model, parser, validation, migrations.
- [src/book/package.ts](src/book/package.ts): archive/folder/link reading and asset checks.
- [src/storage/db.ts](src/storage/db.ts): IndexedDB stores (books, assets, progress, inbox). Also imported by the service worker, so keep it DOM-free.
- [src/App.tsx](src/App.tsx): routing, library/progress state, import pipeline, incoming shares/links.
- [src/screens/Reader.tsx](src/screens/Reader.tsx): gestures, zoom, hints, menu.
- [src/library/useImages.ts](src/library/useImages.ts): neighbour-window image loading and URL revocation.
- [src/sw.ts](src/sw.ts) and [vite.config.ts](vite.config.ts): service worker, manifest, share target, file handlers.
- [src/data/forest-of-echoes/](src/data/forest-of-echoes/): bundled sample book (v1).
- [import-test-books/](import-test-books/): Mosslight test package as a folder and as `mosslight-mystery.letoplex`.
- [scripts/generate-fixtures.mjs](scripts/generate-fixtures.mjs): regenerates fixture images and the test `.letoplex`.
- [scripts/make-icons.ps1](scripts/make-icons.ps1): rebuilds the app icons from `design/icon-source.png`.
- [src/App.css](src/App.css) and [src/index.css](src/index.css): styling and Special Elite font registration.
- [docs/BOOK_FORMAT.md](docs/BOOK_FORMAT.md) and [docs/MOBILE_TESTING.md](docs/MOBILE_TESTING.md): format spec and device checklist.

## Local Development and Verification

```bash
npm install
npm run dev        # or dev:phone to reach it from a phone on the same Wi-Fi
npm test
npm run build
npm run lint
```

Use the real fixtures in `import-test-books/` for import checks (`npm run fixtures` regenerates them). Offline, install and share-target behaviour only work over HTTPS or localhost; see [docs/MOBILE_TESTING.md](docs/MOBILE_TESTING.md).