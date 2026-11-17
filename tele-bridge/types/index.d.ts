// This session's link to Telegram. `pairCode` is unused since 1.1 (kept so
// the thong-ke-token button, which reads this state, stays compatible).
export type Bridge = {
  isOn: boolean
  loopId: string
  pairCode?: string
  lastError?: string
  name?: string
  // Also report work given at the computer (not only from Telegram).
  notifyAll?: boolean
  // Addresses of the running chat page (mirrored from the store for the pane).
  webUrls?: string[]
}

// What the 🟢 sessions keep in the shared store under `sess:<sessionId>`.
// `cwd`: the folder it runs in (the chat page groups agents' sessions by it).
export type SessionEntry = { name: string; at: number; busy?: boolean; cwd?: string }

// A Telegram message the polling session hands to another session.
export type Mail = { kind: 'text' | 'stop' | 'status'; text?: string; origin?: 'tele' | 'web' }

// The running chat page, as the leading session publishes it in the store.
export type WebInfo = { port: number; key: string; urls: string[]; sid: string }

export type Form = {
  chatId: string
  token: string
  note?: string
  isError?: boolean
  // The chat page's password, while being typed.
  webPassword?: string
  // The agent root, while being typed.
  rootInput?: string
  // Which settings card is expanded in the pane.
  open?: 'tele' | 'web' | 'agent'
}

declare module 'claude-code' {
  interface PluginState {
    'tele-bridge': { bridge: Shaped<Bridge>; form: Shaped<Form> }
    // Watched, not written: the thong-ke-token row's Tele button bumps it.
    'thong-ke-token': { teleOpen: number }
  }
}
