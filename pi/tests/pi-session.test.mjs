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
const env = { ...process.env, SANDBOX_RUNTIME: '1', PI_SESSIONS_DIR: root, PI_SESSION_PI: path.join(here, 'fake-pi.mjs') }
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
  const child = spawn('node', [SCRIPT, 'serve', name, '--cwd', root], { env, stdio: 'ignore' })
  await until(() => fs.existsSync(path.join(root, name, 'status.json')) && status(name).state === 'idle')
  return child
}

before(async () => {
  server = await serve('alpha')
})
after(() => {
  server?.kill()
  fs.rmSync(root, { recursive: true, force: true })
})

test('serve reports the model pi chose and goes idle', () => {
  const st = status('alpha')
  assert.equal(st.model, 'fake/echo')
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

test('serve refuses to run outside the sandbox unless allowed, and marks such a session', async () => {
  let out = ''
  try {
    execFileSync('node', [SCRIPT, 'serve', 'bare', '--cwd', root], { env: bareEnv, encoding: 'utf8', stdio: 'pipe' })
  } catch (err) {
    out = `${err.stderr}`
    assert.equal(err.status, 1)
  }
  assert.match(out, /not inside Claude Code's Bash sandbox/)
  assert.ok(!fs.existsSync(path.join(root, 'bare')))
  const child = spawn('node', [SCRIPT, 'serve', 'bare', '--cwd', root, '--allow-unsandboxed'], { env: bareEnv, stdio: 'ignore' })
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

test('status lists sessions in one line each', () => {
  assert.match(cli('status'), /^alpha {2}idle {2}fake\/echo/m)
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
