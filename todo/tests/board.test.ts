import type { On } from 'claude-code'
import { expect, test, type Engine } from 'claude-code/testing'

// The test runner has timers; the hooks module's own environment does not.
declare const setTimeout: (fn: () => void, ms: number) => unknown

// An in-memory project folder beneath the plugin's $.fs calls, and a record
// of the prompts it hands Claude.
function project(on: On, files: Record<string, string>) {
  const prompts: string[] = []
  let clock = 1
  const mtimes: Record<string, number> = {}
  for (const f of Object.keys(files)) mtimes[f] = clock++
  // The plugin's paths arrive resolved against the session's folder.
  const name = (path: string) => path.split('/').pop()!
  const missing = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
  const paths: string[] = []
  // `meanwhile` runs once right after the next read of TODO.md: another
  // writer (Claude) changing the file while the plugin edits it.
  let meanwhile: (() => void) | undefined
  const writeOutside = (f: string, text: string) => {
    files[f] = text
    mtimes[f] = clock++
  }
  on('fs.read', (_$, e) => {
    paths.push(e.path)
    const f = name(e.path)
    if (!(f in files)) throw missing(f)
    const value = files[f]!
    if (f === 'TODO.md' && meanwhile) {
      const run = meanwhile
      meanwhile = undefined
      run()
    }
    return { value }
  })
  on('fs.write', (_$, e) => {
    files[name(e.path)] = e.text
    mtimes[name(e.path)] = clock++
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: name(e.path) in files }))
  on('fs.stat', (_$, e) => {
    const f = name(e.path)
    if (!(f in files)) throw missing(f)
    return { value: { kind: 'file' as const, size: files[f]!.length, mtimeMs: mtimes[f]!, isLink: false } }
  })
  on('clock.every', () => ({ value: undefined }))
  on('clock.after', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/project' }))
  on('session.cwd', () => ({ value: '/project/sub' }))
  on('prompt.submit', (_$, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  const panes = new Set<string>()
  on('ui.open', (_$, e) => {
    panes.add(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', (_$, e) => {
    panes.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [...panes].map(id => ({ id, isPlaced: true })) as never }))
  on('ui.status', () => ({ value: undefined }))
  return {
    files,
    prompts,
    panes,
    paths,
    writeOutside,
    meanwhile: (fn: () => void) => {
      meanwhile = fn
    },
  }
}

const BOARD = `# TODO

## Todo

- T-3 Add retry to upload client
  > Uploads fail silently on 5xx: src/upload/client.ts:88.
  > Decision: how many retries.
- add dark mode to settings

## Doing

- T-2 Fix flaky auth test
  > Q: Mock the clock or raise the timeout?

## Done

- T-1 Cache git status (2026-10-08)
  > Log: cached for 5s.
`

const start = ($: Engine) => $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })

const run = (args: string) => async ($: Engine) => $.command.run({ command: 'todo', args, origin: { kind: 'user' }, presentation: { isFullscreen: true, columns: 160 } } as never)

const mount = <S extends 'terminal' | 'desktop'>($: Engine, surface: S) =>
  $.ui.mount({
    plugin: 'todo',
    surface,
    component: 'Pane' as const,
    requestId: 'todo',
    props: { title: 'Tasks', bodyColumns: 60, placement: 'dock' } as never,
  })

test('/todo <task> adds a raw line at the end of Todo', async ($, on) => {
  const { files } = project(on, { 'TODO.md': BOARD })
  await run('write the release notes')($)
  expect(files['TODO.md']).toContain('- add dark mode to settings\n- write the release notes\n\n## Doing')
})

test('/todo init creates TODO.md and the rules block, and replaces it on a rerun', async ($, on) => {
  const { files } = project(on, { 'CLAUDE.md': '# Project\n\nUse pnpm.\n' })
  await start($)
  await run('init')($)
  expect(files['TODO.md']).toContain('## Todo')
  expect(files['CLAUDE.md']).toContain('Use pnpm.\n\n<!-- todo:start -->')
  expect(files['CLAUDE.md']).toContain('next free ID')
  expect(files['CLAUDE.md']).toContain('first check its `file:line` references')
  const once = files['CLAUDE.md']
  await run('init')($)
  expect(files['CLAUDE.md']).toBe(once)
})

test('/todo init writes to AGENTS.md when CLAUDE.md only imports it', async ($, on) => {
  const { files } = project(on, { 'CLAUDE.md': '@AGENTS.md\n', 'AGENTS.md': '# Agents\n' })
  await run('init')($)
  expect(files['CLAUDE.md']).toBe('@AGENTS.md\n')
  expect(files['AGENTS.md']).toContain('<!-- todo:start -->')
})

test('/todo enrich asks Claude to enrich only the tasks without an ID', async ($, on) => {
  const { prompts } = project(on, { 'TODO.md': BOARD })
  const out = await run('enrich')($)
  expect(out).toMatchObject({ text: 'Asked Claude to enrich 1 task.' })
  await new Promise<void>(resolve => setTimeout(resolve, 20))
  expect(prompts[0]).toContain('Enrich the 1 unenriched task in TODO.md')
})

test('/todo archive moves Done tasks to TODO-archive.md', async ($, on) => {
  const { files } = project(on, { 'TODO.md': BOARD })
  await run('archive')($)
  expect(files['TODO.md']).not.toContain('T-1')
  expect(files['TODO.md']!.trimEnd().endsWith('## Done')).toBe(true)
  expect(files['TODO-archive.md']).toBe('# TODO archive\n\n- T-1 Cache git status (2026-10-08)\n  > Log: cached for 5s.\n')
})

test('reads the board at the project root after a shell cd', async ($, on) => {
  const { paths } = project(on, { 'TODO.md': BOARD })
  await run('add a task')($)
  expect(paths.length).toBeGreaterThan(0)
  for (const p of paths) expect(p).toBe('/project/TODO.md')
})

test('/todo close closes the panel, and says so when it is not open', async ($, on) => {
  const { panes } = project(on, { 'TODO.md': BOARD })
  await run('')($)
  expect(panes.has('todo')).toBe(true)
  expect(await run('close')($)).toMatchObject({ text: 'Task panel closed.' })
  expect(panes.has('todo')).toBe(false)
  expect(await run('close')($)).toMatchObject({ text: 'Task panel is not open.' })
})

test('/todo init leaves rules that lost their markers alone, and the panel sees them', async ($, on) => {
  const rules = '# Project\n\n## Task board (TODO.md)\n\n- **Capture.** ...\n'
  const { files } = project(on, { 'TODO.md': BOARD, 'CLAUDE.md': rules })
  await start($)
  const ui = await mount($, 'terminal')
  expect(await ui.find({ text: 'Rules not in CLAUDE.md yet: run /todo init.' })).toBeUndefined()
  const out = await run('init')($)
  expect(files['CLAUDE.md']).toBe(rules)
  expect(out).toMatchObject({ text: expect.stringContaining('without their markers') })
})

test('/todo init repairs a rules block missing its end marker', async ($, on) => {
  const { files } = project(on, { 'CLAUDE.md': '# Project\n\n<!-- todo:start -->\n## Task board (TODO.md)\nold\n' })
  await run('init')($)
  expect(files['CLAUDE.md']!.split('<!-- todo:start -->').length).toBe(2)
  expect(files['CLAUDE.md']).toContain('<!-- todo:end -->')
  expect(files['CLAUDE.md']).not.toContain('\nold\n')
})

test('/todo archive keeps blank lines elsewhere in the file', async ($, on) => {
  const board = BOARD.replace('## Todo\n', '## Todo\n\n\n')
  const { files } = project(on, { 'TODO.md': board })
  await run('archive')($)
  expect(files['TODO.md']).toContain('## Todo\n\n\n\n- T-3')
})

test('two raw tasks with the same title are told apart', async ($, on) => {
  const board = BOARD.replace('- add dark mode to settings\n', '- add dark mode to settings\n- add dark mode to settings\n  > the second\n')
  const { files } = project(on, { 'TODO.md': board })
  await start($)
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'task:raw:add dark mode to settings:2' })
  await ui.press({ key: 'start' })
  const text = files['TODO.md']!
  expect(text.indexOf('  > the second')).toBeGreaterThan(text.indexOf('## Doing'))
  expect(text.indexOf('- add dark mode to settings')).toBeLessThan(text.indexOf('## Doing'))
})

test('a done task shows its log folded, and o opens and folds it', async ($, on) => {
  const board = BOARD.replace('  > Log: cached for 5s.\n', '  > Log: cached for 5s.\n  > Files: src/git.ts.\n')
  project(on, { 'TODO.md': board })
  await start($)
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'task:T-1' })
  expect(await ui.find({ text: 'Log: cached for 5s.' })).toBeDefined()
  expect(await ui.find({ text: 'Files: src/git.ts.' })).toBeUndefined()
  expect(await ui.find({ text: '+1 more' })).toBeDefined()
  await ui.press({ key: 'log' })
  expect(await ui.find({ text: 'Files: src/git.ts.' })).toBeDefined()
  expect(await ui.find({ text: '+1 more' })).toBeUndefined()
  await ui.press({ key: 'log' })
  expect(await ui.find({ text: 'Files: src/git.ts.' })).toBeUndefined()
})

test('a Todo task keeps its notes unfolded', async ($, on) => {
  project(on, { 'TODO.md': BOARD })
  await start($)
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'task:T-3' })
  expect(await ui.find({ text: 'Decision: how many retries.' })).toBeDefined()
  expect(await ui.find({ key: 'log' })).toBeUndefined()
})

test('the action buttons are spaced apart, not padded with spaces', async ($, on) => {
  project(on, { 'TODO.md': BOARD })
  await start($)
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'task:raw:add dark mode to settings' })
  expect((await ui.find({ key: 'actions' }))?.props.columnGap).toBe(2)
  expect((await ui.find({ key: 'start' }))?.props.label).toBe('Start')
  expect((await ui.find({ key: 'enrich' }))?.props.label).toBe('Enrich')
})

test('r renames a task, keeping its ID and notes, and asks Claude to check the notes', async ($, on) => {
  const { files, prompts } = project(on, { 'TODO.md': BOARD })
  await start($)
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'task:T-3' })
  await ui.press({ key: 'rename-open' })
  await ui.input({ key: 'rename', text: 'Add retry and backoff to upload client' })
  expect(files['TODO.md']).toContain('- T-3 Add retry and backoff to upload client\n  > Uploads fail silently')
  expect(await ui.find({ key: 'rename' })).toBeUndefined()
  expect(prompts[0]).toContain('T-3 in TODO.md was renamed from "Add retry to upload client" to "Add retry and backoff to upload client"')
})

test('renaming a raw task without notes keeps it selected and asks Claude nothing', async ($, on) => {
  const { files, prompts } = project(on, { 'TODO.md': BOARD })
  await start($)
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'task:raw:add dark mode to settings' })
  await ui.press({ key: 'rename-open' })
  await ui.input({ key: 'rename', text: 'add a dark theme to settings' })
  expect(files['TODO.md']).toContain('- add a dark theme to settings\n\n## Doing')
  expect(prompts).toEqual([])
  expect((await ui.find({ key: 'task:raw:add a dark theme to settings' }))?.props.label).toContain('▾')
})

test('an empty or unchanged title leaves the task alone; done tasks cannot be renamed', async ($, on) => {
  const { files } = project(on, { 'TODO.md': BOARD })
  await start($)
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'task:T-3' })
  await ui.press({ key: 'rename-open' })
  await ui.input({ key: 'rename', text: '   ' })
  expect(files['TODO.md']).toBe(BOARD)
  await ui.press({ key: 'task:T-1' })
  expect(await ui.find({ key: 'rename-open' })).toBeUndefined()
})

test('the panel shows only the lists; Enter opens a task, Enter again or Close folds it', async ($, on) => {
  project(on, { 'TODO.md': BOARD })
  await start($)
  const ui = await mount($, 'terminal')
  expect(await ui.find({ key: 'detail' })).toBeUndefined()
  expect(await ui.find({ text: 'Decision: how many retries.' })).toBeUndefined()
  await ui.press({ key: 'task:T-3' })
  expect(await ui.find({ text: 'Decision: how many retries.' })).toBeDefined()
  expect((await ui.find({ key: 'task:T-3' }))?.props.label).toBe('▾ T-3 Add retry to upload client')
  await ui.press({ key: 'task:T-3' })
  expect(await ui.find({ key: 'detail' })).toBeUndefined()
  await ui.press({ key: 'task:T-3' })
  await ui.press({ key: 'task:T-2' })
  expect(await ui.find({ text: 'Decision: how many retries.' })).toBeUndefined()
  expect(await ui.find({ text: 'Q: Mock the clock or raise the timeout?' })).toBeDefined()
  await ui.press({ key: 'close' })
  expect(await ui.find({ key: 'detail' })).toBeUndefined()
})

test('sections and IDs are coloured: Doing yellow, Todo cyan, Done green', async ($, on) => {
  project(on, { 'TODO.md': BOARD })
  await start($)
  const ui = await mount($, 'terminal')
  expect((await ui.find({ type: 'Text', text: /^Doing/ }))?.props.color).toBe('yellow')
  expect((await ui.find({ type: 'Text', text: /^Todo/ }))?.props.color).toBe('cyan')
  expect((await ui.find({ type: 'Text', text: /^Done/ }))?.props.color).toBe('green')
  expect((await ui.find({ type: 'Text', text: 'T-3' }))?.props.color).toBe('cyan')
  expect((await ui.find({ key: 'task:T-1' }))?.props.dimColor).toBe(true)
})

test('b moves a Doing task back to the top of Todo and tells Claude to stop', async ($, on) => {
  const { files, prompts } = project(on, { 'TODO.md': BOARD })
  await start($)
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'task:T-2' })
  await ui.press({ key: 'back' })
  expect(files['TODO.md']).toContain('## Todo\n\n- T-2 Fix flaky auth test\n  > Q: Mock the clock or raise the timeout?\n- T-3 Add retry')
  expect(files['TODO.md']).toContain('## Doing\n\n## Done')
  expect(prompts[0]).toContain('T-2 "Fix flaky auth test" is back in Todo in TODO.md. Stop working on it')
})

test('k and j move a task up and down within its section, notes and all', async ($, on) => {
  const { files } = project(on, { 'TODO.md': BOARD })
  await start($)
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'task:T-3' })
  expect(await ui.find({ key: 'up' })).toBeUndefined()
  await ui.press({ key: 'down' })
  expect(files['TODO.md']).toContain('## Todo\n\n- add dark mode to settings\n- T-3 Add retry to upload client\n  > Uploads fail silently on 5xx: src/upload/client.ts:88.\n  > Decision: how many retries.\n\n## Doing')
  expect(await ui.find({ key: 'down' })).toBeUndefined()
  await ui.press({ key: 'up' })
  expect(files['TODO.md']).toBe(BOARD)
  await ui.press({ key: 'task:T-1' })
  expect(await ui.find({ key: 'up' })).toBeUndefined()
  expect(await ui.find({ key: 'down' })).toBeUndefined()
})

test('m marks Todo tasks and g starts them as one batch, worked one at a time in Todo order', async ($, on) => {
  const board = BOARD.replace('- add dark mode to settings\n', '- add dark mode to settings\n- T-4 Bump node\n')
  const { files, prompts } = project(on, { 'TODO.md': board })
  await start($)
  const ui = await mount($, 'terminal')
  expect(await ui.find({ key: 'start-marked' })).toBeUndefined()
  await ui.press({ key: 'task:T-4' })
  await ui.press({ key: 'mark' })
  await ui.press({ key: 'task:T-3' })
  await ui.press({ key: 'mark' })
  expect(await ui.find({ key: 'detail' })).toBeUndefined()
  expect((await ui.find({ key: 'task:T-3' }))?.props.label).toBe('● T-3 Add retry to upload client')
  expect((await ui.find({ key: 'start-marked' }))?.props.label).toBe('Start 2 marked')
  // Plain buttons draw their key (`g: Start 2 marked`); boxed ones do not.
  expect((await ui.find({ key: 'start-marked' }))?.props.plain).toBe(true)
  expect((await ui.find({ key: 'enrich-all' }))?.props.plain).toBe(true)
  await ui.press({ key: 'start-marked' })
  const text = files['TODO.md']!
  const doing = text.slice(text.indexOf('## Doing'), text.indexOf('## Done'))
  expect(doing).toContain('- T-2 Fix flaky auth test\n  > Q: Mock the clock or raise the timeout?\n- T-3 Add retry to upload client\n  > Uploads fail silently on 5xx: src/upload/client.ts:88.\n  > Decision: how many retries.\n- T-4 Bump node\n')
  expect(text.slice(0, text.indexOf('## Doing'))).toContain('## Todo\n\n- add dark mode to settings\n\n')
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('Start working on these 2 tasks, now under Doing in TODO.md, one at a time in this order:\n1. T-3 "Add retry to upload client"\n2. T-4 "Bump node"')
  expect(prompts[0]).toContain('move it to Done with its own log before starting the next')
  expect(await ui.find({ key: 'start-marked' })).toBeUndefined()
})

test('m again unmarks; a raw task in a batch is enriched first', async ($, on) => {
  const { prompts } = project(on, { 'TODO.md': BOARD })
  await start($)
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'task:T-3' })
  await ui.press({ key: 'mark' })
  await ui.press({ key: 'task:T-3' })
  expect((await ui.find({ key: 'mark' }))?.props.label).toBe('Unmark T-3')
  await ui.press({ key: 'mark' })
  expect(await ui.find({ key: 'start-marked' })).toBeUndefined()
  await ui.press({ key: 'task:T-3' })
  await ui.press({ key: 'mark' })
  await ui.press({ key: 'task:raw:add dark mode to settings' })
  await ui.press({ key: 'mark' })
  await ui.press({ key: 'start-marked' })
  expect(prompts[0]).toContain('2. "add dark mode to settings" (not enriched yet: give it the next free ID and its context lines first)')
})

test('a batch of one starts like a single task', async ($, on) => {
  const { prompts } = project(on, { 'TODO.md': BOARD })
  await start($)
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'task:T-3' })
  await ui.press({ key: 'mark' })
  await ui.press({ key: 'start-marked' })
  expect(prompts[0]).toContain('Start working on T-3 "Add retry to upload client" (now under Doing in TODO.md)')
})

test('Tab walks task rows: a one-step move onto an action button carries on to the next row', async ($, on) => {
  project(on, { 'TODO.md': BOARD })
  const landed: string[] = []
  on('ui.focus', (_$, e) => {
    landed.push(e.element ?? '')
    return {}
  })
  await start($)
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'task:T-3' })
  // The person's Tab: the engine raises ui.focus onto the next element.
  const tab = (element: string) => $.ui.focus({ component: 'Pane', requestId: 'todo', element, origin: { kind: 'person' } } as never)
  await tab('task:T-3')
  await tab('start')
  expect(landed.at(-1)).toBe('task:raw:add dark mode to settings')
  // Shift+Tab from that row lands on T-3's Close button: back to T-3's row.
  await tab('close')
  expect(landed.at(-1)).toBe('task:T-3')
})

test('m marks the row the focus is on, without opening it, then moves to the next Todo row', async ($, on) => {
  const { prompts } = project(on, { 'TODO.md': BOARD })
  const landed: string[] = []
  on('ui.focus', (_$, e) => {
    landed.push(e.element ?? '')
    return {}
  })
  await start($)
  const ui = await mount($, 'terminal')
  expect(await ui.find({ key: 'mark' })).toBeUndefined()
  await $.ui.focus({ component: 'Pane', requestId: 'todo', element: 'task:T-3', origin: { kind: 'person' } } as never)
  expect((await ui.find({ key: 'mark' }))?.props.label).toBe('Mark T-3')
  await ui.press({ key: 'mark' })
  expect(await ui.find({ key: 'detail' })).toBeUndefined()
  expect((await ui.find({ key: 'task:T-3' }))?.props.label).toBe('● T-3 Add retry to upload client')
  // Focus on a Doing row: nothing to mark there.
  await $.ui.focus({ component: 'Pane', requestId: 'todo', element: 'task:T-2', origin: { kind: 'person' } } as never)
  expect(await ui.find({ key: 'mark' })).toBeUndefined()
  await ui.press({ key: 'start-marked' })
  expect(prompts[0]).toContain('Start working on T-3')
  expect(landed).toContain('task:T-3')
})

test('a panel edit made while Claude writes TODO.md keeps both changes', async ($, on) => {
  const board = project(on, { 'TODO.md': BOARD })
  const claudes = BOARD.replace('  > Decision: how many retries.\n', '  > Decision: how many retries.\n  > Q: Three retries?\n')
  board.meanwhile(() => board.writeOutside('TODO.md', claudes))
  await run('write the release notes')($)
  expect(board.files['TODO.md']).toContain('  > Q: Three retries?\n')
  expect(board.files['TODO.md']).toContain('- write the release notes\n')
})

test('archive retries on a concurrent write and archives each task once', async ($, on) => {
  const board = project(on, { 'TODO.md': BOARD })
  board.meanwhile(() => board.writeOutside('TODO.md', BOARD.replace('## Todo\n', '## Todo\n\n- from Claude')))
  await run('archive')($)
  expect(board.files['TODO.md']).toContain('- from Claude')
  expect(board.files['TODO.md']).not.toContain('T-1')
  expect(board.files['TODO-archive.md']!.split('T-1 Cache git status').length).toBe(2)
})

const withDone = (n: number) =>
  BOARD.replace('- T-1 Cache git status (2026-10-08)\n  > Log: cached for 5s.\n', Array.from({ length: n }, (_, i) => `- T-${100 + n - i} Old task ${n - i} (2026-10-01)\n  > Log ${n - i}.\n`).join(''))

test('starting a task archives Done down to the newest 10 once it holds more than 20', async ($, on) => {
  const { files } = project(on, { 'TODO.md': withDone(21) })
  await start($)
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'task:T-3' })
  await ui.press({ key: 'start' })
  const done = files['TODO.md']!.slice(files['TODO.md']!.indexOf('## Done'))
  expect(done.match(/^- T-/gm)).toHaveLength(10)
  expect(done).toContain('- T-121 Old task 21')
  expect(done).not.toContain('- T-111 Old task 11')
  expect(files['TODO-archive.md']!.match(/^- T-/gm)).toHaveLength(11)
  expect(files['TODO.md']).toContain('## Doing\n\n- T-2 Fix flaky auth test\n  > Q: Mock the clock or raise the timeout?\n- T-3 Add retry')
})

test('at 20 done tasks nothing is archived', async ($, on) => {
  const { files } = project(on, { 'TODO.md': withDone(20) })
  await start($)
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'task:T-3' })
  await ui.press({ key: 'start' })
  expect(files['TODO-archive.md']).toBeUndefined()
})

test('autoArchive 0 turns it off', { options: { autoArchive: 0 } }, async ($, on) => {
  const { files } = project(on, { 'TODO.md': withDone(25) })
  await start($)
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'task:T-3' })
  await ui.press({ key: 'start' })
  expect(files['TODO-archive.md']).toBeUndefined()
})

test('q moves a task to the top of Done with the date, its notes kept, without asking Claude', async ($, on) => {
  const { files, prompts } = project(on, { 'TODO.md': BOARD })
  await start($)
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'task:T-2' })
  await ui.press({ key: 'quick-done' })
  const d = new Date()
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  expect(files['TODO.md']).toContain(
    `## Done\n\n- T-2 Fix flaky auth test (${date})\n  > Q: Mock the clock or raise the timeout?\n  > Done from the panel, no log.\n- T-1 Cache git status (2026-10-08)`,
  )
  expect(files['TODO.md']).toContain('## Doing\n\n## Done')
  expect(prompts).toEqual([])
})

test('q works on a Todo task too, and done tasks have no quick done', async ($, on) => {
  const { files } = project(on, { 'TODO.md': BOARD })
  await start($)
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'task:raw:add dark mode to settings' })
  await ui.press({ key: 'quick-done' })
  expect(files['TODO.md']).toMatch(/## Done\n\n- add dark mode to settings \(\d{4}-\d{2}-\d{2}\)\n  > Done from the panel, no log\.\n- T-1/)
  await ui.press({ key: 'task:T-1' })
  expect(await ui.find({ key: 'quick-done' })).toBeUndefined()
})

test('x twice drops a task with an ID to the top of Done, notes kept; once does nothing', async ($, on) => {
  const { files, prompts } = project(on, { 'TODO.md': BOARD })
  await start($)
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'task:T-3' })
  await ui.press({ key: 'drop' })
  expect(files['TODO.md']).toBe(BOARD)
  expect((await ui.find({ key: 'drop' }))?.props.label).toBe('Confirm drop')
  await ui.press({ key: 'drop' })
  expect(files['TODO.md']).toMatch(
    /## Done\n\n- T-3 Add retry to upload client \(dropped \d{4}-\d{2}-\d{2}\)\n  > Uploads fail silently on 5xx: src\/upload\/client\.ts:88\.\n  > Decision: how many retries\.\n- T-1 /,
  )
  expect(prompts).toEqual([])
})

test('dropping a raw task deletes it; closing between presses cancels the drop', async ($, on) => {
  const { files } = project(on, { 'TODO.md': BOARD })
  await start($)
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'task:raw:add dark mode to settings' })
  await ui.press({ key: 'drop' })
  await ui.press({ key: 'close' })
  await ui.press({ key: 'task:raw:add dark mode to settings' })
  expect((await ui.find({ key: 'drop' }))?.props.label).toBe('Drop')
  await ui.press({ key: 'drop' })
  await ui.press({ key: 'drop' })
  expect(files['TODO.md']).not.toContain('dark mode')
  expect(files['TODO.md']).toContain('  > Decision: how many retries.\n\n## Doing')
})

test('Done asks Claude to name the commit, or offer one for uncommitted work, before the log', async ($, on) => {
  const { prompts } = project(on, { 'TODO.md': BOARD })
  await start($)
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'task:T-2' })
  await ui.press({ key: 'done' })
  expect(prompts[0]).toContain('T-2 is done.')
  expect(prompts[0]).toContain('ask me whether to commit them now (staging only that task\'s files) before writing the log')
  expect(prompts[0]).toContain('The log names the commit(s) holding the work, or says "Uncommitted".')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the panel lists the sections and starts a task (${surface})`, async ($, on) => {
    const { files, prompts } = project(on, { 'TODO.md': BOARD, 'CLAUDE.md': '<!-- todo:start -->\n<!-- todo:end -->\n' })
    await start($)
    const ui = await mount($, surface)
    expect(await ui.find({ key: 'task:T-2' })).toBeDefined()
    expect(await ui.find({ key: 'task:raw:add dark mode to settings' })).toBeDefined()
    expect(await ui.find({ key: 'enrich-all' })).toBeDefined()
    // Nothing is open at first: Enter on the Doing task shows its actions.
    expect(await ui.find({ key: 'done' })).toBeUndefined()
    await ui.press({ key: 'task:T-2' })
    expect(await ui.find({ key: 'done' })).toBeDefined()

    await ui.press({ key: 'task:T-3' })
    await ui.press({ key: 'start' })
    const text = files['TODO.md']!
    expect(text.indexOf('- T-3 Add retry')).toBeGreaterThan(text.indexOf('## Doing'))
    expect(text).toContain('  > Decision: how many retries.\n\n## Done')
    expect(prompts[0]).toContain('Start working on T-3 "Add retry to upload client"')
    expect(prompts[0]).toContain('check its `file:line` references against the code')
  })

  test(`the panel adds a task typed in its field (${surface})`, async ($, on) => {
    const { files } = project(on, { 'TODO.md': BOARD })
    await start($)
    const ui = await mount($, surface)
    await ui.input({ key: 'add', text: 'bump node to 24' })
    expect(files['TODO.md']).toContain('- add dark mode to settings\n- bump node to 24\n')
  })
}

test('the panel offers set-up when there is no TODO.md', async ($, on) => {
  const { files } = project(on, {})
  await start($)
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'init' })
  expect(files['TODO.md']).toContain('## Doing')
  expect(files['CLAUDE.md']).toContain('<!-- todo:start -->')
})
