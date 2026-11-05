import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PiSession } from '../types'

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
const LIVE = ['starting', 'idle', 'busy', 'waiting']
// Matches pi-session.mjs: a serve whose heartbeat is older is gone.
const STALE_MS = 20000
// Named colours only, so light and dark terminal themes both read.
const STATE_COLOR: Record<string, string> = {
  idle: 'green',
  busy: 'yellow',
  starting: 'yellow',
  waiting: 'magenta',
  stopped: 'gray',
  failed: 'red',
  lost: 'red',
}

// Which session the card shows when none is picked: the one most likely to
// need you first.
const ATTENTION = ['waiting', 'failed', 'busy', 'starting', 'idle', 'lost', 'stopped']
const rank = (state: string) => {
  const i = ATTENTION.indexOf(state)
  return i === -1 ? ATTENTION.length : i
}

const sessionsAtom = atom({ plugin: 'pi', key: 'sessions' } as const, [] as PiSession[], { shape: 'sessions-1' })
const warningsAtom = atom({ plugin: 'pi', key: 'warnings' } as const, [] as string[])
const selectedAtom = atom({ plugin: 'pi', key: 'selected' } as const, null as string | null)

let home = ''
let cwd = ''
let autoOpen = true
let caWarnDays = 30
let allowUnsandboxed = false
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
const ALLOW_RE = /--allow-unsandboxed/
const flat = (command: string) => command.replace(/["'\\]/g, '')

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
export const runsExcluded = (command: string, excluded: string[]): boolean => {
  if (!excluded.length) return false
  const names = new Set(excluded.map(c => c.split(/[\s:]/)[0]!.replace(/\*$/, '')).filter(Boolean))
  for (const part of command.split(/[;&|\n]|\$\(|`|\(/)) {
    const words = part.trim().replace(/^((\w+=\S*|sudo|env|exec|command|nohup|time)\s+)+/, '').split(/\s+/)
    const first = (words[0] ?? '').split('/').pop() ?? ''
    if (first && names.has(first)) return true
  }
  return false
}

/**
 * Why a Bash command must not run, or null. Unsandboxed, a command that names
 * pi, ~/.pi or auth.json could read the real key; pi-session's way past its
 * own check is for the person to allow (option allowUnsandboxed), not Claude.
 */
export const bashRefusal = (command: string, o: { unsandboxed: boolean; allowUnsandboxed: boolean }): string | null => {
  const text = flat(command)
  // pi-session trusts this to tell it runs in the sandbox; only the sandbox
  // sets it. Naming it (a search, say) is fine; setting or unsetting it is not.
  if (/SANDBOX_RUNTIME\s*=|unset\s+(-v\s+)?SANDBOX_RUNTIME/.test(text))
    return 'pi: SANDBOX_RUNTIME is set by the sandbox itself; a command may not set or change it.'
  // Likewise the program pi-session runs as pi: pointing it elsewhere would get past the gate.
  if (/PI_SESSION_PI\s*=/.test(text)) return 'pi: PI_SESSION_PI is for the mod\'s own tests; a command may not set it.'
  // The opencode-go gate lives in pi-session, so pi runs only through it
  // (pi run directly could use any provider, and `pi auth` prints keys).
  if (runsExcluded(text, ['pi'])) return `pi: run pi only through pi-session (node <pi mod>/scripts/pi-session.mjs serve <name> --model opencode-go/<id>). For now the pi mod works only with an opencode-go API key.`
  if (ALLOW_RE.test(text) && !o.allowUnsandboxed)
    return 'pi: --allow-unsandboxed lets pi read your real key, and only you can allow it (/plugin configure pi@claude-mods, allowUnsandboxed). Run pi-session inside the sandbox instead.'
  if (!o.unsandboxed || !PI_RE.test(text)) return null
  if (AUTH_RE.test(text)) return 'pi: this command would run outside the sandbox and names auth.json, which holds your real provider key.'
  if (o.allowUnsandboxed) return null
  return 'pi: this command would run outside the Bash sandbox, where pi and Claude could read your real provider key. Turn the sandbox on, or allow it yourself (/plugin configure pi@claude-mods, allowUnsandboxed).'
}

/**
 * A Bash command with `--allow-unsandboxed` added to each pi-session serve in
 * it. The mod does this when the person turned allowUnsandboxed on, so the
 * choice is theirs and Claude never passes the flag itself. Inside the sandbox
 * the flag changes nothing.
 */
export const withAllowFlag = (command: string): string =>
  command.replace(/(pi-session(?:\.mjs)?["']?\s+serve)(?=\s|$)(?![^;&|\n]*--allow-unsandboxed)/g, '$1 --allow-unsandboxed')

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
  if (!on.enabled)
    out.push(`The Bash sandbox is off (${on.source}): pi would read your real provider key, and so could Claude's commands. ${allowUnsandboxed ? 'allowUnsandboxed is on, so pi-session starts pi anyway.' : 'pi-session refuses to start pi.'}`)
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
  const dialog = obj(raw.dialog)
  return {
    name,
    state: LIVE.includes(state) && now - beat > STALE_MS ? 'lost' : state,
    cwd: str(raw.cwd),
    model: str(raw.model),
    lastActivity: num(raw.lastActivity),
    lastTool: str(raw.lastTool),
    lastReply: str(raw.lastReply),
    dialog: str(dialog.id) ? { id: str(dialog.id)!, method: str(dialog.method) ?? '', title: str(dialog.title) ?? '' } : null,
    error: str(raw.error),
    sandboxed: typeof raw.sandboxed === 'boolean' ? raw.sandboxed : null,
  }
}

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
  // Ages are drawn from lastActivity, so the list only changes with a session.
  const key = JSON.stringify(list)
  if (key !== seen) {
    seen = key
    await update($, sessionsAtom, () => list)
  }
  const isLive = list.some(s => LIVE.includes(s.state))
  if (isLive && !wasLive && autoOpen) void $.ui.open({ id: PANE, title: TITLE }).catch(() => {})
  wasLive = isLive
}

const ago = (ms: number | null, now: number) => {
  if (!ms) return ''
  const s = Math.max(0, Math.round((now - ms) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`
}
const short = (p: string | null) => (p && home && p.startsWith(home) ? `~${p.slice(home.length)}` : p ?? '')
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s)

const instructions = ($: EngineInterface) => `# pi sessions (pi mod)

You can run long-lived pi coding-agent sessions. Use only this script, through the Bash tool, so pi runs inside the sandbox where its provider key is masked:

  node ${script($)} <command>

- Start: run \`serve <name> --cwd <dir> --model opencode-go/<id>\` with run_in_background. It runs until stopped. pi takes up to ~20s to start; \`status <name>\` says idle when ready. Never start pi any other way (running pi directly is refused).
- For now pi works only on opencode-go with an API key: serve refuses another provider's model, extra pi arguments, and an auth.json holding any other login. If it refuses, tell the person why; never try to get around the gate.
- Work: \`send <name> "<prompt>"\` prints a prompt id. While pi works a new prompt queues as a follow-up; \`--steer\` delivers it before pi's next model call instead.
- Results: run \`wait <name> <id>\` with run_in_background; you are notified when pi settles and it prints the reply (exit 3: pi asks a question, answer with \`answer <name> <request-id> <value>\`). To cap a run, add \`--timeout SECONDS --abort\`: on timeout pi's run is aborted and the wait exits 2. \`read <name> --tail 40\` shows the transcript, \`read <name> --last\` the last reply.
- Control: \`status\`, \`abort <name>\` (stop the current run), \`stop <name>\` (end the session), \`forget <name>\`.
- After a Claude Code restart, \`serve <name>\` again reopens the conversation; work that was mid-run is lost, so ask pi to continue.
- Names: letters, digits, . _ - (e.g. auth-fix). Several sessions can run at once; give each its own folder or git worktree when they edit code.
- Never read ~/.pi or auth.json (the file tools are refused there). Session logs are read through the script.
- \`serve\` refuses to start outside the sandbox. ${allowUnsandboxed ? 'The person has allowed pi without the sandbox (option allowUnsandboxed), so the mod lets serve start there by itself: run serve as usual, never add flags for it, and when the sandbox is off tell them pi holds their real key.' : 'Never try to get around that; tell the person the sandbox is off.'}`

// Stop, abort and forget only write to a session's pipe or files, so the mod
// runs them itself; serving again and answering go through Claude, so pi
// starts inside the sandbox.
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
  seen = ''

  on('session.start', async ($, e, next) => {
    home = (await $.env.get('HOME')) ?? ''
    cwd = e.cwd
    await $.command.register({
      name: COMMAND,
      description: 'pi sessions: /pi opens the panel, /pi check checks the key-masking setup, /pi close',
    }).catch((err: unknown) => $.ui.log(`pi: /${COMMAND} not registered: ${String(err)}`))
    await load($).catch(() => {})
    $.clock.every(POLL_MS, () => void load($).catch(() => {}))
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
      const allowed = allowUnsandboxed ? withAllowFlag(command) : command
      return allowed === command ? next(e) : next({ ...e, command: allowed })
    }
    const base = cwd || home
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
    const now = await $.clock.now()
    const cols = Math.max(20, e.props.bodyColumns ?? 60)

    const fallback = [...list].sort((a, b) => rank(a.state) - rank(b.state))[0]
    const s = list.find(x => x.name === picked) ?? fallback
    const live = list.filter(x => LIVE.includes(x.state)).length
    const asking = list.filter(x => x.state === 'waiting').length
    // Every tile is as wide as the longest name (up to 14), so they line up.
    const tileWidth = Math.min(15, Math.max(...list.map(x => x.name.length), 4) + 2)
    const counts = ATTENTION.map(state => ({ state, n: list.filter(x => x.state === state).length })).filter(c => c.n)

    const card = (s: PiSession) => {
      const isLive = LIVE.includes(s.state)
      const activity = s.dialog
        ? `asks (${s.dialog.method} ${s.dialog.id}): ${s.dialog.title}`
        : s.lastTool
          ? `→ ${s.lastTool}`
          : null
      return (
        <Box flexDirection="column" key="card">
          <Text>
            <Text bold>{s.name}</Text> <Text color={STATE_COLOR[s.state] ?? 'white'}>{s.state}</Text>
            <Text dimColor> {ago(s.lastActivity, now)}</Text>
          </Text>
          <Text dimColor>{clip(`${s.model ?? '-'}  ${short(s.cwd)}`, cols)}</Text>
          {s.sandboxed === false && <Text color="red" bold wrap="wrap">! runs outside the sandbox: pi holds your real provider key</Text>}
          {activity && <Text color={s.dialog ? 'magenta' : undefined}>{clip(activity, cols * 2)}</Text>}
          {s.error && <Text color="red" wrap="wrap">error: {s.error}</Text>}
          {s.lastReply && <Text dimColor wrap="wrap">last: {s.lastReply}</Text>}
          <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1} key="actions">
            {s.dialog && (
              <Button key="answer" plain hotkey="y" label="Answer" onPress={() => ask($, `The pi session ${s.name} asks (${s.dialog!.method} ${s.dialog!.id}): ${s.dialog!.title}\nAnswer it: `)} />
            )}
            {(s.state === 'busy' || s.state === 'waiting') && <Button key="abort" plain hotkey="a" label="Abort" onPress={() => void runScript($, ['abort', s.name])} />}
            {isLive && <Button key="stop" plain hotkey="s" label="Stop" onPress={() => void runScript($, ['stop', s.name])} />}
            {!isLive && <Button key="resume" plain hotkey="r" label="Resume" onPress={() => ask($, `Serve the pi session ${s.name} again and ask it to continue where it left off.`)} />}
            <Button key="transcript" plain hotkey="t" label="Transcript" onPress={() => ask($, `Show me the last 40 lines of the pi session ${s.name}'s transcript.`)} />
            {!isLive && <Button key="forget" plain hotkey="f" label="Forget" onPress={() => void runScript($, ['forget', s.name])} />}
          </Box>
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
            {list.length} session{list.length === 1 ? '' : 's'} · {live} running{asking ? ` · ${asking} asking` : ''}
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
                <Button key={`session:${x.name}`} plain label={`${x.name} ${x.state}`} onPress={() => void update($, selectedAtom, () => x.name)}>
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
}
