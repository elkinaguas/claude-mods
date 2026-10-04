// Drives pixelbar's real module through a scripted demo with a fake engine and
// a controllable clock, writing every frame's cells to frames.json.
import { writeFileSync } from 'node:fs'

// ---------- a clock we control ----------
let now = Date.parse('2026-10-04T15:00:00Z')
Date.now = () => now

// ---------- JSX ----------
globalThis.h = (type, props, ...children) => ({ type, props: props ?? {}, children })
globalThis.Fragment = 'Fragment'

const { register } = await import('./pixelbar.mjs')

// ---------- demo data ----------
const HOME = '/home/dev'
const CWD = '/home/dev/projects/acme-app'
const usage = {
  startedAt: now - 42 * 60_000,
  context: { window: 200_000, tokens: 40_000, percent: 20 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 34, resetsAt: new Date(now + 130 * 60_000).toISOString() },
    { kind: 'seven_day', percentUsed: 12, resetsAt: new Date(now + 5 * 86_400_000 + 2 * 3_600_000).toISOString() },
  ],
  cost: { usd: 1.23 },
}
const gitStatus = [
  '# branch.oid 1234567890abcdef',
  '# branch.head feature/pixel-crab',
  '# branch.upstream origin/feature/pixel-crab',
  '# branch.ab +2 -0',
  '1 .M N... 100644 100644 100644 a b src/app.ts',
  '1 .M N... 100644 100644 100644 a b src/util.ts',
  '? notes.md',
].join('\n')

// ---------- the fake engine ----------
const state = new Map()
const timers = []
let blitted
const $ = {
  state: {
    get: async ref => ({ value: state.get(`${ref.plugin}.${ref.key}`) }),
    set: async ({ plugin, key, value }) => void state.set(`${plugin}.${key}`, value),
  },
  command: { register: async () => {} },
  env: { get: async () => HOME },
  settings: { read: async () => ({ effortLevel: 'high' }) },
  session: {
    usage: async () => structuredClone(usage),
    model: async () => 'claude-opus-5-5',
    cwd: async () => CWD,
  },
  process: { run: async () => ({ exitCode: 0, stdout: gitStatus, stderr: '' }) },
  clock: { every: (ms, fn) => timers.push({ ms, fn }) },
  ui: {
    blit: async ({ cells }) => {
      blitted = cells
      return {}
    },
    resolve: () => ({ Raster: 'Raster', Box: 'Box', Button: 'Button', Text: 'Text', Code: 'Code' }),
    invalidate: () => {},
    toast: () => {},
    log: () => {},
    open: async () => ({ isPlaced: true }),
  },
}

const hooks = new Map()
register((event, matcherOrHook, maybeHook) => {
  const hook = maybeHook ?? matcherOrHook
  const matcher = maybeHook ? matcherOrHook : {}
  hooks.set(event, [...(hooks.get(event) ?? []), { matcher, hook }])
  return { catch: () => {} }
}, {})

const matches = (matcher, e) => Object.entries(matcher).every(([k, v]) => typeof v === 'object' || e[k] === v)

async function raise(event, e, answer = {}) {
  const chain = (hooks.get(event) ?? []).filter(h => matches(h.matcher, e))
  const run = async (i, input) => (i < chain.length ? chain[i].hook($, input, x => run(i + 1, x)) : answer)
  return run(0, e)
}

// ---------- capture ----------
const frames = []
let band = { cols: 0, files: 0 }

async function render() {
  const tree = await raise('ui.render', {
    component: 'AbovePrompt',
    surface: 'terminal',
    requestId: 'band',
    props: { hasSurvey: false, isWorking: working, maxRows: 10, bodyColumns: 112, scroll: { offset: 0, bodyRows: 9 }, view: {} },
  })
  const raster = tree.type === 'Raster' ? tree : tree.children.find(c => c.type === 'Raster')
  const button = tree.type === 'Box' ? JSON.stringify(tree).match(/"label":"([^"]+)"/)?.[1] : undefined
  band = { cols: raster.props.columns, button }
}

const frameTimers = () => timers.filter(t => t.ms === 125)

async function play(seconds) {
  for (let i = 0; i < Math.round(seconds * 8); i++) {
    now += 125
    for (const t of frameTimers()) t.fn()
    await new Promise(r => setTimeout(r, 0))
    frames.push({ cells: blitted, cols: band.cols, rows: 4, button: band.button })
  }
}

async function refresh() {
  for (const t of timers.filter(t => t.ms === 2000)) t.fn()
  await new Promise(r => setTimeout(r, 0))
}

let working = false
const edit = (file, lines) =>
  raise('tool.call', { tool: 'Edit', file_path: file, old_string: 'a', new_string: 'b' }, {
    result: { filePath: file, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines }] },
  })
const bash = (command, answer) => raise('tool.call', { tool: 'Bash', command }, answer)
const measure = async (percent, cost) => {
  usage.context = { window: 200_000, tokens: percent * 2000, percent }
  usage.cost = { usd: cost }
  await raise('session.measure', { context: usage.context, rateLimits: usage.rateLimits, cost: usage.cost, changed: ['context', 'cost'] }, { changed: [] })
}

// ---------- the script ----------
await raise('session.start', { cwd: CWD }, { cwd: CWD })
for (const [p, c] of [[8, 0.2], [11, 0.4], [13, 0.6], [17, 0.9], [20, 1.23]]) await measure(p, c)
await render()
await play(2.5) // idle: blinks and glances around

await raise('prompt.submit', { text: 'add tests' }, {})
working = true
await raise('turn.start', { text: 'add tests', turnId: 't1' }, { turnId: 't1' })
await render()
await play(1.5)
await edit(`${CWD}/src/app.ts`, ['-old', '+new', '+more'])
await edit(`${CWD}/src/app.test.ts`, ['+it("works")', '+expect(app()).toBe(1)', '+})'])
await render()
await play(2) // working: waving claws and sparks

await bash('npm test', { isError: true, result: undefined, text: 'Tests: 3 failed, 39 passed, 42 total' })
await play(3) // uh oh
await edit(`${CWD}/src/util.ts`, ['-bug', '+fix'])
await render()
await play(1)
await bash('npm test', { result: { stdout: 'Tests: 42 passed, 42 total', stderr: '', interrupted: false } })
await play(3.5) // yay!

await measure(31, 1.47)
working = false
await raise('turn.complete', { answer: 'done', durationMs: 134_000, isAborted: false, turnId: 't1', reason: 'answer' }, { text: 'done' })
await refresh()
await render()
await play(2.5) // ready, with the turn summary

await raise('command.run', { command: 'focus-timer', args: '25' }, { text: '' })
await play(2.5) // focus timer under the crab

await raise('command.run', { command: 'focus-timer', args: 'off' }, { text: '' })
now += 11 * 60_000 // nobody around for a while
await refresh()
await play(3.5) // asleep

writeFileSync('frames.json', JSON.stringify(frames))
console.log(`${frames.length} frames, ${band.cols} columns`)
