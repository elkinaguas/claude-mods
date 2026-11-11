import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { PiLive, PiSession } from '../types'

// Long-lived pi sessions run from Claude Code. The mod never starts pi: its
// code runs outside the Bash sandbox, where pi would read the real provider
// key. Claude runs scripts/pi-session.mjs through the Bash tool instead, so pi
// stays in the sandbox and only sees the masked key. The mod tells Claude how
// (a system prompt section), shows the sessions (a pane), keeps Claude's file
// tools out of ~/.pi, and checks the masking settings.

const PANE = 'pi'
const TITLE = 'pi sessions'
const COMMAND = 'pi'
const POLL_MS = 2000
// 'waiting': only a serve started before dialogs were declined still writes it.
const LIVE = ['starting', 'idle', 'busy', 'waiting']
// Matches pi-session.mjs: a serve whose heartbeat is older is gone.
const STALE_MS = 20000
// Named colours only, so light and dark terminal themes both read.
const STATE_COLOR: Record<string, string> = {
  idle: 'green',
  busy: 'yellow',
  starting: 'yellow',
  stopped: 'gray',
  failed: 'red',
  lost: 'red',
}

// Which session the card shows when none is picked: the one most likely to
// need you first.
const ATTENTION = ['failed', 'busy', 'starting', 'idle', 'lost', 'stopped']
const rank = (state: string) => {
  const i = ATTENTION.indexOf(state)
  return i === -1 ? ATTENTION.length : i
}

const sessionsAtom = atom({ plugin: 'pi', key: 'sessions' } as const, [] as PiSession[], { shape: 'sessions-3' })
const warningsAtom = atom({ plugin: 'pi', key: 'warnings' } as const, [] as string[])
const selectedAtom = atom({ plugin: 'pi', key: 'selected' } as const, null as string | null)
// Moved by the poll while the pane is on screen: reading it redraws the pane, so the card's age moves.
const tickAtom = atom({ plugin: 'pi', key: 'tick' } as const, 0)
// The one card whose Live view is open, and the tail serve last wrote for it.
const liveAtom = atom({ plugin: 'pi', key: 'live' } as const, null as PiLive | null, { shape: 'live-2' })

// The Live view reads live.json (which serve rewrites at most every 300ms) this
// often, only while it is open, its pane on screen and its session running.
const LIVE_POLL_MS = 500
// It shows LIVE_ROWS rows of the last LIVE_LINES lines serve keeps.
const LIVE_ROWS = 20
const LIVE_LINES = 200
// pi can write in its session folder: a bigger file is not serve's (which keeps under it).
const LIVE_MAX_BYTES = 256 * 1024
let liveTimer: Timer | null = null
let liveSeen = ''
// As the pane last drew the view: its width, and the rows the view took at the
// bottom of the pane's tree (0 when not drawn), so a wheel tick can be told to be over it.
let liveCols = 60
let liveDrawn = 0

let home = ''
let cwd = ''
let autoOpen = true
let caWarnDays = 30
let allowUnsandboxed = false
// The person's trusted model hosts (option trustedModelHosts), valid entries only.
let trustedHosts: string[] = []
let badHosts: string[] = []
// What the settings say about the sandbox, from the last check.
let sandboxOff = false
let seen = ''
let wasLive = false

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)

const sessionsDir = () => `${home}/.pi/agent/claude-sessions`
const script = ($: EngineInterface) => `${$.plugin.root}/scripts/pi-session.mjs`

// `~`, relative paths and `..` resolved by hand: the module has no `path`.
export const resolvePath = (p: string, base: string, homeDir: string): string => {
  let s = p === '~' || p.startsWith('~/') ? `${homeDir}${p.slice(1)}` : p
  if (!s.startsWith('/')) s = `${base}/${s}`
  const out: string[] = []
  for (const part of s.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

const FILE_TOOLS = ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob']

/** Where a Grep or Glob search starts, as given: its path, an absolute Glob pattern's fixed folder, or the working folder. */
export const searchRoot = (tool: string, input: Json, base: string): string | null => {
  if (tool !== 'Grep' && tool !== 'Glob') return null
  const p = str(input.path)
  if (p) return p
  const pattern = str(input.pattern) ?? ''
  if (tool === 'Glob' && /^[/~]/.test(pattern)) {
    const fixed = globBase(pattern)
    return fixed === pattern ? pattern : fixed.replace(/\/[^/]*$/, '') || '/'
  }
  return base
}

const under = (abs: string, dir: string) => abs === dir || abs.startsWith(dir === '/' ? '/' : `${dir}/`)
// The fixed part of a glob, before its first wildcard.
const globBase = (pattern: string) => pattern.split(/[*?[{]/)[0] ?? ''

/**
 * Why a file tool call would reach ~/.pi (the provider key lives there), or
 * null when it does not. Searches rooted at the home folder itself count too,
 * since they would descend into it.
 */
export const reachesPiDir = (tool: string, input: Json, base: string, homeDir: string): string | null => {
  const piDir = `${homeDir}/.pi`
  const paths: string[] = []
  const patterns: string[] = []
  if (tool === 'Read' || tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') paths.push(str(input.file_path) ?? '')
  else if (tool === 'NotebookEdit') paths.push(str(input.notebook_path) ?? '')
  else if (tool === 'Grep') {
    paths.push(str(input.path) ?? '')
    patterns.push(str(input.glob) ?? '')
  } else if (tool === 'Glob') {
    paths.push(str(input.path) ?? '')
    patterns.push(str(input.pattern) ?? '')
  } else return null
  const isSearch = tool === 'Grep' || tool === 'Glob'
  // A search with no path runs in the working folder, unless a Glob pattern
  // is absolute and names its own root (checked with the patterns below).
  const ownRoot = tool === 'Glob' && /^[/~]/.test(patterns[0] ?? '')
  if (isSearch && !paths[0] && !ownRoot) paths[0] = base
  for (const p of paths.filter(Boolean)) {
    const abs = resolvePath(p, base, homeDir)
    if (under(abs, piDir)) return abs
    // The home folder or any folder above it would descend into ~/.pi.
    if (isSearch && under(homeDir, abs)) return `a search of ${abs}`
  }
  // A relative pattern is read from the search root, so one that climbs out
  // with .. (../.p*/agent/*) is caught by where its fixed folders lead.
  const root = resolvePath(paths[0] || base, base, homeDir)
  for (const g of patterns.filter(Boolean)) {
    if (/(^|\/)\.pi(\/|$)|auth\.json/.test(g)) return `the pattern ${g}`
    const fixed = globBase(g)
    const absolute = fixed.startsWith('/') || fixed.startsWith('~')
    const folder = absolute ? fixed || '/' : fixed.includes('/') ? fixed.slice(0, fixed.lastIndexOf('/')) : ''
    if (!absolute && !folder) continue
    const abs = resolvePath(folder, root, homeDir)
    if (under(abs, piDir) || (under(homeDir, abs) && g !== fixed)) return `the pattern ${g}`
  }
  return null
}

// Read on the command with quotes and backslashes taken out, so ~/.p"i" and
// ~/.p\i match too, and with glob spellings of the folder (~/.p?, ~/.p*).
// Text matching can never catch every spelling (a variable, say): only the
// sandbox does. It keeps the obvious ways out.
const PI_RE = /pi-session|(^|[^\w.-])\.p[i?*[{]|auth(\.json|[?*[{])|agent\/a[?*[{]|(^|[\s;&|(`])pi(\s|$)/
const AUTH_RE = /auth(\.json|[?*[{])|agent\/a[?*[{]|\.p[?*[{][^\s]*\/agent\/a/
// The folder of the options file the mod writes for pi-session (see writeOptions).
const OPTIONS_RE = /plugins\/data\/pi(\/|\s|$)|plugins\/data\/p[?*[{]/
const flat = (command: string) => command.replace(/["'\\]/g, '')

type Heredoc = { delim: string; quoted: boolean; op: number; bodyStart: number; end: number; body: string }

/**
 * The here-documents in a Bash command, in order, or null when one is left
 * unterminated or the command can't be read (an unclosed quote, a delimiter
 * with $ in it). Quotes and comments are skipped so `<<` in them is not one.
 */
const heredocs = (s: string): Heredoc[] | null => {
  const found: Heredoc[] = []
  let pending: { delim: string; quoted: boolean; dash: boolean; op: number }[] = []
  // Past the closing quote that starts at s[from], with backslash escapes when `escapes`.
  const close = (from: number, q: string, escapes: boolean): number => {
    let j = from + 1
    while (j < s.length && s[j] !== q) j += escapes && s[j] === '\\' ? 2 : 1
    return j < s.length ? j + 1 : -1
  }
  let i = 0
  let wordStart = true
  while (i < s.length) {
    const c = s[i]!
    if (c === '\\') {
      i += 2
      wordStart = false
      continue
    }
    if (c === "'" || c === '"' || (c === '$' && s[i + 1] === "'")) {
      const j = c === '$' ? close(i + 1, "'", true) : close(i, c, c === '"')
      if (j < 0) return null
      i = j
      wordStart = false
      continue
    }
    if (c === '#' && wordStart) {
      const j = s.indexOf('\n', i)
      i = j < 0 ? s.length : j
      continue
    }
    // A here-string (<<<) is a word on the line, not a heredoc.
    if (s.startsWith('<<<', i)) {
      i += 3
      wordStart = true
      continue
    }
    if (s.startsWith('<<', i)) {
      let j = i + 2
      const dash = s[j] === '-'
      if (dash) j++
      while (s[j] === ' ' || s[j] === '\t') j++
      let delim = ''
      let quoted = false
      while (j < s.length && !/[\s;&|<>()]/.test(s[j]!)) {
        const d = s[j]!
        if (d === '$' || d === '`') return null
        if (d === '\\') {
          quoted = true
          delim += s[j + 1] ?? ''
          j += 2
        } else if (d === "'" || d === '"') {
          quoted = true
          const k = s.indexOf(d, j + 1)
          if (k < 0) return null
          delim += s.slice(j + 1, k)
          j = k + 1
        } else {
          delim += d
          j++
        }
      }
      if (!delim) return null
      pending.push({ delim, quoted, dash, op: i })
      i = j
      wordStart = false
      continue
    }
    if (c === '\n') {
      i++
      // The bodies follow the line, one after another, each up to its delimiter line.
      for (const h of pending) {
        const bodyStart = i
        for (;;) {
          const nl = s.indexOf('\n', i)
          const line = s.slice(i, nl < 0 ? s.length : nl)
          if ((h.dash ? line.replace(/^\t+/, '') : line) === h.delim) {
            const end = nl < 0 ? s.length : nl + 1
            found.push({ delim: h.delim, quoted: h.quoted, op: h.op, bodyStart, end, body: s.slice(bodyStart, i) })
            i = end
            break
          }
          // Bash would read to the end of input; keep checking all of it.
          if (nl < 0) return null
          i = nl + 1
        }
      }
      pending = []
      wordStart = true
      continue
    }
    wordStart = /[\s;&|()<>]/.test(c)
    i++
  }
  return pending.length ? null : found
}

// The first word of the simple command a heredoc operator at `op` belongs to.
const commandWord = (s: string, op: number): string => {
  const before = s.slice(0, op)
  const start = Math.max(...[';', '&', '|', '\n', '(', ')', '{', '}', '`'].map(x => before.lastIndexOf(x))) + 1
  return before.slice(start).trim().split(/\s+/)[0] ?? ''
}

// Commands that only copy their input and cannot run it. Not interpreters
// (python3, node, perl...): their heredoc is a program that could start pi
// (os.system), and the guard is there so pi runs only through pi-session.
// Not sed or awk either (GNU sed's e command, awk's system()).
const DATA_COMMANDS = new Set(['cat', 'tee'])
// Anything that could run text, or a file the heredoc just wrote, in the same command.
const RUNNERS =
  /(^|[^\w.-])(bash|sh|zsh|dash|ksh|mksh|ash|csh|tcsh|fish|busybox|eval|source|exec|xargs|sudo|doas|su|ssh|env|nohup|timeout|watch|nice|ionice|chroot|unshare|nsenter|setsid|script|parallel|find|python[\d.]*|node|nodejs|deno|bun|perl|ruby|php|lua|tclsh|expect|osascript|g?awk|mawk|nawk|sed|make|npm|npx|yarn|pnpm|git|vim?|nvim|emacs|at|batch|crontab|systemd-run|docker|podman|tmux|screen|alias|function|hash|enable|trap|builtin)($|[^\w.-])/

/** Whether the rest of a command, with the data heredocs' text taken out, could still run that text. */
const mayRunData = (rest: string): boolean => {
  // A pipe (cat <<EOF | bash), a command or process substitution ($(cat <<EOF), >(bash)).
  if (/[|`]|\$\(|[<>]\(/.test(rest)) return true
  const text = flat(rest)
  // A runner, `. file`, a changed PATH, or a function or alias that could stand in for cat.
  if (RUNNERS.test(text) || /(^|[\s;&(){}])\.(\s|$)/.test(text) || /\b(PATH|BASH_ENV|ENV)\s*=/.test(text) || /[\w-]+\s*\(\s*\)/.test(text)) return true
  const targets: string[] = []
  for (const part of text.split(/[;&\n(){}]/)) {
    const words = part.trim().replace(/^((if|then|else|elif|do|while|until|time|!)\s+)+/, '').split(/\s+/)
    // A program run by path, glob or variable (./x.sh, ~/bin/*, $f).
    if (/[/$*?[~]/.test(words[0] ?? '')) return true
    if (words[0] === 'tee') targets.push(...words.slice(1).filter(w => w && !w.startsWith('-') && !/^\d*[<>]/.test(w)))
  }
  for (const m of text.matchAll(/&?>>?(&?)\s*([^\s;&<>()]*)/g)) if (!m[1]) targets.push(m[2]!)
  // A file the data is written to and then named again might be run (chmod +x f; make -f f).
  for (const t of targets) {
    if (!t || /[$*?[{]/.test(t)) return true
    const name = t.split('/').pop() || t
    const count = (x: string) => x.split(name).length - 1
    if (count(text) > targets.reduce((n, u) => n + count(u), 0)) return true
  }
  return false
}

/**
 * The command with the text of heredocs that are only data taken out: fed to
 * cat or tee, with a quoted delimiter or a body with no $( ` or ${ (which an
 * unquoted one would run), and nothing else in the command that could run that
 * text or the file it goes to. Otherwise, or when a heredoc is unterminated,
 * the command as it is: when in doubt, everything stays checked.
 */
export const withoutHeredocData = (command: string): string => {
  const docs = heredocs(command)
  const data = (docs ?? []).filter(h => DATA_COMMANDS.has(commandWord(command, h.op)) && (h.quoted || !/`|\$[({[]/.test(h.body)))
  if (!data.length) return command
  let rest = ''
  let at = 0
  for (const h of data) {
    rest += command.slice(at, h.bodyStart)
    at = h.end
  }
  rest += command.slice(at)
  return mayRunData(rest) ? command : rest
}

/** The commands a settings layer lets run outside the sandbox, and whether Bash may ask to leave it. */
export const sandboxEscapes = (texts: (string | null)[]): { excluded: string[]; unsandboxedAllowed: boolean } => {
  const excluded = new Set<string>()
  let unsandboxedAllowed = false
  for (const text of texts) {
    if (text === null) continue
    try {
      const sandbox = obj(obj(JSON.parse(text)).sandbox)
      for (const c of Array.isArray(sandbox.excludedCommands) ? sandbox.excludedCommands : []) if (typeof c === 'string' && c.trim()) excluded.add(c.trim())
      if (sandbox.allowUnsandboxedCommands === true) unsandboxedAllowed = true
    } catch {
      // A file that does not parse is ignored by Claude Code too.
    }
  }
  return { excluded: [...excluded], unsandboxedAllowed }
}

/** Whether any command in a Bash line is one the sandbox leaves out (sandbox.excludedCommands). */
export const runsExcluded = (command: string, excluded: string[]): boolean => excludedPart(command, excluded) !== null

// The part of a Bash line that runs a command the sandbox leaves out, or null.
const excludedPart = (command: string, excluded: string[]): string | null => {
  if (!excluded.length) return null
  const names = new Set(excluded.map(c => c.split(/[\s:]/)[0]!.replace(/\*$/, '')).filter(Boolean))
  for (const part of command.split(/[;&|\n]|\$\(|`|\(/)) {
    const words = part.trim().replace(/^((\w+=\S*|sudo|env|exec|command|nohup|time)\s+)+/, '').split(/\s+/)
    const first = (words[0] ?? '').split('/').pop() ?? ''
    if (first && names.has(first)) return part.trim()
  }
  return null
}

/**
 * Why a Bash command must not run, or null. Unsandboxed, a command that names
 * pi, ~/.pi or auth.json could read the real key; pi-session's way past its
 * own check is for the person to allow (option allowUnsandboxed), not Claude.
 */
export const bashRefusal = (command: string, o: { unsandboxed: boolean; allowUnsandboxed: boolean }): string | null => {
  // The text of a heredoc that only writes a file is data, not a command.
  const text = flat(withoutHeredocData(command))
  // pi-session trusts this to tell it runs in the sandbox; only the sandbox
  // sets it. Naming it (a search, say) is fine; setting or unsetting it is not.
  if (/SANDBOX_RUNTIME\s*=|unset\s+(-v\s+)?SANDBOX_RUNTIME/.test(text))
    return 'pi: SANDBOX_RUNTIME is set by the sandbox itself; a command may not set or change it.'
  // Likewise the program pi-session runs as pi: pointing it elsewhere would get past the gate.
  if (/PI_SESSION_PI\s*=/.test(text)) return 'pi: PI_SESSION_PI is for the mod\'s own tests; a command may not set it.'
  // The opencode-go gate lives in pi-session, so pi runs only through it
  // (pi run directly could use any provider, and `pi auth` prints keys).
  const runsPi = excludedPart(text, ['pi'])
  if (runsPi !== null) {
    const shown = runsPi.replace(/\s+/g, ' ')
    return `pi: run pi only through pi-session (node <pi mod>/scripts/pi-session.mjs serve <name> --model <provider>/<id>). The pi mod works only with an opencode-go API key, or a model at a host you trust (option trustedModelHosts). This command was read as running pi at: ${shown.length > 80 ? `${shown.slice(0, 80)}...` : shown}. If it only mentions pi in its text, use the Edit or Write tool to change a file, or the Grep tool to search one: a heredoc's text is skipped only when it feeds cat or tee (cat > file <<'EOF'), not an interpreter such as python3, which could start pi itself.`
  }
  // pi-session reads the person's options from the file this points at.
  if (/PI_SESSION_OPTIONS\s*=/.test(text)) return 'pi: PI_SESSION_OPTIONS is for the mod\'s own tests; a command may not set it.'
  // Inside the sandbox the options file can't be written; outside it only this text check stands.
  if (o.unsandboxed && OPTIONS_RE.test(text))
    return 'pi: this command would run outside the sandbox and names the pi mod\'s options file, which only the mod writes. Set the options with /plugin configure pi@claude-mods.'
  if (!o.unsandboxed || !PI_RE.test(text)) return null
  if (AUTH_RE.test(text)) return 'pi: this command would run outside the sandbox and names auth.json, which holds your real provider key.'
  if (o.allowUnsandboxed) return null
  return 'pi: this command would run outside the Bash sandbox, where pi and Claude could read your real provider key. Turn the sandbox on, or allow it yourself (/plugin configure pi@claude-mods, allowUnsandboxed).'
}

// Matches pi-session's host entry: host, host:port or host:*, with *. for subdomains and [v6].
const HOST_ENTRY = /^(\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:]+\])(?::(\d{1,5}|\*))?$/i

/** The option's comma- or space-separated entries, split into valid ones and the rest. */
export const parseTrustedHosts = (value: unknown): { valid: string[]; invalid: string[] } => {
  const all = typeof value === 'string' ? value.split(/[\s,]+/).filter(Boolean) : []
  return { valid: all.filter(h => HOST_ENTRY.test(h)).map(h => h.toLowerCase()), invalid: all.filter(h => !HOST_ENTRY.test(h)) }
}

/** One settings file that can set sandbox.enabled, highest precedence first. */
export type SettingsLayer = { name: string; text: string | null }

/**
 * Whether the sandbox is on, and which file says so: the first layer (managed,
 * local, project) that sets sandbox.enabled wins, else the user settings.
 */
export const sandboxSetting = (layers: SettingsLayer[], userText: string | null): { enabled: boolean; source: string } => {
  for (const l of layers) {
    if (l.text === null) continue
    try {
      const enabled = obj(obj(JSON.parse(l.text)).sandbox).enabled
      if (typeof enabled === 'boolean') return { enabled, source: l.name }
    } catch {
      // A file that does not parse is ignored by Claude Code too.
    }
  }
  try {
    return { enabled: obj(obj(JSON.parse(userText ?? '')).sandbox).enabled === true, source: '~/.claude/settings.json' }
  } catch {
    return { enabled: false, source: '~/.claude/settings.json' }
  }
}

/** What the settings get wrong for pi's key to stay masked; empty when they are right. */
export const settingsProblems = (settingsText: string | null, homeDir: string, layers: SettingsLayer[] = []): string[] => {
  if (settingsText === null) return ['~/.claude/settings.json is missing: the Bash sandbox and the key mask are not set up.']
  let s: Json
  try {
    s = obj(JSON.parse(settingsText))
  } catch {
    return ['~/.claude/settings.json does not parse, so Claude Code ignores all of it: the sandbox is off.']
  }
  const out: string[] = []
  const sandbox = obj(s.sandbox)
  const on = sandboxSetting(layers, settingsText)
  if (!on.enabled) {
    out.push(
      `The Bash sandbox is off (${on.source}): pi would read your real provider key, and so could Claude's commands. ${
        !allowUnsandboxed
          ? 'pi-session refuses to start pi.'
          : trustedHosts.length
            ? `allowUnsandboxed is on, so pi-session starts pi anyway, on a model at your trusted hosts (${trustedHosts.join(', ')}) or on opencode-go.`
            : 'allowUnsandboxed is on, so pi-session starts pi anyway.'
      }`,
    )
    // The mask and TLS termination only act inside the sandbox: nothing more to check.
    return out
  }
  const auth = `${homeDir}/.pi/agent/auth.json`
  const files = Array.isArray(obj(sandbox.credentials).files) ? (obj(sandbox.credentials).files as unknown[]) : []
  const entry = files.map(obj).find(f => resolvePath(str(f.path) ?? '', homeDir, homeDir) === auth)
  const masked = str(entry?.mode) === 'mask'
  if (!masked) out.push('~/.pi/agent/auth.json is not masked (sandbox.credentials.files, mode "mask"): commands Claude runs can read your key.')
  // The opencode-go gate: the real key may be put back on opencode.ai only.
  const hosts = Array.isArray(entry?.injectHosts) ? (entry!.injectHosts as unknown[]).filter((h): h is string => typeof h === 'string') : []
  const otherHosts = hosts.filter(h => h !== 'opencode.ai')
  if (masked && otherHosts.length)
    out.push(`auth.json's key is also put back on ${otherHosts.join(', ')}. For now the pi mod works only with an opencode-go API key: set injectHosts to ["opencode.ai"].`)
  const deny = Array.isArray(obj(s.permissions).deny) ? (obj(s.permissions).deny as unknown[]) : []
  if (deny.some(r => typeof r === 'string' && /^Read\(.*auth\.json/.test(r)))
    out.push('A Read(...) deny rule on auth.json turns the mask into a block: pi finds no key. Remove it; the pi mod guards Claude\'s file tools instead.')
  if (masked && !obj(sandbox.network).tlsTerminate)
    out.push('sandbox.network.tlsTerminate is not set: the masked key is never swapped in, so pi gets 401 Invalid credential.')
  return out
}

/** Days until a certificate's notAfter date, from `openssl x509 -enddate` output. */
export const daysLeft = (opensslOut: string, now: number): number | null => {
  const m = /notAfter=(.+)/.exec(opensslOut)
  const at = m ? Date.parse(m[1]!.trim()) : NaN
  return Number.isNaN(at) ? null : Math.floor((at - now) / 86400000)
}

/** The settings files that shape the sandbox: user settings, and the layers above them. */
async function readSettings($: EngineInterface): Promise<{ text: string | null; layers: SettingsLayer[] }> {
  const text = await $.fs.read(`${home}/.claude/settings.json`).catch(() => null)
  const layers: SettingsLayer[] = []
  for (const [name, at] of [
    ['managed settings', '/etc/claude-code/managed-settings.json'],
    ['.claude/settings.local.json', `${cwd}/.claude/settings.local.json`],
    ['.claude/settings.json', `${cwd}/.claude/settings.json`],
  ] as const) {
    if (name !== 'managed settings' && !cwd) continue
    layers.push({ name, text: await $.fs.read(at).catch(() => null) })
  }
  return { text, layers }
}

async function check($: EngineInterface): Promise<string[]> {
  const { text, layers } = await readSettings($)
  sandboxOff = !sandboxSetting(layers, text).enabled
  const problems = settingsProblems(text, home, layers)
  if (badHosts.length)
    problems.push(`trustedModelHosts has entries that are not a host, host:port or host:* (${badHosts.join(', ')}); they are ignored.`)
  const escapes = sandboxEscapes([text, ...layers.map(l => l.text)])
  if (!sandboxOff && escapes.excluded.length)
    problems.push(
      `sandbox.excludedCommands (${escapes.excluded.join(', ')}) run outside the sandbox, where they can read your real key. The pi guard refuses ones that name pi or its key, but cannot catch every spelling.`,
    )
  if (!sandboxOff && escapes.unsandboxedAllowed)
    problems.push('sandbox.allowUnsandboxedCommands is on: a Bash call can ask to leave the sandbox, where it can read your real key. The pi guard refuses ones that name pi or its key, but cannot catch every spelling.')
  const bare = (await read($, sessionsAtom)).filter(x => x.sandboxed === false && LIVE.includes(x.state))
  if (bare.length)
    problems.push(`${bare.map(x => x.name).join(', ')} ${bare.length === 1 ? 'runs' : 'run'} outside the sandbox: pi holds your real provider key.`)
  let parsed: unknown = {}
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    // settingsProblems has already reported it.
  }
  const tls = obj(obj(obj(parsed).sandbox).network).tlsTerminate
  const ca = str(obj(tls).caCertPath)
  if (ca && !sandboxOff && problems.length === 0) {
    const certPath = resolvePath(ca, home, home)
    const ran = await $.process.run(['openssl', 'x509', '-enddate', '-noout', '-in', certPath]).catch(() => null)
    const days = ran?.exitCode === 0 ? daysLeft(ran.stdout, await $.clock.now()) : null
    if (days === null) problems.push(`The sandbox CA ${ca} could not be read: the sandbox will not start.`)
    else if (days < 0) problems.push(`The sandbox CA ${ca} has expired: regenerate it (RSA) and restart Claude Code.`)
    else if (days < caWarnDays) problems.push(`The sandbox CA ${ca} expires in ${days} day${days === 1 ? '' : 's'}: regenerate it (RSA) before then.`)
  }
  await update($, warningsAtom, () => problems)
  return problems
}

const toSession = (name: string, raw: Json, now: number): PiSession => {
  const state = str(raw.state) ?? 'unknown'
  const beat = num(raw.heartbeatAt) ?? 0
  return {
    name,
    state: LIVE.includes(state) && now - beat > STALE_MS ? 'lost' : state,
    cwd: str(raw.cwd),
    model: str(raw.model),
    lastActivity: num(raw.lastActivity),
    runStartedAt: num(raw.runStartedAt),
    lastTool: str(raw.lastTool),
    lastReply: str(raw.lastReply),
    error: str(raw.error),
    sandboxed: typeof raw.sandboxed === 'boolean' ? raw.sandboxed : null,
    ...usageOf(raw),
  }
}

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
// status.json's turns, and its usage summed by pi-session from pi's assistant messages.
const usageOf = (raw: Json) => {
  const u = obj(raw.usage)
  const tokens = ['input', 'output', 'cacheRead', 'cacheWrite'].reduce((n, k) => n + count(u[k]), 0)
  return { turns: count(raw.turns), tokens: tokens || null, cost: count(u.cost) || null }
}

const fmtTokens = (n: number) =>
  n < 1000 ? `${n}` : n < 99950 ? `${(n / 1e3).toFixed(1)}k` : n < 999500 ? `${Math.round(n / 1e3)}k` : n < 99950000 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e6)}M`
const fmtCost = (c: number) => (c < 0.001 ? '<$0.001' : `$${c.toFixed(c < 10 ? 3 : 2)}`)

/** "12 turns · 48.2k tok · $0.031", each part only when there is something to show (as pi-session status). */
export const usageLine = (s: { turns: number; tokens: number | null; cost: number | null }) =>
  [s.turns && `${s.turns} turn${s.turns === 1 ? '' : 's'}`, s.tokens && `${fmtTokens(s.tokens)} tok`, s.cost && fmtCost(s.cost)].filter(Boolean).join(' · ')

async function load($: EngineInterface) {
  const entries = await $.fs.list(sessionsDir()).catch(() => [])
  const now = await $.clock.now()
  const list: PiSession[] = []
  for (const entry of entries.filter(e => e.kind === 'dir').sort((a, b) => a.name.localeCompare(b.name))) {
    const text = await $.fs.read(`${sessionsDir()}/${entry.name}/status.json`).catch(() => null)
    if (!text) continue
    try {
      list.push(toSession(entry.name, obj(JSON.parse(text)), now))
    } catch {
      // A status.json mid-rename: the next poll reads it.
    }
  }
  // Ages are worked out when drawing (the poll's tick redraws), so the list only changes with a session.
  const key = JSON.stringify(list)
  if (key !== seen) {
    seen = key
    await update($, sessionsAtom, () => list)
  }
  const isLive = list.some(s => LIVE.includes(s.state))
  if (isLive && !wasLive && autoOpen) void $.ui.open({ id: PANE, title: TITLE }).catch(() => {})
  wasLive = isLive
}

/** Where the mod keeps the options pi-session reads; sandboxed commands can't write under ~/.claude/plugins. */
export const optionsDir = (homeDir: string) => `${homeDir}/.claude/plugins/data/pi`

/** Why a file tool call would write the options file's folder, or null. Reads are fine: it holds no secret. */
export const writesOptions = (tool: string, input: Json, base: string, homeDir: string): string | null => {
  const p = tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' ? str(input.file_path) : tool === 'NotebookEdit' ? str(input.notebook_path) : null
  if (!p) return null
  const abs = resolvePath(p, base, homeDir)
  return under(abs, optionsDir(homeDir)) ? abs : null
}

/** The options file's text: what pi-session reads instead of flags in the command. */
export const optionsText = (o: { allowUnsandboxed: boolean; trustedHosts: string[] }, now: number) =>
  `${JSON.stringify({ allowUnsandboxed: o.allowUnsandboxed, trustedModelHosts: o.trustedHosts, writtenAt: now }, null, 2)}\n`

// Written once a minute while Claude Code runs: pi-session takes an older file for
// a mod since turned off. 0 writes at the next chance (new options, a new session).
const OPTIONS_EVERY_MS = 60000
let optionsWrittenAt = 0
async function writeOptions($: EngineInterface) {
  if (!home || Date.now() - optionsWrittenAt < OPTIONS_EVERY_MS) return
  optionsWrittenAt = Date.now()
  await $.fs.write(`${optionsDir(home)}/options.json`, optionsText({ allowUnsandboxed, trustedHosts }, Date.now())).catch((err: unknown) => {
    optionsWrittenAt = 0
    $.ui.log(`pi: could not write its options file: ${String(err)}`)
  })
}

// Every poll reads the sessions; only a pane on screen is redrawn for its age.
async function poll($: EngineInterface) {
  await writeOptions($)
  await load($).catch(() => {})
  const panes = await $.ui.panes().catch(() => [])
  const shown = panes.some(p => p.id === PANE && p.isShown)
  if (shown) await update($, tickAtom, n => n + 1)
  await syncLive($, shown).catch(() => {})
}

// The Live view. The panel reads serve's live.json as it reads status.json
// (the mod's own reads, not Claude's file tools), so no process is started
// twice a second; `read <name> --live` prints the same tail for Claude.
async function readLive($: EngineInterface, name: string) {
  const at = `${sessionsDir()}/${name}/live.json`
  const st = await $.fs.stat(at).catch(() => null)
  // Never through a link (it could lead to any file of yours), nor a file serve would not write.
  const text = st && st.kind === 'file' && !st.isLink && st.size <= LIVE_MAX_BYTES ? await $.fs.read(at).catch(() => null) : null
  // Missing, or the same as last time: nothing to redraw.
  if (text === null || text === liveSeen) return
  let got: Omit<PiLive, 'name' | 'offset'>
  try {
    const v = obj(JSON.parse(text))
    const all = Array.isArray(v.lines) ? v.lines.filter((l): l is string => typeof l === 'string') : []
    const cut = Math.max(0, all.length - LIVE_LINES)
    const lines = all.slice(cut)
    // A file without the numbers (an older serve's) counts as all finished, from 0.
    const first = Math.max(0, Math.floor(num(v.first) ?? 0)) + cut
    const done = Math.min(lines.length, Math.max(0, Math.floor(num(v.done) ?? all.length) - cut))
    got = { lines, first, done }
  } catch {
    return
  }
  liveSeen = text
  await update($, liveAtom, cur => (cur?.name === name ? { name, ...got, offset: keepPlace(cur, got, liveCols) } : cur))
}

/**
 * Where a scrolled-up Live view stands once new lines came: as many rows more
 * from the end as came after what it had, so the rows shown stay put. A view
 * at the end (0) follows it; a new serve, numbering its lines afresh, too.
 */
export const keepPlace = (cur: Omit<PiLive, 'name'>, next: Omit<PiLive, 'name' | 'offset'>, cols: number): number => {
  if (!cur.offset) return 0
  const end = cur.first + cur.done
  if (next.first < cur.first || next.first + next.done < end) return 0
  // Rows of the lines numbered `from` on: lines before it are finished in both, the same.
  const after = (lv: Omit<PiLive, 'name' | 'offset'>, from: number) => liveRows(lv.lines.slice(Math.max(0, from - lv.first)), cols).length
  const offset = cur.offset + after(next, end) - after(cur, end)
  return Math.min(Math.max(0, liveRows(next.lines, cols).length - LIVE_ROWS), Math.max(0, offset))
}

// Scrolls the open view back by `to` rows (negative: toward the end), or to its top or end.
async function scrollLive($: EngineInterface, to: number | 'top' | 'end') {
  await update($, liveAtom, cur => {
    if (!cur) return cur
    const max = Math.max(0, liveRows(cur.lines, liveCols).length - LIVE_ROWS)
    const offset = to === 'end' ? 0 : to === 'top' ? max : Math.min(max, Math.max(0, cur.offset + to))
    return offset === cur.offset ? cur : { ...cur, offset }
  })
}

const stopLiveTimer = () => {
  liveTimer?.cancel()
  liveTimer = null
}

// The view's timer runs only while it is open, its pane on screen and its
// session running; a session that stopped gets one last read.
async function syncLive($: EngineInterface, shown: boolean) {
  const lv = await read($, liveAtom)
  if (!lv) return stopLiveTimer()
  const s = (await read($, sessionsAtom)).find(x => x.name === lv.name)
  if (!s) return closeLive($)
  const want = shown && LIVE.includes(s.state)
  if (want && !liveTimer) liveTimer = $.clock.every(LIVE_POLL_MS, () => void readLive($, lv.name).catch(() => {}))
  else if (!want && liveTimer) {
    stopLiveTimer()
    await readLive($, lv.name).catch(() => {})
  }
}

async function openLive($: EngineInterface, name: string) {
  stopLiveTimer()
  liveSeen = ''
  await update($, liveAtom, () => ({ name, lines: [], first: 0, done: 0, offset: 0 }))
  // The card stays on this session while its view is open.
  await update($, selectedAtom, () => name)
  await readLive($, name).catch(() => {})
  await syncLive($, true)
}

async function closeLive($: EngineInterface) {
  stopLiveTimer()
  liveSeen = ''
  await update($, liveAtom, () => null)
}

// Picking another session's tile closes the open view: one card is live at a time.
async function pick($: EngineInterface, name: string) {
  await update($, selectedAtom, () => name)
  const lv = await read($, liveAtom)
  if (lv && lv.name !== name) await closeLive($)
}

const ago = (ms: number | null, now: number) => {
  if (!ms) return ''
  const s = Math.max(0, Math.round((now - ms) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`
}
const short = (p: string | null) => (p && home && p.startsWith(home) ? `~${p.slice(home.length)}` : p ?? '')
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s)

// A line broken into rows of at most n characters, at a space when there is one late enough.
const wrapRows = (s: string, n: number) => {
  const out: string[] = []
  let rest = s
  while (rest.length > n) {
    const space = rest.lastIndexOf(' ', n)
    const at = space > n / 2 ? space : n
    out.push(rest.slice(0, at).trimEnd())
    rest = rest.slice(at).trimStart()
  }
  if (rest) out.push(rest)
  return out
}

/** The Live view's rows, all of them: tool calls cut to the pane's width, reply text wrapped to it. */
export const liveRows = (lines: string[], cols: number): string[] => {
  const n = Math.max(10, cols)
  const rows: string[] = []
  for (const raw of lines) {
    // No control characters reach the terminal; a long reply line keeps its end, at most a view's worth of rows.
    const line = raw.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    if (line.startsWith('→ ')) rows.push(clip(line, n))
    else rows.push(...wrapRows(line.slice(-n * LIVE_ROWS), n))
  }
  return rows
}

/**
 * The 20 rows the view shows, `offset` rows up from the end (clamped to what
 * there is), with how many rows are above (`older`) and below (`newer`) them.
 */
export const liveWindow = (rows: string[], offset: number) => {
  const max = Math.max(0, rows.length - LIVE_ROWS)
  const at = Math.min(max, Math.max(0, Math.floor(offset) || 0))
  const end = rows.length - at
  const start = Math.max(0, end - LIVE_ROWS)
  return { rows: rows.slice(start, end), older: start, newer: at, offset: at, max }
}

const instructions = ($: EngineInterface) => `# pi sessions (pi mod)

You can run long-lived pi coding-agent sessions. Use only this script, through the Bash tool, so pi runs inside the sandbox where its provider key is masked:

  node ${script($)} <command>

- Start: run \`serve <name> --cwd <dir> --model <provider>/<id>\` with run_in_background. It runs until stopped. pi takes up to ~20s to start; \`status <name>\` says idle when ready. Never start pi any other way (running pi directly is refused). \`--model\` may be left out when pi's own default model (its settings.json) passes the gate; if it doesn't, serve and run refuse and say so. \`models\` lists the model ids the gate allows.
- pi works only on opencode-go with an API key${trustedHosts.length ? `, or on a provider that ~/.pi/agent/models.json points at one of the person's trusted hosts (${trustedHosts.join(', ')}); serve and run read those hosts from the mod's options file themselves` : ''}. serve and run refuse any other model, extra pi arguments, logins in auth.json beyond what that needs, and providers in models.json at other hosts. If they refuse, tell the person why; never try to get around the gate.
- One-shot: \`run <name> --model <provider>/<id> [--cwd <dir>] --file <prompt file>\` (or a quoted prompt) with run_in_background starts the session, sends the prompt, prints pi's reply and stops the session, so you are notified when it is done. It takes wait's \`--timeout SECONDS --abort\`, \`--out FILE\` and exit codes, and \`--format findings\`. \`--keep\` leaves the session running for follow-ups; the call then ends only when the session does, so run \`wait <name>\` with run_in_background to be told when the reply is there.
- Work: \`send <name> "<prompt>"\` prints a prompt id. While pi works a new prompt queues as a follow-up; \`--steer\` delivers it before pi's next model call instead.
- Results: run \`wait <name> <id>\` with run_in_background; you are notified when pi settles and it prints the reply. Sessions never stop for questions: pi is told to finish and list its assumptions, and a question from a pi extension is declined at once and named on stderr, so a step it guarded may have been skipped. To cap a run, add \`--timeout SECONDS --abort\`: on timeout pi's run is aborted and the wait exits 2. Cap review runs (e.g. \`--format findings\`) with \`--timeout 1800 --abort\` (30 minutes); \`run\` has no default cap. For a long reply, add \`--out FILE\` to write it to a file and print only its path and size. If the prompt got no reply of its own (pi refused it or hit an error, its run was aborted, or it wrote no reply), the wait exits 3 with the reason on stderr and prints or writes nothing. To ask for review findings as a checked JSON array, use \`send <name> --format findings "<prompt>"\`: \`wait\` prints only the array, or exits 4 if the reply is invalid. \`read <name> --tail 40\` shows the transcript, \`read <name> --last\` the last reply, \`read <name> --live\` the last 20 lines of tool calls and reply text as pi writes them.
- Control: \`status\`, \`abort <name>\` (stop the current run), \`stop <name>\` (end the session), \`forget <name>\`.
- After a Claude Code restart, \`serve <name>\` again reopens the conversation (a killed \`run\` too); work that was mid-run is lost, so ask pi to continue.
- After a restart, use \`status <name>\` for how a session stands, and \`read <name> --last\` for its last reply. Never go by the output of a task from before the restart: it is old, and those tasks are gone.
- Names: letters, digits, . _ - (e.g. auth-fix). Several sessions can run at once; give each its own folder or git worktree when they edit code.
- Never read ~/.pi or auth.json (the file tools are refused there). Session logs are read through the script.
- \`serve\` and \`run\` refuse to start outside the sandbox. ${allowUnsandboxed ? 'The person has allowed pi without the sandbox (option allowUnsandboxed), so serve and run start there by themselves: use them as usual, with no flags for it, and when the sandbox is off tell them pi holds their real key.' : 'Never try to get around that; tell the person the sandbox is off.'}`

// Stop, abort and forget only write to a session's pipe or files, so the mod
// runs them itself; serving again goes through Claude, so pi starts inside
// the sandbox.
async function runScript($: EngineInterface, args: string[]) {
  const ran = await $.process.run(['node', script($), ...args]).catch((err: unknown) => ({ exitCode: 1, stdout: '', stderr: String(err) }))
  const out = (ran.exitCode === 0 ? ran.stdout : ran.stderr || ran.stdout).trim()
  $.ui.toast(`pi: ${out.replace(/^pi-session: /, '') || args.join(' ')}`)
  await load($).catch(() => {})
}

function ask($: EngineInterface, text: string) {
  void $.prompt.fill({ text }).catch(() => {})
}

export const register: Register = (on, options) => {
  autoOpen = options.autoOpen !== false
  caWarnDays = typeof options.caWarnDays === 'number' && options.caWarnDays >= 0 ? options.caWarnDays : 30
  allowUnsandboxed = options.allowUnsandboxed === true
  ;({ valid: trustedHosts, invalid: badHosts } = parseTrustedHosts(options.trustedModelHosts))
  seen = ''
  optionsWrittenAt = 0
  // A reload drops the timers; the next poll starts an open view's again.
  liveTimer = null
  liveSeen = ''
  liveDrawn = 0

  on('session.start', async ($, e, next) => {
    home = (await $.env.get('HOME')) ?? ''
    cwd = e.cwd
    await $.command.register({
      name: COMMAND,
      description: 'pi sessions: /pi opens the panel, /pi check checks the key-masking setup, /pi close',
    }).catch((err: unknown) => $.ui.log(`pi: /${COMMAND} not registered: ${String(err)}`))
    optionsWrittenAt = 0
    await writeOptions($)
    await load($).catch(() => {})
    $.clock.every(POLL_MS, () => void poll($).catch(() => {}))
    const problems = await check($).catch(() => [] as string[])
    if (problems.length) $.ui.toast(`pi: ${problems.length} setup problem${problems.length === 1 ? '' : 's'}; /pi check`)
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { ...composed, sections: [...composed.sections, { id: 'pi:sessions', text: instructions($), scope: 'session' as const }] }
  })

  // Claude's file tools run outside the sandbox and would see the real key.
  on('tool.call', async ($, e, next) => {
    if (!home) home = (await $.env.get('HOME')) ?? ''
    const input = e as unknown as Json
    if (e.tool === 'Bash') {
      const command = str(input.command) ?? ''
      // Read the settings now, not at session start: the sandbox can be turned
      // off mid-session, and excluded commands run outside it even when on.
      const { text, layers } = await readSettings($)
      sandboxOff = !sandboxSetting(layers, text).enabled
      const { excluded } = sandboxEscapes([text, ...layers.map(l => l.text)])
      const unsandboxed = sandboxOff || input.dangerouslyDisableSandbox === true || runsExcluded(command, excluded)
      const why = bashRefusal(command, { unsandboxed, allowUnsandboxed })
      if (why) return { deny: why }
      // Unchanged: pi-session reads the options itself, so what auto mode reviews is what runs.
      return next(e)
    }
    const base = cwd || home
    // Claude's file tools run outside the sandbox, so they could write the options file.
    const OPTIONS_DENY = 'is the pi mod\'s options file, which only the mod writes. Set the options with /plugin configure pi@claude-mods.'
    const optionsHit = writesOptions(e.tool, input, base, home)
    if (optionsHit) return { deny: `pi: ${optionsHit} ${OPTIONS_DENY}` }
    let hit = reachesPiDir(e.tool, input, base, home)
    // A link elsewhere that lands in ~/.pi: check where it really leads. A
    // search follows a link given as its root (ripgrep does), so Grep and Glob
    // are checked too, at their path, the root of an absolute Glob pattern,
    // or the working folder.
    const target = searchRoot(e.tool, input, base) ?? str(input.file_path) ?? str(input.notebook_path)
    if (!hit && target && FILE_TOOLS.includes(e.tool)) {
      const st = await $.fs.stat(resolvePath(target, base, home), { resolve: true }).catch(() => null)
      const real = st && 'realPath' in st ? str((st as unknown as Json).realPath) : null
      const isSearch = e.tool === 'Grep' || e.tool === 'Glob'
      if (real && !isSearch && e.tool !== 'Read' && under(real, optionsDir(home))) return { deny: `pi: ${target} (a link to ${real}) ${OPTIONS_DENY}` }
      if (real && (under(real, `${home}/.pi`) || (isSearch && under(home, real)))) hit = `${target} (a link to ${real})`
    }
    if (!hit) return next(e)
    return { deny: `pi: ${hit} is in ~/.pi, which holds your provider key. Read session logs with pi-session (read, status) instead.` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'pi: its ~/.pi guard failed, so the call is refused.' }))

  on('command.run', { command: COMMAND }, async ($, e) => {
    const word = e.args.trim().toLowerCase()
    if (word === 'check') {
      const problems = await check($)
      return {
        text: problems.length
          ? `pi setup problems:\n${problems.map(p => `- ${p}`).join('\n')}`
          : 'pi setup looks right: sandbox on, auth.json masked, TLS termination set, CA valid.',
      }
    }
    if (word === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'pi sessions panel closed.' }
    }
    await load($)
    await $.ui.open({ id: PANE, title: TITLE })
    const list = await read($, sessionsAtom)
    const live = list.filter(s => LIVE.includes(s.state)).length
    return { text: list.length ? `${list.length} pi session${list.length === 1 ? '' : 's'}, ${live} running.` : 'No pi sessions yet. Ask Claude to start one.' }
  })

  // One tile per session, named and coloured by state, in rows that wrap; the card
  // below shows the picked one.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, sessionsAtom)
    const warnings = await read($, warningsAtom)
    const picked = await read($, selectedAtom)
    const liveView = await read($, liveAtom)
    await read($, tickAtom)
    const now = await $.clock.now()
    const cols = Math.max(20, e.props.bodyColumns ?? 60)
    liveCols = cols
    liveDrawn = 0

    const fallback = [...list].sort((a, b) => rank(a.state) - rank(b.state))[0]
    const s = list.find(x => x.name === picked) ?? fallback
    const live = list.filter(x => LIVE.includes(x.state)).length
    // Every tile is as wide as the longest name (up to 14), so they line up.
    const tileWidth = Math.min(15, Math.max(...list.map(x => x.name.length), 4) + 2)
    const counts = ATTENTION.map(state => ({ state, n: list.filter(x => x.state === state).length })).filter(c => c.n)

    const card = (s: PiSession) => {
      const isLive = LIVE.includes(s.state)
      const activity = s.lastTool ? `→ ${s.lastTool}` : null
      // A busy session counts from the start of its run, the others from pi's last event.
      const since = s.state === 'busy' && s.runStartedAt ? s.runStartedAt : s.lastActivity
      // Open, the Live view takes the place of the one tool line and the start of the last reply.
      const tail = liveView?.name === s.name ? liveWindow(liveRows(liveView.lines, cols), liveView.offset) : null
      // The view is the card's last part, so the pane's last rows: a wheel tick over them scrolls it.
      liveDrawn = tail ? 1 + (tail.older ? 1 : 0) + Math.max(1, tail.rows.length) + (tail.newer ? 1 : 0) : 0
      return (
        <Box flexDirection="column" key="card">
          <Text>
            <Text bold>{s.name}</Text> <Text color={STATE_COLOR[s.state] ?? 'white'}>{s.state}</Text>
            <Text dimColor> {[ago(since, now), usageLine(s)].filter(Boolean).join(' · ')}</Text>
          </Text>
          <Text dimColor>{clip(`${s.model ?? '-'}  ${short(s.cwd)}`, cols)}</Text>
          {s.sandboxed === false && <Text color="red" bold wrap="wrap">! runs outside the sandbox: pi holds your real provider key</Text>}
          {!tail && activity && <Text>{clip(activity, cols * 2)}</Text>}
          {s.error && <Text color="red" wrap="wrap">error: {s.error}</Text>}
          {!tail && s.lastReply && <Text dimColor wrap="wrap">last: {s.lastReply}</Text>}
          <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1} key="actions">
            {s.state === 'busy' && <Button key="abort" plain hotkey="a" label="Abort" onPress={() => void runScript($, ['abort', s.name])} />}
            {isLive && <Button key="stop" plain hotkey="s" label="Stop" onPress={() => void runScript($, ['stop', s.name])} />}
            {!isLive && <Button key="resume" plain hotkey="r" label="Resume" onPress={() => ask($, `Serve the pi session ${s.name} again and ask it to continue where it left off.`)} />}
            <Button key="live" plain hotkey="l" label={tail ? 'Live off' : 'Live'} onPress={() => void (tail ? closeLive($) : openLive($, s.name)).catch(() => {})} />
            <Button key="transcript" plain hotkey="t" label="Transcript" onPress={() => ask($, `Show me the last 40 lines of the pi session ${s.name}'s transcript.`)} />
            {!isLive && <Button key="forget" plain hotkey="f" label="Forget" onPress={() => void runScript($, ['forget', s.name])} />}
          </Box>
          {tail && (
            // Under the actions, so they stay put as the tail grows. Scrolled
            // up, it stays on the rows shown as lines come (paused) until
            // `↓ N newer`, End or scrolling down takes it back to the end.
            <Box flexDirection="column" marginTop={1} key="tail">
              <Box flexDirection="row" columnGap={2} key="tail-bar">
                <Text dimColor wrap="truncate-end">
                  {`live · tool calls and reply${tail.newer ? ' · paused' : ''}`}
                </Text>
                {tail.offset < tail.max && <Button key="live-up" plain hotkey="k" label="▲" onPress={() => void scrollLive($, 1).catch(() => {})} />}
                {tail.offset > 0 && <Button key="live-down" plain hotkey="j" label="▼" onPress={() => void scrollLive($, -1).catch(() => {})} />}
              </Box>
              {tail.older > 0 && <Text dimColor>{`↑ ${tail.older} older`}</Text>}
              {tail.rows.length ? tail.rows.map(row => <Text wrap="truncate-end">{row}</Text>) : <Text dimColor>(nothing yet)</Text>}
              {tail.newer > 0 && <Button key="live-end" plain label={`↓ ${tail.newer} newer`} onPress={() => void scrollLive($, 'end').catch(() => {})} />}
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {warnings.map(w => (
          <Text color="red" wrap="wrap">! {w}</Text>
        ))}
        {list.length === 0 && <Text dimColor>No pi sessions yet. Ask Claude to start one.</Text>}
        {list.length > 0 && (
          <Text dimColor>
            {list.length} session{list.length === 1 ? '' : 's'} · {live} running
          </Text>
        )}
        {list.length > 0 && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1} key="grid">
            {list.map(x => {
              const color = STATE_COLOR[x.state] ?? 'white'
              // An unsandboxed session ends its tile with a red !.
              const bare = x.sandboxed === false
              const label = clip(x.name, tileWidth - (bare ? 2 : 1)).padEnd(tileWidth - (bare ? 2 : 1))
              // The picked tile is filled with its colour (inverse, so it reads
              // on light and dark themes); the others show a bar of it.
              return (
                <Button key={`session:${x.name}`} plain label={`${x.name} ${x.state}`} onPress={() => void pick($, x.name).catch(() => {})}>
                  {x.name === s?.name ? (
                    <Text color={color} inverse bold>
                      ▌{label}
                      {bare && <Text color="red">!</Text>}
                    </Text>
                  ) : (
                    <Text>
                      <Text color={color}>▌</Text>
                      {label}
                      {bare && <Text color="red" bold>!</Text>}
                    </Text>
                  )}
                </Button>
              )
            })}
          </Box>
        )}
        {counts.length > 0 && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1} key="legend">
            {counts.map(c => (
              <Text>
                <Text color={STATE_COLOR[c.state] ?? 'white'}>●</Text>
                <Text dimColor> {c.n} {c.state}</Text>
              </Text>
            ))}
          </Box>
        )}
        {s && <Text dimColor>{'─'.repeat(Math.min(cols, 60))}</Text>}
        {s && card(s)}
      </Box>
    )
  })

  // The person's wheel over the open Live view, or their scroll keys while it
  // is in sight, scroll the view rather than the pane: arrows and ticks by
  // rows, PageUp/PageDown by its 20, Home and End to its top and end. At the
  // view's edge, or with the pointer elsewhere, Live closed or a tail that
  // fits, the pane scrolls as ever.
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if (e.origin.kind !== 'person' || !e.by || !liveDrawn) return next(e)
    const lv = await read($, liveAtom)
    if (!lv) return next(e)
    const { offset, max } = liveWindow(liveRows(lv.lines, liveCols), lv.offset)
    if (!max) return next(e)
    // The pane's window before this move, and the tree row the view starts at.
    const top = Math.min(Math.max(0, e.contentRows - e.bodyRows), Math.max(0, e.offset - e.by))
    const from = e.contentRows - liveDrawn
    if (e.pointer) {
      const row = top + e.pointer.row
      if (row < from || row >= e.contentRows) return next(e)
    } else if (top + e.bodyRows <= from) return next(e)
    if (e.by < 0 ? offset >= max : offset <= 0) return next(e)
    const n = Math.abs(e.by)
    const rows = e.pointer ? n : n === e.contentRows ? max : n === e.bodyRows ? LIVE_ROWS : n
    await scrollLive($, e.by < 0 ? rows : -rows)
    return {}
  })
}
