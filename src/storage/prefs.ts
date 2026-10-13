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

const HIDDEN_BUILTINS = 'hidden-builtin-books'

/** Ids of built-in books the user removed from their library. */
export const readHiddenBuiltins = (): string[] => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PREFIX + HIDDEN_BUILTINS) ?? '[]')
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

export const writeHiddenBuiltins = (ids: string[]) => {
  try {
    localStorage.setItem(PREFIX + HIDDEN_BUILTINS, JSON.stringify(ids))
  } catch {
    // Not persisted; the sample reappears next visit.
  }
}
