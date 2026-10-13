import { useEffect, useState } from 'react'
import { isIos, isStandalone } from '../pwa'
import { readFlag, writeFlag } from '../storage/prefs'

const DISMISSED_FLAG = 'install-hint-dismissed'

/** Suggests installing to the home screen, for full-screen reading and offline use. */
export function InstallHint() {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null)
  const [dismissed, setDismissed] = useState(() => readFlag(DISMISSED_FLAG) || isStandalone())

  useEffect(() => {
    const handlePrompt = (event: BeforeInstallPromptEvent) => {
      event.preventDefault()
      setInstallEvent(event)
    }
    const handleInstalled = () => setDismissed(true)
    window.addEventListener('beforeinstallprompt', handlePrompt)
    window.addEventListener('appinstalled', handleInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', handlePrompt)
      window.removeEventListener('appinstalled', handleInstalled)
    }
  }, [])

  const dismiss = () => {
    setDismissed(true)
    writeFlag(DISMISSED_FLAG)
  }

  if (dismissed || (!installEvent && !isIos())) {
    return null
  }

  return (
    <aside className="install-hint">
      <div>
        <strong>Read full screen, even offline</strong>
        {installEvent ? (
          <span>Install the app to your home screen.</span>
        ) : (
          <span>
            Tap <b>Share</b>, then <b>Add to Home Screen</b>.
          </span>
        )}
      </div>
      {installEvent && (
        <button
          type="button"
          className="pill-button"
          onClick={async () => {
            await installEvent.prompt()
            const { outcome } = await installEvent.userChoice
            setInstallEvent(null)
            if (outcome === 'accepted') {
              dismiss()
            }
          }}
        >
          Install
        </button>
      )}
      <button type="button" className="icon-button" aria-label="Dismiss" onClick={dismiss}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
      </button>
    </aside>
  )
}
