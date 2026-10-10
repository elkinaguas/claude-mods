import type { On, RenderElement } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'

const props = (over: { hasSurvey?: boolean; isWorking?: boolean } = {}) => ({
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 9 },
  view: {},
  ...over,
})

test('draws the pixel band above the prompt on the terminal', async $ => {
  const ui = await $.ui.mount({ plugin: 'pixelbar', surface: 'terminal', component: 'AbovePrompt', props: props() })
  const bar = await ui.find({ key: 'bar' })
  expect(bar).toBeDefined()
  expect(await ui.drawn()).toMatchObject({ type: 'Raster', props: { columns: 120, rows: 4 } })
})

test('draws while a turn is running', async $ => {
  const ui = await $.ui.mount({ plugin: 'pixelbar', surface: 'terminal', component: 'AbovePrompt', props: props({ isWorking: true }) })
  expect(await ui.find({ key: 'bar' })).toBeDefined()
})

const measure = (percent: number) => ({
  context: { window: 200_000, tokens: percent * 2000, percent },
  rateLimits: [],
  cost: { usd: 1 },
  changed: ['context' as const],
})

// The Raster's cells back to text, one string per row.
function rows(cells: string, columns: number): string[] {
  const bin = atob(cells)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const words = new Uint32Array(bytes.buffer)
  const out: string[] = []
  let line = ''
  for (let i = 0; i < words.length; i += 3) {
    line += String.fromCodePoint(words[i]!)
    if (line.length === columns) {
      out.push(line)
      line = ''
    }
  }
  return out
}

test('warns once at 80% and 90% context, and hints /compact', async ($, on) => {
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  for (const p of [50, 82, 85, 91, 93]) await $.session.measure(measure(p))
  expect(toasts).toEqual(['Context at 82%. Consider /compact soon.', 'Context at 91%. Consider /compact soon.'])

  const ui = await $.ui.mount({ plugin: 'pixelbar', surface: 'terminal', component: 'AbovePrompt', props: props() })
  const bar = await ui.find({ key: 'bar' })
  const text = rows(String(bar?.props.cells), Number(bar?.props.columns))
  expect(text[1]).toContain('/compact?')
  expect(text[2]).toContain('ctx ▁▆▇██')
})

test('a small climb in context still rises in the sparkline', async ($, on) => {
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }))
  for (const p of [8, 10, 12, 15]) await $.session.measure(measure(p))
  const ui = await $.ui.mount({ plugin: 'pixelbar', surface: 'terminal', component: 'AbovePrompt', props: props() })
  const bar = await ui.find({ key: 'bar' })
  expect(rows(String(bar?.props.cells), Number(bar?.props.columns))[2]).toContain('ctx ▁▃▅█')
})

test('re-arms the warning after a compaction', async ($, on) => {
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  for (const p of [82, 30, 84]) await $.session.measure(measure(p))
  expect(toasts).toHaveLength(2)
})

async function statusRow($: Engine): Promise<string> {
  const ui = await $.ui.mount({ plugin: 'pixelbar', surface: 'terminal', component: 'AbovePrompt', props: props() })
  const bar = await ui.find({ key: 'bar' })
  return rows(String(bar?.props.cells), Number(bar?.props.columns))[2]!
}

test('the crab celebrates passing tests', async ($, on) => {
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '42 passed', stderr: '', interrupted: false } }))
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const row = await statusRow($)
  expect(row).toContain('yay!')
  expect(row).toContain('tests ✓ 42')
})

test('a build badge without counts', async ($, on) => {
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'done', stderr: '', interrupted: false } }))
  await $.tool.call({ tool: 'Bash', command: 'npm run build' })
  expect(await statusRow($)).toContain('build ✓')
})

test('the crab worries about failing tests', async ($, on) => {
  on('tool.call', { tool: 'Bash' }, () => ({ isError: true as const, result: undefined, text: 'Tests: 3 failed, 39 passed' }))
  await $.tool.call({ tool: 'Bash', command: 'npx vitest run' })
  const row = await statusRow($)
  expect(row).toContain('uh oh')
  expect(row).toContain('tests ✗ 3 failing')
})

test('the crab shrugs off a grep with no match', async ($, on) => {
  on('tool.call', { tool: 'Bash' }, (_$, e) =>
    e.command.startsWith('grep')
      ? { isError: true as const, result: undefined, text: 'exit 1' }
      : { result: { stdout: '42 passed', stderr: '', interrupted: false } },
  )
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Bash', command: 'grep -r nothing .' })
  expect(await statusRow($)).toContain('yay!')
})

test('summarizes the last turn', async ($, on) => {
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.call', { tool: 'Edit' }, () => ({
    result: {
      filePath: '/tmp/demo/app.ts',
      oldString: 'a',
      newString: 'b',
      originalFile: 'a\n',
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-a', '+b', '+c'] }],
      userModified: false,
      replaceAll: false,
    },
  }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/tmp/demo/app.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.turn.complete({ answer: 'done', durationMs: 134_000, isAborted: false, turnId: 't1', reason: 'answer' })

  const ui = await $.ui.mount({ plugin: 'pixelbar', surface: 'terminal', component: 'AbovePrompt', props: props() })
  const bar = await ui.find({ key: 'bar' })
  expect(rows(String(bar?.props.cells), Number(bar?.props.columns))[3]).toContain('last turn ✓ 2m14s · 2 tools · 1 file +2 −1 · turn $0.00')
})

const runFocus = ($: Engine, args: string) =>
  $.command.run({ command: 'focus-timer', args, origin: { kind: 'user' }, presentation: { isFullscreen: false, columns: 120 } } as never)

test('a focus timer counts down under the crab and can be stopped', async $ => {
  expect(await runFocus($, '25')).toMatchObject({ text: 'Focus timer started: 25 minutes.' })
  let row = rows(String((await bandOf($))?.props.cells), 120)[3]!
  expect(row.slice(0, 12)).toMatch(/○ (25:00|24:5\d)/)

  expect(await runFocus($, 'off')).toMatchObject({ text: 'Focus timer stopped.' })
  row = rows(String((await bandOf($))?.props.cells), 120)[3]!
  expect(row.slice(0, 12).trim()).toBe('')
})

test('rejects a bad focus length', async $ => {
  expect(await runFocus($, 'soon')).toMatchObject({ text: 'Usage: /focus-timer [minutes, up to 600] or /focus-timer off' })
})

async function bandOf($: Engine) {
  const ui = await $.ui.mount({ plugin: 'pixelbar', surface: 'terminal', component: 'AbovePrompt', props: props() })
  return ui.find({ key: 'bar' })
}

test('starts up even when a command name is refused', async ($, on) => {
  mock.clock(on)
  const logs: string[] = []
  on('command.register', (_$, e) => (e.name === 'focus-timer' ? { deny: 'it is a built-in' } : { value: { command: e.name } }))
  on('ui.log', (_$, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('env.get', () => ({ value: '/home/me' }))
  on('settings.read', () => ({ value: { effortLevel: 'high' } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: '/home/me/code' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000, tokens: 20_000, percent: 10 }, rateLimits: [], cost: { usd: 0.5 } },
  }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'not a git repository' } }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/home/me/code' } as never)

  expect(logs.some(l => l.includes('/focus-timer not registered'))).toBe(true)
  const row = rows(String((await bandOf($))?.props.cells), 120)[0]!
  expect(row).toContain('Opus 5.5 · high (200k) │ ~/code')
})

const paneProps = { title: 'Session files', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 } } as never

const editResult = (filePath: string, lines: string[]) => ({
  result: {
    filePath,
    oldString: 'a',
    newString: 'b',
    originalFile: 'a\n',
    structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 2, lines }],
    userModified: false,
    replaceAll: false,
  },
})

test('the files pane lists edited files and shows the chosen diff', async ($, on) => {
  on('tool.call', { tool: 'Edit' }, (_$, e) =>
    e.file_path.endsWith('app.ts') ? editResult(e.file_path, ['-old', '+new', '+more']) : editResult(e.file_path, ['+x']),
  )
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  await $.tool.call({ tool: 'Edit', file_path: '/w/app.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Edit', file_path: '/w/util.ts', old_string: 'a', new_string: 'b' })

  const ran = await $.command.run({ command: 'session-files', args: '', origin: { kind: 'user' }, presentation: { isFullscreen: false, columns: 120 } } as never)
  expect(ran).toMatchObject({ text: '2 files edited this session.' })

  const pane = await $.ui.mount({ plugin: 'pixelbar', surface: 'terminal', component: 'Pane', requestId: 'pixelbar-files', props: paneProps })
  // Most recent first, and its diff shown.
  expect((await pane.find({ key: 'file:/w/util.ts' }))?.props.label).toContain('▸')
  expect(String((await pane.find({ type: 'Code' }))?.props.source)).toBe('@@ -3,0 +3,1 @@\n+x')

  await pane.press({ key: 'file:/w/app.ts' })
  expect((await pane.find({ key: 'file:/w/app.ts' }))?.props.label).toContain('▸')
  expect(String((await pane.find({ type: 'Code' }))?.props.source)).toBe('@@ -3,1 +3,2 @@\n-old\n+new\n+more')
})

test('the files pane says when nothing was edited', async $ => {
  const pane = await $.ui.mount({ plugin: 'pixelbar', surface: 'terminal', component: 'Pane', requestId: 'pixelbar-files', props: paneProps })
  expect(await pane.drawn()).toMatchObject({ type: 'Text' })
})

test('the band shows a files button with the count once a file is edited', async ($, on) => {
  const opened: string[] = []
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('tool.call', { tool: 'Edit' }, (_$, e) => editResult(e.file_path, ['+x']))

  let band = await $.ui.mount({ plugin: 'pixelbar', surface: 'terminal', component: 'AbovePrompt', props: props() })
  expect(await band.find({ key: 'files' })).toBeUndefined()

  await $.tool.call({ tool: 'Edit', file_path: '/w/a.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Edit', file_path: '/w/b.ts', old_string: 'a', new_string: 'b' })
  band = await $.ui.mount({ plugin: 'pixelbar', surface: 'terminal', component: 'AbovePrompt', props: props() })
  expect((await band.find({ key: 'files' }))?.props.label).toBe('2 files')
  // The bar gives up the button's width: "[ 2 files ]" and a gap.
  expect((await band.find({ key: 'bar' }))?.props.columns).toBe(120 - 12)

  await band.press({ key: 'files' })
  expect(opened).toEqual(['pixelbar-files'])
})

test('yields the band to a survey', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, { key: 'survey' }, 'survey') as RenderElement
  })
  const ui = await $.ui.mount({ plugin: 'pixelbar', surface: 'terminal', component: 'AbovePrompt', props: props({ hasSurvey: true }) })
  expect(await ui.find({ key: 'bar' })).toBeUndefined()
  expect(await ui.drawn()).toMatchObject({ type: 'Text' })
})

const usage = (read: number, write: number, fresh: number, output = 0) => ({
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
  input_tokens: fresh,
  output_tokens: output,
  model: 'claude-opus-5-5',
})

// One main-loop model request answered with these token counts.
async function step($: Engine, turnId: string, index: number) {
  const s = $.turn.step({ turnId, index, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of s);
  return s.result
}

function answerSteps(on: On, counts: ReturnType<typeof usage>[]) {
  let i = 0
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: counts[i++] ?? null }
  })
}

test('splits the context bar by cache use and counts down to the cache lapsing', async ($, on) => {
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }))
  answerSteps(on, [usage(60_000, 20_000, 15_000, 5_000)])
  await $.session.measure(measure(50))
  await step($, 't1', 0)

  const bar = await bandOf($)
  const cells = String(bar?.props.cells)
  const text = rows(cells, 120)
  expect(text[1]).toMatch(/50% · 63\.1% cached, expires [45]:\d\d/)

  // The bar's filled half: blue (read), yellow (write) and red (new), 60/20/20.
  const { eighths, filled } = ctxBar(cells, text[1]!)
  expect(Math.abs(eighths(0x5f87d7) - filled * 0.6)).toBeLessThanOrEqual(1)
  expect(Math.abs(eighths(0xd7af00) - filled * 0.2)).toBeLessThanOrEqual(1)
  expect(Math.abs(eighths(0xd75f5f) - filled * 0.2)).toBeLessThanOrEqual(1)
})

test('the last turn shows how much input the cache served', async ($, on) => {
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  answerSteps(on, [usage(10_000, 8_000, 2_000), usage(18_000, 1_000, 1_000)])

  await $.turn.start({ text: 'go', turnId: 't1' })
  await step($, 't1', 0)
  await step($, 't1', 1)
  await $.turn.complete({ answer: 'done', durationMs: 5_000, isAborted: false, turnId: 't1', reason: 'answer' })

  expect(rows(String((await bandOf($))?.props.cells), 120)[3]).toContain('· cache 70.0% ·')
})

test('a subagent request leaves the bar alone', async ($, on) => {
  answerSteps(on, [usage(1000, 0, 0)])
  const s = $.turn.step({ turnId: 'a1', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'sub' })
  for await (const _ of s);
  expect(rows(String((await bandOf($))?.props.cells), 120)[1]).not.toContain('expires')
})

test('above 70% context the bar goes back to heat colors', async ($, on) => {
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }))
  answerSteps(on, [usage(60_000, 20_000, 15_000, 5_000)])
  await $.session.measure(measure(75))
  await step($, 't1', 0)

  const cells = String((await bandOf($))?.props.cells)
  const { fgs } = ctxBar(cells, rows(cells, 120)[1]!)
  expect(fgs).not.toContain(0x5f87d7)
  expect(fgs[0]).toBe(0x5fff5f)
})

const PARTIAL = ['▏', '▎', '▍', '▌', '▋', '▊', '▉']

// The context bar on row 1 (from "ctx " to the token count): each cell's
// foreground, its width in cells, and how many eighths of a cell each color
// covers, `filled` the eighths off the track.
function ctxBar(cells: string, row: string, columns = 120) {
  const bin = atob(cells)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const words = new Uint32Array(bytes.buffer)
  const start = row.indexOf('ctx ') + 4
  const end = start + row.slice(start).search(/ ([\d.]+[kM]?|–)\/[\d.]+[kM]? /)
  const fgs: number[] = []
  const by = new Map<number, number>()
  const seq: number[] = []
  const add = (col: number, n: number) => {
    by.set(col, (by.get(col) ?? 0) + n)
    for (let i = 0; i < n; i++) seq.push(col)
  }
  for (let x = start; x < end; x++) {
    const [ch, fg, bg] = [String.fromCodePoint(words[(columns + x) * 3]!), words[(columns + x) * 3 + 1]!, words[(columns + x) * 3 + 2]!]
    fgs.push(fg)
    const part = PARTIAL.indexOf(ch)
    if (ch === ' ') add(bg, 8)
    else if (part < 0) add(fg, 8)
    else {
      add(fg, part + 1)
      add(bg, 7 - part)
    }
  }
  const filled = [...by].reduce((n, [col, k]) => (col === 0x3a3a3a ? n : n + k), 0)
  // The colors in the order drawn, one entry per change.
  const order = seq.filter((col, i) => col !== seq[i - 1])
  return { fgs, width: end - start, filled, order, eighths: (col: number) => by.get(col) ?? 0 }
}

test('the bars stretch to fill the row, the context bar the widest', async ($, on) => {
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }))
  const limits = [
    { kind: 'five_hour', percentUsed: 30, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
    { kind: 'seven_day', percentUsed: 10, resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
  ]
  await $.session.measure({ ...measure(40), rateLimits: limits } as never)

  for (const columns of [100, 200]) {
    const ui = await $.ui.mount({ plugin: 'pixelbar', surface: 'terminal', component: 'AbovePrompt', props: { ...props(), bodyColumns: columns } })
    const bar = await ui.find({ key: 'bar' })
    const cells = String(bar?.props.cells)
    const row = rows(cells, columns)[1]!
    // The row ends within a cell of the band's edge.
    expect(row.trimEnd().length).toBeGreaterThanOrEqual(columns - 2)
    const { width } = ctxBar(cells, row, columns)
    const fiveH = row.slice(row.indexOf('5h ') + 3).search(/ \d+%/)
    expect(width).toBeGreaterThanOrEqual(2 * fiveH - 1)
  }
})

const ROUND = /ctx \uE0B6[^\uE0B4]*\uE0B4 /

async function startIn($: Engine, on: On, env: Record<string, string>) {
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('settings.read', () => ({ value: {} }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: '/home/me/code' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000, tokens: 20_000, percent: 10 }, rateLimits: [], cost: { usd: 0 } },
  }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: '' } }) as never)
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/home/me/code' } as never)
  return rows(String((await bandOf($))?.props.cells), 120)[1]!
}

test('rounds the bar ends in Ghostty', async ($, on) => {
  mock.clock(on)
  expect(await startIn($, on, { TERM_PROGRAM: 'ghostty' })).toMatch(ROUND)
})

test('keeps square ends in a terminal that may not draw the round glyphs', async ($, on) => {
  mock.clock(on)
  const row = await startIn($, on, { TERM_PROGRAM: 'gnome-terminal' })
  expect(row).not.toContain('\uE0B6')
  expect(row).toContain('ctx █')
})

test('the barEnds setting overrides the terminal', { options: { barEnds: 'rounded' } }, async ($, on) => {
  mock.clock(on)
  expect(await startIn($, on, {})).toMatch(ROUND)
})

test('square ends when set, even in Ghostty', { options: { barEnds: 'square' } }, async ($, on) => {
  mock.clock(on)
  expect(await startIn($, on, { TERM_PROGRAM: 'ghostty' })).not.toContain('\uE0B6')
})

test('the context bar colors add up the whole session, subagents included', async ($, on) => {
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }))
  // A cache miss (all written), then a hit (all read), then a subagent's miss.
  answerSteps(on, [usage(0, 40_000, 0), usage(40_000, 0, 0), usage(0, 0, 0, 20_000)])
  await $.session.measure(measure(60))
  await step($, 't1', 0)
  await step($, 't1', 1)
  const s = $.turn.step({ turnId: 'a1', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'sub' })
  for await (const _ of s);

  const cells = String((await bandOf($))?.props.cells)
  const { eighths, filled } = ctxBar(cells, rows(cells, 120)[1]!)
  // 40k read, 40k written, 20k new: 40/40/20.
  expect(Math.abs(eighths(0x5f87d7) - filled * 0.4)).toBeLessThanOrEqual(1)
  expect(Math.abs(eighths(0xd7af00) - filled * 0.4)).toBeLessThanOrEqual(1)
  expect(Math.abs(eighths(0xd75f5f) - filled * 0.2)).toBeLessThanOrEqual(1)
})

test('thin parts show at their size and in order, and the row says how much was cached', async ($, on) => {
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }))
  answerSteps(on, [usage(980_000, 14_000, 0, 6_000)])
  await $.session.measure(measure(40))
  await step($, 't1', 0)

  const cells = String((await bandOf($))?.props.cells)
  const row = rows(cells, 120)[1]!
  expect(row).toContain('· 98.5% cached')
  // 98% / 1.4% / 0.6% of a 40% fill: the thin parts as many eighths as their
  // share, at least one, and in order at the end: blue, yellow, red, track.
  const { eighths, filled, order, width } = ctxBar(cells, row)
  const nominal = Math.round(width * 0.4 * 8)
  expect(eighths(0xd7af00)).toBe(Math.max(1, Math.round(nominal * 0.014)))
  expect(eighths(0xd75f5f)).toBe(Math.max(1, Math.round(nominal * 0.006)))
  expect(eighths(0x5f87d7) + eighths(0xd7af00) + eighths(0xd75f5f)).toBe(filled)
  expect(Math.abs(filled - nominal)).toBeLessThan(8)
  expect(order).toEqual([0x5f87d7, 0xd7af00, 0xd75f5f, 0x3a3a3a])
})

test('in a narrow band the labels shorten so the weekly bar still fits', async ($, on) => {
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }))
  answerSteps(on, [usage(90_000, 8_000, 0, 2_000)])
  const limits = [
    { kind: 'five_hour', percentUsed: 34, resetsAt: new Date(Date.now() + 7_740_000).toISOString() },
    { kind: 'seven_day', percentUsed: 12, resetsAt: new Date(Date.now() + 439_200_000).toISOString() },
  ]
  await $.session.measure({ ...measure(20), rateLimits: limits } as never)
  await step($, 't1', 0)

  const wide = await $.ui.mount({ plugin: 'pixelbar', surface: 'terminal', component: 'AbovePrompt', props: { ...props(), bodyColumns: 160 } })
  const wideRow = rows(String((await wide.find({ key: 'bar' }))?.props.cells), 160)[1]!
  expect(wideRow).toMatch(/cached, expires [45]:\d\d   5h .* 34% 2h\d+m   wk .* 12% 5d\d+h/)

  const narrow = await $.ui.mount({ plugin: 'pixelbar', surface: 'terminal', component: 'AbovePrompt', props: { ...props(), bodyColumns: 96 } })
  const narrowRow = rows(String((await narrow.find({ key: 'bar' }))?.props.cells), 96)[1]!
  expect(narrowRow).toMatch(/wk .* 12%/)
  expect(narrowRow.trimEnd().length).toBeLessThanOrEqual(95)
})
