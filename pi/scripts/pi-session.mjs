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
const DIALOGS = ['select', 'confirm', 'input', 'editor']
// Claude Code's Bash sandbox sets this in every command it wraps. Outside it,
// pi would read the real provider key from ~/.pi/agent/auth.json.
const SANDBOXED = !!process.env.SANDBOX_RUNTIME

const USAGE = `pi-session: long-lived pi sessions for Claude Code

  serve <name> [--cwd DIR] [--model PROVIDER/ID] [--thinking LEVEL] [--allow-unsandboxed] [-- PI_ARGS...]
      Run pi for this session until stopped. Run it in the background.
      Serving a stopped session again reopens its conversation. Refused
      outside Claude Code's sandbox unless --allow-unsandboxed (pi then reads
      your real key; the pi mod allows the flag only when you enable it).
  send <name> [--steer] <prompt...> | --file FILE | -
      Send a prompt. Prints its id. While pi works it is queued as a
      follow-up, or with --steer delivered before pi's next model call.
  wait <name> [ID] [--timeout SECONDS [--abort]]
      Block until pi has settled (after prompt ID, or everything sent so far),
      then print its last reply. Exit 3 when pi waits on a dialog, 2 on
      timeout; with --abort a timeout also stops pi's run.
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
const needLive = name => {
  const st = readStatus(name)
  if (!isLive(st)) fail(`${name} is not running (${shownState(st)}). Start it in the background: pi-session serve ${name}`)
  return st
}

// Writes one command to a running serve's pipe. Non-blocking open fails at
// once (ENXIO) when nothing reads the pipe, instead of hanging.
const toPipe = (name, cmd) => {
  let fd
  try {
    fd = fs.openSync(file(name, 'in.fifo'), fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
  } catch (err) {
    fail(`${name} is not listening (${err.code}). Serve it again.`)
  }
  fs.writeSync(fd, `${JSON.stringify(cmd)}\n`)
  fs.closeSync(fd)
}

const parse = argv => {
  const flags = {}
  const rest = []
  const extra = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      extra.push(...argv.slice(i + 1))
      break
    }
    if (/^--(cwd|model|thinking|timeout|tail|since|file)$/.test(a)) flags[a.slice(2)] = argv[++i]
    else if (/^--(steer|last|json|cancel|abort|allow-unsandboxed)$/.test(a)) flags[a.slice(2)] = true
    else rest.push(a)
  }
  return { flags, rest, extra }
}

// Tool arguments in one short line: the path, command or pattern when there is one.
const argSummary = args => {
  if (!args || typeof args !== 'object') return ''
  const key = ['path', 'file_path', 'command', 'pattern', 'url', 'query'].find(k => typeof args[k] === 'string')
  return oneLine(key ? args[key] : JSON.stringify(args), 90)
}

function serve(name, flags, extra) {
  if (!SANDBOXED && !flags['allow-unsandboxed'])
    fail(`not inside Claude Code's Bash sandbox, so pi would read your real provider key. Run it from Claude's Bash tool with the sandbox on.`)
  fs.mkdirSync(dir(name), { recursive: true })
  const before = readStatus(name)
  if (isLive(before)) fail(`${name} is already running.`)
  const meta = readJson(file(name, 'meta.json'), {})
  const cwd = path.resolve(flags.cwd ?? meta.cwd ?? process.cwd())
  const model = flags.model ?? meta.model
  const thinking = flags.thinking ?? meta.thinking
  // pi's own session id: reopened (not recreated) when the session is served again.
  const sessionId = meta.sessionId ?? `claude-${name}`
  writeJson(file(name, 'meta.json'), { name, cwd, model, thinking, sessionId, createdAt: meta.createdAt ?? Date.now() })

  const fifo = file(name, 'in.fifo')
  fs.rmSync(fifo, { force: true })
  const made = spawnSync('mkfifo', ['-m', '600', fifo])
  if (made.status !== 0) fail(`mkfifo failed: ${String(made.stderr || made.error)}`)

  const args = ['--mode', 'rpc', '--session-id', sessionId]
  if (model) args.push('--model', model)
  if (thinking) args.push('--thinking', thinking)
  args.push(...extra)

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
    heartbeatAt: Date.now(),
    promptSeq: before?.promptSeq ?? 0,
    acceptedSeq: before?.promptSeq ?? 0,
    settledSeq: before?.promptSeq ?? 0,
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

  onLines(pipeIn, line => {
    let cmd
    try {
      cmd = JSON.parse(line)
    } catch {
      return
    }
    if (cmd.type === '__stop') return end()
    if (cmd.type === 'prompt') {
      st.promptSeq += 1
      st.prompts[cmd.id] = st.promptSeq
      const ids = Object.keys(st.prompts)
      if (ids.length > 50) delete st.prompts[ids[0]]
      log(`\n## you · ${cmd.id} · ${clock()}${cmd.streamingBehavior === 'steer' ? ' · steer' : ''}\n${cmd.message}`)
    }
    if (cmd.type === 'extension_ui_response') {
      st.dialog = null
      st.state = 'busy'
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
          st.dialog = { id: r.id, method: r.method, title: r.title ?? r.message ?? '', options: r.options ?? null }
          st.state = 'waiting'
          log(`? ${r.method} ${r.id}: ${st.dialog.title}${r.options ? ` [${r.options.join(' | ')}]` : ''}`)
        }
        break
      case 'agent_settled':
        st.state = st.dialog ? 'waiting' : 'idle'
        // Only prompts pi had accepted before settling are done; one still in
        // flight starts a new run.
        st.settledSeq = st.acceptedSeq
        st.lastTool = null
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
    clearInterval(beat)
    st.state = state
    st.exitCode = code
    st.dialog = null
    if (why) st.error = why
    save()
    log(`# ${state}${code != null ? ` (exit ${code})` : ''} · ${clock()}`)
    fs.rmSync(fifo, { force: true })
    pipeIn.destroy()
    transcript.end()
    events.end()
    process.exitCode = code ?? 1
  }
  pi.on('error', err => finish('failed', 127, `could not start ${PI}: ${err.message}`))
  pi.on('exit', (code, signal) => {
    if (ending && (code === 0 || signal === 'SIGTERM')) finish('stopped', code ?? 0)
    else finish('failed', code ?? 1, st.error ?? `pi exited (${signal ?? code}); see ${file(name, 'stderr.log')}`)
  })
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, end)
}

function send(name, flags, rest) {
  needLive(name)
  let message = rest.join(' ')
  if (flags.file) message = fs.readFileSync(flags.file, 'utf8')
  else if (message === '-') message = fs.readFileSync(0, 'utf8')
  if (!message.trim()) fail('nothing to send.')
  const id = `p${Date.now().toString(36)}`
  // Always says how to queue: pi refuses a plain prompt while it streams,
  // and our status can trail pi by a moment.
  toPipe(name, { id, type: 'prompt', message, streamingBehavior: flags.steer ? 'steer' : 'followUp' })
  process.stdout.write(`${id}\n`)
}

async function wait(name, id, flags) {
  const deadline = flags.timeout ? Date.now() + Number(flags.timeout) * 1000 : Infinity
  for (;;) {
    const st = readStatus(name)
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
      const reply = fs.existsSync(file(name, 'last-reply.md')) ? fs.readFileSync(file(name, 'last-reply.md'), 'utf8') : ''
      if (st.error) process.stdout.write(`error: ${st.error}\n`)
      process.stdout.write(reply || '(no reply text)\n')
      process.exit(isLive(st) ? 0 : 1)
    } else if (!isLive(st)) {
      fail(`${name} ${shownState(st)} before settling${st.error ? `: ${st.error}` : ''}.`)
    }
    if (Date.now() > deadline) {
      if (flags.abort && isLive(st)) return abortAfterTimeout(name, flags.timeout)
      fail(`still ${st.state} after ${flags.timeout}s.`, 2)
    }
    await new Promise(r => setTimeout(r, 1000))
  }
}

// A capped wait: stop pi's run, then report what it had done by then.
async function abortAfterTimeout(name, timeout) {
  toPipe(name, { id: `a${Date.now().toString(36)}`, type: 'abort' })
  const until = Date.now() + 15000
  let st = readStatus(name)
  while (isLive(st) && st.state === 'busy' && Date.now() < until) {
    await new Promise(r => setTimeout(r, 500))
    st = readStatus(name)
  }
  const settled = !isLive(st) || st.state !== 'busy'
  process.stderr.write(`pi-session: ${name} timed out after ${timeout}s; ${settled ? 'its run was aborted' : 'abort sent, but it is still busy'}.\n`)
  const reply = fs.existsSync(file(name, 'last-reply.md')) ? fs.readFileSync(file(name, 'last-reply.md'), 'utf8') : ''
  if (reply) process.stdout.write(`last reply before the abort:\n${reply}`)
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

function answer(name, reqId, flags, rest) {
  const st = needLive(name)
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

function forget(name) {
  const st = readStatus(name)
  if (isLive(st)) fail(`${name} is running; stop it first.`)
  if (!fs.existsSync(dir(name))) fail(`no session ${name}.`)
  fs.rmSync(dir(name), { recursive: true, force: true })
  process.stdout.write(`forgot ${name}\n`)
}

const [cmd, ...argv] = process.argv.slice(2)
const { flags, rest, extra } = parse(argv)
switch (cmd) {
  case 'serve':
    serve(needName(rest[0]), flags, extra)
    break
  case 'send':
    send(needName(rest[0]), flags, rest.slice(1))
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
    answer(needName(rest[0]), rest[1], flags, rest.slice(2))
    break
  case 'abort':
    needLive(needName(rest[0]))
    toPipe(rest[0], { id: `a${Date.now().toString(36)}`, type: 'abort' })
    process.stdout.write('abort sent\n')
    break
  case 'stop':
    needLive(needName(rest[0]))
    toPipe(rest[0], { type: '__stop' })
    process.stdout.write('stopping\n')
    break
  case 'forget':
    forget(needName(rest[0]))
    break
  default:
    process.stdout.write(`${USAGE}\n`)
    process.exit(cmd && !['help', '--help', '-h'].includes(cmd) ? 1 : 0)
}
