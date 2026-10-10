import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'

import type { TodoFile } from '../types'

// A task board kept in TODO.md (## Todo / ## Doing / ## Done), drawn in a
// pane. The mod does the mechanical edits (capture, moving to Doing,
// archiving); anything that needs the code's context (enrichment, done logs)
// it hands to Claude as a prompt, following the rules /todo init writes.

const FILE = 'TODO.md'
const ARCHIVE = 'TODO-archive.md'
const RULE_FILES = ['CLAUDE.md', 'AGENTS.md']
const PANE = 'todo'
const TITLE = 'Tasks'
const COMMAND = 'todo'
const POLL_MS = 1500
const DONE_SHOWN = 5
// Named colours only, so light and dark terminal themes both read.
const SECTION_COLOR = { doing: 'yellow', todo: 'cyan', done: 'green' } as const
const MARK_START = '<!-- todo:start -->'
const MARK_END = '<!-- todo:end -->'
const RULES_HEADING = '## Task board (TODO.md)'

const fileAtom = atom({ plugin: 'todo', key: 'file' } as const, { exists: false, text: '', mtime: 0 })
const selectedAtom = atom({ plugin: 'todo', key: 'selected' } as const, null)
const draftAtom = atom({ plugin: 'todo', key: 'draft' } as const, '')
const rulesAtom = atom({ plugin: 'todo', key: 'hasRules' } as const, false)
const expandedAtom = atom({ plugin: 'todo', key: 'expanded' } as const, null)
const renamingAtom = atom({ plugin: 'todo', key: 'renaming' } as const, null)
const markedAtom = atom({ plugin: 'todo', key: 'marked' } as const, [] as string[])
const focusedAtom = atom({ plugin: 'todo', key: 'focused' } as const, null as string | null)
const droppingAtom = atom({ plugin: 'todo', key: 'dropping' } as const, null as string | null)

const TEMPLATE = `# TODO

## Todo

## Doing

## Done
`

const RULES = `${MARK_START}
${RULES_HEADING}

\`TODO.md\` at the project root is the task board, in three sections: \`## Todo\`, \`## Doing\`, \`## Done\`. Older done tasks move to \`TODO-archive.md\`.

- **Capture.** The engineer adds tasks as one short line under \`## Todo\` (\`- fix flaky auth test\`), with no ID. Keep their wording.
- **Enrichment.** When asked to enrich (any time, mid-project included), find every task line with no ID. Give each the next free ID, \`T-<n>\`: one more than the highest ID in TODO.md and TODO-archive.md. Never reuse or renumber an ID, and leave tasks that already have one alone. Under the task add 3 to 4 short lines of context for the engineer to decide on: where it lands in the code (\`file:line\`), related code or helpers to reuse, risks, and the decisions that are theirs. No more than 4 lines.
- **Doing.** A task being worked on sits under \`## Doing\`. When a decision is the engineer's, ask them; record each question under the task as \`> Q: ...\` and their answer as \`> A: ...\`. On starting a task, first check its \`file:line\` references against the code and fix any that drifted.
- **Done.** When a task is finished, move it to the top of \`## Done\`, append the date to its line (\`- T-12 Fix flaky auth test (2026-10-10)\`), and replace its notes with the log: what was done, the decisions taken and why, the result (tests, behaviour), and the files or commits touched. This one may be longer; keep it to bullets.
- **Format.** A task is a line \`- T-<n> <title>\` (or \`- <title>\` before enrichment) at column 0; its notes follow on lines indented two spaces, each starting with \`> \`. Keep to it: the task panel parses this file.
${MARK_END}`

type Section = 'todo' | 'doing' | 'done'

type Task = {
  section: Section
  id?: string
  // The ID, or `raw:<title>` (`raw:<title>:<n>` for the nth of a repeated title).
  key: string
  title: string
  notes: string[]
  hasOpenQuestion: boolean
  // The open question's text and its line in the file, while one is open.
  question?: { text: string; line: number }
  // Lines [start, end) of the file, the task line and its notes.
  start: number
  end: number
}

const keyOf = (t: Task) => t.key

const SECTION_RE = /^##\s+(todo|doing|done)\s*$/i
const TASK_RE = /^[-*]\s+(?:\[[ xX]\]\s+)?(.+)$/
const ID_RE = /^(T-\d+)\b[:.]?\s*(.*)$/

function parse(text: string): Task[] {
  const lines = text.split('\n')
  const tasks: Task[] = []
  let section: Section | null = null
  let task: Task | null = null
  const repeats: Record<string, number> = {}
  lines.forEach((line, i) => {
    const heading = SECTION_RE.exec(line)
    if (heading || line.startsWith('#')) {
      task = null
      section = heading ? (heading[1]!.toLowerCase() as Section) : null
      return
    }
    if (!section) return
    const item = TASK_RE.exec(line)
    if (item) {
      const id = ID_RE.exec(item[1]!.trim())
      const title = (id ? id[2]! : item[1]!).trim()
      const n = id ? 0 : (repeats[title] = (repeats[title] ?? 0) + 1)
      task = {
        section,
        id: id?.[1],
        key: id ? id[1]! : n > 1 ? `raw:${title}:${n}` : `raw:${title}`,
        title,
        notes: [],
        hasOpenQuestion: false,
        start: i,
        end: i + 1,
      }
      tasks.push(task)
      return
    }
    if (task && /^\s/.test(line) && line.trim()) {
      const note = line.trim().replace(/^>\s?/, '')
      task.notes.push(note)
      task.end = i + 1
      if (/^Q:/i.test(note)) {
        task.hasOpenQuestion = true
        task.question = { text: note.replace(/^Q:\s*/i, ''), line: i }
      } else if (/^A:/i.test(note)) {
        task.hasOpenQuestion = false
        task.question = undefined
      }
    } else if (line.trim()) {
      task = null
    }
  })
  return tasks
}

// Where a section's last task ends (blank lines before the next heading left
// alone), adding the heading at the end of the file when it is missing.
function sectionEnd(lines: string[], section: Section): number {
  let at = lines.findIndex(l => SECTION_RE.exec(l)?.[1]!.toLowerCase() === section)
  if (at === -1) {
    while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop()
    lines.push('', `## ${section[0]!.toUpperCase()}${section.slice(1)}`, '')
    return lines.length - 1
  }
  let end = at + 1
  while (end < lines.length && !lines[end]!.startsWith('#')) end++
  while (end > at + 1 && !lines[end - 1]!.trim()) end--
  return end
}

function insertInto(lines: string[], section: Section, block: string[]): string[] {
  const out = [...lines]
  const at = sectionEnd(out, section)
  // One blank line between a heading and its first task.
  const pad = SECTION_RE.test(out[at - 1] ?? '') ? [''] : []
  out.splice(at, 0, ...pad, ...block)
  return out
}

function addTask(text: string, title: string): string {
  const lines = text.split('\n')
  return insertInto(lines, 'todo', [`- ${title}`]).join('\n')
}

// Removes a task's lines and closes the gap they leave (no other blank lines touched).
function removeBlock(lines: string[], t: Task): string[] {
  const block = lines.splice(t.start, t.end - t.start)
  while (t.start > 0 && t.start < lines.length && !lines[t.start - 1]!.trim() && !lines[t.start]!.trim()) lines.splice(t.start, 1)
  return block
}

function moveTask(
  text: string,
  key: string,
  to: Section,
  atTop = false,
  reshape: (block: string[]) => string[] = block => block,
): string | null {
  const task = parse(text).find(t => keyOf(t) === key)
  if (!task || task.section === to) return null
  const lines = text.split('\n')
  const block = reshape(removeBlock(lines, task))
  const first = atTop ? parse(lines.join('\n')).find(t => t.section === to) : undefined
  if (first) {
    lines.splice(first.start, 0, ...block)
    return lines.join('\n')
  }
  return insertInto(lines, to, block).join('\n')
}

// Swaps a task with its neighbour in the same section (-1 up, 1 down).
function reorderTask(text: string, key: string, dir: -1 | 1): string | null {
  const tasks = parse(text)
  const task = tasks.find(t => keyOf(t) === key)
  if (!task) return null
  const peers = tasks.filter(t => t.section === task.section)
  const other = peers[peers.indexOf(task) + dir]
  if (!other) return null
  const [a, b] = dir === -1 ? [other, task] : [task, other]
  const lines = text.split('\n')
  return [
    ...lines.slice(0, a.start),
    ...lines.slice(b.start, b.end),
    ...lines.slice(a.end, b.start),
    ...lines.slice(a.start, a.end),
    ...lines.slice(b.end),
  ].join('\n')
}

// The task line's bullet, checkbox and ID kept, its title replaced.
const LINE_HEAD_RE = /^([-*]\s+(?:\[[ xX]\]\s+)?(?:T-\d+\b[:.]?\s*)?)/

function renameTask(text: string, key: string, title: string): { text: string; key: string } | null {
  const task = parse(text).find(t => keyOf(t) === key)
  if (!task) return null
  const lines = text.split('\n')
  const head = LINE_HEAD_RE.exec(lines[task.start]!)?.[1] ?? '- '
  lines[task.start] = `${head}${head.endsWith(' ') ? '' : ' '}${title}`
  const next = lines.join('\n')
  // A raw task's key is its title: find it again where it sits.
  const renamed = parse(next).find(t => t.start === task.start)
  return { text: next, key: renamed ? keyOf(renamed) : key }
}

// The board sits at the project root, not wherever a shell cd left the session.
const inRoot = async ($: EngineInterface, file: string) => `${await $.session.root()}/${file}`

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

// The panel's focusable keys as last drawn, the ones Tab stops on, and where
// the person's focus last landed: Tab walks task rows, not every button.
let focusOrder: string[] = []
let focusStops = new Set<string>()
let lastFocus: string | undefined

// The mtime last read, so a poll redraws only on a change.
let seen = -1

async function load($: EngineInterface) {
  const stat = await $.fs.stat(await inRoot($, FILE)).catch(() => null)
  const mtime = stat?.mtimeMs ?? 0
  if (mtime === seen) return
  seen = mtime
  const text = stat ? await $.fs.read(await inRoot($, FILE)).catch(() => '') : ''
  const file: TodoFile = { exists: stat !== null, text: typeof text === 'string' ? text : '', mtime }
  await update($, fileAtom, () => file)
  const doing = parse(file.text).filter(t => t.section === 'doing')
  const first = doing[0]
  $.ui.status(
    first ? `▸ ${first.id ? `${first.id} ` : ''}${first.title}${doing.length > 1 ? ` (+${doing.length - 1})` : ''}` : undefined,
  )
}

// Every panel edit to TODO.md: read it, apply `edit`, write it back, unless
// the file changed while the edit was made (Claude writing it too); then the
// edit runs again on the fresh text, so neither change is lost. `beforeWrite`
// runs once the write is sure to happen. Resolves to the text written, or
// null when the edit changed nothing or the file kept moving.
async function editBoard(
  $: EngineInterface,
  edit: (text: string) => string | null,
  beforeWrite?: () => Promise<void>,
): Promise<string | null> {
  const path = await inRoot($, FILE)
  const mtimeOf = async () => (await $.fs.stat(path).catch(() => null))?.mtimeMs ?? null
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await mtimeOf()
    const text = before === null ? TEMPLATE : ((await $.fs.read(path)) as string)
    const next = edit(text)
    if (next === null || next === text) return null
    if ((await mtimeOf()) !== before) continue
    await beforeWrite?.()
    await $.fs.write(path, next)
    seen = -1
    await load($)
    return next
  }
  $.ui.toast(`todo: ${FILE} kept changing, the edit was not saved; try again`)
  return null
}

async function current($: EngineInterface) {
  const exists = await $.fs.exists(await inRoot($, FILE))
  return exists ? await $.fs.read(await inRoot($, FILE)) as string : TEMPLATE
}

async function checkRules($: EngineInterface) {
  let has = false
  for (const f of RULE_FILES) {
    const text = await $.fs.read(await inRoot($, f)).catch(() => '')
    if (typeof text === 'string' && (text.includes(MARK_START) || text.includes(RULES_HEADING))) has = true
  }
  await update($, rulesAtom, () => has)
  return has
}

async function capture($: EngineInterface, title: string) {
  await editBoard($, text => addTask(text, title.trim()))
}

// Writes the rules block into CLAUDE.md and AGENTS.md where they exist
// (replacing an older block), or a new CLAUDE.md; skips a CLAUDE.md that
// only imports AGENTS.md. Creates TODO.md from the template.
async function init($: EngineInterface) {
  const done: string[] = []
  if (!(await $.fs.exists(await inRoot($, FILE)))) {
    await $.fs.write(await inRoot($, FILE), TEMPLATE)
    done.push(`created ${FILE}`)
  }
  const present: Record<string, string> = {}
  for (const f of RULE_FILES) {
    const text = await $.fs.read(await inRoot($, f)).catch(() => null)
    if (typeof text === 'string') present[f] = text
  }
  const targets = Object.keys(present).filter(f => !(f === 'CLAUDE.md' && present['AGENTS.md'] !== undefined && /^@AGENTS\.md\s*$/m.test(present[f]!)))
  if (targets.length === 0) targets.push('CLAUDE.md')
  for (const f of targets) {
    const text = present[f] ?? ''
    const start = text.indexOf(MARK_START)
    if (start === -1 && text.includes(RULES_HEADING)) {
      done.push(`found the rules in ${f} without their markers, left them as they are`)
      continue
    }
    const end = text.indexOf(MARK_END, start)
    // A block that lost its end marker runs to the end of the file.
    const next =
      start !== -1
        ? text.slice(0, start) + RULES + (end !== -1 ? text.slice(end + MARK_END.length) : '\n')
        : `${text.trimEnd()}${text.trim() ? '\n\n' : ''}${RULES}\n`
    if (next === text) continue
    await $.fs.write(await inRoot($, f), next)
    done.push(`${start !== -1 ? 'updated' : 'added'} the rules in ${f}`)
  }
  seen = -1
  await load($)
  await checkRules($)
  return done
}

// Moves the Done tasks to the archive, all of them or all but the newest
// `keep` (Done runs newest first).
async function archive($: EngineInterface, keep = 0) {
  let moved: string[] = []
  let n = 0
  const written = await editBoard(
    $,
    text => {
      const done = parse(text).filter(t => t.section === 'done').slice(keep)
      if (done.length === 0) return null
      const lines = text.split('\n')
      moved = done.flatMap(t => lines.slice(t.start, t.end))
      n = done.length
      for (const t of [...done].reverse()) removeBlock(lines, t)
      return lines.join('\n')
    },
    // The archive is written first, so a failed write loses no task.
    async () => {
      const old = await $.fs.read(await inRoot($, ARCHIVE)).catch(() => '# TODO archive\n')
      const head = typeof old === 'string' ? old.trimEnd() : '# TODO archive'
      await $.fs.write(await inRoot($, ARCHIVE), `${head}\n\n${moved.join('\n')}\n`)
    },
  )
  return written === null ? 0 : n
}

// Set from the `autoArchive` option: archive when Done holds more than this
// many tasks (0: never), keeping the newest AUTO_ARCHIVE_KEEP.
let autoArchiveOver = 20
const AUTO_ARCHIVE_KEEP = 10

async function autoArchive($: EngineInterface) {
  if (autoArchiveOver <= 0) return
  const done = parse(await current($)).filter(t => t.section === 'done').length
  if (done <= autoArchiveOver) return
  const n = await archive($, Math.min(AUTO_ARCHIVE_KEEP, autoArchiveOver))
  if (n) $.ui.toast(`todo: moved ${plural(n, 'old done task')} to ${ARCHIVE}`)
}

async function ask($: EngineInterface, text: string) {
  await $.prompt.submit({ text }).catch((err: unknown) => $.ui.log(`todo: prompt not sent: ${String(err)}`))
}
const ref = (t: Task) => (t.id ? `${t.id} "${t.title}"` : `the task "${t.title}"`)

function enrichAll($: EngineInterface, n: number) {
  return ask(
    $,
    `Enrich the ${plural(n, 'unenriched task')} in ${FILE}, following the task board rules: give each the next free ID and 3 to 4 lines of context.`,
  )
}

async function start($: EngineInterface, t: Task) {
  await autoArchive($)
  await editBoard($, text => moveTask(text, keyOf(t), 'doing'))
  await ask(
    $,
    t.id
      ? `Start working on ${ref(t)} (now under Doing in ${FILE}). First check its \`file:line\` references against the code and fix any that drifted. Follow the task board rules: ask me when a decision is mine and record the Q/A under the task.`
      : `Start working on ${ref(t)} (now under Doing in ${FILE}). It is not enriched yet: give it the next free ID and its context lines first, then follow the task board rules.`,
  )
}

// Starts the marked tasks as one batch, in Todo order: all move to Doing,
// and Claude works them one at a time, each finished before the next.
async function startBatch($: EngineInterface, ts: Task[]) {
  await update($, markedAtom, () => [])
  if (ts.length === 1) return start($, ts[0]!)
  await autoArchive($)
  await editBoard($, text => ts.reduce((acc, t) => moveTask(acc, keyOf(t), 'doing') ?? acc, text))
  const list = ts.map((t, i) => `${i + 1}. ${t.id ? `${t.id} "${t.title}"` : `"${t.title}" (not enriched yet: give it the next free ID and its context lines first)`}`)
  await ask(
    $,
    `Start working on these ${ts.length} tasks, now under Doing in ${FILE}, one at a time in this order:\n${list.join('\n')}\n` +
      `For each: first check its \`file:line\` references against the code and fix any that drifted, follow the task board rules (ask me when a decision is mine and record the Q/A under that task), and when it is finished move it to Done with its own log before starting the next. ${COMMIT_STEP}`,
  )
}

const QUICK_DONE_NOTE = '  > Done from the panel, no log.'
// The local date (toISOString would give UTC's, a day off late in the evening).
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Moves a task to the top of Done with today's date, its notes kept and a
// line saying no log was written: for tasks too small to ask Claude about.
function quickDoneTask(text: string, key: string, date: string): string | null {
  return moveTask(text, key, 'done', true, ([line, ...notes]) => [`${line!.trimEnd()} (${date})`, ...notes, QUICK_DONE_NOTE])
}

async function quickDone($: EngineInterface, t: Task) {
  await editBoard($, text => quickDoneTask(text, keyOf(t), today()))
}

// Writes `> A: <answer>` right under the task's open question.
function answerTask(text: string, key: string, answer: string): string | null {
  const task = parse(text).find(t => keyOf(t) === key)
  if (!task?.question) return null
  const lines = text.split('\n')
  lines.splice(task.question.line + 1, 0, `  > A: ${answer}`)
  return lines.join('\n')
}

async function answer($: EngineInterface, t: Task, value: string) {
  const text = value.trim()
  if (!text || !t.question) return
  const written = await editBoard($, board => answerTask(board, keyOf(t), text))
  if (written === null) return
  await ask(
    $,
    `${ref(t)}: I answered its open question in ${FILE}. Q: ${t.question.text} A: ${text}. ` +
      (t.section === 'doing' ? 'Carry on with it, following the task board rules.' : 'It is not started; no need to work on it now.'),
  )
}

// A task given up on: one with an ID goes to the top of Done marked
// `(dropped <date>)`, notes kept, so its ID stays taken; a raw one is deleted.
function dropTask(text: string, key: string, date: string): string | null {
  const task = parse(text).find(t => keyOf(t) === key)
  if (!task || task.section === 'done') return null
  if (task.id) return moveTask(text, key, 'done', true, ([line, ...notes]) => [`${line!.trimEnd()} (dropped ${date})`, ...notes])
  const lines = text.split('\n')
  removeBlock(lines, task)
  return lines.join('\n')
}

async function sendBack($: EngineInterface, t: Task) {
  const moved = await editBoard($, text => moveTask(text, keyOf(t), 'todo', true))
  if (moved === null) return
  await ask($, `${ref(t)} is back in Todo in ${FILE}. Stop working on it and leave its notes as they are.`)
}

async function reorder($: EngineInterface, t: Task, dir: -1 | 1) {
  await editBoard($, text => reorderTask(text, keyOf(t), dir))
}

async function rename($: EngineInterface, t: Task, value: string) {
  await update($, renamingAtom, () => null)
  const title = value.trim()
  if (!title || title === t.title) return
  let key = keyOf(t)
  const written = await editBoard($, text => {
    const out = renameTask(text, keyOf(t), title)
    if (out) key = out.key
    return out?.text ?? null
  })
  if (written === null) return
  await update($, selectedAtom, () => key)
  // Notes written for the old title may no longer fit: Claude reviews them.
  if (t.notes.length > 0) {
    await ask(
      $,
      `${t.id ?? 'A task'} in ${FILE} was renamed from "${t.title}" to "${title}". Check its notes against the new title and update them if they no longer fit, following the task board rules.`,
    )
  }
}

// What Done asks about commits: the log names them; work not yet committed
// is offered for a commit first (only the task's files), never committed
// without a yes.
const COMMIT_STEP =
  `If the task's changes are not committed yet, ask me whether to commit them now (staging only that task's files) before writing the log. ` +
  `The log names the commit(s) holding the work, or says "Uncommitted".`

function finish($: EngineInterface, t: Task) {
  return ask(
    $,
    `${t.id ?? `The task "${t.title}"`} is done. Following the task board rules, move it to Done in ${FILE} with today's date and replace its notes with the done log: what was done, the decisions and why, the result, the files touched. ${COMMIT_STEP}`,
  )
}

function open($: EngineInterface) {
  return $.ui.open({ id: PANE, title: TITLE, closeOnEscape: true })
}

async function submitDraft($: EngineInterface, value: string) {
  await update($, draftAtom, () => '')
  if (value.trim()) await capture($, value)
}

export const register: Register = (on, options) => {
  if (typeof options.autoArchive === 'number') autoArchiveOver = options.autoArchive
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Task board: /todo opens the panel, /todo <task> adds one, /todo init | enrich | archive | close',
    }).catch((err: unknown) => $.ui.log(`todo: /${COMMAND} not registered: ${String(err)}`))
    await load($).catch(() => {})
    await checkRules($).catch(() => {})
    $.clock.every(POLL_MS, () => void load($).catch(() => {}))
    if (options.autoOpen !== false && (await read($, fileAtom)).exists) void open($).catch(() => {})
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const args = e.args.trim()
    const word = args.toLowerCase()
    if (word === 'init') {
      const done = await init($)
      await open($)
      return { text: done.length ? `Task board: ${done.join(', ')}.` : 'Task board already set up.' }
    }
    if (word === 'enrich') {
      const n = parse(await current($)).filter(t => !t.id && t.section !== 'done').length
      if (n === 0) return { text: 'Every task already has an ID.' }
      // A command may not submit while it holds the turn: send it just after.
      $.clock.after(0, () => void enrichAll($, n))
      return { text: `Asked Claude to enrich ${plural(n, 'task')}.` }
    }
    if (word === 'close') {
      const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
      if (!isOpen) return { text: 'Task panel is not open.' }
      await $.ui.close({ id: PANE })
      return { text: 'Task panel closed.' }
    }
    if (word === 'archive') {
      const n = await archive($)
      return { text: n ? `Moved ${plural(n, 'done task')} to ${ARCHIVE}.` : 'No done tasks to archive.' }
    }
    if (args) {
      await capture($, args)
      return { text: `Added to ${FILE}: ${args}` }
    }
    const opened = await open($)
    return { text: opened.isPlaced ? 'Task panel opened.' : `Task panel waiting: ${opened.reason ?? 'no room'}.` }
  })

  // A Tab (or arrow) step onto an action button carries on, the same way, to
  // the next row; buttons are pressed by their letters. Only one-step moves
  // are redirected, so a click on a button far from the focus is left alone.
  on('ui.focus', async ($, e, next) => {
    if (e.component !== 'Pane' || e.requestId !== PANE || !e.element) return next(e)
    if (e.origin.kind !== 'person') {
      lastFocus = e.element
      await update($, focusedAtom, () => e.element ?? null)
      return next(e)
    }
    const from = lastFocus === undefined ? -1 : focusOrder.indexOf(lastFocus)
    const to = focusOrder.indexOf(e.element)
    let element = e.element
    if (from !== -1 && to !== -1 && Math.abs(to - from) === 1 && !focusStops.has(element)) {
      const dir = to - from
      let i = to
      while (i >= 0 && i < focusOrder.length && !focusStops.has(focusOrder[i]!)) i += dir
      if (i >= 0 && i < focusOrder.length) element = focusOrder[i]!
    }
    lastFocus = element
    // The top bar's Mark follows the focused row.
    await update($, focusedAtom, () => element)
    return element === e.element ? next(e) : next({ ...e, element })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    // Mobile has no Input; there tasks are added with /todo <task>.
    const Input = 'Input' in els ? els.Input : undefined
    const file = await read($, fileAtom)
    const hasRules = await read($, rulesAtom)
    const draft = await read($, draftAtom)

    if (!file.exists) {
      return (
        <Box flexDirection="column">
          <Text>No {FILE} in this project yet.</Text>
          <Text dimColor>Create it and add the task board rules to CLAUDE.md:</Text>
          <Button key="init" variant="primary" hotkey="i" label="Set up the task board" onPress={() => void init($)} />
        </Box>
      )
    }

    // Every focusable key in drawing order (keys are evaluated top-down), and
    // which of them Tab stops on: the add field, task rows, the rename field.
    const order: string[] = []
    const stops = new Set<string>()
    const k = (key: string, stop = false) => {
      order.push(key)
      if (stop) stops.add(key)
      return key
    }

    const tasks = parse(file.text)
    const by = (s: Section) => tasks.filter(t => t.section === s)
    const [todo, doing, done] = [by('todo'), by('doing'), by('done')]
    const raw = tasks.filter(t => !t.id && t.section !== 'done')
    const peers = (t: Task) => by(t.section)
    // The open task: its detail shows under its row until Enter or Close folds it.
    const selectedKey = await read($, selectedAtom)
    const chosen = tasks.find(t => keyOf(t) === selectedKey)
    // A done task's log folds to its first line until opened with `o`.
    const foldable = chosen?.section === 'done' && chosen.notes.length > 1
    const folded = foldable && (await read($, expandedAtom)) !== keyOf(chosen)
    const notes = chosen ? (folded ? chosen.notes.slice(0, 1) : chosen.notes) : []
    const renaming = await read($, renamingAtom)
    const dropping = await read($, droppingAtom)
    // The keyboard goes to a row that stays: the task's own once in Done, or
    // a neighbour when a raw task is deleted.
    const drop = async (t: Task) => {
      const peers = by(t.section)
      const i = peers.indexOf(t)
      const stays = t.id ? t : peers[i + 1] ?? peers[i - 1]
      await close(stays)
      await editBoard($, text => dropTask(text, keyOf(t), today()))
    }
    // Marks of tasks that left Todo (started, renamed, removed) drop out here.
    const markedKeys = await read($, markedAtom)
    const marked = todo.filter(t => markedKeys.includes(keyOf(t)))
    const isMarked = (t: Task) => marked.includes(t)
    // `m` marks the Todo task the focus is on, else the open one; the focus
    // then moves to the next Todo row, so m, m, m marks a run of tasks.
    const focusedKey = await read($, focusedAtom)
    const focusedTask = tasks.find(t => `task:${keyOf(t)}` === focusedKey)
    const markTarget = focusedTask?.section === 'todo' ? focusedTask : chosen?.section === 'todo' ? chosen : undefined
    const toggleMark = async (t: Task) => {
      const key = keyOf(t)
      await update($, markedAtom, keys => (keys.includes(key) ? keys.filter(k => k !== key) : [...keys, key]))
      const nextRow = todo[todo.indexOf(t) + 1] ?? t
      if (chosen === t) return close(nextRow)
      await $.ui.focus({ requestId: PANE, key: `task:${keyOf(nextRow)}` }).catch(() => {})
    }

    const detail = (t: Task) => (
      <Box flexDirection="column" paddingLeft={4} key="detail">
        {renaming === keyOf(t) && Input && (
          <Box flexDirection="row" columnGap={2} key="rename-row">
            <Input key={k('rename', true)} value={t.title} submitLabel="save" onSubmit={value => void rename($, t, value)} />
            <Button key={k('rename-cancel')} plain label="Cancel" onPress={() => void update($, renamingAtom, () => null)} />
          </Box>
        )}
        {t.notes.length === 0 && <Text dimColor>{t.id ? 'No notes.' : 'Not enriched yet.'}</Text>}
        {notes.map(n => (
          <Text dimColor={!/^[QA]:/i.test(n)} color={/^Q:/i.test(n) ? 'yellow' : undefined} wrap={folded ? 'truncate-end' : undefined}>
            {n}
          </Text>
        ))}
        {folded && <Text dimColor>+{t.notes.length - 1} more</Text>}
        {t.question && Input && (
          <Input key={k('answer', true)} label="Answer:" submitLabel="answer" onSubmit={value => void answer($, t, value)} />
        )}
        <Box flexDirection="row" columnGap={2} key="actions">
          {t.section === 'todo' && <Button key={k('start')} plain hotkey="s" label="Start" onPress={() => void start($, t)} />}
          {t.section === 'doing' && <Button key={k('done')} plain hotkey="d" label="Done" onPress={() => void finish($, t)} />}
          {t.section !== 'done' && (
            <Button key={k('quick-done')} plain hotkey="q" label="Quick done" onPress={() => void quickDone($, t)} />
          )}
          {t.section !== 'done' && (
            <Button
              key={k('drop')}
              plain
              hotkey="x"
              label={dropping === keyOf(t) ? 'Confirm drop' : 'Drop'}
              onPress={() => void (dropping === keyOf(t) ? drop(t) : update($, droppingAtom, () => keyOf(t)))}
            />
          )}
          {t.section === 'doing' && <Button key={k('back')} plain hotkey="b" label="Back to Todo" onPress={() => void sendBack($, t)} />}
          {t.section !== 'done' && peers(t).indexOf(t) > 0 && (
            <Button key={k('up')} plain hotkey="k" label="Up" onPress={() => void reorder($, t, -1)} />
          )}
          {t.section !== 'done' && peers(t).indexOf(t) < peers(t).length - 1 && (
            <Button key={k('down')} plain hotkey="j" label="Down" onPress={() => void reorder($, t, 1)} />
          )}
          {t.section !== 'done' && Input && renaming !== keyOf(t) && (
            <Button
              key={k('rename-open')}
              plain
              hotkey="r"
              label="Rename"
              onPress={async () => {
                await update($, renamingAtom, () => keyOf(t))
                await $.ui.focus({ requestId: PANE, key: 'rename' }).catch(() => {})
              }}
            />
          )}
          {foldable && (
            <Button
              key={k('log')}
              plain
              hotkey="o"
              label={folded ? 'Open log' : 'Fold log'}
              onPress={() => void update($, expandedAtom, () => (folded ? keyOf(t) : null))}
            />
          )}
          {!t.id && t.section !== 'done' && (
            <Button
              key={k('enrich')}
              plain
              hotkey="e"
              label="Enrich"
              onPress={() => void ask($, `Enrich ${ref(t)} in ${FILE}, following the task board rules.`)}
            />
          )}
          <Button key={k('close')} plain hotkey="c" label="Close" onPress={() => void close()} />
        </Box>
      </Box>
    )
    // Folding removes the button that holds the keyboard; the pane would hand
    // the keys back to the prompt (a hotkey then types into the chat), so the
    // focus moves to a row that stays first.
    const close = async (focusOn = chosen) => {
      if (focusOn) await $.ui.focus({ requestId: PANE, key: `task:${keyOf(focusOn)}` }).catch(() => {})
      await update($, droppingAtom, () => null)
      await update($, renamingAtom, () => null)
      await update($, selectedAtom, () => null)
    }
    // Enter on a row opens its detail; on the open row, folds it.
    const toggle = async (t: Task) => {
      if (chosen && keyOf(chosen) === keyOf(t)) return close()
      await update($, droppingAtom, () => null)
      await update($, renamingAtom, () => null)
      await update($, selectedAtom, () => keyOf(t))
    }

    const row = (t: Task) => {
      const isOpen = chosen !== undefined && keyOf(chosen) === keyOf(t)
      const isDone = t.section === 'done'
      const marker = isOpen ? '▾' : isMarked(t) ? '●' : ' '
      return (
        <Box flexDirection="column" key={`row:${keyOf(t)}`}>
          <Box flexDirection="row">
            <Button
              key={k(`task:${keyOf(t)}`, true)}
              plain
              dimColor={isDone}
              label={`${marker} ${t.id ?? '·'} ${t.title}`}
              onPress={() => void toggle(t)}
            >
              {`${marker} `}
              {t.id ? <Text color={SECTION_COLOR[t.section]}>{t.id}</Text> : <Text dimColor>·</Text>}
              {` ${t.title}`}
            </Button>
            {t.hasOpenQuestion && <Text color="yellow"> ?</Text>}
          </Box>
          {isOpen && detail(t)}
        </Box>
      )
    }
    const heading = (section: Section, n: number) => (
      <Text bold color={SECTION_COLOR[section]}>
        {section[0]!.toUpperCase()}{section.slice(1)} <Text dimColor>{n}</Text>
      </Text>
    )

    const tree = (
      <Box flexDirection="column">
        {!hasRules && <Text color="yellow">Rules not in CLAUDE.md yet: run /todo init.</Text>}
        {Input && (<Input
          key={k('add', true)}
          placeholder="Add a task…"
          submitLabel="add"
          value={draft}
          onInput={value => void update($, draftAtom, () => value)}
          onSubmit={value => void submitDraft($, value)}
        />)}
        {(raw.length > 0 || marked.length > 0 || markTarget) && (
          <Box flexDirection="row" columnGap={2} key="top-actions">
            {raw.length > 0 && (
              <Button key={k('enrich-all')} plain hotkey="a" label={`Enrich ${plural(raw.length, 'new task')}`} onPress={() => void enrichAll($, raw.length)} />
            )}
            {markTarget && (
              <Button
                key={k('mark')}
                plain
                hotkey="m"
                label={`${isMarked(markTarget) ? 'Unmark' : 'Mark'} ${markTarget.id ?? markTarget.title}`}
                onPress={() => void toggleMark(markTarget)}
              />
            )}
            {marked.length > 0 && (
              <Button key={k('start-marked')} plain hotkey="g" label={`Start ${marked.length} marked`} onPress={() => void startBatch($, marked)} />
            )}
          </Box>
        )}
        <Text> </Text>
        {heading('doing', doing.length)}
        {doing.map(row)}
        {heading('todo', todo.length)}
        {todo.map(row)}
        {heading('done', done.length)}
        {done.slice(0, DONE_SHOWN).map(row)}
        {done.length > DONE_SHOWN && <Text dimColor>  +{done.length - DONE_SHOWN} more · /todo archive</Text>}
        {!chosen && tasks.length > 0 && <Text dimColor>Enter on a task shows its notes and actions.</Text>}
      </Box>
    )
    focusOrder = order
    focusStops = stops
    return tree
  })
}
