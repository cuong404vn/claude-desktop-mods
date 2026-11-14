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
    }
    // null here: unset until that mod has loaded (or when it is not installed).
    'tele-bridge': { bridge: Shaped<TeleBridge | null> }
  }
}
