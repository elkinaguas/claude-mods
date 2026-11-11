#!/usr/bin/env node
// A stand-in for `pi --mode rpc`: answers get_state, runs each prompt as one
// turn (a tool call, then "echo: <prompt>"), and opens a confirm dialog when
// the prompt says "ask", refuses a prompt that says "reject", and works for
// ten minutes (until aborted) on one that says "slow" ("stream": after
// streaming part of a reply). Replies stream in as message_update deltas. One holding reply=<url-encoded text> gets
// that text as its reply. "nag" asks again each time it hears no; "nag=<n>" asks n times, then replies. Enough of pi's protocol to test pi-session.

const out = r => process.stdout.write(`${JSON.stringify(r)}\n`)
// What the read tool "gives back": file contents, which the live tail must never show.
const TOOL_OUTPUT = 'TOOL-OUTPUT: the file holds secret=hunter2'
// --list-models: a table laid out as pi's own (columns padded to the widest
// cell, two spaces apart, sorted by provider then id), then exit.
if (process.argv.includes('--list-models')) {
  const rows = [
    ['provider', 'model', 'context', 'max-out', 'thinking', 'images'],
    ['anthropic', 'claude-sonnet-4-5', '200K', '64K', 'yes', 'yes'],
    ['corp', 'm', '128K', '16K', 'no', 'no'],
    ['opencode-go', 'glm-5', '200K', '128K', 'yes', 'no'],
    ['opencode-go', 'kimi-k2.5', '256K', '64K', 'yes', 'yes'],
  ]
  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => r[i].length)))
  for (const r of rows) process.stdout.write(`${r.map((c, i) => c.padEnd(widths[i])).join('  ')}\n`)
  process.exit(0)
}
// What serve passed, for the tests to check (stderr goes to the session's stderr.log).
process.stderr.write(`fake-pi args: ${process.argv.slice(2).join(' ')}\n`)
let busy = false
let pendingDialog = null
let slow = null
let nags = 0
let nagging = null
const queue = []
// FAKE_PI_STARTUP_DIALOG: an extension asks as pi starts. FAKE_PI_STATE: get_state fails ("fail") or gets no reply ("silent").
if (process.env.FAKE_PI_STARTUP_DIALOG) out({ type: 'extension_ui_request', id: 's1', method: 'confirm', title: process.env.FAKE_PI_STARTUP_DIALOG })

const run = msg => {
  busy = true
  out({ type: 'agent_start' })
  out({ type: 'turn_start' })
  out({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'README.md' } })
  // What the tool gave back: never shown in the live tail.
  out({ type: 'tool_execution_update', toolCallId: 't1', toolName: 'read', partialResult: { content: [{ type: 'text', text: TOOL_OUTPUT }] } })
  out({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'read', isError: false, durationMs: 3, result: { content: [{ type: 'text', text: TOOL_OUTPUT }] } })
  if (/\bstream\b/.test(msg)) {
    // Streams part of a reply as bare text deltas, then works until aborted.
    for (const delta of ['Reading the', ' code now.\nNext I will', ' run the tests'])
      out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta } })
    slow = setTimeout(() => finish(msg), 600000)
    return
  }
  // "flood": a reply in 400 tiny deltas at once, as a fast model streams.
  if (/\bflood\b/.test(msg)) for (let i = 0; i < 400; i++) out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x' } })
  if (/\bslow\b/.test(msg)) {
    out({ type: 'tool_execution_start', toolCallId: 't2', toolName: 'bash', args: { command: 'npm test -- --watch' } })
    slow = setTimeout(() => finish(msg), 600000)
    return
  }
  if (/\bsilent\b/.test(msg)) {
    // A run that ends with no reply text.
    out({ type: 'turn_end', message: {}, toolResults: [] })
    out({ type: 'agent_end', messages: [], willRetry: false })
    busy = false
    out({ type: 'agent_settled', aborted: false })
    return
  }
  const nag = /\bnag(?:=(\d+))?\b/.exec(msg)
  if (nag) {
    // An extension that asks again each time it hears no.
    nags = 0
    nagging = { msg, times: nag[1] ? Number(nag[1]) : Infinity }
    out({ type: 'extension_ui_request', id: 'n0', method: 'input', title: 'Your name?' })
    return
  }
  if (/\bask\b/.test(msg)) {
    pendingDialog = { id: 'd1', msg }
    out({ type: 'extension_ui_request', id: 'd1', method: 'confirm', title: 'Proceed?' })
    return
  }
  finish(msg)
}
const finish = (msg, extra = '') => {
  const scripted = /\breply=(\S+)/.exec(msg)
  const text = scripted ? decodeURIComponent(scripted[1]) : `echo: ${msg}${extra}`
  const message = { role: 'assistant', content: [{ type: 'text', text }] }
  // pi's Usage shape (packages/ai). "nousage": a provider that reports none; "free": no prices for the model.
  if (!/\bnousage\b/.test(msg)) {
    const free = /\bfree\b/.test(msg)
    message.usage = {
      input: 1200,
      output: 300,
      cacheRead: 8000,
      cacheWrite: 500,
      totalTokens: 10000,
      cost: free ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } : { input: 0.0012, output: 0.0012, cacheRead: 0.0008, cacheWrite: 0.001, total: 0.0042 },
    }
  }
  // The reply streams in, as pi sends it: each update carries the partial message so far.
  for (let at = 0; at < text.length; at += Math.ceil(text.length / 3) || 1) {
    const partial = text.slice(0, at + (Math.ceil(text.length / 3) || 1))
    out({
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'thinking it over' }, { type: 'text', text: partial }] },
      assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: partial.slice(at) },
    })
  }
  // A tool result can carry usage too (a subagent's); pi-session counts only assistant messages.
  out({ type: 'message_end', message: { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: TOOL_OUTPUT }], usage: { input: 99999, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 99999, cost: { total: 9 } } } })
  out({ type: 'message_end', message })
  out({ type: 'turn_end', message: {}, toolResults: [] })
  out({ type: 'agent_end', messages: [], willRetry: false })
  if (queue.length) return run(queue.shift())
  busy = false
  out({ type: 'agent_settled', aborted: false })
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const cmd = JSON.parse(buf.slice(0, i))
    buf = buf.slice(i + 1)
    // Replies to what was asked, not to pi-session's note on a first prompt.
    if (typeof cmd.message === 'string') cmd.message = cmd.message.split('\n\n[Session note:')[0]
    if (cmd.type === 'get_state' && process.env.FAKE_PI_STATE === 'silent') {
      // No reply.
    } else if (cmd.type === 'get_state' && process.env.FAKE_PI_STATE === 'fail') {
      out({ id: cmd.id, type: 'response', command: 'get_state', success: false, error: 'bad config' })
    } else if (cmd.type === 'extension_ui_response' && /^n\d+$/.test(cmd.id)) {
      nags += 1
      if (nags >= nagging.times) finish(nagging.msg)
      else out({ type: 'extension_ui_request', id: `n${nags}`, method: 'input', title: 'Your name?' })
    } else if (cmd.type === 'get_state') {
      out({ id: cmd.id, type: 'response', command: 'get_state', success: true, data: { model: { provider: process.env.FAKE_PI_PROVIDER || 'opencode-go', id: 'echo' }, sessionFile: 'FAKE_PI_SESSION_FILE' in process.env ? process.env.FAKE_PI_SESSION_FILE || null : '/tmp/fake.jsonl', isStreaming: false } })
    } else if (cmd.type === 'prompt' && /\breject\b/.test(cmd.message)) {
      out({ id: cmd.id, type: 'response', command: 'prompt', success: false, error: 'no model selected' })
    } else if (cmd.type === 'prompt') {
      out({ id: cmd.id, type: 'response', command: 'prompt', success: true, data: { disposition: busy ? 'queued' : 'started' } })
      if (busy) queue.push(cmd.message)
      else {
        busy = true
        setTimeout(() => run(cmd.message), 50)
      }
    } else if (cmd.type === 'extension_ui_response' && pendingDialog?.id === cmd.id) {
      const { msg } = pendingDialog
      pendingDialog = null
      finish(msg, cmd.confirmed ? ' (confirmed)' : ' (declined)')
    } else if (cmd.type === 'abort') {
      out({ id: cmd.id, type: 'response', command: 'abort', success: true })
      if (slow || pendingDialog) {
        clearTimeout(slow)
        slow = null
        pendingDialog = null
        queue.length = 0
        busy = false
        out({ type: 'agent_end', messages: [], willRetry: false })
        out({ type: 'agent_settled', aborted: true })
      }
    }
  }
})
process.stdin.on('end', () => process.exit(0))
