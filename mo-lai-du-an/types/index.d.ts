// A project folder Claude Code has worked in on this computer.
export type Project = {
  cwd: string
  title: string
  lastAt: number
  sid: string
  file: string
  hasClaudeMd: boolean
}

export type View = {
  projects: Project[] | null
  selected: string[] // cwd of the ticked projects
  withContext: boolean
  isLoading: boolean
  isOpening: boolean
  note?: string
  isError?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'mo-lai-du-an': { view: Shaped<View>; ready: boolean }
    // Watched, not written: the thong-ke-token row's 📂 button bumps it.
    'thong-ke-token': { projOpen: number }
  }
}
