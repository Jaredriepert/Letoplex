// Small per-device UI preferences. localStorage can be unavailable (private
// mode, blocked storage), so every access is guarded and failures are ignored.
const PREFIX = 'graphic-adventure:'

export const readFlag = (name: string) => {
  try {
    return localStorage.getItem(PREFIX + name) === '1'
  } catch {
    return false
  }
}

export const writeFlag = (name: string) => {
  try {
    localStorage.setItem(PREFIX + name, '1')
  } catch {
    // Not persisted; the user will just see the hint again next time.
  }
}
