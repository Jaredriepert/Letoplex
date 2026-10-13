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
- A headless phone-sized Chrome run was used during development to check swipes, edge taps, zoom, back button, reload, import, duplicates, errors, removal, offline loading and share-target handling. It is **not** a substitute for the device checks below; it can't reproduce Safari or real touch hardware.

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
| 18 | Large book (50+ full-size pages): import completes; page turns stay smooth; no reload/crash after reading many pages | | |
| 19 | Remove a book from ⋯ → it's gone after reopening the app | | |
| 20 | Private/incognito mode: app shows the "isn't letting the app save books" notice instead of failing silently | | |

## Known platform limits

- **iOS has no share target or file association for web apps.** iPhone users import through *Add a book* (Files, iCloud Drive, Downloads) or a link.
- **iOS may evict web storage** for sites not opened in ~7 days unless the app is installed to the Home Screen. Installing is the main protection; `navigator.storage.persist()` is also requested after the first import.
- **Link import is subject to CORS.** Downloading a `.gab` from another site only works if that host allows cross-origin requests (GitHub Pages, GitHub raw and most CDNs do; Google Drive and Dropbox share pages don't). Hosting `.gab` files next to the app always works.
