#!/usr/bin/env node
// A stand-in for `pi --mode rpc`: answers get_state, runs each prompt as one
// turn (a tool call, then "echo: <prompt>"), and opens a confirm dialog when
// the prompt says "ask", refuses a prompt that says "reject", and works for
// ten minutes (until aborted) on one that says "slow". One holding reply=<url-encoded text> gets
// that text as its reply. Enough of pi's protocol to test pi-session.

const out = r => process.stdout.write(`${JSON.stringify(r)}\n`)
let busy = false
let pendingDialog = null
let slow = null
let nags = 0
const queue = []
// FAKE_PI_STARTUP_DIALOG: an extension asks as pi starts. FAKE_PI_STATE: get_state fails ("fail") or gets no reply ("silent").
if (process.env.FAKE_PI_STARTUP_DIALOG) out({ type: 'extension_ui_request', id: 's1', method: 'confirm', title: process.env.FAKE_PI_STARTUP_DIALOG })

const run = msg => {
  busy = true
  out({ type: 'agent_start' })
  out({ type: 'turn_start' })
  out({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'README.md' } })
  out({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'read', isError: false, durationMs: 3 })
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
  if (/\bnag\b/.test(msg)) {
    // An extension that asks again each time it hears no.
    nags = 0
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
  out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } })
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
      out({ type: 'extension_ui_request', id: `n${nags}`, method: 'input', title: 'Your name?' })
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
