# Book Package Format (v1)

A book is a **package**: a `book.json` file plus the page images it references. The reader imports packages in three forms:

| Form | Best for | Notes |
| --- | --- | --- |
| `.gab` file | Phones, sharing | A standard zip archive renamed `.gab`. Installed apps can register as the opener for `.gab`. |
| `.zip` file | Phones, sharing | Same contents as `.gab`. |
| Folder | Computers, authoring | A folder that contains `book.json`. Folder picking is unreliable on phones. |

`book.json` may sit at the archive root or inside a single top-level folder (`my-book/book.json`). The shallowest `book.json` marks the package root. Hidden files and `__MACOSX/` entries are ignored.

Layout example:

```text
my-book/
  book.json
  chapters/
    chapter-1/
      intro.png
      forest.png
    chapter-2/
      altar.png
```

To make a `.gab` from the folder above, zip the **contents** of `my-book/` (or the folder itself) and rename the result to `my-book.gab`.

## book.json

```json
{
  "format": "graphic-adventure-book",
  "version": 1,
  "id": "forest-of-echoes",
  "title": "Forest of Echoes",
  "author": "Story Forge Studio",
  "description": "A short branching walk through a whispering forest.",
  "startPageId": "intro",
  "cover": "chapters/chapter-1/intro.png",
  "fit": "contain",
  "chapters": [
    {
      "id": "chapter-1",
      "title": "The Lantern Gate",
      "pages": [
        {
          "id": "intro",
          "title": "The Lantern Gate",
          "image": "chapters/chapter-1/intro.png",
          "description": "A stone gate stands in the fog.",
          "position": { "x": 0, "y": 0 },
          "directions": { "up": null, "down": "river", "left": null, "right": "forest" }
        }
      ]
    }
  ]
}
```

### Book fields

| Field | Required | Meaning |
| --- | --- | --- |
| `format` | Recommended | Always `"graphic-adventure-book"`. Any other value is rejected. |
| `version` | Recommended | Schema version, currently `1`. Books with a higher version are rejected with a "needs a newer app" message. |
| `id` | Recommended | Stable identifier, used to detect re-imports of the same book. Slugified (`a-z`, `0-9`, `-`). Defaults to the slugified title. |
| `title` | Yes | Book title. |
| `author` | No | Defaults to "Unknown Author". |
| `description` | No | Shown on the chapter screen. |
| `startPageId` | Yes | The page "Start reading" opens. Defaults to the first page of the first chapter, with a warning. |
| `cover` | No | Image path for the library card. Defaults to the start page image. |
| `fit` | No | `"contain"` (default: whole page visible, letterboxed) or `"cover"` (fills the screen, edges may be cropped). |
| `chapters` | Yes | Chapters in reading order. Order in this array is the chapter order. |

### Chapter fields

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | Recommended | Unique within the book. Defaults to the slugified title. |
| `title` | Yes | Chapter title. |
| `pages` | Yes | Pages in authored order. The first page is where "open this chapter" lands. Empty chapters are skipped. |

### Page fields

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | Yes | Unique across the **whole book**. |
| `title` | No | Shown in the reader's top bar. Defaults to the id. |
| `image` | Yes | Package-relative image path. |
| `description` | No | Used as the image's alt text and shown if the image fails to load. |
| `position` | No | `{ x, y }` grid position, reserved for the future editor. The reader ignores it. |
| `directions` | No | `up`, `down`, `left`, `right`: each a page id or `null`. Missing directions are `null`. |

### Images and paths

- Paths are relative to the package root and use `/`. `./` prefixes and `\` separators are normalized.
- Absolute paths, URLs (`https:`, `data:`), and `..` segments are rejected.
- Supported types: PNG, JPEG, WebP, GIF, AVIF, SVG.
- Portrait images around 1080×1920 suit phones. Keep individual images under 64 MB and the whole package under 1 GB. In practice, a few MB per page is plenty.

## Validation

An import fails, listing every problem, if:

- `book.json` is missing or isn't valid JSON
- `format` is unknown or `version` is newer than the app supports
- there are no chapters or no pages
- a page has no `id` or no `image`, or an id is used twice
- a direction points to a page id that doesn't exist
- `startPageId` names a missing page
- an image path is unsafe, an unsupported type, or missing from the package

Warnings (the import still succeeds and the user can view them) cover defaults that were filled in and older layouts that were converted.

## Older layouts

Books written before v1 still import:

- **Nested chapters without `format`/`version`** are read as v1.
- **A flat `pages` array**, where each page has a `chapter` label, is grouped into chapters in the order the labels first appear.

New books should use the v1 layout above. The parser lives in [src/book/schema.ts](../src/book/schema.ts) and the package reader in [src/book/package.ts](../src/book/package.ts).

## Behaviour notes for authors

- **Swipes drag the page like paper.** Swiping your finger left moves to the `right` page. Tapping near the right edge, tapping the right arrow, or pressing → also moves `right`.
- Arrows appear only for directions that have a target. A page with no directions shows an "end of this path" card.
- A chapter unlocks on the chapter screen once the reader reaches any page in it.
