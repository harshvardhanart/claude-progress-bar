import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Task, Timing, Usage } from '../types'

const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 }

const tasks = atom({ plugin: 'task-progress', key: 'tasks' } as const, [])
const isHidden = atom({ plugin: 'task-progress', key: 'isHidden' } as const, false)
const timing = atom({ plugin: 'task-progress', key: 'timing' } as const, null)
const usage = atom({ plugin: 'task-progress', key: 'usage' } as const, NO_USAGE)

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
  return { total, done, pct, active, elapsed, activeFor, eta }
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
  $.ui.status(
    total === 0
      ? undefined
      : `Tasks ${bar(done, total, 10)} ${done}/${total} (${pct}%) ⏱ ${fmt(elapsed)}${tokens > 0 ? ` · ${fmtTok(tokens)} tokens` : ''}`,
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
    const allDone = done === total
    const hide = () => update($, isHidden, () => true)

    // Surfaces that draw SVG (desktop, mobile): a frosted-glass card.
    if (e.surface === 'desktop' || e.surface === 'mobile') {
      const { Box, Button, Svg } = $.ui.resolve(e)
      return (
        <Box flexDirection="row" alignItems="center">
          <Svg key="card" source={glassCard(s, used)} alt={altText(s, used)} />
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

    return (
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
        {tokens > 0 ? <Text color="#fbbf24">🪙 {fmtTok(tokens)} tokens </Text> : null}
        <Text dimColor>{label}</Text>
        <Text dimColor italic>
          {CREDIT}{' '}
        </Text>
        <Button key="hide" label="Hide" dimColor onPress={hide} />
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

export function altText(s: Summary, u: Usage = NO_USAGE): string {
  const time = s.done === s.total ? `all done in ${fmt(s.elapsed)}` : `${fmt(s.elapsed)} elapsed`
  const step = s.active ? `, now: ${s.active.activeForm ?? s.active.subject}` : ''
  const tokens = totalTokens(u) > 0 ? `, ${fmtTok(totalTokens(u))} tokens` : ''
  return `Progress ${s.done}/${s.total} · ${s.pct}%, ${time}${tokens}${step}`
}

/** A big, background-free glowing progress bar: label + count on top, thick gradient bar, then time and tokens below. */
export function glassCard(s: Summary, u: Usage = NO_USAGE): string {
  const W = 900
  const H = 116
  const allDone = s.done === s.total
  const barY = 52
  const barH = 18
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
  <filter id="glow" x="-10%" y="-150%" width="120%" height="400%"><feGaussianBlur stdDeviation="7"/></filter>
  <clipPath id="bar"><rect x="${trackX}" y="${barY}" width="${fillW}" height="${barH}" rx="${barH / 2}"/></clipPath>
</defs>
<text x="${trackX}" y="33" font-size="29" font-weight="600" fill="#f1f5ff">${esc(left)}</text>
<text x="${W - 4}" y="33" font-size="26" font-weight="800" text-anchor="end" fill="#ffffff">${s.done}/${s.total} · ${s.pct}%</text>
<text x="${trackX}" y="${H - 8}" font-size="23" fill="#a5b0d6">${esc(time)}</text>
<text x="${W - 4}" y="${H - 8}" font-size="23" text-anchor="end" fill="#fbbf24">${esc(tokenText)}</text>
<text x="${W / 2}" y="${H - 9}" font-size="15" font-style="italic" letter-spacing="0.5" text-anchor="middle" fill="#ffffff" fill-opacity="0.38">${CREDIT}</text>
<rect x="${trackX}" y="${barY}" width="${trackW}" height="${barH}" rx="${barH / 2}" fill="url(#track)" stroke="#ffffff" stroke-opacity="0.12"/>
${fillW > 0 ? `<rect x="${trackX}" y="${barY}" width="${fillW}" height="${barH}" rx="${barH / 2}" fill="url(#fill)" filter="url(#glow)" opacity="0.8"/>
<rect x="${trackX}" y="${barY}" width="${fillW}" height="${barH}" rx="${barH / 2}" fill="url(#fill)"/>
<rect x="${trackX + 6}" y="${barY + 3}" width="${Math.max(0, fillW - 12)}" height="${barH / 3}" rx="${barH / 6}" fill="#ffffff" fill-opacity="0.3"/>
<g clip-path="url(#bar)"><rect y="${barY}" width="160" height="${barH}" fill="url(#shine)"><animate attributeName="x" from="${trackX - 160}" to="${trackX + fillW}" dur="2.4s" repeatCount="indefinite"/></rect></g>` : ''}
${fillW > 0 && !allDone ? `<circle cx="${trackX + fillW - barH / 2}" cy="${mid}" r="6" fill="#ffffff"><animate attributeName="r" values="5;8;5" dur="1.6s" repeatCount="indefinite"/><animate attributeName="fill-opacity" values="1;0.6;1" dur="1.6s" repeatCount="indefinite"/></circle>` : ''}
</svg>`
}