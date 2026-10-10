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
const graphZoomAtom = atom({ plugin: 'todo', key: 'graphZoom' } as const, 2)
const graphScrollAtom = atom({ plugin: 'todo', key: 'graphScroll' } as const, 0)

const TEMPLATE = `# TODO

## Todo

## Doing

## Done
`

const RULES = `${MARK_START}
${RULES_HEADING}

\`TODO.md\` at the project root is the task board, in three sections: \`## Todo\`, \`## Doing\`, \`## Done\`. Older done tasks move to \`TODO-archive.md\`.

- **Capture.** The engineer adds tasks as one short line under \`## Todo\` (\`- fix flaky auth test\`), with no ID. Keep their wording.
- **Enrichment.** When asked to enrich (any time, mid-project included), find every task line with no ID. Give each the next free ID, \`T-<n>\`: one more than the highest ID in TODO.md and TODO-archive.md. Never reuse or renumber an ID, and leave tasks that already have one alone. Under the task add 3 to 4 short lines of context for the engineer to decide on: where it lands in the code (\`file:line\`), related code or helpers to reuse, risks, and the decisions that are theirs. No more than 4 lines. When the task can only be done after other open tasks, one of those lines is \`> Depends: T-<n>, T-<m>\`.
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
  // IDs from a `> Depends: T-3, T-5` note: the tasks this one waits on.
  deps: string[]
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
        deps: [],
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
      } else if (/^Depends:/i.test(note)) {
        task.deps.push(...(note.match(/T-\d+/g) ?? []))
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

// A toast for tasks starting before what they wait on is done; they still
// start (the person may know better).
function warnUnmet($: EngineInterface, ts: Task[], tasks: Task[], alsoDone: Task[] = []) {
  const notes = ts.flatMap(t => {
    const unmet = unmetDeps(t, tasks).filter(d => !alsoDone.some(o => o.id === d))
    return unmet.length ? [`${t.id ?? t.title} waits on ${unmet.join(', ')}`] : []
  })
  if (notes.length) void $.ui.toast(`todo: ${notes.join('; ')}`)
}

// A batch in an order that puts each task after the batch tasks it waits on,
// Todo order kept otherwise (a cycle falls back to it).
function depsFirst(ts: Task[]): Task[] {
  const out: Task[] = []
  const left = [...ts]
  while (left.length) {
    const i = left.findIndex(t => !t.deps.some(d => left.some(o => o !== t && o.id === d)))
    out.push(...left.splice(i === -1 ? 0 : i, 1))
  }
  return out
}

async function start($: EngineInterface, t: Task) {
  warnUnmet($, [t], parse(await current($)))
  await autoArchive($)
  await editBoard($, text => moveTask(text, keyOf(t), 'doing'))
  await ask(
    $,
    t.id
      ? `Start working on ${ref(t)} (now under Doing in ${FILE}). First check its \`file:line\` references against the code and fix any that drifted. Follow the task board rules: ask me when a decision is mine and record the Q/A under the task.`
      : `Start working on ${ref(t)} (now under Doing in ${FILE}). It is not enriched yet: give it the next free ID and its context lines first, then follow the task board rules.`,
  )
}

// Starts the marked tasks as one batch, in Todo order with each task after
// the batch tasks it waits on: all move to Doing,
// and Claude works them one at a time, each finished before the next.
async function startBatch($: EngineInterface, marked: Task[]) {
  await update($, markedAtom, () => [])
  if (marked.length === 1) return start($, marked[0]!)
  const ts = depsFirst(marked)
  // Deps inside the batch are met by the time their turn comes.
  warnUnmet($, ts, parse(await current($)), ts)
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

// ---- The dependency graph -------------------------------------------------
// Drawn left to right under the lists as a grid of terminal cells (a
// Raster): each task a thin oval with its ID, outlined in its section's
// colour, and arrows from each task to the tasks it unblocks. Pure: tasks
// in, cells out.

type GraphNode = { id: string; title: string; section: Section; deps: string[]; isOpen: boolean }
// A waypoint is the free slot an arrow takes in each column it crosses.
type Placed = GraphNode & { layer: number; x: number; y: number; waypoint?: true }
// One arrow segment between neighbouring columns; `src` / `dst` are the tasks
// at the ends of the whole arrow it belongs to.
type GraphEdge = { from: string; to: string; src: string; dst: string }
// Zoom 1: one-row pills; 2: three-row ovals; 3: ovals with the title under.
type Zoom = 1 | 2 | 3
type Shape = { zoom: Zoom; nodeW: number; colW: number; gap: number; slot: number; mid: number }
type Cells = { columns: number; rows: number; char: string[]; fg: number[] }
type Drawn = Cells & { nodes: Placed[] }

const TITLE_W = 16

function shapeFor(zoom: Zoom, idW: number): Shape {
  if (zoom === 1) return { zoom, nodeW: idW + 2, colW: idW + 2, gap: 5, slot: 2, mid: 0 }
  const nodeW = idW + 4
  if (zoom === 2) return { zoom, nodeW, colW: nodeW, gap: 7, slot: 4, mid: 1 }
  return { zoom, nodeW, colW: Math.max(nodeW, TITLE_W), gap: 7, slot: 5, mid: 1 }
}

// Columns by depth: a task sits one column right of the deepest task it
// waits on (a cycle is cut where it closes). Within a column, tasks follow
// the average row of what they wait on, which keeps arrows short and level.
function layoutGraph(input: GraphNode[], shape: Shape): { nodes: Placed[]; edges: GraphEdge[]; columns: number; rows: number } {
  const byId = new Map(input.map(n => [n.id, n]))
  const layer = new Map<string, number>()
  const visiting = new Set<string>()
  const depth = (id: string): number => {
    const known = layer.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) return 0
    visiting.add(id)
    const deps = byId.get(id)!.deps.filter(d => byId.has(d))
    const d = deps.length ? 1 + Math.max(...deps.map(depth)) : 0
    visiting.delete(id)
    layer.set(id, d)
    return d
  }
  input.forEach(n => depth(n.id))

  // An arrow that skips columns gets a waypoint in each column it crosses,
  // so it runs through a free slot there, never through another task.
  type Slot = GraphNode & { waypoint?: true; preds: string[] }
  const layers: Slot[][] = []
  const add = (slot: Slot, l: number) => (layers[l] ??= []).push(slot)
  const edges: GraphEdge[] = []
  for (const n of input) {
    const preds: string[] = []
    for (const d of n.deps.filter(d => byId.has(d) && layer.get(d)! < layer.get(n.id)!)) {
      let prev = d
      for (let l = layer.get(d)! + 1; l < layer.get(n.id)!; l++) {
        const id = `${d}>${n.id}@${l}`
        add({ id, title: '', section: n.section, deps: [prev], isOpen: false, waypoint: true, preds: [prev] }, l)
        edges.push({ from: prev, to: id, src: d, dst: n.id })
        prev = id
      }
      edges.push({ from: prev, to: n.id, src: d, dst: n.id })
      preds.push(prev)
    }
    add({ ...n, preds }, layer.get(n.id)!)
  }
  // Within a column, follow the average row of the slots feeding in from the
  // column before; tasks before waypoints when tied.
  const rowOf = new Map<string, number>()
  layers.forEach((col, l) => {
    if (l > 0) {
      const weight = (n: Slot) => {
        const rows = n.preds.map(d => rowOf.get(d)).filter((r): r is number => r !== undefined)
        return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : Number.MAX_SAFE_INTEGER
      }
      col.sort((a, b) => weight(a) - weight(b) || Number(!!a.waypoint) - Number(!!b.waypoint))
    }
    col.forEach((n, i) => rowOf.set(n.id, i))
  })

  const step = shape.colW + shape.gap
  const nodes: Placed[] = []
  layers.forEach((col, l) =>
    col.forEach(({ preds: _, ...n }, i) => nodes.push({ ...n, layer: l, x: l * step, y: i * shape.slot })),
  )
  const tallest = Math.max(0, ...layers.map(c => c.length))
  return { nodes, edges, columns: layers.length ? layers.length * step - shape.gap : 0, rows: tallest ? tallest * shape.slot - 1 : 0 }
}

// Colours as 0x00RRGGBB; CELL_DEFAULT is the terminal's own (Raster's bit 24).
const CELL_DEFAULT = 0x01000000
const EDGE_COLOR = 0x8a8a8a
const OPEN_COLOR = 0xffffff
const NODE_COLOR: Record<Section, number> = { doing: 0xe8c547, todo: 0x5fc4d4, done: 0x6f9a6f }

// Line pieces by the directions they join: up 1, right 2, down 4, left 8.
const PIECE: Record<number, string> = {
  2: '─', 8: '─', 10: '─', 1: '│', 4: '│', 5: '│',
  6: '╭', 12: '╮', 3: '╰', 9: '╯',
  7: '├', 13: '┤', 14: '┬', 11: '┴', 15: '┼',
}

// A width-1 BMP character, or '?' (Raster refuses wide and control ones).
function cellChar(ch: string): string {
  const c = ch.codePointAt(0)!
  const wide =
    (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6)
  return c < 0x20 || (c >= 0x7f && c < 0xa0) || c > 0xffff || wide ? '?' : ch
}

const fitCells = (text: string, width: number) => {
  const chars = [...text].map(cellChar)
  return chars.length <= width ? chars : [...chars.slice(0, width - 1), '…']
}

function drawGraph(input: GraphNode[], zoom: Zoom): Drawn {
  const shape = shapeFor(zoom, Math.max(3, ...input.map(n => n.id.length)))
  const g = layoutGraph(input, shape)
  const columns = Math.max(1, g.columns)
  const rows = Math.max(1, g.rows)
  const char = new Array<string>(columns * rows).fill(' ')
  const fg = new Array<number>(columns * rows).fill(CELL_DEFAULT)
  const at = (x: number, y: number) => (x >= 0 && x < columns && y >= 0 && y < rows ? y * columns + x : -1)
  const put = (x: number, y: number, ch: string, color: number) => {
    const i = at(x, y)
    if (i === -1) return
    char[i] = ch
    fg[i] = color
  }

  // Arrows first, nodes over them. Each leaves its node's middle row on the
  // right, turns in the gap before its target's column (one lane per target,
  // so arrows into one task join), and ends in ▶. Arrows sharing a source or
  // a target join where they meet; unrelated ones cross, the vertical over.
  const pos = new Map(g.nodes.map(p => [p.id, p]))
  const pieces = new Map<number, { dirs: number; edge: GraphEdge }[]>()
  const join = (x: number, y: number, dirs: number, edge: GraphEdge) => {
    const i = at(x, y)
    if (i === -1) return
    const list = pieces.get(i) ?? []
    list.push({ dirs, edge })
    pieces.set(i, list)
  }
  // Lanes: in each gap, one column per target where its arrows turn. A line
  // leaving a row must turn before a line arriving on that row begins, or
  // the two would run together: so a target reached from row r gets an
  // earlier lane than the target sitting on row r (a cycle keeps file order).
  const lanes = new Map<string, number>()
  const byLayer = new Map<number, GraphEdge[]>()
  for (const e of g.edges) {
    const l = pos.get(e.to)!.layer
    byLayer.set(l, [...(byLayer.get(l) ?? []), e])
  }
  for (const list of byLayer.values()) {
    const targets = [...new Set(list.map(e => e.to))]
    const after = new Map<string, Set<string>>(targets.map(t => [t, new Set<string>()]))
    for (const e of list) {
      const rowA = pos.get(e.from)!.y
      const onRow = targets.find(t => t !== e.to && pos.get(t)!.y === rowA)
      if (onRow) after.get(e.to)!.add(onRow)
    }
    const order: string[] = []
    const left = [...targets]
    while (left.length) {
      const i = left.findIndex(t => !left.some(o => o !== t && after.get(o)!.has(t)))
      order.push(...left.splice(i === -1 ? 0 : i, 1))
    }
    order.forEach((t, i) => lanes.set(t, i))
  }
  const heads: [number, number][] = []
  for (const e of g.edges) {
    const a = pos.get(e.from)!
    const b = pos.get(e.to)!
    // Out of a task's right edge, or a waypoint's far side; into a task's
    // arrowhead, or straight through a waypoint.
    const sx = a.x + (a.waypoint ? shape.colW : shape.nodeW)
    const sy = a.y + shape.mid
    const tx = b.waypoint ? b.x : b.x - 1
    const ty = b.y + shape.mid
    const bend = Math.min(tx - 1, b.x - shape.gap + 1 + (lanes.get(e.to)! % Math.max(1, shape.gap - 3)))
    for (let x = sx; x < bend; x++) join(x, sy, 2 | 8, e)
    if (sy === ty) {
      join(bend, sy, 2 | 8, e)
    } else {
      const down = ty > sy
      join(bend, sy, 8 | (down ? 4 : 1), e)
      for (let y = Math.min(sy, ty) + 1; y < Math.max(sy, ty); y++) join(bend, y, 1 | 4, e)
      join(bend, ty, 2 | (down ? 1 : 4), e)
    }
    for (let x = bend + 1; x < tx; x++) join(x, ty, 2 | 8, e)
    if (b.waypoint) for (let x = b.x; x < b.x + shape.colW; x++) join(x, ty, 2 | 8, e)
    else heads.push([tx, ty])
  }
  const related = (a: GraphEdge, b: GraphEdge) => a.src === b.src || a.dst === b.dst
  for (const [i, list] of pieces) {
    const vertical = list.find(p => p.dirs === (1 | 4))
    const keep = vertical && list.some(p => !related(p.edge, vertical.edge)) ? list.filter(p => related(p.edge, vertical.edge)) : list
    char[i] = PIECE[keep.reduce((acc, p) => acc | p.dirs, 0)] ?? '┼'
    fg[i] = EDGE_COLOR
  }
  for (const [x, y] of heads) put(x, y, '▶', EDGE_COLOR)

  // Nodes: a pill `(T-12)` at zoom 1; a thin oval at 2 and 3, the title
  // under it at 3. The open task is drawn in white.
  for (const p of g.nodes.filter(n => !n.waypoint)) {
    const color = p.isOpen ? OPEN_COLOR : NODE_COLOR[p.section]
    const w = shape.nodeW
    const id = [...p.id]
    const pad = Math.floor((w - 2 - id.length) / 2)
    const midRow = p.y + shape.mid
    for (let x = p.x + 1; x < p.x + w - 1; x++) put(x, midRow, ' ', color)
    put(p.x, midRow, '(', color)
    put(p.x + w - 1, midRow, ')', color)
    id.forEach((ch, i) => put(p.x + 1 + pad + i, midRow, ch, color))
    if (zoom === 1) continue
    put(p.x + 1, p.y, '╭', color)
    put(p.x + w - 2, p.y, '╮', color)
    put(p.x + 1, p.y + 2, '╰', color)
    put(p.x + w - 2, p.y + 2, '╯', color)
    for (let x = p.x + 2; x < p.x + w - 2; x++) {
      put(x, p.y, '─', color)
      put(x, p.y + 2, '─', color)
    }
    if (zoom === 3) fitCells(p.title, shape.colW).forEach((ch, i) => put(p.x + i, p.y + 3, ch, p.isOpen ? OPEN_COLOR : EDGE_COLOR))
  }
  return { columns, rows, char, fg, nodes: g.nodes }
}

// The visible window of a drawing: `width` columns from `from` (clamped).
function windowOf(c: Cells, from: number, width: number): Cells {
  const start = Math.max(0, Math.min(from, c.columns - width))
  const columns = Math.max(1, Math.min(width, c.columns))
  const char: string[] = []
  const fg: number[] = []
  for (let y = 0; y < c.rows; y++) {
    for (let x = start; x < start + columns; x++) {
      char.push(c.char[y * c.columns + x] ?? ' ')
      fg.push(c.fg[y * c.columns + x] ?? CELL_DEFAULT)
    }
  }
  return { columns, rows: c.rows, char, fg }
}

// Raster's `cells`: base64 of little-endian u32 triplets [codePoint, fg, bg].
function encodeCells(c: Cells): string {
  const words = new Uint32Array(c.columns * c.rows * 3)
  for (let i = 0; i < c.columns * c.rows; i++) {
    words[i * 3] = c.char[i]!.codePointAt(0)!
    words[i * 3 + 1] = c.fg[i]!
    words[i * 3 + 2] = CELL_DEFAULT
  }
  const bytes = new Uint8Array(words.buffer)
  const native = bytes as unknown as { toBase64?: () => string }
  if (typeof native.toBase64 === 'function') return native.toBase64()
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

// What the graph shows: open tasks with an ID, plus the done tasks they wait
// on; null when no open task waits on another (nothing to draw). A
// dependency missing from the file counts as done and archived.
function graphNodes(tasks: Task[], openKey: string | null): GraphNode[] | null {
  const open = tasks.filter(t => t.id && t.section !== 'done')
  const ids = new Set(tasks.filter(t => t.id).map(t => t.id!))
  if (!open.some(t => t.deps.some(d => ids.has(d)))) return null
  const wanted = new Set(open.flatMap(t => t.deps))
  return tasks
    .filter(t => t.id && (t.section !== 'done' || wanted.has(t.id)))
    .map(t => ({ id: t.id!, title: t.title, section: t.section, deps: t.deps, isOpen: keyOf(t) === openKey }))
}

// The deps of `t` not done yet: present in the file and outside Done.
const unmetDeps = (t: Task, tasks: Task[]) => t.deps.filter(d => tasks.some(o => o.id === d && o.section !== 'done'))

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

    // The dependency graph under the lists: only when an open task waits on
    // another, and only where the surface draws cells (the terminal). `z`
    // cycles the zoom; `h` / `l` scroll it when wider than the pane.
    const Raster = 'Raster' in els ? els.Raster : undefined
    const nodes = Raster ? graphNodes(tasks, chosen ? keyOf(chosen) : null) : null
    let graph = null
    if (Raster && nodes) {
      const zoomSetting = await read($, graphZoomAtom)
      const zoom: Zoom = zoomSetting === 1 || zoomSetting === 3 ? zoomSetting : 2
      const drawn = drawGraph(nodes, zoom)
      const width = Math.max(10, Math.min(512, (e.props as { bodyColumns?: number }).bodyColumns ?? 60))
      const maxScroll = Math.max(0, drawn.columns - width)
      const scroll = Math.min(maxScroll, Math.max(0, await read($, graphScrollAtom)))
      const view = windowOf(drawn, scroll, width)
      const SCROLL_STEP = 10
      graph = (
        <Box flexDirection="column" key="graph">
          <Text> </Text>
          <Box flexDirection="row" columnGap={2} key="graph-bar">
            <Text bold>Dependencies</Text>
            <Button
              key={k('graph-zoom')}
              plain
              hotkey="z"
              label={`Zoom ${zoom}/3`}
              onPress={() => void update($, graphZoomAtom, () => (zoom === 3 ? 1 : zoom + 1))}
            />
            {scroll > 0 && (
              <Button key={k('graph-left')} plain hotkey="h" label="◀" onPress={() => void update($, graphScrollAtom, () => Math.max(0, scroll - SCROLL_STEP))} />
            )}
            {scroll < maxScroll && (
              <Button key={k('graph-right')} plain hotkey="l" label="▶" onPress={() => void update($, graphScrollAtom, () => Math.min(maxScroll, scroll + SCROLL_STEP))} />
            )}
          </Box>
          <Raster key="graph-cells" columns={view.columns} rows={Math.min(256, view.rows)} cells={encodeCells({ ...view, rows: Math.min(256, view.rows), char: view.char.slice(0, view.columns * 256), fg: view.fg.slice(0, view.columns * 256) })} />
        </Box>
      )
    }

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
        {graph}
      </Box>
    )
    focusOrder = order
    focusStops = stops
    return tree
  })
}
