import { InstallHint } from '../components/InstallHint'
import type { LibraryEntry } from '../library/library'
import { useAssetUrl } from '../library/useImages'
import type { Progress } from '../storage/db'

type Props = {
  entries: LibraryEntry[]
  progress: Record<string, Progress>
  loading: boolean
  storageError: boolean
  onOpen: (bookId: string) => void
  onContinue: (bookId: string) => void
  onImport: () => void
  onBookActions: (bookId: string) => void
}

function BookCard({
  entry,
  canContinue,
  onOpen,
  onContinue,
  onActions,
}: {
  entry: LibraryEntry
  canContinue: boolean
  onOpen: () => void
  onContinue: () => void
  onActions: () => void
}) {
  const cover = useAssetUrl(entry, entry.book.cover)

  return (
    <article className="book-card">
      <button type="button" className="book-card-main" onClick={onOpen}>
        <div className="book-cover">{cover && <img src={cover} alt="" draggable={false} />}</div>
        <div className="book-card-copy">
          <strong>{entry.book.title}</strong>
          <span>{entry.book.author}</span>
        </div>
      </button>
      <div className="book-card-actions">
        {canContinue ? (
          <button type="button" className="pill-button" onClick={onContinue}>
            Continue
          </button>
        ) : (
          <button type="button" className="pill-button" onClick={onOpen}>
            Start
          </button>
        )}
        <button type="button" className="icon-button" aria-label={`More options for ${entry.book.title}`} onClick={onActions}>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <circle cx="5" cy="12" r="2" fill="currentColor" />
            <circle cx="12" cy="12" r="2" fill="currentColor" />
            <circle cx="19" cy="12" r="2" fill="currentColor" />
          </svg>
        </button>
      </div>
    </article>
  )
}

export function Library({ entries, progress, loading, storageError, onOpen, onContinue, onImport, onBookActions }: Props) {
  return (
    <div className="library-screen">
      <header className="library-header">
        <div>
          <p className="section-label">Library</p>
          <h1>My Books</h1>
        </div>

        <button type="button" className="primary-button" onClick={onImport}>
          Add a book
        </button>
      </header>

      <InstallHint />

      {storageError && (
        <p className="notice" role="status">
          This browser isn't letting the app save books (private browsing can do this). You can still read, but imported books will be gone when you
          close the page.
        </p>
      )}

      <div className="book-grid" aria-busy={loading}>
        {entries.map((entry) => {
          const lastPageId = progress[entry.book.id]?.lastPageId
          return (
            <BookCard
              key={entry.book.id}
              entry={entry}
              canContinue={Boolean(lastPageId && entry.book.pages[lastPageId])}
              onOpen={() => onOpen(entry.book.id)}
              onContinue={() => onContinue(entry.book.id)}
              onActions={() => onBookActions(entry.book.id)}
            />
          )
        })}
      </div>

      <p className="library-footnote">Books and reading progress are saved only on this device.</p>
    </div>
  )
}
