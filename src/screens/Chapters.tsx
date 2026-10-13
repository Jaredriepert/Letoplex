import { chapterIndexOf } from '../book/schema'
import type { LibraryEntry } from '../library/library'
import type { Progress } from '../storage/db'

type Props = {
  entry: LibraryEntry
  progress: Progress | undefined
  onBack: () => void
  onRead: (pageId: string) => void
}

export function Chapters({ entry, progress, onBack, onRead }: Props) {
  const { book } = entry
  const lastPageId = progress?.lastPageId && book.pages[progress.lastPageId] ? progress.lastPageId : null
  const unlocked = Math.max(progress?.unlockedChapterIndex ?? 0, chapterIndexOf(book, book.startPageId))
  const currentChapterIndex = lastPageId ? chapterIndexOf(book, lastPageId) : -1

  return (
    <div className="chapter-screen">
      <header className="chapter-header">
        <div>
          <p className="section-label">{book.author}</p>
          <h1>{book.title}</h1>
          {book.description && <p className="book-description">{book.description}</p>}
        </div>

        <button type="button" className="secondary-button" onClick={onBack}>
          Library
        </button>
      </header>

      <div className="chapter-actions">
        {lastPageId ? (
          <>
            <button type="button" className="primary-button" onClick={() => onRead(lastPageId)}>
              Continue: {book.pages[lastPageId].title}
            </button>
            <button type="button" className="secondary-button" onClick={() => onRead(book.startPageId)}>
              From the beginning
            </button>
          </>
        ) : (
          <button type="button" className="primary-button" onClick={() => onRead(book.startPageId)}>
            Start reading
          </button>
        )}
      </div>

      <div className="chapter-list">
        {book.chapters.map((chapter, index) => {
          const isUnlocked = index <= unlocked
          const isCurrent = index === currentChapterIndex

          return (
            <button
              key={chapter.id}
              type="button"
              className={`chapter-button ${isCurrent ? 'is-current' : ''} ${isUnlocked ? '' : 'is-locked'}`}
              disabled={!isUnlocked}
              onClick={() => onRead(chapter.pageIds[0])}
            >
              <span className="chapter-number">Chapter {index + 1}</span>
              <strong>{chapter.title}</strong>
              <small>
                {isUnlocked
                  ? `${chapter.pageIds.length} page${chapter.pageIds.length === 1 ? '' : 's'}${isCurrent ? ' · reading' : ''}`
                  : 'Reach it in the story to unlock'}
              </small>
            </button>
          )
        })}
      </div>
    </div>
  )
}
