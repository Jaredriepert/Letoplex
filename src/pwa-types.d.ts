// File Handling API (installed PWAs on Chromium). Not yet in TypeScript's DOM lib.
interface LaunchParams {
  readonly files?: readonly FileSystemFileHandle[]
}

interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void | Promise<void>): void
}

interface Window {
  readonly launchQueue?: LaunchQueue
}

// Install prompt event (Chromium only).
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

interface WindowEventMap {
  beforeinstallprompt: BeforeInstallPromptEvent
}
