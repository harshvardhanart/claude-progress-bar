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

declare module 'claude-code' {
  interface PluginState {
    'task-progress': { tasks: Task[]; isHidden: boolean; timing: Timing | null; usage: Usage }
  }
}
