export type Bridge = { isOn: boolean; loopId: string; pairCode?: string; lastError?: string }

export type Form = { chatId: string; token: string; note?: string; isError?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'tele-bridge': { bridge: Shaped<Bridge>; form: Shaped<Form> }
    // Watched, not written: the thong-ke-token row's Tele button bumps it.
    'thong-ke-token': { teleOpen: number }
  }
}
