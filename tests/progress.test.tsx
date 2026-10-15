import { expect, mock, test } from 'claude-code/testing'

import { addUsage, bar, fmt, fmtTok, glassCard, isFreshRun, summarize, totalTokens } from '../hooks/register'

type Drawn = { find: (q: { type: string; text?: RegExp }) => Promise<{ props: Record<string, unknown> } | undefined> }

// What the band shows: terminal Text, or the desktop glass card's SVG.
async function sees(ui: Drawn, re: RegExp): Promise<boolean> {
  if (await ui.find({ type: 'Text', text: re })) return true
  const svg = await ui.find({ type: 'Svg' })
  return svg !== undefined && (re.test(String(svg.props.alt)) || re.test(String(svg.props.source)))
}

test('bar and time formatting', async () => {
  expect(bar(1, 4, 8)).toBe('██░░░░░░')
  expect(bar(0, 0, 4)).toBe('░░░░')
  expect(fmt(5_000)).toBe('5s')
  expect(fmt(125_000)).toBe('2m 05s')
  expect(fmt(3_900_000)).toBe('1h 5m')
})

test('token usage adds up across model calls and shows on the bar', async () => {
  const none = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 }
  const step = { input_tokens: 1_200, output_tokens: 800, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 2_000 }
  const u = addUsage(addUsage(none, step), step)
  expect(u.calls).toBe(2)
  expect(totalTokens(u)).toBe(88_000)
  expect(fmtTok(950)).toBe('950')
  expect(fmtTok(4_321)).toBe('4.3k')
  expect(fmtTok(88_000)).toBe('88k')
  expect(fmtTok(1_234_567)).toBe('1.23M')

  const s = summarize([{ id: '0', subject: 'Cut reel', status: 'in_progress', startedAt: 0 }], { listStart: 0, listEnd: null, now: 65_000 })
  const svg = glassCard(s, u)
  expect(svg).toContain('🪙 88k tokens · 1.6k out')
  expect(svg).toContain('⏱ 1m 05s')
  expect(svg).toContain('by Harsh Vardhan')
})

test('new jobs and restarts count as a fresh run; progress updates do not', async () => {
  const prev = [
    { id: '0', subject: 'Cut reel', status: 'completed' as const },
    { id: '1', subject: 'Add captions', status: 'in_progress' as const },
  ]
  // Continuing the same list.
  expect(isFreshRun(prev, [{ content: 'Cut reel', status: 'completed' }, { content: 'Add captions', status: 'completed' }])).toBe(false)
  // A different job.
  expect(isFreshRun(prev, [{ content: 'Design thumbnail', status: 'in_progress' }])).toBe(true)
  // Same job, sent back with nothing done: a restart.
  expect(isFreshRun(prev, [{ content: 'Cut reel', status: 'in_progress' }, { content: 'Add captions', status: 'pending' }])).toBe(true)
  // Anything after a finished list.
  expect(isFreshRun([{ id: '0', subject: 'Cut reel', status: 'completed' }], [{ content: 'Cut reel', status: 'pending' }])).toBe(true)
})

test('a restart resets the timer and the bar, and a new message clears a finished bar', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  let reminded: readonly string[] = []
  on('prompt.submit', ($, e) => {
    reminded = e.context ?? []
    return { text: e.text, origin: e.origin, context: e.context }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  const call =(tasks: { content: string; status: string }[]) => $.tool.call({ tool: 'mcp__task-progress__progress', tasks })

  await call([{ content: 'Cut reel', status: 'completed' }, { content: 'Export', status: 'in_progress' }])
  await clock.advance(120_000)
  await call([{ content: 'Cut reel', status: 'in_progress' }, { content: 'Export', status: 'pending' }])
  await clock.advance(3_000)

  const ui = await $.ui.mount({ plugin: 'task-progress', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } })
  expect(await sees(ui, /0\/2 · 0%/)).toBe(true)
  expect(await sees(ui, /⏱ 3s/)).toBe(true)

  await call([{ content: 'Cut reel', status: 'completed' }, { content: 'Export', status: 'completed' }])
  expect(await sees(ui, /all done/)).toBe(true)
  await $.prompt.submit({ text: 'make a thumbnail now' })
  expect(await sees(ui, /all done/)).toBe(false)
  expect(reminded.some(c => c.includes('mcp__task-progress__progress'))).toBe(true)

  // The next job shows up again from zero.
  await call([{ content: 'Design thumbnail', status: 'in_progress' }, { content: 'Export', status: 'pending' }])
  expect(await sees(ui, /0\/2 · 0%/)).toBe(true)
})

test('every request gets a one-step bar straight away, replaced by a real list', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('prompt.submit', ($, e) => ({ text: e.text, origin: e.origin, context: e.context }))

  await $.prompt.submit({ text: 'rename the export file\nand keep the old one' })
  const ui = await $.ui.mount({ plugin: 'task-progress', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } })
  expect(await sees(ui, /0\/1 · 0%/)).toBe(true)
  expect(await sees(ui, /Working on: rename the export file/)).toBe(true)

  await $.tool.call({
    tool: 'mcp__task-progress__progress',
    tasks: [{ content: 'Rename file', status: 'completed' }, { content: 'Keep backup', status: 'in_progress' }],
  })
  expect(await sees(ui, /1\/2 · 50%/)).toBe(true)
})

test('summary computes ETA from average time per finished task', async () => {
  const s = summarize(
    [
      { id: '1', subject: 'a', status: 'completed' },
      { id: '2', subject: 'b', status: 'in_progress', startedAt: 50_000 },
      { id: '3', subject: 'c', status: 'pending' },
      { id: '4', subject: 'd', status: 'pending' },
    ],
    { listStart: 0, listEnd: null, now: 60_000 },
  )
  expect(s.done).toBe(1)
  expect(s.pct).toBe(25)
  expect(s.elapsed).toBe(60_000)
  expect(s.activeFor).toBe(10_000)
  expect(s.eta).toBe(180_000)
})

test("the plugin's own progress tool drives the bar (desktop sessions)", async ($, on) => {
  mock.clock(on, { now: 0 })
  const ran = await $.tool.call({
    tool: 'mcp__task-progress__progress',
    tasks: [
      { content: 'Cut reel', status: 'completed' },
      { content: 'Add captions', status: 'in_progress', activeForm: 'Adding captions' },
      { content: 'Export', status: 'pending' },
    ],
  })
  expect(ran.deny).toBeUndefined()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'task-progress', surface, component: 'AbovePrompt', props: { hasSurvey: false } })
    expect(await sees(ui, /1\/3 · 33%/)).toBe(true)
    expect(await sees(ui, /Adding captions/)).toBe(true)
    await ui.unmount()
  }
})

test('a list that began before the plugin loaded is picked up on the next update', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('tool.call', { tool: 'TaskUpdate' }, ($, e) => ({ result: { success: true, taskId: e.taskId, updatedFields: ['status'] } }))
  on('tool.call', { tool: 'TaskList' }, () => ({
    result: {
      tasks: [
        { id: '1', subject: 'Cut reel', status: 'completed' as const, blockedBy: [] },
        { id: '2', subject: 'Add captions', status: 'in_progress' as const, blockedBy: [] },
        { id: '3', subject: 'Export', status: 'pending' as const, blockedBy: [] },
      ],
    },
  }))

  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' })

  const ui = await $.ui.mount({ plugin: 'task-progress', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } })
  expect(await sees(ui, /1\/3 · 33%/)).toBe(true)
  expect(await sees(ui, /Add captions/)).toBe(true)
})

test('band shows progress and a live clock after the task tools run', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  let n = 0
  on('tool.call', { tool: 'TaskCreate' }, ($, e) => ({ result: { task: { id: String(++n), subject: e.subject } } }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('tool.call', { tool: 'TaskUpdate' }, ($, e) => ({ result: { success: true, taskId: e.taskId, updatedFields: ['status'] } }))

  await $.tool.call({ tool: 'TaskCreate', subject: 'Cut intro', description: '', activeForm: 'Cutting intro' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Add SFX', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
  await clock.advance(30_000)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' })
  await clock.advance(5_000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'task-progress', surface, component: 'AbovePrompt', props: { hasSurvey: false } })
    expect(await sees(ui, /1\/2 · 50%/)).toBe(true)
    expect(await sees(ui, /⏱ 35s · ~35s left/)).toBe(true)
    expect(await sees(ui, /Add SFX/)).toBe(true)
    if (surface === 'desktop') expect(String((await ui.find({ type: 'Svg' }))?.props.source)).toContain('url(#fill)')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'task-progress', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } })
  await ui.press({ key: 'hide' })
  expect(await ui.find({ type: 'Text', text: /1\/2/ })).toBeUndefined()

  // /progress brings it back.
  await $.command.run({ command: 'progress', args: '' })
  expect(await ui.find({ type: 'Text', text: /1\/2/ })).toBeDefined()
  await $.command.run({ command: 'progress', args: 'hide' })
  expect(await ui.find({ type: 'Text', text: /1\/2/ })).toBeUndefined()

  // Finishing the list stops the clock and says how long it took.
  await $.tool.call({ tool: 'TaskCreate', subject: 'Render', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '3', status: 'completed' })
  await clock.advance(60_000)
  expect(await ui.find({ type: 'Text', text: /all done in 35s/ })).toBeDefined()
})
