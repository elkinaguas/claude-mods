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
  on('fs.read', (_$, e) => {
    paths.push(e.path)
    const f = name(e.path)
    if (!(f in files)) throw missing(f)
    return { value: files[f]! }
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
  return { files, prompts, panes, paths }
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

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the panel lists the sections and starts a task (${surface})`, async ($, on) => {
    const { files, prompts } = project(on, { 'TODO.md': BOARD, 'CLAUDE.md': '<!-- todo:start -->\n<!-- todo:end -->\n' })
    await start($)
    const ui = await mount($, surface)
    expect(await ui.find({ key: 'task:T-2' })).toBeDefined()
    expect(await ui.find({ key: 'task:raw:add dark mode to settings' })).toBeDefined()
    expect(await ui.find({ key: 'enrich-all' })).toBeDefined()
    // The Doing task is chosen first, with its open question.
    expect(await ui.find({ key: 'done' })).toBeDefined()

    await ui.press({ key: 'task:T-3' })
    await ui.press({ key: 'start' })
    const text = files['TODO.md']!
    expect(text.indexOf('- T-3 Add retry')).toBeGreaterThan(text.indexOf('## Doing'))
    expect(text).toContain('  > Decision: how many retries.\n\n## Done')
    expect(prompts[0]).toContain('Start working on T-3 "Add retry to upload client"')
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
