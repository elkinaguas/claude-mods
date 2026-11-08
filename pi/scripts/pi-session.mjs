#!/usr/bin/env node
// pi-session: long-lived pi sessions (`pi --mode rpc`) driven from Claude Code's
// Bash tool, so pi runs inside the sandbox and only ever sees a masked key.
//
// `serve` owns one pi process: it reads commands from a named pipe, forwards
// them to pi's stdin, and turns pi's event stream into status.json (read by
// the pi mod's panel), a readable transcript, and the last reply. Every other
// subcommand talks to a running `serve` through the pipe or reads its files.

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const ROOT = process.env.PI_SESSIONS_DIR || path.join(os.homedir(), '.pi', 'agent', 'claude-sessions')
const PI = process.env.PI_SESSION_PI || 'pi'
const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/
const LIVE = ['starting', 'idle', 'busy', 'waiting']
const HEARTBEAT_MS = 5000
// A serve whose heartbeat is older than this is gone (killed with Claude Code,
// or the machine slept through it). Each sandboxed command has its own process
// namespace, so a pid cannot be checked from another command.
const STALE_MS = 20000
// The most a command line may take to arrive in one piece (PIPE_BUF).
const PIPE_LINE = 4096
const DIALOGS = ['select', 'confirm', 'input', 'editor']
// Claude Code's Bash sandbox sets this in every command it wraps. Outside it,
// pi would read the real provider key from ~/.pi/agent/auth.json.
const SANDBOXED = !!process.env.SANDBOX_RUNTIME
// The gate: the mod runs pi only on opencode-go, with an API key that is the
// only login in pi's auth.json, or on a model whose provider models.json
// points at a host the person trusts (option trustedModelHosts, passed by the
// mod as --trusted-hosts). So pi-session can't be used to reach any other
// provider's credentials (a Claude subscription login, say).
const PROVIDER = 'opencode-go'
const AUTH = path.join(os.homedir(), '.pi', 'agent', 'auth.json')
const MODELS = path.join(os.homedir(), '.pi', 'agent', 'models.json')
// What serve passes on from its pipe to pi; anything else (set_model, say) is refused.
const PIPE_TYPES = ['prompt', 'abort', 'extension_ui_response', '__stop']
const GATE_NOTE = `The pi mod works only with an ${PROVIDER} API key, or a model at a host you trust (option trustedModelHosts).`
const PI_HOME = path.join(os.homedir(), '.pi')
// `wait` exits with this when a findings prompt's reply fails its check.
const BAD_FINDINGS = 4
const SEVERITIES = ['critical', 'high', 'medium', 'low']
const CONFIDENCES = ['high', 'medium', 'low']
const FINDING_KEYS = ['file', 'line', 'severity', 'confidence', 'title']
// What `send --format findings` adds to the prompt; checkFindings holds pi's reply to it.
const FINDINGS_NOTE = `

Give your findings as exactly one fenced \`\`\`json code block holding a JSON array, and write nothing outside the block. Each finding is an object with exactly these keys: "file" (string, the path), "line" (integer, 1 or higher; 1 when it concerns the whole file), "severity" (${SEVERITIES.map(v => `"${v}"`).join(', ')}), "confidence" (${CONFIDENCES.map(v => `"${v}"`).join(', ')}), "title" (string, one line). Add no other keys. With no findings, the block holds [].`

/**
 * One trusted host entry: `host` (the URL scheme's default port only),
 * `host:port`, `host:*` (any port), with `*.domain` for its subdomains and
 * `[v6]` for an IPv6 address. Null when the entry is not one of these.
 */
const parseHostEntry = entry => {
  const m = /^(\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:]+\])(?::(\d{1,5}|\*))?$/i.exec(entry.trim())
  if (!m) return null
  return { sub: !!m[1], host: m[2].toLowerCase(), port: m[3] ?? null }
}

/** Whether a URL's host and port are one of the trusted entries. */
const trustedUrl = (url, entries) => {
  let u
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
  const host = u.hostname.toLowerCase()
  const port = u.port || (u.protocol === 'https:' ? '443' : '80')
  return entries.some(e => {
    const hostOk = e.sub ? host.endsWith(`.${e.host}`) : host === e.host
    const portOk = e.port === '*' || (e.port ?? (u.protocol === 'https:' ? '443' : '80')) === port
    return hostOk && portOk
  })
}

const USAGE = `pi-session: long-lived pi sessions for Claude Code

  serve <name> --model PROVIDER/ID [--cwd DIR] [--thinking LEVEL]
      Run pi for this session until stopped. Run it in the background.
      Serving a stopped session again reopens its conversation. PROVIDER is
      opencode-go, or one models.json points at a trusted host. Refused
      outside Claude Code's sandbox unless --allow-unsandboxed (pi then reads
      your real key). The pi mod adds --allow-unsandboxed and
      --trusted-hosts itself, from your options; Claude never passes them.
  send <name> [--steer] [--format findings] <prompt...> | --file FILE | -
      Send a prompt. Prints its id. While pi works it is queued as a
      follow-up, or with --steer delivered before pi's next model call.
      --format findings asks pi for a fenced JSON array of objects with file,
      line, severity, confidence and title, which wait then checks.
  wait <name> [ID] [--timeout SECONDS [--abort]] [--out FILE]
      Block until pi has settled (after prompt ID, or everything sent so far),
      then print its last reply. Exit 3 when pi waits on a dialog, 2 on
      timeout; with --abort a timeout also stops pi's run. --out writes the
      reply to FILE and prints only its path and size; FILE can't be in ~/.pi.
      A findings reply comes as the JSON array alone. Exit 4 if it fails the
      check: the error is reported, nothing is written, read --last has it.
  read <name> [--last | --tail N | --since LINE]
      Print the transcript (default: last 40 lines), or the last reply.
  status [name] [--json]
  answer <name> <request-id> <value...> | --cancel
      Answer a dialog an extension opened (confirm takes yes or no).
  abort <name>     Stop pi's current run; the session stays.
  stop <name>      End the session; serve it again later to continue.
  forget <name>    Delete a stopped session's files here (pi keeps its own copy).

Sessions live in ${ROOT}.`

const fail = (msg, code = 1) => {
  process.stderr.write(`pi-session: ${msg}\n`)
  process.exit(code)
}
const dir = name => path.join(ROOT, name)
const file = (name, f) => path.join(dir(name), f)
const readJson = (p, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return fallback
  }
}
const writeJson = (p, v) => {
  const tmp = `${p}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(v, null, 2)}\n`)
  fs.renameSync(tmp, p)
}
const readStatus = name => readJson(file(name, 'status.json'), null)
const isLive = st => !!st && LIVE.includes(st.state) && Date.now() - (st.heartbeatAt ?? 0) < STALE_MS
const shownState = st => (!st ? 'unknown' : LIVE.includes(st.state) && !isLive(st) ? 'lost' : st.state)
const clock = () => new Date().toTimeString().slice(0, 8)
const oneLine = (s, n = 100) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}
const ago = ms => {
  if (!ms) return '-'
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`
}

// Splits a stream on LF only: Node's readline also splits on U+2028/U+2029,
// which are valid inside JSON strings (pi's RPC docs call this out).
const onLines = (stream, fn) => {
  let buf = ''
  stream.setEncoding('utf8')
  stream.on('data', chunk => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '')
      buf = buf.slice(i + 1)
      if (line.trim()) fn(line)
    }
  })
}

const needName = name => {
  if (!name) fail('name a session.')
  if (!NAME_RE.test(name)) fail(`"${name}" is not a session name: letters, digits, . _ - (start and end with a letter or digit).`)
  return name
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
// A stale heartbeat alone does not prove a serve is gone: after the machine
// sleeps, every heartbeat looks old until the serve's next beat. So a live
// state with a stale heartbeat is read again after more than one beat, and
// the session counts as gone only if the heartbeat has not moved.
const settledStatus = async name => {
  const st = readStatus(name)
  if (!st || isLive(st) || !LIVE.includes(st.state)) return st
  await sleep(HEARTBEAT_MS + 1500)
  return readStatus(name)
}
const needLive = async name => {
  const st = await settledStatus(name)
  if (!isLive(st)) fail(`${name} is not running (${shownState(st)}). Start it in the background: pi-session serve ${name}`)
  return st
}

// Writes one command to a running serve's pipe. Non-blocking open fails at
// once (ENXIO) when nothing reads the pipe, instead of hanging.
// The panel runs stop and abort outside the sandbox, and sandboxed commands
// can write in the sessions folder: so the session folder must be a real
// folder, in.fifo is never followed as a link, and only a pipe is written to.
// Otherwise a planted link would turn this into a write to any file of yours.
const toPipe = (name, cmd) => {
  let fd
  try {
    if (!fs.lstatSync(dir(name)).isDirectory()) fail(`${dir(name)} is not a folder; refusing to write to it.`)
    fd = fs.openSync(file(name, 'in.fifo'), fs.constants.O_WRONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW)
  } catch (err) {
    if (err.code === 'ELOOP') fail(`${file(name, 'in.fifo')} is a link, not ${name}'s pipe; refusing to write through it.`)
    fail(`${name} is not listening (${err.code}). Serve it again.`)
  }
  if (!fs.fstatSync(fd).isFIFO()) {
    fs.closeSync(fd)
    fail(`${file(name, 'in.fifo')} is not a pipe; refusing to write to it.`)
  }
  // A write of at most PIPE_BUF (4096) bytes to a pipe is all or nothing, so
  // a line never arrives cut, nor mixed with another sender's. A full pipe
  // refuses it (EAGAIN): try again for a while. Longer prompts go by file.
  const line = Buffer.from(`${JSON.stringify(cmd)}\n`)
  if (line.length > PIPE_LINE) fail(`internal: a ${line.length}-byte command does not fit the pipe.`)
  for (let tries = 0; ; tries++) {
    try {
      fs.writeSync(fd, line)
      break
    } catch (err) {
      if (err.code !== 'EAGAIN' || tries > 300) {
        fs.closeSync(fd)
        fail(`${name} did not take the command (${err.code}); is it stuck?`)
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
  }
  fs.closeSync(fd)
}

// Only the command that takes --out or --format reads it, so a prompt can mention them.
const parse = (argv, cmd) => {
  const flags = {}
  const rest = []
  const extra = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      extra.push(...argv.slice(i + 1))
      break
    }
    if (/^--(cwd|model|thinking|timeout|tail|since|file|trusted-hosts)$/.test(a) || (a === '--out' && cmd === 'wait') || (a === '--format' && cmd === 'send'))
      flags[a.slice(2)] = argv[++i]
    else if (/^--(steer|last|json|cancel|abort|allow-unsandboxed)$/.test(a)) flags[a.slice(2)] = true
    else rest.push(a)
  }
  return { flags, rest, extra }
}

// The real path of p, through the real path of its nearest existing parent.
// Throws on a dangling link: a write would land wherever it points.
const realTarget = p => {
  const tail = []
  for (let at = path.resolve(p); ; at = path.dirname(at)) {
    try {
      return path.join(fs.realpathSync.native(at), ...tail)
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`can't resolve ${at} (${err.code})`)
    }
    if (fs.lstatSync(at, { throwIfNoEntry: false })) throw new Error(`${at} is a link to nothing`)
    tail.unshift(path.basename(at))
  }
}
const within = (p, base) => p === base || p.startsWith(`${base}${path.sep}`)

// Where --out may write: resolved, so no link or relative path reaches ~/.pi
// (auth.json and the session files pi-session and its panel trust are there).
const outTarget = p => {
  let real
  const homes = [PI_HOME]
  try {
    real = realTarget(p)
  } catch (err) {
    fail(`refusing --out ${p}: ${err.message}.`)
  }
  try {
    homes.push(realTarget(PI_HOME))
  } catch {
    // A dangling ~/.pi: the path as named is all there is to compare.
  }
  if (homes.some(h => within(real, h))) fail(`refusing --out ${p}: ${real} is in ~/.pi. Write it in the project or the scratchpad.`)
  const st = fs.lstatSync(real, { throwIfNoEntry: false })
  if (st && !st.isFile()) fail(`refusing --out ${p}: ${real} is not a plain file.`)
  return real
}

// Checked before the wait starts, so a bad FILE fails at once, not after a long run.
const prepareOut = p => {
  const parent = path.dirname(outTarget(p))
  try {
    fs.mkdirSync(parent, { recursive: true })
    fs.accessSync(parent, fs.constants.W_OK)
  } catch (err) {
    fail(`can't write --out ${p} (${err.code}): use a folder sandboxed commands can write, such as the project or the scratchpad.`)
  }
}

// Replaces FILE by rename, so the write can't go through a link or a hard link
// planted since the check, and FILE never holds half a reply.
const writeOut = (p, text) => {
  const real = outTarget(p)
  const tmp = `${real}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx' })
    fs.renameSync(tmp, real)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    fail(`could not write --out ${p} (${err.code}). The reply is still there: read --last.`)
  }
  process.stdout.write(`${real} (${Buffer.byteLength(text)} bytes)\n`)
}

// A reply to `send --format findings`: { findings } when it holds one fenced
// block with an array of the fixed schema, or { error } saying what is wrong.
const checkFindings = reply => {
  const blocks = [...reply.matchAll(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/gim)]
  if (blocks.length !== 1) return { error: `expected one fenced JSON block, found ${blocks.length}` }
  let findings
  try {
    findings = JSON.parse(blocks[0][1])
  } catch (err) {
    return { error: `the block is not JSON (${err.message})` }
  }
  if (!Array.isArray(findings)) return { error: 'the block is not a JSON array' }
  for (const [i, f] of findings.entries()) {
    const at = `finding ${i + 1}`
    if (!f || typeof f !== 'object' || Array.isArray(f)) return { error: `${at} is not an object` }
    const other = Object.keys(f).filter(k => !FINDING_KEYS.includes(k))
    if (other.length) return { error: `${at} has other keys (${other.join(', ')})` }
    if (typeof f.file !== 'string' || !f.file.trim()) return { error: `${at}: file must be a path` }
    if (!Number.isInteger(f.line) || f.line < 1) return { error: `${at}: line must be an integer, 1 or higher` }
    if (!SEVERITIES.includes(f.severity)) return { error: `${at}: severity must be one of ${SEVERITIES.join(', ')}` }
    if (!CONFIDENCES.includes(f.confidence)) return { error: `${at}: confidence must be one of ${CONFIDENCES.join(', ')}` }
    if (typeof f.title !== 'string' || !f.title.trim()) return { error: `${at}: title must be a line of text` }
  }
  return { findings }
}
const noFindings = (name, why, code) => fail(`${name} gave no valid findings: ${why}. Nothing was written; its raw reply: read ${name} --last.`, code)

const lastReply = name => (fs.existsSync(file(name, 'last-reply.md')) ? fs.readFileSync(file(name, 'last-reply.md'), 'utf8') : '')

// Tool arguments in one short line: the path, command or pattern when there is one.
const argSummary = args => {
  if (!args || typeof args !== 'object') return ''
  const key = ['path', 'file_path', 'command', 'pattern', 'url', 'query'].find(k => typeof args[k] === 'string')
  return oneLine(key ? args[key] : JSON.stringify(args), 90)
}

// auth.json's logins, or {} when it is missing or empty; null when it does not parse.
const readAuth = () => {
  let text
  try {
    text = fs.readFileSync(AUTH, 'utf8')
  } catch (err) {
    return err.code === 'ENOENT' ? {} : null
  }
  if (!text.trim()) return {}
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

// Refuses to serve unless the model is opencode-go's with its API key the only
// login in auth.json, or its provider is defined in models.json on a trusted
// host with no login in auth.json. Either way every provider models.json
// defines must be on a trusted host, so no other service's key sits there.
// Reads only names, types and base URLs, never a key or a token.
function gate(model, extra, trustedList) {
  if (extra.length) fail(`extra pi arguments (${extra.join(' ')}) are off. ${GATE_NOTE}`)
  const entries = (trustedList ?? '').split(',').filter(Boolean).map(parseHostEntry)
  if (entries.some(e => !e)) fail(`--trusted-hosts holds an entry that is not a host, host:port or host:*. ${GATE_NOTE}`)
  if (!model) fail(`name the model: --model ${PROVIDER}/<id>, or <provider>/<id> for a provider at a trusted host. ${GATE_NOTE}`)
  const provider = model.split('/')[0]
  let models = {}
  try {
    models = JSON.parse(fs.readFileSync(MODELS, 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') fail(`could not read ${MODELS} (${err.code ?? 'not JSON'}). ${GATE_NOTE}`)
  }
  const providers = models && typeof models.providers === 'object' && models.providers ? models.providers : {}
  const untrusted = Object.entries(providers)
    .filter(([, p]) => !(p && typeof p.baseUrl === 'string' && trustedUrl(p.baseUrl, entries)))
    .map(([n]) => n)
  if (untrusted.length)
    fail(`${MODELS} defines ${untrusted.join(', ')} with no base URL at a trusted host. pi-session runs pi only while every provider there is at a host you trust, so no other service's key is within reach. ${GATE_NOTE}`)
  if (provider !== PROVIDER) {
    if (!entries.length) fail(`${model} is not an ${PROVIDER} model. ${GATE_NOTE}`)
    if (!providers[provider]) fail(`${provider} is not defined in ${MODELS}, at a trusted host. ${GATE_NOTE}`)
    const auth = readAuth()
    if (auth === null) fail(`${AUTH} does not parse. ${GATE_NOTE}`)
    const logins = Object.keys(auth)
    if (logins.length)
      fail(`${AUTH} holds ${logins.join(', ')}. A model at a trusted host runs only while auth.json holds no login, so no other provider's credentials are within reach. ${GATE_NOTE}`)
    return
  }
  const auth = readAuth()
  if (auth === null) fail(`could not read ${AUTH} (not JSON). Log in to ${PROVIDER} in pi with an API key first. ${GATE_NOTE}`)
  const entry = auth && typeof auth === 'object' ? auth[PROVIDER] : null
  if (!entry || entry.type !== 'api_key') fail(`${AUTH} has no ${PROVIDER} API key${entry?.type ? ` (its login is ${entry.type})` : ''}. ${GATE_NOTE}`)
  const others = Object.keys(auth).filter(n => n !== PROVIDER)
  if (others.length)
    fail(`${AUTH} also holds ${others.join(', ')}. pi-session runs pi only while the ${PROVIDER} API key is the only login there, so no other provider's credentials are within reach. Log out of the others in pi first. ${GATE_NOTE}`)
}

async function serve(name, flags, extra) {
  if (!SANDBOXED && !flags['allow-unsandboxed'])
    fail(`not inside Claude Code's Bash sandbox, so pi would read your real provider key. Run it from Claude's Bash tool with the sandbox on.`)
  fs.mkdirSync(dir(name), { recursive: true })
  const before = await settledStatus(name)
  if (isLive(before)) fail(`${name} is already running.`)
  const meta = readJson(file(name, 'meta.json'), {})
  const cwd = path.resolve(flags.cwd ?? meta.cwd ?? process.cwd())
  const model = flags.model ?? meta.model
  const thinking = flags.thinking ?? meta.thinking
  gate(model, extra, flags['trusted-hosts'])
  // pi's own session id: reopened when the session is served again, and new
  // for a new session, so a name used again after forget starts afresh.
  const sessionId = meta.sessionId ?? `claude-${name}-${Date.now().toString(36)}`
  writeJson(file(name, 'meta.json'), { name, cwd, model, thinking, sessionId, createdAt: meta.createdAt ?? Date.now() })

  const fifo = file(name, 'in.fifo')
  fs.rmSync(fifo, { force: true })
  const made = spawnSync('mkfifo', ['-m', '600', fifo])
  if (made.status !== 0) fail(`mkfifo failed: ${String(made.stderr || made.error)}`)

  const args = ['--mode', 'rpc', '--session-id', sessionId]
  if (model) args.push('--model', model)
  if (thinking) args.push('--thinking', thinking)

  const st = {
    name,
    state: 'starting',
    cwd,
    model: model ?? null,
    sandboxed: SANDBOXED,
    sessionId,
    sessionFile: null,
    startedAt: Date.now(),
    lastActivity: Date.now(),
    runStartedAt: null,
    heartbeatAt: Date.now(),
    promptSeq: before?.promptSeq ?? 0,
    acceptedSeq: before?.promptSeq ?? 0,
    settledSeq: before?.promptSeq ?? 0,
    // The newest prompt sent with --format findings: while it is the last one
    // settled, last-reply.md is its reply and wait checks it.
    findingsSeq: before?.findingsSeq ?? 0,
    prompts: before?.prompts ?? {},
    turns: before?.turns ?? 0,
    lastTool: null,
    lastReply: before?.lastReply ?? null,
    dialog: null,
    error: null,
    exitCode: null,
  }
  const save = () => {
    st.heartbeatAt = Date.now()
    writeJson(file(name, 'status.json'), st)
  }
  save()

  const transcript = fs.createWriteStream(file(name, 'transcript.md'), { flags: 'a' })
  const events = fs.createWriteStream(file(name, 'events.jsonl'), { flags: 'a' })
  const log = text => transcript.write(`${text}\n`)
  log(`\n# served ${new Date().toISOString()} · ${cwd}${model ? ` · ${model}` : ''}${SANDBOXED ? '' : ' · UNSANDBOXED: pi holds the real key'}`)

  // A .mjs stand-in (the tests' fake pi) runs through node: no exec bit needed.
  const [bin, pre] = /\.m?js$/.test(PI) ? [process.execPath, [PI]] : [PI, []]
  const pi = spawn(bin, [...pre, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  const stderr = fs.createWriteStream(file(name, 'stderr.log'), { flags: 'a' })
  pi.stderr.pipe(stderr)

  // O_RDWR keeps a writer open on our side, so the pipe never reports EOF
  // between two `send`s. Read through a socket (epoll), not a file stream: a
  // file stream's blocking read would hold a thread and keep us alive.
  const pipeFd = fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK)
  const pipeIn = new net.Socket({ fd: pipeFd, readable: true, writable: false })
  let ending = false
  const end = () => {
    if (ending) return
    ending = true
    pi.stdin.end()
    setTimeout(() => pi.kill('SIGTERM'), 10000).unref()
  }

  let finished = false
  onLines(pipeIn, line => {
    if (finished) return
    let cmd
    try {
      cmd = JSON.parse(line)
    } catch {
      return
    }
    if (!PIPE_TYPES.includes(cmd?.type)) {
      // A model or provider switch would get past the gate; only our own commands go to pi.
      log(`! refused a ${String(cmd?.type)} command: only prompts, answers, abort and stop reach pi. ${GATE_NOTE}`)
      return save()
    }
    if (cmd.type === '__stop') return end()
    if (cmd.type === 'prompt' && typeof cmd.messageFile === 'string') {
      // A long prompt send left in the inbox: only a plain file there.
      const at = file(name, `inbox/${path.basename(cmd.messageFile)}`)
      try {
        if (!fs.lstatSync(at).isFile()) throw new Error('not a file')
        cmd.message = fs.readFileSync(at, 'utf8')
      } catch (err) {
        log(`! could not read ${cmd.messageFile}: ${err.message}`)
        return
      } finally {
        fs.rmSync(at, { force: true })
      }
      delete cmd.messageFile
    }
    if (cmd.type === 'prompt') {
      st.promptSeq += 1
      st.prompts[cmd.id] = st.promptSeq
      if (cmd.format === 'findings') st.findingsSeq = st.promptSeq
      delete cmd.format
      const ids = Object.keys(st.prompts)
      if (ids.length > 50) delete st.prompts[ids[0]]
      log(`\n## you · ${cmd.id} · ${clock()}${cmd.streamingBehavior === 'steer' ? ' · steer' : ''}\n${cmd.message}`)
    }
    if (cmd.type === 'extension_ui_response') {
      // Back to what the session was doing when pi asked.
      st.state = st.dialog?.inRun === false ? 'idle' : 'busy'
      st.dialog = null
      log(`  answered ${cmd.id}`)
    }
    if (cmd.type === 'abort') log(`  abort requested · ${clock()}`)
    save()
    pi.stdin.write(`${JSON.stringify(cmd)}\n`)
  })

  const accept = (id, done) => {
    st.acceptedSeq = Math.max(st.acceptedSeq, st.prompts[id] ?? 0)
    if (done && st.state !== 'busy') st.settledSeq = st.acceptedSeq
  }

  let lastDeltaSave = 0
  onLines(pi.stdout, line => {
    if (finished) return
    events.write(`${line}\n`)
    let r
    try {
      r = JSON.parse(line)
    } catch {
      return
    }
    st.lastActivity = Date.now()
    switch (r.type) {
      case 'response':
        if (r.id === 'pi-session-state' && r.success) {
          const m = r.data?.model
          if (m) st.model = `${m.provider}/${m.id}`
          if (m?.provider !== model.split('/')[0]) {
            // pi chose another provider than the gate let through: end the session.
            st.error = `pi runs ${st.model ?? 'no model'}, not ${model.split('/')[0]}. ${GATE_NOTE}`
            log(`! ${st.error}`)
            end()
          }
          st.sessionFile = r.data?.sessionFile ?? null
          if (st.state === 'starting') st.state = r.data?.isStreaming ? 'busy' : 'idle'
        } else if (!r.success) {
          st.error = `${r.command}: ${r.error}`
          log(`! ${st.error}`)
          // A refused prompt starts no run: it is done now, or with the run
          // already going, so `wait` does not block on it.
          if (r.command === 'prompt') accept(r.id, true)
        } else if (r.command === 'prompt') {
          // pi has taken this prompt: the next agent_settled covers it.
          accept(r.id, r.data?.disposition === 'handled')
        }
        break
      case 'agent_start':
        st.state = 'busy'
        st.error = null
        st.runStartedAt = Date.now()
        break
      case 'turn_end':
        st.turns += 1
        break
      case 'message_end': {
        const msg = r.message
        if (msg?.role !== 'assistant') break
        const text = (Array.isArray(msg.content) ? msg.content : [])
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('\n')
          .trim()
        if (text) {
          st.lastReply = oneLine(text, 300)
          fs.writeFileSync(file(name, 'last-reply.md'), `${text}\n`)
          log(`\n## pi · ${clock()}\n${text}`)
        }
        if (msg.stopReason === 'error' || msg.errorMessage) {
          st.error = oneLine(msg.errorMessage ?? 'model error', 200)
          log(`! ${st.error}`)
        }
        break
      }
      case 'tool_execution_start':
        st.lastTool = `${r.toolName} ${argSummary(r.args)}`.trim()
        log(`→ ${st.lastTool}`)
        break
      case 'tool_execution_end':
        log(`  ${r.isError ? '✗' : '✓'} ${r.toolName}${r.durationMs != null ? ` ${r.durationMs}ms` : ''}`)
        break
      case 'extension_ui_request':
        if (DIALOGS.includes(r.method)) {
          // inRun: asked during a run, which pi's next settle ends; outside
          // one (an extension at startup) it stays until answered.
          const inRun = st.state === 'busy' || (st.state === 'waiting' && st.dialog?.inRun !== false)
          st.dialog = { id: r.id, method: r.method, title: r.title ?? r.message ?? '', options: r.options ?? null, inRun }
          st.state = 'waiting'
          log(`? ${r.method} ${r.id}: ${st.dialog.title}${r.options ? ` [${r.options.join(' | ')}]` : ''}`)
        }
        break
      case 'agent_settled':
        // A run's dialog ends with the run (aborted, or resolved by pi).
        if (st.dialog?.inRun !== false) st.dialog = null
        st.state = st.dialog ? 'waiting' : 'idle'
        // Only prompts pi had accepted before settling are done; one still in
        // flight starts a new run.
        st.settledSeq = st.acceptedSeq
        st.lastTool = null
        st.runStartedAt = null
        log(`· settled${r.aborted ? ' (aborted)' : ''} · ${clock()}`)
        break
      case 'message_update':
        // Streaming deltas: only keep the heartbeat and activity time fresh.
        if (Date.now() - lastDeltaSave < 2000) return
        lastDeltaSave = Date.now()
        break
    }
    save()
  })

  const beat = setInterval(save, HEARTBEAT_MS)
  pi.stdin.write(`${JSON.stringify({ id: 'pi-session-state', type: 'get_state' })}\n`)

  const finish = (state, code, why) => {
    if (finished) return
    finished = true
    clearInterval(beat)
    st.state = state
    st.exitCode = code
    st.dialog = null
    st.runStartedAt = null
    if (why) st.error = why
    save()
    log(`# ${state}${code != null ? ` (exit ${code})` : ''} · ${clock()}`)
    fs.rmSync(fifo, { force: true })
    pipeIn.destroy()
    transcript.end()
    events.end()
    process.exitCode = code ?? 1
  }
  pi.stdin.on('error', () => {})
  pi.on('error', err => finish('failed', 127, `could not start ${PI}: ${err.message}`))
  // 'close' comes after pi's last output has been read, unlike 'exit'.
  pi.on('close', (code, signal) => {
    if (ending && (code === 0 || signal === 'SIGTERM')) finish('stopped', code ?? 0)
    else finish('failed', code ?? 1, st.error ?? `pi exited (${signal ?? code}); see ${file(name, 'stderr.log')}`)
  })
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, end)
}

async function send(name, flags, rest) {
  if ('format' in flags && flags.format !== 'findings') fail(`--format takes findings${flags.format ? `, not ${flags.format}` : ''}.`)
  await needLive(name)
  let message = rest.join(' ')
  if (flags.file) message = fs.readFileSync(flags.file, 'utf8')
  else if (message === '-') message = fs.readFileSync(0, 'utf8')
  if (!message.trim()) fail('nothing to send.')
  if (flags.format) message += FINDINGS_NOTE
  const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  // Always says how to queue: pi refuses a plain prompt while it streams,
  // and our status can trail pi by a moment.
  const cmd = { id, type: 'prompt', message, streamingBehavior: flags.steer ? 'steer' : 'followUp', ...(flags.format ? { format: flags.format } : {}) }
  if (Buffer.byteLength(JSON.stringify(cmd)) + 1 > PIPE_LINE) {
    // Too long for one pipe write: serve reads it from the inbox instead.
    fs.mkdirSync(file(name, 'inbox'), { recursive: true })
    fs.writeFileSync(file(name, `inbox/${id}.md`), message)
    delete cmd.message
    cmd.messageFile = `${id}.md`
  }
  toPipe(name, cmd)
  process.stdout.write(`${id}\n`)
}

async function wait(name, id, flags) {
  if (id?.startsWith('--')) fail(`wait does not take ${id}.`)
  if ('out' in flags) {
    if (!flags.out) fail('--out names a file.')
    prepareOut(flags.out)
  }
  const deadline = flags.timeout ? Date.now() + Number(flags.timeout) * 1000 : Infinity
  for (;;) {
    const st = await settledStatus(name)
    if (!st) fail(`no session ${name}.`)
    const target = id ? st.prompts?.[id] : st.promptSeq
    if (id && target == null && isLive(st)) {
      // The prompt may still be in the pipe: give serve a moment.
    } else if (st.state === 'waiting' && st.dialog) {
      process.stdout.write(`pi asks (${st.dialog.method} ${st.dialog.id}): ${st.dialog.title}\n`)
      if (st.dialog.options) process.stdout.write(`options: ${st.dialog.options.join(' | ')}\n`)
      process.stdout.write(`Answer: pi-session answer ${name} ${st.dialog.id} <value>\n`)
      process.exit(3)
    } else if (st.settledSeq >= (target ?? 0) && st.state !== 'busy' && st.state !== 'starting') {
      let reply = lastReply(name)
      if (st.findingsSeq && st.findingsSeq === st.settledSeq) {
        // An error means the reply there is an older one, not the answer to this prompt.
        const checked = st.error ? { error: st.error } : checkFindings(reply)
        if (checked.error) noFindings(name, checked.error, BAD_FINDINGS)
        reply = `${JSON.stringify(checked.findings, null, 2)}\n`
      } else if (st.error) process.stdout.write(`error: ${st.error}\n`)
      if (flags.out) writeOut(flags.out, reply)
      else process.stdout.write(reply || '(no reply text)\n')
      process.exit(isLive(st) ? 0 : 1)
    } else if (!isLive(st)) {
      fail(`${name} ${shownState(st)} before settling${st.error ? `: ${st.error}` : ''}.`)
    }
    if (Date.now() > deadline) {
      if (flags.abort && isLive(st)) return abortAfterTimeout(name, flags)
      fail(`still ${st.state} after ${flags.timeout}s.`, 2)
    }
    await new Promise(r => setTimeout(r, 1000))
  }
}

// A capped wait: stop pi's run, then report what it had done by then.
async function abortAfterTimeout(name, flags) {
  toPipe(name, { id: `a${Date.now().toString(36)}`, type: 'abort' })
  const until = Date.now() + 15000
  let st = readStatus(name)
  while (isLive(st) && st.state === 'busy' && Date.now() < until) {
    await new Promise(r => setTimeout(r, 500))
    st = readStatus(name)
  }
  const settled = !isLive(st) || st.state !== 'busy'
  process.stderr.write(`pi-session: ${name} timed out after ${flags.timeout}s; ${settled ? 'its run was aborted' : 'abort sent, but it is still busy'}.\n`)
  // An unfinished run's reply is not its answer, even if an older one would pass the check.
  if (st?.findingsSeq && st.findingsSeq === st.acceptedSeq) noFindings(name, 'the run did not finish', 2)
  const reply = lastReply(name)
  if (reply && flags.out) writeOut(flags.out, reply)
  else if (reply) process.stdout.write(`last reply before the abort:\n${reply}`)
  process.exit(2)
}

function read(name, flags) {
  if (flags.last) {
    const p = file(name, 'last-reply.md')
    if (!fs.existsSync(p)) fail(`${name} has no reply yet.`)
    return process.stdout.write(fs.readFileSync(p, 'utf8'))
  }
  const p = file(name, 'transcript.md')
  if (!fs.existsSync(p)) fail(`no session ${name}.`)
  const lines = fs.readFileSync(p, 'utf8').split('\n')
  if (lines.at(-1) === '') lines.pop()
  const from = flags.since != null ? Math.max(0, Number(flags.since)) : Math.max(0, lines.length - Number(flags.tail ?? 40))
  process.stdout.write(lines.slice(from).join('\n') + '\n')
  process.stdout.write(`[next: --since ${lines.length}]\n`)
}

function status(name, flags) {
  const names = name ? [name] : fs.existsSync(ROOT) ? fs.readdirSync(ROOT).filter(n => NAME_RE.test(n)).sort() : []
  const rows = names.map(n => ({ ...(readStatus(n) ?? { name: n }), shown: shownState(readStatus(n)) }))
  if (flags.json) return process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
  if (!rows.length) return process.stdout.write(`No pi sessions in ${ROOT}.\n`)
  for (const r of rows) {
    process.stdout.write(`${r.name}  ${r.shown}  ${r.model ?? '-'}  ${r.cwd ?? '-'}  active ${ago(r.lastActivity)} ago${r.sandboxed === false ? '  UNSANDBOXED' : ''}\n`)
    const detail = r.dialog ? `asks (${r.dialog.method} ${r.dialog.id}): ${r.dialog.title}` : r.error ? `error: ${r.error}` : r.lastTool ? `→ ${r.lastTool}` : r.lastReply ? `last: ${r.lastReply}` : ''
    if (detail) process.stdout.write(`  ${oneLine(detail, 160)}\n`)
  }
}

async function answer(name, reqId, flags, rest) {
  const st = await needLive(name)
  if (!reqId) fail('name the request id.')
  const d = st.dialog
  if (!d || d.id !== reqId) fail(`${name} has no open dialog ${reqId}${d ? ` (open: ${d.id})` : ''}.`)
  const value = rest.join(' ')
  const res = { type: 'extension_ui_response', id: reqId }
  if (flags.cancel) res.cancelled = true
  else if (d.method === 'confirm') res.confirmed = /^(y|yes|true|1)$/i.test(value)
  else res.value = value
  toPipe(name, res)
  process.stdout.write('answered\n')
}

async function forget(name) {
  const st = await settledStatus(name)
  if (isLive(st)) fail(`${name} is running; stop it first.`)
  if (!fs.existsSync(dir(name))) fail(`no session ${name}.`)
  fs.rmSync(dir(name), { recursive: true, force: true })
  process.stdout.write(`forgot ${name}\n`)
}

const [cmd, ...argv] = process.argv.slice(2)
const { flags, rest, extra } = parse(argv, cmd)
switch (cmd) {
  case 'serve':
    await serve(needName(rest[0]), flags, extra)
    break
  case 'send':
    await send(needName(rest[0]), flags, rest.slice(1))
    break
  case 'wait':
    await wait(needName(rest[0]), rest[1], flags)
    break
  case 'read':
    read(needName(rest[0]), flags)
    break
  case 'status':
  case 'list':
    status(rest[0] ? needName(rest[0]) : undefined, flags)
    break
  case 'answer':
    await answer(needName(rest[0]), rest[1], flags, rest.slice(2))
    break
  case 'abort':
    await needLive(needName(rest[0]))
    toPipe(rest[0], { id: `a${Date.now().toString(36)}`, type: 'abort' })
    process.stdout.write('abort sent\n')
    break
  case 'stop':
    await needLive(needName(rest[0]))
    toPipe(rest[0], { type: '__stop' })
    process.stdout.write('stopping\n')
    break
  case 'forget':
    await forget(needName(rest[0]))
    break
  default:
    process.stdout.write(`${USAGE}\n`)
    process.exit(cmd && !['help', '--help', '-h'].includes(cmd) ? 1 : 0)
}
