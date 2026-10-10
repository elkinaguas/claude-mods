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
const MARK_START = '<!-- todo:start -->'
const MARK_END = '<!-- todo:end -->'
const RULES_HEADING = '## Task board (TODO.md)'

const fileAtom = atom({ plugin: 'todo', key: 'file' } as const, { exists: false, text: '', mtime: 0 })
const selectedAtom = atom({ plugin: 'todo', key: 'selected' } as const, null)
const draftAtom = atom({ plugin: 'todo', key: 'draft' } as const, '')
const rulesAtom = atom({ plugin: 'todo', key: 'hasRules' } as const, false)

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
- **Doing.** A task being worked on sits under \`## Doing\`. When a decision is the engineer's, ask them; record each question under the task as \`> Q: ...\` and their answer as \`> A: ...\`.
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
      if (/^Q:/i.test(note)) task.hasOpenQuestion = true
      else if (/^A:/i.test(note)) task.hasOpenQuestion = false
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

function moveTask(text: string, key: string, to: Section): string | null {
  const task = parse(text).find(t => keyOf(t) === key)
  if (!task || task.section === to) return null
  const lines = text.split('\n')
  const block = lines.splice(task.start, task.end - task.start)
  return insertInto(lines, to, block).join('\n')
}

// The board sits at the project root, not wherever a shell cd left the session.
const inRoot = async ($: EngineInterface, file: string) => `${await $.session.root()}/${file}`

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

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

async function save($: EngineInterface, text: string) {
  await $.fs.write(await inRoot($, FILE), text)
  seen = -1
  await load($)
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
  await save($, addTask(await current($), title.trim()))
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

async function archive($: EngineInterface) {
  const text = await current($)
  const done = parse(text).filter(t => t.section === 'done')
  if (done.length === 0) return 0
  const lines = text.split('\n')
  const moved = done.flatMap(t => lines.slice(t.start, t.end))
  for (const t of [...done].reverse()) {
    lines.splice(t.start, t.end - t.start)
    // Close the gap the task leaves, not blank lines elsewhere in the file.
    while (t.start > 0 && t.start < lines.length && !lines[t.start - 1]!.trim() && !lines[t.start]!.trim()) lines.splice(t.start, 1)
  }
  const old = await $.fs.read(await inRoot($, ARCHIVE)).catch(() => '# TODO archive\n')
  const head = typeof old === 'string' ? old.trimEnd() : '# TODO archive'
  await $.fs.write(await inRoot($, ARCHIVE), `${head}\n\n${moved.join('\n')}\n`)
  await save($, lines.join('\n'))
  return done.length
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
  const moved = moveTask(await current($), keyOf(t), 'doing')
  if (moved !== null) await save($, moved)
  await ask(
    $,
    t.id
      ? `Start working on ${ref(t)} (now under Doing in ${FILE}). Follow the task board rules: ask me when a decision is mine and record the Q/A under the task.`
      : `Start working on ${ref(t)} (now under Doing in ${FILE}). It is not enriched yet: give it the next free ID and its context lines first, then follow the task board rules.`,
  )
}

function finish($: EngineInterface, t: Task) {
  return ask(
    $,
    `${t.id ?? `The task "${t.title}"`} is done. Following the task board rules, move it to Done in ${FILE} with today's date and replace its notes with the done log: what was done, the decisions and why, the result, the files touched.`,
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

    const tasks = parse(file.text)
    const by = (s: Section) => tasks.filter(t => t.section === s)
    const [todo, doing, done] = [by('todo'), by('doing'), by('done')]
    const raw = tasks.filter(t => !t.id && t.section !== 'done')
    const selectedKey = await read($, selectedAtom)
    const chosen = tasks.find(t => keyOf(t) === selectedKey) ?? doing[0] ?? todo[0]

    const row = (t: Task) => (
      <Box flexDirection="row" key={`row:${keyOf(t)}`}>
        <Button
          key={`task:${keyOf(t)}`}
          plain
          dimColor={t.section === 'done'}
          label={`${chosen && keyOf(t) === keyOf(chosen) ? '▸' : ' '} ${t.id ?? '·'} ${t.title}`}
          onPress={() => void update($, selectedAtom, () => keyOf(t))}
        />
        {t.hasOpenQuestion && <Text color="yellow"> ?</Text>}
      </Box>
    )
    const heading = (name: string, n: number) => (
      <Text bold>
        {name} <Text dimColor>{n}</Text>
      </Text>
    )

    return (
      <Box flexDirection="column">
        {!hasRules && <Text color="yellow">Rules not in CLAUDE.md yet: run /todo init.</Text>}
        {Input && (<Input
          key="add"
          placeholder="Add a task…"
          submitLabel="add"
          value={draft}
          onInput={value => void update($, draftAtom, () => value)}
          onSubmit={value => void submitDraft($, value)}
        />)}
        {raw.length > 0 && (
          <Button key="enrich-all" hotkey="a" label={`Enrich ${plural(raw.length, 'new task')}`} onPress={() => void enrichAll($, raw.length)} />
        )}
        <Text> </Text>
        {heading('Doing', doing.length)}
        {doing.map(row)}
        {heading('Todo', todo.length)}
        {todo.map(row)}
        {heading('Done', done.length)}
        {done.slice(0, DONE_SHOWN).map(row)}
        {done.length > DONE_SHOWN && <Text dimColor>  +{done.length - DONE_SHOWN} more · /todo archive</Text>}
        {chosen && (
          <Box flexDirection="column" key="detail">
            <Text> </Text>
            <Text bold>
              {chosen.id ?? 'No ID yet'} <Text dimColor>· {chosen.section}</Text>
            </Text>
            <Text>{chosen.title}</Text>
            {chosen.notes.length === 0 && !chosen.id && <Text dimColor>Not enriched yet.</Text>}
            {chosen.notes.map(n => (
              <Text dimColor={!/^[QA]:/i.test(n)} color={/^Q:/i.test(n) ? 'yellow' : undefined}>
                {n}
              </Text>
            ))}
            <Box flexDirection="row" key="actions">
              {chosen.section === 'todo' && <Button key="start" plain hotkey="s" label="Start" onPress={() => void start($, chosen)} />}
              {chosen.section === 'doing' && <Button key="done" plain hotkey="d" label="Done" onPress={() => void finish($, chosen)} />}
              {!chosen.id && chosen.section !== 'done' && (
                <Button
                  key="enrich"
                  plain
                  hotkey="e"
                  label="  Enrich"
                  onPress={() => void ask($, `Enrich ${ref(chosen)} in ${FILE}, following the task board rules.`)}
                />
              )}
            </Box>
          </Box>
        )}
      </Box>
    )
  })
}
