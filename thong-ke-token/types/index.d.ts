export type Tally = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  activeMs: number
}

export type Scan = {
  monthStart: number
  scannedAt: number
  month: Tally & { sessions: number }
  session: Tally
  // Tokens per day of the month, the 1st first, up to today (absent before 1.1).
  days?: number[]
}

export type ScanState = { result: Scan | null; isRunning: boolean; error?: string }

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Live = { startedAt: number; costUsd?: number; limits: Limit[] }

// Read-only view of the tele-bridge mod's state, so this mod can draw its
// button in the same row (that mod owns and writes it).
export type TeleBridge = { isOn: boolean; loopId: string; pairCode?: string; lastError?: string }

declare module 'claude-code' {
  interface PluginState {
    'thong-ke-token': {
      scan: Shaped<ScanState>
      live: Shaped<Live | null>
      // Bumped by the Tele button; tele-bridge hooks its state.set and opens
      // its pane (no slash command, so nothing is written to the chat).
      teleOpen: number
      // The daily chart shows the whole month instead of the last 7 days.
      allDays: boolean
      // Bumped by the 📂 button; the mo-lai-du-an mod opens its pane.
      projOpen: number
    }
    // null here: unset until that mod has loaded (or when it is not installed).
    'tele-bridge': { bridge: Shaped<TeleBridge | null> }
    // True once the mo-lai-du-an mod has loaded (read only, to show 📂).
    'mo-lai-du-an': { ready: boolean }
  }
}
