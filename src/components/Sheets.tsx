import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import type { Issue } from '../book/schema'
import { formatBytes, type LibraryEntry } from '../library/library'

/** Bottom sheet on phones, centred dialog on wider screens. */
export function Sheet({ title, onClose, children }: { title: string; onClose?: () => void; children: ReactNode }) {
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    panelRef.current?.focus()
    if (!onClose) {
      return undefined
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  return (
    <div className="sheet-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose?.()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={panelRef}>
        <div className="sheet-header">
          <h2>{title}</h2>
          {onClose && (
            <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  )
}

const useStorageEstimate = () => {
  const [estimate, setEstimate] = useState<{ usage: number; quota: number } | null>(null)
  useEffect(() => {
    navigator.storage
      ?.estimate?.()
      .then(({ usage, quota }) => usage !== undefined && quota !== undefined && setEstimate({ usage, quota }))
      .catch(() => undefined)
  }, [])
  return estimate
}

const supportsFolderPicker = () => 'webkitdirectory' in document.createElement('input')

export function ImportSheet({
  onClose,
  onFiles,
  onUrl,
  onSample,
}: {
  onClose: () => void
  onFiles: (files: File[]) => void
  onUrl: (url: string) => void
  onSample: () => void
}) {
  const fileRef = useRef<HTMLInputElement | null>(null)
  const folderRef = useRef<HTMLInputElement | null>(null)
  const [url, setUrl] = useState('')
  const estimate = useStorageEstimate()

  const handlePicked = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (files.length > 0) {
      onFiles(files)
    }
  }

  const submitUrl = (event: FormEvent) => {
    event.preventDefault()
    if (url.trim()) {
      onUrl(url.trim())
    }
  }

  return (
    <Sheet title="Add a book" onClose={onClose}>
      <div className="sheet-body">
        <button type="button" className="primary-button wide" onClick={() => fileRef.current?.click()}>
          Choose a book file
          <small>.gab or .zip, from Files, Downloads or Drive</small>
        </button>
        {/* No `accept` filter: iOS greys out unfamiliar extensions like .gab. */}
        <input ref={fileRef} type="file" hidden onChange={handlePicked} />

        {supportsFolderPicker() && (
          <>
            <button type="button" className="secondary-button wide" onClick={() => folderRef.current?.click()}>
              Choose a book folder
              <small>Best on a computer; a folder that contains book.json</small>
            </button>
            <input
              ref={folderRef}
              type="file"
              multiple
              hidden
              {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
              onChange={handlePicked}
            />
          </>
        )}

        <form className="url-form" onSubmit={submitUrl}>
          <label htmlFor="import-url">From a link</label>
          <div className="url-row">
            <input
              id="import-url"
              type="url"
              inputMode="url"
              placeholder="https://…/my-book.gab"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
            <button type="submit" className="secondary-button" disabled={!url.trim()}>
              Get
            </button>
          </div>
        </form>

        <button type="button" className="link-button" onClick={onSample}>
          No book yet? Try the Mosslight Mystery sample
        </button>

        <p className="sheet-note">
          Books are copied into this device's browser storage and never uploaded.
          {estimate && ` Using ${formatBytes(estimate.usage)} of about ${formatBytes(estimate.quota)} available.`}
        </p>
      </div>
    </Sheet>
  )
}

export function IssueList({ issues }: { issues: Issue[] }) {
  return (
    <ul className="issue-list">
      {issues.map((issue, index) => (
        <li key={index} className={`issue-${issue.level}`}>
          <span className="issue-tag">{issue.level === 'error' ? 'Problem' : 'Note'}</span>
          {issue.message}
        </li>
      ))}
    </ul>
  )
}

export function ReportSheet({ title, issues, onClose }: { title: string; issues: Issue[]; onClose: () => void }) {
  const hasErrors = issues.some((issue) => issue.level === 'error')
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="sheet-body">
        {hasErrors && <p>Fix these in the book package and import it again.</p>}
        <IssueList issues={issues} />
        <button type="button" className="primary-button wide" onClick={onClose}>
          OK
        </button>
      </div>
    </Sheet>
  )
}

export function DuplicateSheet({
  title,
  canReplace,
  onReplace,
  onKeepBoth,
  onCancel,
}: {
  title: string
  canReplace: boolean
  onReplace: () => void
  onKeepBoth: () => void
  onCancel: () => void
}) {
  return (
    <Sheet title="Already in your library" onClose={onCancel}>
      <div className="sheet-body">
        <p>
          You already have <b>{title}</b>.{' '}
          {canReplace ? 'Replace it with this copy? Your reading progress is kept.' : 'The built-in copy stays; you can add this one alongside it.'}
        </p>
        {canReplace && (
          <button type="button" className="primary-button wide" onClick={onReplace}>
            Replace
          </button>
        )}
        <button type="button" className={`${canReplace ? 'secondary' : 'primary'}-button wide`} onClick={onKeepBoth}>
          Keep both
        </button>
        <button type="button" className="link-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </Sheet>
  )
}

export function ConfirmLinkSheet({ url, onConfirm, onCancel }: { url: string; onConfirm: () => void; onCancel: () => void }) {
  let host = url
  try {
    host = new URL(url, window.location.href).host
  } catch {
    // Show the raw value.
  }
  return (
    <Sheet title="Add this book?" onClose={onCancel}>
      <div className="sheet-body">
        <p>
          This link wants to download a book from <b>{host}</b> into your library.
        </p>
        <button type="button" className="primary-button wide" onClick={onConfirm}>
          Download and add
        </button>
        <button type="button" className="link-button" onClick={onCancel}>
          Not now
        </button>
      </div>
    </Sheet>
  )
}

export function BookActionsSheet({
  entry,
  hasProgress,
  onClose,
  onResetProgress,
  onRemove,
}: {
  entry: LibraryEntry
  hasProgress: boolean
  onClose: () => void
  onResetProgress: () => void
  onRemove: () => void
}) {
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const { book } = entry
  const pageCount = Object.keys(book.pages).length

  return (
    <Sheet title={book.title} onClose={onClose}>
      <div className="sheet-body">
        <p className="sheet-note">
          {book.author} · {book.chapters.length} chapter{book.chapters.length === 1 ? '' : 's'} · {pageCount} page{pageCount === 1 ? '' : 's'}
          {entry.builtin ? ' · Built in' : ` · ${formatBytes(entry.sizeBytes)} on this device`}
        </p>

        <button type="button" className="secondary-button wide" disabled={!hasProgress} onClick={onResetProgress}>
          Start over
          <small>Forget reading progress and lock later chapters again</small>
        </button>

        {!entry.builtin &&
          (confirmingRemove ? (
            <div className="confirm-row">
              <p>Remove this book and its pictures from this device?</p>
              <button type="button" className="danger-button wide" onClick={onRemove}>
                Yes, remove it
              </button>
              <button type="button" className="link-button" onClick={() => setConfirmingRemove(false)}>
                Keep it
              </button>
            </div>
          ) : (
            <button type="button" className="secondary-button wide" onClick={() => setConfirmingRemove(true)}>
              Remove from this device
            </button>
          ))}
      </div>
    </Sheet>
  )
}

export function BusyOverlay({ message }: { message: string }) {
  return (
    <div className="busy-overlay" role="status" aria-live="polite">
      <div className="busy-card">
        <span className="spinner" aria-hidden="true" />
        {message}
      </div>
    </div>
  )
}

export type ToastMessage = { id: number; text: string; action?: { label: string; run: () => void } }

export function Toast({ toast, onDismiss }: { toast: ToastMessage; onDismiss: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, toast.action ? 7000 : 4000)
    return () => window.clearTimeout(timer)
  }, [toast, onDismiss])

  return (
    <div className="toast" role="status" aria-live="polite">
      <span>{toast.text}</span>
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            toast.action?.run()
            onDismiss()
          }}
        >
          {toast.action.label}
        </button>
      )}
    </div>
  )
}
