// pi-session against a fake pi: node --test pi/tests/
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(here, '..', 'scripts', 'pi-session.mjs')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-'))
// As inside Claude Code's sandbox, whether or not the tests run in one.
// A home of its own whose pi login is an opencode-go API key alone, as the gate needs.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-home-'))
const authFile = path.join(home, '.pi', 'agent', 'auth.json')
const goodAuth = JSON.stringify({ 'opencode-go': { type: 'api_key', key: 'placeholder' } })
fs.mkdirSync(path.dirname(authFile), { recursive: true })
fs.writeFileSync(authFile, goodAuth)
const env = { ...process.env, HOME: home, SANDBOX_RUNTIME: '1', PI_SESSIONS_DIR: root, PI_SESSION_PI: path.join(here, 'fake-pi.mjs') }
const { SANDBOX_RUNTIME: _, ...bareEnv } = env
const cli = (...args) => execFileSync('node', [SCRIPT, ...args], { env, encoding: 'utf8' })
const cliFails = (...args) => {
  try {
    cli(...args)
  } catch (err) {
    return { code: err.status, out: `${err.stdout}${err.stderr}` }
  }
  assert.fail(`pi-session ${args.join(' ')} should have failed`)
}
const status = name => JSON.parse(fs.readFileSync(path.join(root, name, 'status.json'), 'utf8'))
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) assert.fail('timed out')
    await new Promise(r => setTimeout(r, 50))
  }
}

let server
const serve = async name => {
  const child = spawn('node', [SCRIPT, 'serve', name, '--cwd', root, '--model', 'opencode-go/echo'], { env, stdio: 'ignore' })
  await until(() => fs.existsSync(path.join(root, name, 'status.json')) && status(name).state === 'idle')
  return child
}

before(async () => {
  server = await serve('alpha')
})
after(() => {
  server?.kill()
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
})

test('serve reports the model pi chose and goes idle', () => {
  const st = status('alpha')
  assert.equal(st.model, 'opencode-go/echo')
  assert.match(st.sessionId, /^claude-alpha-[0-9a-z]+$/)
  assert.equal(st.cwd, root)
})

test('send then wait prints the reply', () => {
  const id = cli('send', 'alpha', 'hello', 'there').trim()
  assert.match(id, /^p[0-9a-z]+$/)
  assert.equal(cli('wait', 'alpha', id, '--timeout', '5'), 'echo: hello there\n')
  assert.equal(cli('read', 'alpha', '--last'), 'echo: hello there\n')
})

test('a prompt sent while pi works is queued and both get answered', () => {
  const a = cli('send', 'alpha', 'first').trim()
  const b = cli('send', 'alpha', 'second').trim()
  assert.equal(cli('wait', 'alpha', b, '--timeout', '5'), 'echo: second\n')
  const transcript = cli('read', 'alpha', '--tail', '100')
  assert.match(transcript, new RegExp(`## you · ${a}`))
  assert.match(transcript, /echo: first/)
  assert.match(transcript, /→ read README\.md/)
})

test('a dialog makes wait exit 3, and answer resumes the run', () => {
  const id = cli('send', 'alpha', 'please ask me').trim()
  const asked = cliFails('wait', 'alpha', id, '--timeout', '5')
  assert.equal(asked.code, 3)
  assert.match(asked.out, /confirm d1\): Proceed\?/)
  assert.equal(status('alpha').state, 'waiting')
  cli('answer', 'alpha', 'd1', 'yes')
  assert.equal(cli('wait', 'alpha', id, '--timeout', '5'), 'echo: please ask me (confirmed)\n')
})

test('a prompt pi refuses ends wait with the error instead of hanging', () => {
  const id = cli('send', 'alpha', 'please reject this').trim()
  assert.match(cli('wait', 'alpha', id, '--timeout', '5'), /^error: prompt: no model selected\n/)
  assert.equal(status('alpha').state, 'idle')
})

test('a wait that times out with --abort stops the run', () => {
  const id = cli('send', 'alpha', 'slow: a long job').trim()
  const timedOut = cliFails('wait', 'alpha', id, '--timeout', '1', '--abort')
  assert.equal(timedOut.code, 2)
  assert.match(timedOut.out, /timed out after 1s; its run was aborted/)
  assert.equal(status('alpha').state, 'idle')
  assert.match(cli('read', 'alpha', '--tail', '5'), /settled \(aborted\)/)
})

test('a run records its start from agent_start, kept while pi asks, cleared when it settles', async () => {
  assert.equal(status('alpha').runStartedAt, null)
  const before = Date.now()
  const id = cli('send', 'alpha', 'please ask me').trim()
  await until(() => status('alpha').state === 'waiting')
  const started = status('alpha').runStartedAt
  assert.equal(typeof started, 'number')
  assert.ok(started >= before && started <= Date.now())
  cli('answer', 'alpha', 'd1', 'yes')
  cli('wait', 'alpha', id, '--timeout', '5')
  assert.equal(status('alpha').state, 'idle')
  assert.equal(status('alpha').runStartedAt, null)

  const slow = cli('send', 'alpha', 'slow: a long job').trim()
  await until(() => status('alpha').state === 'busy')
  const running = status('alpha').runStartedAt
  assert.ok(running >= started)
  // Pi's later events move lastActivity, not the run's start.
  await until(() => status('alpha').lastTool?.startsWith('bash'))
  assert.equal(status('alpha').runStartedAt, running)
  cliFails('wait', 'alpha', slow, '--timeout', '1', '--abort')
  assert.equal(status('alpha').runStartedAt, null)
})

test('serve refuses to run outside the sandbox unless allowed, and marks such a session', async () => {
  let out = ''
  try {
    execFileSync('node', [SCRIPT, 'serve', 'bare', '--cwd', root, '--model', 'opencode-go/echo'], { env: bareEnv, encoding: 'utf8', stdio: 'pipe' })
  } catch (err) {
    out = `${err.stderr}`
    assert.equal(err.status, 1)
  }
  assert.match(out, /not inside Claude Code's Bash sandbox/)
  assert.ok(!fs.existsSync(path.join(root, 'bare')))
  const child = spawn('node', [SCRIPT, 'serve', 'bare', '--cwd', root, '--model', 'opencode-go/echo', '--allow-unsandboxed'], { env: bareEnv, stdio: 'ignore' })
  await until(() => fs.existsSync(path.join(root, 'bare', 'status.json')) && status('bare').state === 'idle')
  assert.equal(status('bare').sandboxed, false)
  assert.equal(status('alpha').sandboxed, true)
  assert.match(cli('status', 'bare'), /UNSANDBOXED/)
  cli('stop', 'bare')
  await until(() => status('bare').state === 'stopped')
  child.kill()
  cli('forget', 'bare')
})

test('stop and abort never write through a planted link or to a plain file', () => {
  // A session that looks live, as a sandboxed process could fake one.
  const fake = path.join(root, 'planted')
  fs.mkdirSync(fake)
  fs.writeFileSync(path.join(fake, 'status.json'), JSON.stringify({ name: 'planted', state: 'idle', heartbeatAt: Date.now() + 3600000 }))
  const victim = path.join(root, 'victim.json')
  fs.writeFileSync(victim, '{ "keep": true }\n')
  fs.symlinkSync(victim, path.join(fake, 'in.fifo'))
  assert.match(cliFails('stop', 'planted').out, /is a link, not planted's pipe/)
  assert.match(cliFails('abort', 'planted').out, /is a link/)
  fs.rmSync(path.join(fake, 'in.fifo'))
  fs.writeFileSync(path.join(fake, 'in.fifo'), '')
  assert.match(cliFails('stop', 'planted').out, /is not a pipe/)
  assert.equal(fs.readFileSync(victim, 'utf8'), '{ "keep": true }\n')
  assert.equal(fs.readFileSync(path.join(fake, 'in.fifo'), 'utf8'), '')
  // A session folder that is itself a link is refused too.
  fs.rmSync(fake, { recursive: true })
  fs.mkdirSync(path.join(root, 'elsewhere'))
  fs.writeFileSync(path.join(root, 'elsewhere', 'status.json'), JSON.stringify({ name: 'planted', state: 'idle', heartbeatAt: Date.now() + 3600000 }))
  fs.symlinkSync(path.join(root, 'elsewhere'), fake)
  assert.match(cliFails('stop', 'planted').out, /is not a folder/)
  fs.rmSync(fake)
  fs.rmSync(path.join(root, 'elsewhere'), { recursive: true })
  fs.rmSync(victim)
})

test('a prompt too long for one pipe write arrives whole, through the inbox', () => {
  const long = `start ${'x'.repeat(100000)} end`
  const big = path.join(root, 'big.md')
  fs.writeFileSync(big, long)
  const id = cli('send', 'alpha', '--file', big).trim()
  assert.equal(cli('wait', 'alpha', id, '--timeout', '10'), `echo: ${long}\n`)
  assert.deepEqual(fs.readdirSync(path.join(root, 'alpha', 'inbox')), [])
  // The next command still gets through.
  const after = cli('send', 'alpha', 'after').trim()
  assert.equal(cli('wait', 'alpha', after, '--timeout', '5'), 'echo: after\n')
})

test('aborting while pi asks ends the dialog, and the session goes idle', () => {
  const id = cli('send', 'alpha', 'please ask again').trim()
  assert.equal(cliFails('wait', 'alpha', id, '--timeout', '5').code, 3)
  cli('abort', 'alpha')
  const out = cli('wait', 'alpha', id, '--timeout', '5')
  assert.ok(!/pi asks/.test(out))
  assert.equal(status('alpha').state, 'idle')
  assert.equal(status('alpha').dialog, null)
})

test('a live session whose heartbeat only looks stale (after sleep) is not taken for gone', () => {
  const file = path.join(root, 'alpha', 'status.json')
  fs.writeFileSync(file, JSON.stringify({ ...status('alpha'), heartbeatAt: Date.now() - 60000 }))
  // forget reads it again after a beat: serve has written a fresh one by then.
  assert.match(cliFails('forget', 'alpha').out, /running; stop it first/)
})

test('the gate: serve runs pi only on opencode-go, with its API key the only login', async () => {
  const refused = (args, auth = goodAuth) => {
    fs.writeFileSync(authFile, auth)
    try {
      return cliFails('serve', 'gated', '--cwd', root, ...args).out
    } finally {
      fs.writeFileSync(authFile, goodAuth)
    }
  }
  assert.match(refused([]), /name the model: --model opencode-go\/<id>/)
  assert.match(refused([]), /only with an opencode-go API key/)
  assert.match(refused(['--model', 'anthropic/claude-x']), /is not an opencode-go model/)
  assert.match(refused(['--model', 'opencode-go/echo', '--', '--provider', 'anthropic']), /extra pi arguments .* are off/)
  assert.match(refused(['--model', 'opencode-go/echo'], JSON.stringify({ 'opencode-go': { type: 'oauth', refresh: 'r' } })), /no opencode-go API key \(its login is oauth\)/)
  assert.match(
    refused(['--model', 'opencode-go/echo'], JSON.stringify({ 'opencode-go': { type: 'api_key', key: 'k' }, anthropic: { type: 'oauth', refresh: 'r' } })),
    /also holds anthropic/,
  )
  assert.match(refused(['--model', 'opencode-go/echo'], '{'), /could not read/)
  fs.rmSync(path.join(root, 'gated'), { recursive: true, force: true })
  // pi picking another provider after all ends the session.
  const child = spawn('node', [SCRIPT, 'serve', 'other', '--cwd', root, '--model', 'opencode-go/echo'], { env: { ...env, FAKE_PI_PROVIDER: 'anthropic' }, stdio: 'ignore' })
  await until(() => fs.existsSync(path.join(root, 'other', 'status.json')) && ['stopped', 'failed'].includes(status('other').state))
  assert.match(status('other').error, /pi runs anthropic\/echo, not opencode-go/)
  child.kill()
  cli('forget', 'other')
})

test('a model at a trusted host: host and port matched exactly, models.json and auth.json kept clean', async () => {
  const modelsFile = path.join(home, '.pi', 'agent', 'models.json')
  const corp = (baseUrl, more = {}) => JSON.stringify({ providers: { corp: { baseUrl, apiKey: 'dummy', models: [{ id: 'm' }] }, ...more } })
  // With an opencode-go login still in auth.json, a config whose hosts pass
  // stops at the auth.json rule; one whose hosts fail stops before it.
  const outcome = (models, hosts, model = 'corp/m') => {
    fs.writeFileSync(modelsFile, models)
    try {
      return cliFails('serve', 'corp', '--cwd', root, '--model', model, ...(hosts ? ['--trusted-hosts', hosts] : [])).out
    } finally {
      fs.rmSync(modelsFile, { force: true })
    }
  }
  const passes = /holds opencode-go\. A model at a trusted host runs only while auth\.json holds no login/
  const fails = /defines corp with no base URL at a trusted host/
  // Host alone: the scheme's default port only.
  assert.match(outcome(corp('https://llm.corp.example.com/v1'), 'llm.corp.example.com'), passes)
  assert.match(outcome(corp('https://llm.corp.example.com:443/v1'), 'llm.corp.example.com'), passes)
  assert.match(outcome(corp('https://llm.corp.example.com:8443/v1'), 'llm.corp.example.com'), fails)
  assert.match(outcome(corp('http://llm.corp.example.com/v1'), 'llm.corp.example.com'), passes)
  // An explicit port, or any port.
  assert.match(outcome(corp('https://llm.corp.example.com:8443/v1'), 'llm.corp.example.com:8443'), passes)
  assert.match(outcome(corp('https://llm.corp.example.com:9000/v1'), 'llm.corp.example.com:8443'), fails)
  assert.match(outcome(corp('http://localhost:11434/v1'), 'localhost:*'), passes)
  // *. covers subdomains, not the domain itself; other hosts never pass.
  assert.match(outcome(corp('https://llm.corp.example.com/v1'), '*.corp.example.com'), passes)
  assert.match(outcome(corp('https://corp.example.com/v1'), '*.corp.example.com'), fails)
  assert.match(outcome(corp('https://llm.corp.example.com.evil.io/v1'), 'llm.corp.example.com'), fails)
  // Every provider in models.json must be at a trusted host, in either mode.
  assert.match(outcome(corp('https://llm.corp.example.com/v1', { openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk' } }), 'llm.corp.example.com'), /defines openai with no base URL/)
  assert.match(outcome(corp('https://llm.corp.example.com/v1'), null, 'opencode-go/echo'), fails)
  // No trusted hosts: only opencode-go.
  assert.match(outcome('{}', null), /is not an opencode-go model/)
  assert.match(outcome(corp('https://llm.corp.example.com/v1'), 'llm.corp.example.com', 'other/m'), /other is not defined in .*models\.json/)
  assert.match(outcome('{}', 'not a host!'), /not a host, host:port or host:\*/)
  fs.rmSync(path.join(root, 'corp'), { recursive: true, force: true })

  // With auth.json empty it serves, on the trusted provider.
  fs.writeFileSync(modelsFile, corp('https://llm.corp.example.com/v1'))
  fs.writeFileSync(authFile, '{}')
  const child = spawn('node', [SCRIPT, 'serve', 'corp', '--cwd', root, '--model', 'corp/m', '--trusted-hosts', 'llm.corp.example.com'], {
    env: { ...env, FAKE_PI_PROVIDER: 'corp' },
    stdio: 'ignore',
  })
  try {
    await until(() => fs.existsSync(path.join(root, 'corp', 'status.json')) && status('corp').state === 'idle')
    assert.equal(status('corp').model, 'corp/echo')
    cli('stop', 'corp')
    await until(() => status('corp').state === 'stopped')
  } finally {
    child.kill()
    fs.rmSync(modelsFile, { force: true })
    fs.writeFileSync(authFile, goodAuth)
  }
  cli('forget', 'corp')
})

test('serve passes only its own commands to pi: a model switch written to the pipe is refused', () => {
  const fd = fs.openSync(path.join(root, 'alpha', 'in.fifo'), fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
  fs.writeSync(fd, `${JSON.stringify({ type: 'set_model', provider: 'anthropic', modelId: 'x' })}\n`)
  fs.closeSync(fd)
  const id = cli('send', 'alpha', 'still here').trim()
  assert.equal(cli('wait', 'alpha', id, '--timeout', '5'), 'echo: still here\n')
  assert.match(cli('read', 'alpha', '--tail', '20'), /refused a set_model command/)
  assert.equal(status('alpha').model, 'opencode-go/echo')
})

test('status lists sessions in one line each', () => {
  assert.match(cli('status'), /^alpha {2}idle {2}opencode-go\/echo/m)
})

test('names that pi would refuse are refused', () => {
  assert.match(cliFails('send', 'alpha/../x', 'hi').out, /not a session name/)
})

test('stop ends the session; serving again reopens it and keeps its history', async () => {
  const firstSessionId = status('alpha').sessionId
  cli('stop', 'alpha')
  await until(() => status('alpha').state === 'stopped')
  assert.match(cliFails('send', 'alpha', 'hi').out, /not running \(stopped\)/)
  assert.ok(!fs.existsSync(path.join(root, 'alpha', 'in.fifo')))
  server = await serve('alpha')
  const st = status('alpha')
  assert.equal(st.sessionId, firstSessionId)
  assert.ok(st.promptSeq >= 4)
  const id = cli('send', 'alpha', 'again').trim()
  assert.equal(cli('wait', 'alpha', id, '--timeout', '5'), 'echo: again\n')
})

test('a session whose serve died shows as lost, and forget refuses a live one', async () => {
  assert.match(cliFails('forget', 'alpha').out, /running; stop it first/)
  server.kill('SIGKILL')
  const file = path.join(root, 'alpha', 'status.json')
  const st = status('alpha')
  fs.writeFileSync(file, JSON.stringify({ ...st, heartbeatAt: Date.now() - 60000 }))
  assert.match(cli('status', 'alpha'), /alpha {2}lost/)
  assert.match(cli('forget', 'alpha'), /forgot alpha/)
  server = null
})

test('a name served again after forget starts a new pi conversation', async () => {
  const child = await serve('gamma')
  const first = status('gamma').sessionId
  cli('stop', 'gamma')
  await until(() => status('gamma').state === 'stopped')
  child.kill()
  cli('forget', 'gamma')
  const again = await serve('gamma')
  assert.notEqual(status('gamma').sessionId, first)
  cli('stop', 'gamma')
  await until(() => status('gamma').state === 'stopped')
  again.kill()
})
