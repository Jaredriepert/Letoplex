import { useEffect, useState } from 'react'
import type { Draft } from '../editor/draft'
import { useDraftImage } from '../editor/useDraftImage'
import { listDrafts } from '../storage/db'
import { HomeTabs, type HomeTab } from './Library'

type Props = {
  onSwitchTab: (tab: HomeTab) => void
  onNewDraft: () => void
  onCopySample: () => void
  onOpenDraft: (draftId: string) => void
  onDeleteDraft: (draftId: string) => void
  /** Changes when drafts are added or removed elsewhere, to reload the list. */
  refreshKey: number
}

const timeAgo = (time: number) => {
  const minutes = Math.round((Date.now() - time) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return days < 30 ? `${days} day${days === 1 ? '' : 's'} ago` : new Date(time).toLocaleDateString()
}

function DraftCard({ draft, onOpen, onDelete }: { draft: Draft; onOpen: () => void; onDelete: () => void }) {
  const { book } = draft
  const coverPath = book.cover || book.pages[book.startPageId]?.image || ''
  const cover = useDraftImage(draft.id, coverPath)
  const [confirming, setConfirming] = useState(false)
  const pageCount = Object.keys(book.pages).length

  return (
    <article className="book-card">
      <button type="button" className="book-card-main" onClick={onOpen}>
        <div className="book-cover">{cover && <img src={cover} alt="" draggable={false} />}</div>
        <div className="book-card-copy">
          <strong>{book.title || 'Untitled book'}</strong>
          <span className="draft-card-meta">
            {pageCount} page{pageCount === 1 ? '' : 's'} · edited {timeAgo(draft.updatedAt)}
          </span>
        </div>
      </button>
      <div className="book-card-actions">
        {confirming ? (
          <>
            <button type="button" className="danger-button compact" onClick={onDelete}>
              Delete
            </button>
            <button type="button" className="link-button" onClick={() => setConfirming(false)}>
              Keep
            </button>
          </>
        ) : (
          <>
            <button type="button" className="pill-button" onClick={onOpen}>
              Edit
            </button>
            <button type="button" className="icon-button" aria-label={`Delete draft ${book.title}`} onClick={() => setConfirming(true)}>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </>
        )}
      </div>
    </article>
  )
}

export function Create({ onSwitchTab, onNewDraft, onCopySample, onOpenDraft, onDeleteDraft, refreshKey }: Props) {
  const [drafts, setDrafts] = useState<Draft[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    listDrafts()
      .then((items) => !cancelled && setDrafts(items.sort((a, b) => b.updatedAt - a.updatedAt)))
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  return (
    <div className="library-screen">
      <HomeTabs active="create" onSwitch={onSwitchTab} />
      <header className="library-header">
        <div>
          <p className="section-label">Create</p>
          <h1>My Drafts</h1>
        </div>
        <button type="button" className="primary-button" onClick={onNewDraft}>
          New book
        </button>
      </header>

      <p className="create-tips">
        Make your own branching book from your pictures. It's easiest on a computer, but works on phones too. Drafts save automatically on this
        device.
      </p>

      {failed && <p className="notice">Drafts can't be saved in this browser (private browsing can do this).</p>}

      {drafts && drafts.length === 0 && (
        <div className="library-empty">
          <p>No drafts yet.</p>
          <div className="chapter-actions" style={{ justifyContent: 'center' }}>
            <button type="button" className="primary-button" onClick={onNewDraft}>
              Start a new book
            </button>
            <button type="button" className="secondary-button" onClick={onCopySample}>
              Explore a copy of the sample
            </button>
          </div>
        </div>
      )}

      {drafts && drafts.length > 0 && (
        <div className="book-grid">
          {drafts.map((draft) => (
            <DraftCard key={draft.id} draft={draft} onOpen={() => onOpenDraft(draft.id)} onDelete={() => onDeleteDraft(draft.id)} />
          ))}
        </div>
      )}

      {drafts && drafts.length > 0 && (
        <p className="library-footnote">
          Drafts live only on this device. Export a .letoplex file to back one up or move it to another device.{' '}
          <button type="button" className="link-button" onClick={onCopySample}>
            Copy the sample to explore
          </button>
        </p>
      )}
    </div>
  )
}
