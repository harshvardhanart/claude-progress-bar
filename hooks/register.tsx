import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { LimitWindow, Limits, Task, Timing, Usage, WindowLedger } from '../types'

const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 }

const tasks = atom({ plugin: 'task-progress', key: 'tasks' } as const, [])
const isHidden = atom({ plugin: 'task-progress', key: 'isHidden' } as const, false)
const timing = atom({ plugin: 'task-progress', key: 'timing' } as const, null)
const usage = atom({ plugin: 'task-progress', key: 'usage' } as const, NO_USAGE)
const limitsAtom = atom({ plugin: 'task-progress', key: 'limits' } as const, {})
const sessionLedger = atom({ plugin: 'task-progress', key: 'sessionLedger' } as const, {})

// ---- Plan limits (5-hour and weekly) -------------------------------------
//
// The API only reports the ACCOUNT's % used of each window. A project's share
// is the rise in that % between readings, credited to whichever project made
// the reading. The last reading is shared by every chat (in $.store), so two
// chats never both claim the same rise. Chats running at the same moment can
// still credit each other a little: the figures are close, not exact.

/** The windows the bar shows, by the API's kind. */
const WINDOWS = { five_hour: 'fiveHour', seven_day: 'weekly' } as const
type WindowKind = keyof typeof WINDOWS

export type LimitReading = { kind: string; percentUsed: number; resetsAt?: string }

/** Everything kept across chats: the last reading per window, and each project's share. */
export type LimitStore = {
  last: Record<string, { percent: number; resetsAt?: number }>
  projects: Record<string, WindowLedger>
}

const STORE_KEY = 'limits'

function isKind(kind: string): kind is WindowKind {
  return kind in WINDOWS
}

function parseTime(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? undefined : ms
}

/** Two reset times name the same window when they are within half an hour (the API's stamp can drift). */
function sameWindow(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return Math.abs(a - b) < 30 * 60_000
}

const round1 = (n: number) => Math.round(n * 10) / 10

export function readStore(raw: unknown): LimitStore {
  const v = (raw ?? {}) as Partial<LimitStore>
  return { last: { ...(v.last ?? {}) }, projects: { ...(v.projects ?? {}) } }
}

/**
 * Folds one set of readings into the store and this chat's ledger. With
 * `attribute` false (a chat just opened) it only notes the readings: the rise
 * since the last one happened somewhere else.
 */
export function applyReadings(
  store: LimitStore,
  chat: WindowLedger,
  project: string,
  readings: readonly LimitReading[],
  attribute: boolean,
): { store: LimitStore; chat: WindowLedger; limits: Limits } {
  const last = { ...store.last }
  const mine: WindowLedger = { ...(store.projects[project] ?? {}) }
  const ours: WindowLedger = { ...chat }

  for (const r of readings) {
    if (!isKind(r.kind)) continue
    const resetsAt = parseTime(r.resetsAt)
    const prev = last[r.kind]

    let rise = 0
    if (attribute && prev !== undefined) {
      if (sameWindow(prev.resetsAt, resetsAt)) rise = Math.max(0, r.percentUsed - prev.percent)
      else if ((resetsAt ?? 0) > (prev.resetsAt ?? 0)) rise = r.percentUsed // a new window began
    }

    const credit = (ledger: WindowLedger) => {
      const entry = ledger[r.kind]
      const base = entry !== undefined && sameWindow(entry.resetsAt, resetsAt) ? entry.used : 0
      ledger[r.kind] = { used: Math.min(r.percentUsed, round1(base + rise)), resetsAt }
    }
    credit(mine)
    credit(ours)

    // Never step the shared reading back: a stale reading from a slower chat is lower.
    const isOlder = prev !== undefined && sameWindow(prev.resetsAt, resetsAt) && r.percentUsed < prev.percent
    if (!isOlder) last[r.kind] = { percent: r.percentUsed, resetsAt }
  }

  const next: LimitStore = { last, projects: { ...store.projects, [project]: mine } }
  return { store: next, chat: ours, limits: limitsFrom(next, ours, project) }
}

/** The bar's view: account total, this project's share and this chat's share, for each window still current. */
export function limitsFrom(store: LimitStore, chat: WindowLedger, project: string): Limits {
  const out: Limits = {}
  for (const kind of Object.keys(WINDOWS) as WindowKind[]) {
    const last = store.last[kind]
    if (last === undefined) continue
    const share = (ledger: WindowLedger | undefined) => {
      const e = ledger?.[kind]
      return e !== undefined && sameWindow(e.resetsAt, last.resetsAt) ? e.used : 0
    }
    const w: LimitWindow = { total: last.percent, mine: share(store.projects[project]), session: share(chat), resetsAt: last.resetsAt }
    out[WINDOWS[kind]] = w
  }
  return out
}

async function recordLimits($: EngineInterface, readings: readonly LimitReading[], attribute: boolean) {
  const project = await $.session.root()
  const store = readStore(await $.store.get(STORE_KEY))
  const chat = await read($, sessionLedger)
  const result = applyReadings(store, chat, project, readings, attribute)
  await $.store.set(STORE_KEY, result.store)
  await update($, sessionLedger, () => result.chat)
  await update($, limitsAtom, () => result.limits)
}

export function fmtPct(n: number): string {
  return n < 10 ? `${n.toFixed(1)}%` : `${Math.round(n)}%`
}

/** "2h 14m", "3d 4h", "12m": how long until a window resets. */
export function fmtIn(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m % 60}m`
  return `${m}m`
}

/** Every token the model calls processed: fresh input, cache reads and writes, and output. */
export function totalTokens(u: Usage): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite
}

export function fmtTok(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`
}

export function addUsage(
  u: Usage,
  r: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number },
): Usage {
  return {
    input: u.input + r.input_tokens,
    output: u.output + r.output_tokens,
    cacheRead: u.cacheRead + r.cache_read_input_tokens,
    cacheWrite: u.cacheWrite + r.cache_creation_input_tokens,
    calls: u.calls + 1,
  }
}

const WIDTH = 20

export function bar(done: number, total: number, width = WIDTH): string {
  const filled = total === 0 ? 0 : Math.round((done / total) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export function fmt(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`
  return `${sec}s`
}

export function summarize(list: Task[], t: Timing | null) {
  const total = list.length
  const done = list.filter(x => x.status === 'completed').length
  const active = list.find(x => x.status === 'in_progress')
  const pct = total === 0 ? 0 : Math.round((done / total) * 100)
  const now = t?.listEnd ?? t?.now ?? 0
  const elapsed = t ? now - t.listStart : 0
  const activeFor = active?.startedAt !== undefined && t ? t.now - active.startedAt : undefined
  // ETA: average time per finished task × tasks left.
  const eta = done > 0 && done < total ? (elapsed / done) * (total - done) : undefined
  return { total, done, pct, active, elapsed, activeFor, eta, now: t?.now ?? 0 }
}

/** Applies one status change, stamping start / finish times. */
function stamp(t: Task, status: Task['status'] | undefined, now: number): Task {
  if (status === undefined || status === t.status) return t
  return {
    ...t,
    status,
    startedAt: status === 'in_progress' ? (t.startedAt ?? now) : t.startedAt,
    doneAt: status === 'completed' ? now : undefined,
  }
}

let ticker: Timer | undefined

async function tick($: EngineInterface) {
  const n = await $.clock.now()
  await update($, timing, t => (t ? { ...t, now: n } : t))
  await showStatus($)
}

async function sync($: EngineInterface) {
  const now = await $.clock.now()
  const list = await read($, tasks)
  const allDone = list.length > 0 && list.every(x => x.status === 'completed')

  await update($, timing, t => {
    if (list.length === 0) return null
    const base = t ?? { listStart: now, listEnd: null, now }
    return { ...base, now, listEnd: allDone ? (base.listEnd ?? now) : null }
  })

  // Tick once a second while work is open, so the clock in the band moves.
  if (list.length > 0 && !allDone) {
    ticker ??= $.clock.every(1000, () => void tick($))
  } else {
    ticker?.cancel()
    ticker = undefined
  }
  await showStatus($)
}

// Status line mirrors the band so it shows even when the band is hidden.
async function showStatus($: EngineInterface) {
  const list = await read($, tasks)
  const { total, done, pct, elapsed } = summarize(list, await read($, timing))
  const tokens = totalTokens(await read($, usage))
  const l = await read($, limitsAtom)
  const lim = [l.fiveHour ? `5h ${fmtPct(l.fiveHour.mine)}` : '', l.weekly ? `wk ${fmtPct(l.weekly.mine)}` : '']
    .filter(Boolean)
    .join(' · ')
  $.ui.status(
    total === 0
      ? undefined
      : `Tasks ${bar(done, total, 10)} ${done}/${total} (${pct}%)${lim ? ` · ${lim} this project` : ''} ⏱ ${fmt(elapsed)}${tokens > 0 ? ` · ${fmtTok(tokens)} tok` : ''}`,
  )
}

// A list that was finished and got replaced starts its clock over.
async function restartTimingIfNew($: EngineInterface) {
  const t = await read($, timing)
  const list = await read($, tasks)
  if (t?.listEnd != null && list.some(x => x.status !== 'completed')) {
    await update($, timing, () => null)
  }
}

type Listed = { id: string; subject: string; status: Task['status'] }[]

// Takes the tool's full list as the truth, keeping the times we stamped.
async function adopt($: EngineInterface, listed: Listed) {
  const now = await $.clock.now()
  await update($, tasks, list =>
    listed.map(t => {
      const old = list.find(o => o.id === t.id) ?? { id: t.id, subject: t.subject, status: 'pending' as const }
      return { ...stamp(old, t.status, now), subject: t.subject }
    }),
  )
  await sync($)
}

// A task we never saw (the list began before the plugin loaded): fetch them all.
async function catchUp($: EngineInterface) {
  const listed = await $.tool.call({ tool: 'TaskList' })
  if (listed.deny === undefined && listed.isError !== true) {
    await adopt($, listed.result.tasks)
  }
}

type Todo = { content: string; status: Task['status']; activeForm?: string }

// A whole list at once (TodoWrite, or this plugin's own progress tool).
/**
 * Whether `todos` begins a new run rather than continuing `prev`: nothing shown
 * yet, the last list finished, no step in common (a new job), or the same job
 * sent back with no step done (a restart).
 */
export function isFreshRun(prev: readonly Task[], todos: readonly Todo[]): boolean {
  if (prev.length === 0) return true
  if (prev.every(x => x.status === 'completed')) return true
  const prevSubjects = new Set(prev.map(x => x.subject))
  if (!todos.some(t => prevSubjects.has(t.content))) return true
  const doneBefore = prev.filter(x => x.status === 'completed').length
  return doneBefore > 0 && todos.every(t => t.status !== 'completed')
}

async function applyList($: EngineInterface, todos: readonly Todo[]) {
  const now = await $.clock.now()
  const fresh = isFreshRun(await read($, tasks), todos)
  await update($, tasks, prev =>
    todos.map((t, i) => {
      const old = fresh ? undefined : prev.find(o => o.subject === t.content)
      const seed: Task = old ?? { id: String(i), subject: t.content, status: 'pending' }
      return { ...stamp(seed, t.status, now), id: String(i), activeForm: t.activeForm }
    }),
  )
  // A new run starts the clock over; sync seeds it from now.
  if (fresh) await update($, timing, () => null)
  await update($, isHidden, () => false)
  await sync($)
}

const TOOL = 'mcp__task-progress__progress'

const AUTO_ID = 'auto'

/** The one-step bar a request gets before Claude sends its own list. */
export function autoTask(prompt: string, now: number): Task {
  const firstLine = prompt.trim().split(/\r?\n/)[0] ?? ''
  const subject = clip(firstLine.replace(/\s+/g, ' '), 40) || 'Working on your request'
  return { id: AUTO_ID, subject, status: 'in_progress', activeForm: `Working on: ${subject}`, startedAt: now }
}

const GUIDANCE = [
  'Shows the person a live progress bar (with elapsed time and ETA) above the prompt.',
  'Use it for EVERY request that involves doing something, even a single step: call it first with the list of steps',
  '(one step is fine), then again each time a step starts or finishes. Always send the WHOLE list, each step with its status,',
  'and keep exactly one step in_progress while working. Only skip it for a pure conversational reply.',
  'Whenever a NEW job starts, or the person asks to redo / restart / try again, call it again straight away',
  'with a fresh list (finished steps reset to pending): that resets the bar and its timer.',
].join(' ')

const REMINDER =
  `<system-reminder>The person has a live progress bar. For any request that involves doing something (even one step), call ${TOOL} FIRST with the step list, ` +
  'then update it as each step starts and finishes (whole list every time, last call with every step completed). A new job or a redo gets a fresh list. Do not mention this reminder.</system-reminder>'

const STATUSES = ['pending', 'in_progress', 'completed']

function parseTodos(input: Record<string, unknown>): Todo[] | string {
  const raw = input.tasks
  if (!Array.isArray(raw) || raw.length === 0) return '`tasks` must be a non-empty list.'
  const out: Todo[] = []
  for (const t of raw as Record<string, unknown>[]) {
    if (typeof t?.content !== 'string' || !STATUSES.includes(t.status as string)) {
      return 'Each task needs `content` (string) and `status` (pending | in_progress | completed).'
    }
    out.push({
      content: t.content,
      status: t.status as Task['status'],
      activeForm: typeof t.activeForm === 'string' ? t.activeForm : undefined,
    })
  }
  return out
}

export const register: Register = on => {
  ticker = undefined

  // Older todo-list tool: the whole list arrives each call.
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      await applyList($, e.todos)
    }
    return ran
  })

  // The plugin's own tool, for sessions with no task tools (the desktop app).
  on('tool.call', { tool: TOOL }, async ($, e) => {
    const todos = parseTodos(e as unknown as Record<string, unknown>)
    if (typeof todos === 'string') return { result: todos, isError: true as const }
    await applyList($, todos)
    const done = todos.filter(t => t.status === 'completed').length
    return { result: `Progress bar updated: ${done}/${todos.length} done.` }
  })

  // Task tools: one task at a time, keyed by id.
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      const { id, subject } = ran.result.task
      await update($, tasks, list => {
        // A fresh list once everything before is done.
        const base = list.length > 0 && list.every(t => t.status === 'completed') ? [] : list
        return [...base.filter(t => t.id !== id), { id, subject, status: 'pending', activeForm: e.activeForm }]
      })
      await restartTimingIfNew($)
      await update($, isHidden, () => false)
      await sync($)
    }
    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      if (!(await read($, tasks)).some(t => t.id === e.taskId)) {
        await catchUp($)
        return ran
      }
      const now = await $.clock.now()
      await update($, tasks, list => {
        if (e.status === 'deleted') return list.filter(t => t.id !== e.taskId)
        return list.map(t =>
          t.id !== e.taskId
            ? t
            : {
                ...stamp(t, e.status, now),
                subject: e.subject ?? t.subject,
                activeForm: e.activeForm ?? t.activeForm,
              },
        )
      })
      await sync($)
    }
    return ran
  })

  // TaskList returns the truth: resync from it, keeping our timestamps.
  on('tool.call', { tool: 'TaskList' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      await adopt($, ran.result.tasks)
    }
    return ran
  })

  // Every new request starts a bar of its own straight away: one step named after
  // the request, replaced as soon as Claude sends a real step list.
  on('prompt.submit', async ($, e, next) => {
    const list = await read($, tasks)
    const isIdle = list.length === 0 || list.every(t => t.status === 'completed')
    if (isIdle) {
      const now = await $.clock.now()
      await update($, tasks, () => [autoTask(e.text, now)])
      await update($, timing, () => null)
      await update($, usage, () => NO_USAGE)
      await update($, isHidden, () => false)
      await sync($)
    }
    // Remind the model on every prompt, so the bar shows up in every chat.
    return next({ ...e, context: [...(e.context ?? []), REMINDER] })
  })

  // Every model call (main loop and subagents) adds its tokens to the request's count.
  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    if (response.usage) {
      const used = response.usage
      await update($, usage, u => addUsage(u, used))
    }
    return response
  })

  // After each reply, and whenever a limit moves a whole point: credit the rise to this project and chat.
  on('session.measure', async ($, e, next) => {
    if (e.rateLimits.length > 0) await recordLimits($, e.rateLimits, true)
    return next(e)
  })

  // A turn that never sent a list still finishes its one-step bar.
  on('turn.complete', async ($, e, next) => {
    const list = await read($, tasks)
    if (list.length === 1 && list[0]?.id === AUTO_ID && list[0].status !== 'completed') {
      const now = await $.clock.now()
      await update($, tasks, l => l.map(t => stamp(t, 'completed', now)))
      await sync($)
    }
    return next(e)
  })

  // /progress brings a hidden bar back; /progress hide hides it.
  on('command.run', { command: 'progress' }, async ($, e) => {
    const wantsHide = /\bhide\b/i.test(e.args)
    await update($, isHidden, () => wantsHide)
    const list = await read($, tasks)
    if (wantsHide) return { text: 'Progress bar hidden. Type /progress to show it again.' }
    return {
      text:
        list.length === 0
          ? 'Progress bar is on. It shows up as soon as Claude starts a multi-step job.'
          : 'Progress bar is showing again.',
    }
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'progress',
      description: 'Show the progress bar again (or "/progress hide" to hide it)',
    })
    await $.tool.register({
      name: 'progress',
      description: GUIDANCE,
      inputSchema: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: 'The step, imperative ("Cut the intro")' },
                status: { type: 'string', enum: STATUSES },
                activeForm: { type: 'string', description: 'Present continuous ("Cutting the intro")' },
              },
              required: ['content', 'status'],
            },
          },
        },
        required: ['tasks'],
      },
      isDeferred: false,
    })
    // Show this project's figures straight away; the rise since the last reading was another chat's.
    try {
      const { rateLimits } = await $.session.usage()
      await recordLimits($, rateLimits, false)
    } catch {
      // No plan limits here (an API key, a gateway): the bar simply shows none.
    }
    await sync($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, tasks)
    if (e.props.hasSurvey || list.length === 0 || (await read($, isHidden))) {
      return next(e)
    }

    const s = summarize(list, await read($, timing))
    const { total, done, pct, active, elapsed, activeFor, eta } = s
    const used = await read($, usage)
    const tokens = totalTokens(used)
    const limits = await read($, limitsAtom)
    const allDone = done === total
    const hide = () => update($, isHidden, () => true)

    // Surfaces that draw SVG (desktop, mobile): a frosted-glass card.
    if (e.surface === 'desktop' || e.surface === 'mobile') {
      const { Box, Button, Svg } = $.ui.resolve(e)
      return (
        <Box flexDirection="row" alignItems="center">
          <Svg key="card" source={glassCard(s, used, limits)} alt={altText(s, used, limits)} />
          <Button key="hide" label="Hide" dimColor onPress={hide} />
        </Box>
      )
    }

    // Terminal: a gradient segmented bar.
    const { Box, Button, Text } = $.ui.resolve(e)
    const label = allDone
      ? `✓ all done in ${fmt(elapsed)} `
      : active
        ? `▶ ${active.activeForm ?? active.subject}${activeFor !== undefined ? ` (${fmt(activeFor)})` : ''} `
        : ''
    const filled = total === 0 ? 0 : Math.round((done / total) * WIDTH)
    const ramp = allDone ? DONE_RAMP : RAMP

    const limitText = (name: string, w: LimitWindow | undefined) =>
      w === undefined ? null : (
        <Text key={name}>
          <Text bold color="#a5b4fc">
            {name} {fmtPct(w.mine)}
          </Text>
          <Text dimColor>
            {' '}this project · {fmtPct(w.session)} this chat · account {fmtPct(w.total)}
            {w.resetsAt !== undefined && s.now > 0 ? ` · resets in ${fmtIn(w.resetsAt - s.now)}` : ''}
            {'   '}
          </Text>
        </Text>
      )

    return (
      <Box flexDirection="column">
        {limits.fiveHour || limits.weekly ? (
          <Box>
            {limitText('5-hour', limits.fiveHour)}
            {limitText('Weekly', limits.weekly)}
          </Box>
        ) : null}
        <Box>
        {Array.from({ length: WIDTH }, (_, i) => (
          <Text key={`s${i}`} color={i < filled ? ramp[Math.floor((i / WIDTH) * ramp.length)] : '#3b4252'}>
            {i < filled ? '▰' : '▱'}
          </Text>
        ))}
        <Text bold> {done}/{total} · {pct}% </Text>
        {allDone ? null : (
          <Text dimColor>
            ⏱ {fmt(elapsed)}
            {eta !== undefined ? ` · ~${fmt(eta)} left` : ''}{' '}
          </Text>
        )}
        {tokens > 0 ? <Text dimColor>🪙 {fmtTok(tokens)} tok </Text> : null}
        <Text dimColor>{label}</Text>
        <Text dimColor italic>
          {CREDIT}{' '}
        </Text>
        <Button key="hide" label="Hide" dimColor onPress={hide} />
        </Box>
      </Box>
    )
  })
}

const CREDIT = 'by Harsh Vardhan'

const RAMP = ['#22d3ee', '#38bdf8', '#60a5fa', '#818cf8', '#a78bfa', '#c084fc', '#e879f9']
const DONE_RAMP = ['#34d399', '#2dd4bf', '#22d3ee']

type Summary = ReturnType<typeof summarize>

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}


/** One line per window for the status line, terminal and screen readers. */
function limitLine(name: string, w: LimitWindow | undefined): string {
  if (w === undefined) return ''
  return `${name} ${fmtPct(w.mine)} this project (${fmtPct(w.session)} this chat, account ${fmtPct(w.total)})`
}

export function altText(s: Summary, u: Usage = NO_USAGE, l: Limits = {}): string {
  const time = s.done === s.total ? `all done in ${fmt(s.elapsed)}` : `${fmt(s.elapsed)} elapsed`
  const step = s.active ? `, now: ${s.active.activeForm ?? s.active.subject}` : ''
  const limits = [limitLine('5-hour limit', l.fiveHour), limitLine('weekly limit', l.weekly)].filter(Boolean).join('; ')
  const tokens = totalTokens(u) > 0 ? `, ${fmtTok(totalTokens(u))} tokens` : ''
  return `Progress ${s.done}/${s.total} · ${s.pct}%${limits ? `. ${limits}` : ''}. ${time}${tokens}${step}`
}

const FIVE_HOUR_RAMP = ['#22d3ee', '#818cf8']
const WEEKLY_RAMP = ['#a78bfa', '#e879f9']

/** One big limit panel: label + reset time, the project's % large, this chat's % beside it, and a meter. */
function limitPanel(id: string, x: number, width: number, top: number, label: string, ramp: string[], w: LimitWindow | undefined, now: number): string {
  if (w === undefined) {
    return `<text x="${x}" y="${top + 50}" font-size="19" fill="#a5b0d6" fill-opacity="0.7">${label}: shows after Claude's first reply</text>`
  }
  const meterY = top + 62
  const meterH = 10
  const px = (pct: number) => Math.round((Math.min(100, Math.max(0, pct)) / 100) * width)
  const totalW = px(w.total)
  const mineW = Math.min(totalW, Math.max(w.mine > 0 ? 6 : 0, px(w.mine)))
  const isHigh = w.total >= 80
  const resets = w.resetsAt !== undefined && now > 0 ? `resets in ${fmtIn(w.resetsAt - now)}` : ''
  return `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="${ramp[0]}"/><stop offset="100%" stop-color="${ramp[1]}"/></linearGradient></defs>
<text x="${x}" y="${top}" font-size="15" font-weight="700" letter-spacing="2" fill="#a5b0d6">${label}</text>
<text x="${x + width}" y="${top}" font-size="15" text-anchor="end" fill="#a5b0d6" fill-opacity="0.8">${resets}</text>
<text x="${x}" y="${top + 46}" fill="url(#${id})"><tspan font-size="46" font-weight="800">${fmtPct(w.mine)}</tspan><tspan dx="10" font-size="18" font-weight="500" fill="#c7d0f0">this project</tspan></text>
<text x="${x + width}" y="${top + 46}" font-size="19" text-anchor="end" fill="#c7d0f0"><tspan fill-opacity="0.75">this chat </tspan><tspan font-weight="700" fill="#ffffff">${fmtPct(w.session)}</tspan></text>
<rect x="${x}" y="${meterY}" width="${width}" height="${meterH}" rx="${meterH / 2}" fill="#ffffff" fill-opacity="0.08"/>
<rect x="${x}" y="${meterY}" width="${totalW}" height="${meterH}" rx="${meterH / 2}" fill="${isHigh ? '#f59e0b' : '#ffffff'}" fill-opacity="${isHigh ? 0.55 : 0.22}"/>
${mineW > 0 ? `<rect x="${x + totalW - mineW}" y="${meterY}" width="${mineW}" height="${meterH}" rx="${meterH / 2}" fill="url(#${id})"/>` : ''}
<text x="${x}" y="${meterY + 30}" font-size="15" fill="#a5b0d6" fill-opacity="0.85">account ${fmtPct(w.total)} used</text>`
}

/**
 * The desktop bar, no background: step and count on top, the progress bar, then
 * the 5-hour and weekly limits big, then time, credit and tokens small.
 */
export function glassCard(s: Summary, u: Usage = NO_USAGE, l: Limits = {}): string {
  const W = 900
  const H = 236
  const allDone = s.done === s.total
  const barY = 46
  const barH = 14
  const trackX = 4
  const trackW = W - 8
  const fillW = Math.max(s.pct > 0 ? barH : 0, Math.round((s.pct / 100) * trackW))
  const stops = allDone ? DONE_RAMP : ['#22d3ee', '#818cf8', '#e879f9']

  const left = allDone
    ? `✓ All done in ${fmt(s.elapsed)}`
    : s.active
      ? `${clip(s.active.activeForm ?? s.active.subject, 44)}${s.activeFor !== undefined ? ` · ${fmt(s.activeFor)}` : ''}`
      : 'Getting started'
  const time = allDone ? `⏱ ${fmt(s.elapsed)} total` : `⏱ ${fmt(s.elapsed)}${s.eta !== undefined ? ` · ~${fmt(s.eta)} left` : ''}`
  const tokens = totalTokens(u)
  const tokenText = tokens > 0 ? `🪙 ${fmtTok(tokens)} tokens · ${fmtTok(u.output)} out` : '🪙 counting tokens…'

  const gradStops = stops
    .map((c, i) => `<stop offset="${Math.round((i / (stops.length - 1)) * 100)}%" stop-color="${c}"/>`)
    .join('')
  const mid = barY + barH / 2
  const panelTop = 100
  const panelW = (W - 8 - 40) / 2

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Inter, 'Segoe UI', system-ui, sans-serif">
<defs>
  <linearGradient id="fill" x1="0" y1="0" x2="1" y2="0">${gradStops}</linearGradient>
  <linearGradient id="track" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#ffffff" stop-opacity="0.14"/>
    <stop offset="100%" stop-color="#ffffff" stop-opacity="0.05"/>
  </linearGradient>
  <linearGradient id="shine" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0%" stop-color="#ffffff" stop-opacity="0"/>
    <stop offset="50%" stop-color="#ffffff" stop-opacity="0.6"/>
    <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
  </linearGradient>
  <filter id="glow" x="-10%" y="-150%" width="120%" height="400%"><feGaussianBlur stdDeviation="6"/></filter>
  <clipPath id="bar"><rect x="${trackX}" y="${barY}" width="${fillW}" height="${barH}" rx="${barH / 2}"/></clipPath>
</defs>
<text x="${trackX}" y="31" font-size="26" font-weight="600" fill="#f1f5ff">${esc(left)}</text>
<text x="${W - 4}" y="31" font-size="24" font-weight="800" text-anchor="end" fill="#ffffff">${s.done}/${s.total} · ${s.pct}%</text>
<rect x="${trackX}" y="${barY}" width="${trackW}" height="${barH}" rx="${barH / 2}" fill="url(#track)" stroke="#ffffff" stroke-opacity="0.12"/>
${fillW > 0 ? `<rect x="${trackX}" y="${barY}" width="${fillW}" height="${barH}" rx="${barH / 2}" fill="url(#fill)" filter="url(#glow)" opacity="0.8"/>
<rect x="${trackX}" y="${barY}" width="${fillW}" height="${barH}" rx="${barH / 2}" fill="url(#fill)"/>
<rect x="${trackX + 6}" y="${barY + 3}" width="${Math.max(0, fillW - 12)}" height="${barH / 3}" rx="${barH / 6}" fill="#ffffff" fill-opacity="0.3"/>
<g clip-path="url(#bar)"><rect y="${barY}" width="160" height="${barH}" fill="url(#shine)"><animate attributeName="x" from="${trackX - 160}" to="${trackX + fillW}" dur="2.4s" repeatCount="indefinite"/></rect></g>` : ''}
${fillW > 0 && !allDone ? `<circle cx="${trackX + fillW - barH / 2}" cy="${mid}" r="5" fill="#ffffff"><animate attributeName="r" values="4;7;4" dur="1.6s" repeatCount="indefinite"/><animate attributeName="fill-opacity" values="1;0.6;1" dur="1.6s" repeatCount="indefinite"/></circle>` : ''}
${limitPanel('lim5h', trackX, panelW, panelTop, '5-HOUR LIMIT', FIVE_HOUR_RAMP, l.fiveHour, s.now)}
${limitPanel('limwk', trackX + panelW + 40, panelW, panelTop, 'WEEKLY LIMIT', WEEKLY_RAMP, l.weekly, s.now)}
<text x="${trackX}" y="${H - 8}" font-size="16" fill="#a5b0d6" fill-opacity="0.85">${esc(time)}</text>
<text x="${W / 2}" y="${H - 8}" font-size="14" font-style="italic" letter-spacing="0.5" text-anchor="middle" fill="#ffffff" fill-opacity="0.38">${CREDIT}</text>
<text x="${W - 4}" y="${H - 8}" font-size="16" text-anchor="end" fill="#fbbf24" fill-opacity="0.85">${esc(tokenText)}</text>
</svg>`
}
