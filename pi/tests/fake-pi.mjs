#!/usr/bin/env node
// A stand-in for `pi --mode rpc`: answers get_state, runs each prompt as one
// turn (a tool call, then "echo: <prompt>"), and opens a confirm dialog when
// the prompt says "ask", refuses a prompt that says "reject", and works for
// ten minutes (until aborted) on one that says "slow". Enough of pi's protocol to test pi-session.

const out = r => process.stdout.write(`${JSON.stringify(r)}\n`)
let busy = false
let pendingDialog = null
let slow = null
const queue = []

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
  if (/\bask\b/.test(msg)) {
    pendingDialog = { id: 'd1', msg }
    out({ type: 'extension_ui_request', id: 'd1', method: 'confirm', title: 'Proceed?' })
    return
  }
  finish(msg)
}
const finish = (msg, extra = '') => {
  out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: `echo: ${msg}${extra}` }] } })
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
    if (cmd.type === 'get_state') {
      out({ id: cmd.id, type: 'response', command: 'get_state', success: true, data: { model: { provider: 'fake', id: 'echo' }, sessionFile: '/tmp/fake.jsonl', isStreaming: false } })
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
