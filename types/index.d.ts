export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export type Task = {
  id: string
  subject: string
  status: TaskStatus
  activeForm?: string
  /** ms epoch when it went in_progress */
  startedAt?: number
  /** ms epoch when it went completed */
  doneAt?: number
}

export type Timing = {
  /** ms epoch the list began */
  listStart: number
  /** ms epoch the last task completed, null while running */
  listEnd: number | null
  /** last clock tick, ms epoch: the band redraws on each write */
  now: number
}

/** Tokens the current request has used so far, summed over every model call (subagents included). */
export type Usage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  calls: number
}

/** One plan limit window as the bar shows it. */
export type LimitWindow = {
  /** Account-wide % of the window used (all projects, all chats). */
  total: number
  /** % of the window this project used since the window began (all its chats). */
  mine: number
  /** % of the window this chat used. */
  session: number
  /** When the window resets, ms epoch; absent when the API gave none. */
  resetsAt?: number
}

/** How much of each window (by kind: five_hour, seven_day) was used, and which window that was. */
export type WindowLedger = Record<string, { used: number; resetsAt?: number }>

/** The 5-hour and weekly plan limits, for the current project. */
export type Limits = {
  fiveHour?: LimitWindow
  weekly?: LimitWindow
}

declare module 'claude-code' {
  interface PluginState {
    'task-progress': {
      tasks: Task[]
      isHidden: boolean
      timing: Timing | null
      usage: Usage
      limits: Limits
      /** This chat's own share of each window, by window kind. */
      sessionLedger: WindowLedger
    }
  }
}
