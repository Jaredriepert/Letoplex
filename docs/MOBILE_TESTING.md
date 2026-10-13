# Testing on Phones

## Getting the app onto a phone

**Quick check on your own Wi-Fi (no install, no offline):**

```bash
npm run dev:phone        # or: npm run build && npm run preview:phone
```

Open the `Network:` address Vite prints (e.g. `http://192.168.1.20:5173`) on the phone. Reading, importing and saving books all work. Over plain `http` the service worker doesn't register, so offline mode, installing, share-to-app and file opening can't be tested this way.

**Full PWA behaviour needs HTTPS.** Deploy to GitHub Pages: push to `main` and the workflow in `.github/workflows/deploy-pages.yml` tests, builds and publishes. One-time setup: repo **Settings → Pages → Source: GitHub Actions**. Any static host also works (`npm run build`, then upload `dist/`). For a host that serves from a sub-path, build with `BASE_PATH=/sub-path/`.

**Test books:** `import-test-books/mosslight-mystery.gab` (copy it to the phone via Drive, email, AirDrop or USB). The app also offers it under *Add a book → Try the Mosslight Mystery sample*. Re-generate fixtures with `npm run fixtures`.

## What's automated

- `npm test`: schema, migration, validation and package-reading unit tests.
- A headless phone-sized Chrome run was used during development to check swipes, edge taps, zoom, back button, reload, import, duplicates, errors, removal, offline loading and share-target handling.
- A 602 MB, 300-page stress book was imported the same way. Peak JavaScript memory stayed around 5 MB. Cancel, a simulated full device, and a tab killed mid-import all left storage consistent.
- The editor was driven the same way at desktop and phone sizes: creating a book from pictures (including optimising a 3000×4000 photo), branching, linking, undo/redo, preview, export, re-import, add to library, and editing the sample. The exported `.gab` also opens with Windows' built-in unzip.
- None of this is a substitute for the device checks below; it can't reproduce Safari, real touch hardware, or phone storage speeds. Expect large imports to take noticeably longer on a phone than on a desktop.

## Real-device checklist

Run on a current **iPhone (Safari)** and a current **Android phone (Chrome)**. Tick both columns.

| # | Check | iOS | Android |
| --- | --- | --- | --- |
| 1 | Library loads; bundled book cover shows | | |
| 2 | Add a book → Choose a book file → pick `mosslight-mystery.gab` from Files/Downloads; it imports and opens | | |
| 3 | `.gab` is selectable in the picker (not greyed out) | | |
| 4 | Import the same file again → "Already in your library" → Keep both works | | |
| 5 | Pick a non-book file (photo, PDF) → readable error, app keeps working | | |
| 6 | Close the browser fully, reopen → imported books and "Continue" are still there | | |
| 7 | Reader: swipe left/right/up/down follows the arrows; page doesn't scroll or bounce | | |
| 8 | Reader: tap near each edge moves that way; tap the middle hides/shows controls | | |
| 9 | Reader: pinch zoom and double-tap zoom; swiping while zoomed pans, doesn't turn pages | | |
| 10 | Reader: top bar and arrows clear the notch / camera cutout and home indicator | | |
| 11 | Reader: rotate to landscape and back; page stays whole and readable | | |
| 12 | Android back button / iOS back swipe steps back through pages, then chapters, then library | | |
| 13 | Dead end (direction with no page): page nudges, nothing breaks | | |
| 14 | Install: Android shows *Install*; iOS shows the *Share → Add to Home Screen* hint. The installed app opens full screen | | |
| 15 | Installed app in airplane mode: opens, library and imported books readable | | |
| 16 | Android, installed: share a `.gab` from Files/Drive → *Graphic Adventure* appears in the share sheet and imports it | | |
| 17 | Link import: open `https://<your-site>/?import=https://<your-site>/samples/mosslight-mystery.gab` → confirm sheet → imports | | |
| 18 | Large book (several hundred MB): progress bar moves steadily, app stays responsive, import completes; page turns stay smooth; no reload/crash after reading many pages | | |
| 18a | Cancel a large import part-way: "Import cancelled", library unchanged | | |
| 18b | Lock the phone or switch apps mid-import, then come back: the import either finished, or the book isn't in the library and Storage shows no leftover space used after reopening | | |
| 18c | Import a book bigger than the phone's free space: "Not enough space" appears before saving; *Free up space* → remove a book → *Continue adding* works | | |
| 19 | Remove a book from ⋯ → it's gone after reopening the app | | |
| E1 | Create → New book → Add pictures from the photo library / Files (several at once); camera photos trigger "Optimise for phones?" | | |
| E2 | Map: tap tiles, tap + to add, tap connectors to link; page editor opens full screen and closes | | |
| E3 | Page editor: text fields don't zoom the page; selects are usable; Replace picture works | | |
| E4 | Switch apps mid-edit, come back / reopen the app: the draft is saved | | |
| E5 | Preview → turn pages → Back to editor (menu and Android back button) | | |
| E6 | Export → Share… (sends a .gab via Messages/email/Save to Files) and Download .gab | | |
| E7 | Export → Add to my library → reads correctly; edit again and Replace keeps reading progress | | |
| 20 | Private/incognito mode: app shows the "isn't letting the app save books" notice instead of failing silently | | |

## Known platform limits

- **iOS has no share target or file association for web apps.** iPhone users import through *Add a book* (Files, iCloud Drive, Downloads) or a link.
- **iOS may evict web storage** for sites not opened in ~7 days unless the app is installed to the Home Screen. Installing is the main protection; `navigator.storage.persist()` is also requested after the first import.
- **Link import is subject to CORS.** Downloading a `.gab` from another site only works if that host allows cross-origin requests (GitHub Pages, GitHub raw and most CDNs do; Google Drive and Dropbox share pages don't). Hosting `.gab` files next to the app always works.
