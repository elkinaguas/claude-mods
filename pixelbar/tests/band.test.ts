import type { RenderElement } from 'claude-code'
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
  const text = rows(String(bar?.props.cells), 120)
  expect(text[1]).toContain('/compact?')
  expect(text[2]).toContain('ctx ▁▆▇██')
})

test('a small climb in context still rises in the sparkline', async ($, on) => {
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }))
  for (const p of [8, 10, 12, 15]) await $.session.measure(measure(p))
  const ui = await $.ui.mount({ plugin: 'pixelbar', surface: 'terminal', component: 'AbovePrompt', props: props() })
  const bar = await ui.find({ key: 'bar' })
  expect(rows(String(bar?.props.cells), 120)[2]).toContain('ctx ▁▃▅█')
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
  return rows(String(bar?.props.cells), 120)[2]!
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
  expect(rows(String(bar?.props.cells), 120)[3]).toContain('last turn ✓ 2m14s · 2 tools · 1 file +2 −1 · turn $0.00')
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

test('yields the band to a survey', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, { key: 'survey' }, 'survey') as RenderElement
  })
  const ui = await $.ui.mount({ plugin: 'pixelbar', surface: 'terminal', component: 'AbovePrompt', props: props({ hasSurvey: true }) })
  expect(await ui.find({ key: 'bar' })).toBeUndefined()
  expect(await ui.drawn()).toMatchObject({ type: 'Text' })
})
