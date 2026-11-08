// pi-session against a fake pi: node --test pi/tests/
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
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

test('a dialog is declined at once, the run goes on, and wait names it apart from the reply', () => {
  const id = cli('send', 'alpha', 'please ask me').trim()
  const done = spawnSync('node', [SCRIPT, 'wait', 'alpha', id, '--timeout', '5'], { env, encoding: 'utf8' })
  assert.equal(done.status, 0, done.stderr)
  assert.equal(done.stdout, 'echo: please ask me (declined)\n')
  assert.match(done.stderr, /alpha declined a question from an extension \(confirm\): Proceed\?/)
  assert.equal(status('alpha').state, 'idle')
  assert.deepEqual(status('alpha').declined.map(d => d.title), ['Proceed?'])
  assert.match(cli('read', 'alpha', '--tail', '8'), /! declined confirm d1: Proceed\?/)
  assert.match(cli('status', 'alpha'), /declined 1 extension question: see read alpha/)
  // The next run starts with a clean list.
  const next = cli('send', 'alpha', 'plain').trim()
  const after = spawnSync('node', [SCRIPT, 'wait', 'alpha', next, '--timeout', '5'], { env, encoding: 'utf8' })
  assert.equal(after.stderr, '')
  assert.deepEqual(status('alpha').declined, [])
  // Nothing is left to answer with.
  assert.equal(spawnSync('node', [SCRIPT, 'answer', 'alpha', 'd1', 'yes'], { env, encoding: 'utf8' }).status, 1)
})

test('pi hears once per conversation not to stop for questions, also after serving again', async () => {
  const live = await serve('noted')
  const first = cli('send', 'noted', 'first').trim()
  assert.equal(cli('wait', 'noted', first, '--timeout', '5'), 'echo: first\n')
  const second = cli('send', 'noted', 'second').trim()
  cli('wait', 'noted', second, '--timeout', '5')
  cli('stop', 'noted')
  await until(() => status('noted').state === 'stopped')
  live.kill()
  const again = await serve('noted')
  const third = cli('send', 'noted', 'third').trim()
  cli('wait', 'noted', third, '--timeout', '5')
  const transcript = cli('read', 'noted', '--tail', '60')
  assert.equal(transcript.match(/\[Session note: nobody can answer questions/g).length, 1)
  assert.match(transcript, /first\n\n\[Session note:.*list open questions and assumptions in your final reply/)
  cli('stop', 'noted')
  await until(() => status('noted').state === 'stopped')
  again.kill()
  cli('forget', 'noted')
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

test('a run records its start from agent_start and clears it when it settles', async () => {
  assert.equal(status('alpha').runStartedAt, null)
  const before = Date.now()
  const slow = cli('send', 'alpha', 'slow: a long job').trim()
  await until(() => status('alpha').state === 'busy' && status('alpha').runStartedAt)
  const running = status('alpha').runStartedAt
  assert.equal(typeof running, 'number')
  assert.ok(running >= before && running <= Date.now())
  // Pi's later events move lastActivity, not the run's start.
  await until(() => status('alpha').lastTool?.startsWith('bash'))
  assert.equal(status('alpha').runStartedAt, running)
  cliFails('wait', 'alpha', slow, '--timeout', '1', '--abort')
  assert.equal(status('alpha').runStartedAt, null)
})

test('wait --out writes the reply to the file and prints only its path and size', () => {
  const dest = path.join(fs.realpathSync(root), 'out', 'deep', 'report.md')
  const secret = 'reply text that stays out of the output'
  const id = cli('send', 'alpha', secret).trim()
  const printed = cli('wait', 'alpha', id, '--timeout', '5', '--out', dest)
  const text = `echo: ${secret}\n`
  assert.equal(printed, `${dest} (${Buffer.byteLength(text)} bytes)\n`)
  assert.equal(fs.readFileSync(dest, 'utf8'), text)
  assert.deepEqual(fs.readdirSync(path.dirname(dest)), ['report.md'])
  // An existing file is replaced, and a relative path resolves from here.
  const again = cli('send', 'alpha', 'shorter').trim()
  const relative = path.relative(process.cwd(), dest)
  assert.equal(cli('wait', 'alpha', again, '--timeout', '5', '--out', relative), `${dest} (14 bytes)\n`)
  assert.equal(fs.readFileSync(dest, 'utf8'), 'echo: shorter\n')
  fs.rmSync(path.join(root, 'out'), { recursive: true })
})

test('a capped wait --out writes the last reply there too, and prints only its path and size', () => {
  const dest = path.join(fs.realpathSync(root), 'capped.md')
  const done = cli('send', 'alpha', 'before the cap').trim()
  cli('wait', 'alpha', done, '--timeout', '5')
  const id = cli('send', 'alpha', 'slow: a long job').trim()
  const run = spawnSync('node', [SCRIPT, 'wait', 'alpha', id, '--timeout', '1', '--abort', '--out', dest], { env, encoding: 'utf8' })
  assert.equal(run.status, 2)
  assert.match(run.stderr, /timed out after 1s; its run was aborted/)
  assert.equal(run.stdout, `${dest} (21 bytes)\n`)
  assert.equal(fs.readFileSync(dest, 'utf8'), 'echo: before the cap\n')
  fs.rmSync(dest)
})

test('wait --out refuses ~/.pi, through links and relative paths, before it waits', () => {
  const realRoot = fs.realpathSync(root)
  const piAgent = path.join(home, '.pi', 'agent')
  const refused = (target, re) => {
    // No such session: the refusal has to come first, and a wrong pass would say "no session".
    const failed = cliFails('wait', 'nosuch', '--out', target)
    assert.equal(failed.code, 1)
    assert.match(failed.out, re)
    assert.ok(!/no session/.test(failed.out), failed.out)
  }
  const inPi = /refusing --out .* is in ~\/\.pi/
  refused(authFile, inPi)
  refused(path.join(home, '.pi'), inPi)
  refused(path.join(piAgent, 'new', 'folder', 'report.md'), inPi)
  refused(path.relative(process.cwd(), authFile), inPi)
  // A link to the file, a link to the folder with a new file beyond it, and a link to a link.
  const links = path.join(realRoot, 'links')
  fs.mkdirSync(links)
  fs.symlinkSync(authFile, path.join(links, 'file.md'))
  fs.symlinkSync(piAgent, path.join(links, 'dir'))
  fs.symlinkSync(path.join(links, 'dir'), path.join(links, 'dir2'))
  refused(path.join(links, 'file.md'), inPi)
  refused(path.join(links, 'dir', 'report.md'), inPi)
  refused(path.join(links, 'dir2', 'new', 'report.md'), inPi)
  // A dangling link would write wherever it points, and may point into ~/.pi.
  fs.symlinkSync(path.join(piAgent, 'not-yet.md'), path.join(links, 'dangling.md'))
  refused(path.join(links, 'dangling.md'), /is a link to nothing/)
  refused(path.join(links, 'dangling.md', 'report.md'), /is a link to nothing/)
  // Not a plain file: a folder, or a pipe that would hang.
  refused(links, /is not a plain file/)
  assert.equal(spawnSync('mkfifo', [path.join(links, 'pipe')]).status, 0)
  refused(path.join(links, 'pipe'), /is not a plain file/)
  assert.ok(!fs.existsSync(path.join(piAgent, 'not-yet.md')))
  assert.ok(!fs.existsSync(path.join(piAgent, 'new')))
  assert.equal(fs.readFileSync(authFile, 'utf8'), goodAuth)
  assert.match(cliFails('wait', 'nosuch', '--out').out, /--out names a file/)
  // ~/.pi that is itself a link: where it really lives is refused too.
  const otherHome = path.join(realRoot, 'other-home')
  fs.mkdirSync(path.join(realRoot, 'dotfiles', 'pi'), { recursive: true })
  fs.mkdirSync(otherHome)
  fs.symlinkSync(path.join(realRoot, 'dotfiles', 'pi'), path.join(otherHome, '.pi'))
  const viaLink = spawnSync('node', [SCRIPT, 'wait', 'nosuch', '--out', path.join(realRoot, 'dotfiles', 'pi', 'report.md')], { env: { ...env, HOME: otherHome }, encoding: 'utf8' })
  assert.equal(viaLink.status, 1)
  assert.match(viaLink.stderr, inPi)
  fs.rmSync(otherHome, { recursive: true })
  fs.rmSync(path.join(realRoot, 'dotfiles'), { recursive: true })
  // A folder that can't be made fails at once as well.
  const plain = path.join(links, 'plain')
  fs.writeFileSync(plain, '')
  assert.match(cliFails('wait', 'nosuch', '--out', path.join(plain, 'report.md')).out, /ENOTDIR/)
  fs.rmSync(links, { recursive: true })
})

test('wait --out replaces a hard link instead of writing through it', () => {
  const realRoot = fs.realpathSync(root)
  const victim = path.join(realRoot, 'hard-victim')
  const dest = path.join(realRoot, 'hard-dest.md')
  fs.writeFileSync(victim, 'keep\n')
  fs.linkSync(victim, dest)
  const id = cli('send', 'alpha', 'hard').trim()
  cli('wait', 'alpha', id, '--timeout', '5', '--out', dest)
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep\n')
  assert.equal(fs.readFileSync(dest, 'utf8'), 'echo: hard\n')
  fs.rmSync(victim)
  fs.rmSync(dest)
})

const scripted = text => `reply=${encodeURIComponent(text)}`
const finding = { file: 'src/a.js', line: 12, severity: 'high', confidence: 'medium', title: 'Off by one' }
const fence = v => `\`\`\`json\n${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}\n\`\`\``

test('send --format findings adds the instruction, and pi never sees the flag', () => {
  const id = cli('send', 'alpha', '--format', 'findings', `review it ${scripted(fence([]))}`).trim()
  cli('wait', 'alpha', id, '--timeout', '5')
  const transcript = cli('read', 'alpha', '--tail', '12')
  assert.match(transcript, /review it reply=/)
  assert.match(transcript, /fenced ```json code block holding a JSON array/)
  for (const key of ['file', 'line', 'severity', 'confidence', 'title']) assert.ok(transcript.includes(`"${key}"`), key)
  const events = fs.readFileSync(path.join(root, 'alpha', 'events.jsonl'), 'utf8')
  assert.ok(!events.includes('"format"'))
  assert.match(cliFails('send', 'alpha', '--format', 'yaml', 'hi').out, /--format takes findings, not yaml/)
  assert.match(cliFails('send', 'alpha', 'hi', '--format').out, /--format takes findings/)
})

test('a valid findings reply comes back as the JSON array alone, also through --out', () => {
  const both = [finding, { ...finding, line: 1, severity: 'critical', confidence: 'low' }]
  const reply = `Here you go.\n\n${fence(both)}`
  const id = cli('send', 'alpha', '--format', 'findings', scripted(reply)).trim()
  const printed = cli('wait', 'alpha', id, '--timeout', '5')
  assert.deepEqual(JSON.parse(printed), both)
  // read --last keeps what pi really said.
  assert.equal(cli('read', 'alpha', '--last'), `${reply}\n`)
  const dest = path.join(fs.realpathSync(root), 'findings.json')
  assert.equal(cli('wait', 'alpha', id, '--out', dest), `${dest} (${Buffer.byteLength(printed)} bytes)\n`)
  assert.deepEqual(JSON.parse(fs.readFileSync(dest, 'utf8')), both)
  fs.rmSync(dest)
  // No findings is valid too, in a fence that names no language.
  const none = cli('send', 'alpha', '--format', 'findings', scripted('```\n[]\n```')).trim()
  assert.deepEqual(JSON.parse(cli('wait', 'alpha', none, '--timeout', '5')), [])
})

test('an invalid findings reply reports the error, exits 4, and neither prints nor writes it', () => {
  const dest = path.join(fs.realpathSync(root), 'bad-findings.json')
  const bad = (reply, re) => {
    const id = cli('send', 'alpha', '--format', 'findings', scripted(reply)).trim()
    const run = spawnSync('node', [SCRIPT, 'wait', 'alpha', id, '--timeout', '5', '--out', dest], { env, encoding: 'utf8' })
    assert.equal(run.status, 4, run.stderr)
    assert.equal(run.stdout, '')
    assert.match(run.stderr, re)
    assert.match(run.stderr, /read alpha --last/)
    assert.ok(!fs.existsSync(dest))
    const printed = spawnSync('node', [SCRIPT, 'wait', 'alpha', id, '--timeout', '5'], { env, encoding: 'utf8' })
    assert.equal(printed.status, 4)
    assert.equal(printed.stdout, '')
    assert.ok(!printed.stderr.includes(reply))
  }
  bad('Nothing fenced here.', /expected one fenced JSON block, found 0/)
  bad(`${fence([])}\nand\n${fence([])}`, /found 2/)
  bad(fence('[{"file": "a", oops}]'), /the block is not JSON/)
  bad(fence({ findings: [] }), /not a JSON array/)
  bad(fence(['a string']), /finding 1 is not an object/)
  bad(fence([finding, { ...finding, fix: 'do this' }]), /finding 2 has other keys \(fix\)/)
  bad(fence([{ ...finding, file: '' }]), /file must be a path/)
  bad(fence([{ ...finding, line: 0 }]), /line must be an integer/)
  bad(fence([{ ...finding, line: '12' }]), /line must be an integer/)
  bad(fence([{ ...finding, severity: 'urgent' }]), /severity must be one of/)
  bad(fence([{ ...finding, confidence: 0.9 }]), /confidence must be one of/)
  const { title: _title, ...untitled } = finding
  bad(fence([untitled]), /title must be/)
})

test('a findings prompt pi refuses, or a capped run, never passes off an older reply as its findings', () => {
  const good = cli('send', 'alpha', '--format', 'findings', scripted(fence([finding]))).trim()
  cli('wait', 'alpha', good, '--timeout', '5')
  const refused = cli('send', 'alpha', '--format', 'findings', 'please reject this').trim()
  const failed = cliFails('wait', 'alpha', refused, '--timeout', '5')
  assert.equal(failed.code, 4)
  assert.match(failed.out, /no valid findings: prompt: no model selected/)
  const clear = cli('send', 'alpha', '--format', 'findings', scripted(fence([finding]))).trim()
  cli('wait', 'alpha', clear, '--timeout', '5')
  const dest = path.join(fs.realpathSync(root), 'capped-findings.json')
  const id = cli('send', 'alpha', '--format', 'findings', 'slow: review').trim()
  const capped = cliFails('wait', 'alpha', id, '--timeout', '1', '--abort', '--out', dest)
  assert.equal(capped.code, 2)
  assert.match(capped.out, /no valid findings: the run did not finish/)
  assert.ok(!fs.existsSync(dest))
})

test('only the findings prompt is checked: a plain prompt after it, or queued after it, is not', () => {
  const a = cli('send', 'alpha', '--format', 'findings', scripted('not findings')).trim()
  assert.equal(cliFails('wait', 'alpha', a, '--timeout', '5').code, 4)
  const b = cli('send', 'alpha', 'plain again').trim()
  assert.equal(cli('wait', 'alpha', b, '--timeout', '5'), 'echo: plain again\n')
  cli('send', 'alpha', '--format', 'findings', scripted('not findings'))
  const d = cli('send', 'alpha', 'plain queued').trim()
  assert.equal(cli('wait', 'alpha', d, '--timeout', '5'), 'echo: plain queued\n')
})

test('--out and --format mean nothing in the commands that do not take them', () => {
  const id = cli('send', 'alpha', 'the --out flag and').trim()
  assert.equal(cli('wait', 'alpha', id, '--timeout', '5'), 'echo: the --out flag and\n')
  assert.match(cliFails('wait', 'alpha', '--format', 'findings').out, /wait does not take --format/)
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

// A `run` in the background: what it has printed so far, and its end.
const startRun = (args, runEnv = env) => {
  const child = spawn('node', [SCRIPT, 'run', ...args], { env: runEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  const seen = { out: '', err: '' }
  child.stdout.on('data', d => (seen.out += d))
  child.stderr.on('data', d => (seen.err += d))
  const done = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal, ...seen })))
  return { child, seen, done }
}
const AT = ['--cwd', root, '--model', 'opencode-go/echo']
const runOnce = (args, runEnv) => startRun(args, runEnv).done
const stillRunning = child => child.exitCode === null && child.signalCode === null
const noSession = name => assert.ok(!fs.existsSync(path.join(root, name, 'status.json')), `${name} started`)

test('run starts the session, sends the prompt, prints the reply, and stops it', async () => {
  const run = await runOnce(['one', ...AT, 'hello', 'there'])
  assert.equal(run.code, 0, run.err)
  assert.equal(run.out, 'echo: hello there\n')
  assert.equal(status('one').state, 'stopped')
  assert.equal(status('one').model, 'opencode-go/echo')
  assert.equal(status('one').sandboxed, true)
  assert.ok(!fs.existsSync(path.join(root, 'one', 'in.fifo')))
  assert.equal(cli('read', 'one', '--last'), 'echo: hello there\n')
  // The same name again reopens that conversation, with the model it had.
  const firstId = status('one').sessionId
  const again = await runOnce(['one', 'more'])
  assert.equal(again.code, 0, again.err)
  assert.equal(again.out, 'echo: more\n')
  assert.equal(status('one').sessionId, firstId)
  cli('forget', 'one')
})

test('run takes its prompt from a file, however long', async () => {
  const long = `start ${'x'.repeat(100000)} end`
  const big = path.join(root, 'run-big.md')
  fs.writeFileSync(big, long)
  const run = await runOnce(['big', ...AT, '--file', big])
  assert.equal(run.code, 0, run.err)
  assert.equal(run.out, `echo: ${long}\n`)
  fs.rmSync(big)
  cli('forget', 'big')
})

test('run: what is wrong with the call fails before pi starts', async () => {
  const refused = async (args, re) => {
    const run = await runOnce(['early', ...AT, ...args])
    assert.equal(run.code, 1)
    assert.match(run.err, re)
    noSession('early')
  }
  await refused([], /nothing to send/)
  await refused(['--file', path.join(root, 'no-such-prompt.md')], /is not a file/)
  await refused(['--format', 'yaml', 'hi'], /--format takes findings, not yaml/)
  await refused(['--out', authFile, 'hi'], /refusing --out .* is in ~\/\.pi/)
  await refused(['hi', '--out'], /--out names a file/)
  assert.equal(fs.readFileSync(authFile, 'utf8'), goodAuth)
  fs.rmSync(path.join(root, 'early'), { recursive: true, force: true })
  // A session that is already running is not taken over, and gets no prompt.
  const live = await serve('taken')
  const before = status('taken').promptSeq
  const clash = await runOnce(['taken', ...AT, 'hi'])
  assert.equal(clash.code, 1)
  assert.match(clash.err, /taken is already running/)
  assert.equal(status('taken').promptSeq, before)
  assert.equal(status('taken').state, 'idle')
  cli('stop', 'taken')
  await until(() => status('taken').state === 'stopped')
  live.kill()
  cli('forget', 'taken')
})

test('run is held to the sandbox check, with the same way past it as serve', async () => {
  const bare = await runOnce(['bare-run', ...AT, 'hi'], bareEnv)
  assert.equal(bare.code, 1)
  assert.match(bare.err, /not inside Claude Code's Bash sandbox/)
  assert.ok(!fs.existsSync(path.join(root, 'bare-run')))
  const allowed = await runOnce(['bare-run', '--allow-unsandboxed', ...AT, 'hi'], bareEnv)
  assert.equal(allowed.code, 0, allowed.err)
  assert.equal(status('bare-run').sandboxed, false)
  cli('forget', 'bare-run')
})

test('run is held to the gate, and pi never gets the prompt when it fails', async () => {
  const refused = async (args, auth = goodAuth) => {
    fs.writeFileSync(authFile, auth)
    try {
      const run = await runOnce(['gated-run', '--cwd', root, ...args])
      assert.equal(run.code, 1)
      assert.equal(run.out, '')
      return run.err
    } finally {
      fs.writeFileSync(authFile, goodAuth)
      noSession('gated-run')
    }
  }
  assert.match(await refused(['hi']), /name the model/)
  assert.match(await refused(['--model', 'anthropic/claude-x', 'hi']), /is not an opencode-go model/)
  assert.match(await refused(['--model', 'opencode-go/echo', 'hi', '--', '--provider', 'anthropic']), /extra pi arguments .* are off/)
  assert.match(await refused(['--model', 'opencode-go/echo', 'hi'], JSON.stringify({ 'opencode-go': { type: 'oauth', refresh: 'r' } })), /no opencode-go API key/)
  assert.match(await refused(['--model', 'opencode-go/echo', 'hi'], JSON.stringify({ 'opencode-go': { type: 'api_key', key: 'k' }, anthropic: { type: 'oauth' } })), /also holds anthropic/)
  assert.match(await refused(['--model', 'corp/m', '--trusted-hosts', 'not a host!', 'hi']), /not a host, host:port or host:\*/)
  fs.rmSync(path.join(root, 'gated-run'), { recursive: true, force: true })
  // pi ending up on another provider ends the session before the prompt reaches it.
  const other = await runOnce(['other-run', ...AT, 'a secret prompt'], { ...env, FAKE_PI_PROVIDER: 'anthropic' })
  assert.equal(other.code, 1)
  assert.equal(other.out, '')
  assert.match(other.err, /before it took the prompt: pi runs anthropic\/echo, not opencode-go/)
  assert.ok(!cli('read', 'other-run', '--tail', '50').includes('a secret prompt'))
  assert.ok(!fs.readFileSync(path.join(root, 'other-run', 'events.jsonl'), 'utf8').includes('a secret prompt'))
  cli('forget', 'other-run')
})

test('run takes a model at a trusted host through --trusted-hosts, as serve does', async () => {
  const modelsFile = path.join(home, '.pi', 'agent', 'models.json')
  fs.writeFileSync(modelsFile, JSON.stringify({ providers: { corp: { baseUrl: 'https://llm.corp.example.com/v1', apiKey: 'dummy', models: [{ id: 'm' }] } } }))
  fs.writeFileSync(authFile, '{}')
  try {
    const args = ['corp-run', '--cwd', root, '--model', 'corp/m']
    const without = await runOnce([...args, 'hi'], { ...env, FAKE_PI_PROVIDER: 'corp' })
    assert.equal(without.code, 1)
    assert.match(without.err, /defines corp with no base URL at a trusted host/)
    const run = await runOnce([...args, '--trusted-hosts', 'llm.corp.example.com', 'hi'], { ...env, FAKE_PI_PROVIDER: 'corp' })
    assert.equal(run.code, 0, run.err)
    assert.equal(run.out, 'echo: hi\n')
  } finally {
    fs.rmSync(modelsFile, { force: true })
    fs.writeFileSync(authFile, goodAuth)
  }
  cli('forget', 'corp-run')
})

test('run --keep prints the reply and leaves the session up for follow-ups', async () => {
  const run = startRun(['kept', ...AT, '--keep', 'first'])
  await until(() => run.seen.out === 'echo: first\n')
  assert.equal(status('kept').state, 'idle')
  assert.ok(stillRunning(run.child))
  const id = cli('send', 'kept', 'second').trim()
  assert.equal(cli('wait', 'kept', id, '--timeout', '5'), 'echo: second\n')
  cli('stop', 'kept')
  const end = await run.done
  assert.equal(end.code, 0, end.err)
  assert.equal(status('kept').state, 'stopped')
  cli('forget', 'kept')
})

test('a wait started beside run --keep never takes the session for done before its prompt', async () => {
  const run = startRun(['beside', ...AT, '--keep', 'slow: a long job'])
  await until(() => fs.existsSync(path.join(root, 'beside', 'status.json')) && status('beside').state !== 'starting')
  // Idle or busy from here, its prompt is already counted.
  assert.equal(status('beside').settledSeq, status('beside').promptSeq - 1)
  const capped = cliFails('wait', 'beside', '--timeout', '1')
  assert.equal(capped.code, 2)
  cli('stop', 'beside')
  await run.done
  cli('forget', 'beside')
})

test('--keep means nothing in the commands that do not take it', async () => {
  const live = await serve('words')
  const id = cli('send', 'words', 'the --keep flag').trim()
  assert.equal(cli('wait', 'words', id, '--timeout', '5'), 'echo: the --keep flag\n')
  cli('stop', 'words')
  await until(() => status('words').state === 'stopped')
  live.kill()
  cli('forget', 'words')
})

test('a findings prompt aborted, or ending with no text, never passes off an older reply', async () => {
  const good = cli('send', 'alpha', '--format', 'findings', scripted(fence([finding]))).trim()
  cli('wait', 'alpha', good, '--timeout', '5')
  const slow = cli('send', 'alpha', '--format', 'findings', 'slow: review').trim()
  await until(() => status('alpha').state === 'busy' && status('alpha').lastTool?.startsWith('bash'))
  cli('abort', 'alpha')
  await until(() => status('alpha').state === 'idle')
  const aborted = cliFails('wait', 'alpha', slow, '--timeout', '5')
  assert.equal(aborted.code, 4)
  assert.match(aborted.out, /no valid findings: its run was aborted/)
  const silent = cli('send', 'alpha', '--format', 'findings', 'silent').trim()
  const empty = cliFails('wait', 'alpha', silent, '--timeout', '5')
  assert.equal(empty.code, 4)
  assert.match(empty.out, /no valid findings: pi wrote no reply to it/)
})

test('a findings prompt with a later prompt behind it is refused, and writes nothing', () => {
  const dest = path.join(fs.realpathSync(root), 'mixed-findings.json')
  const findings = cli('send', 'alpha', '--format', 'findings', scripted(fence([finding]))).trim()
  const plain = cli('send', 'alpha', 'a plain follow-up').trim()
  assert.equal(cli('wait', 'alpha', plain, '--timeout', '5'), 'echo: a plain follow-up\n')
  const mixed = cliFails('wait', 'alpha', findings, '--timeout', '5', '--out', dest)
  assert.equal(mixed.code, 4)
  assert.match(mixed.out, /no valid findings: a later prompt settled with it/)
  assert.ok(!fs.existsSync(dest))
  // Capped while the later prompt is queued: exit 2, and still nothing written.
  const slow = cli('send', 'alpha', '--format', 'findings', 'slow: review').trim()
  cli('send', 'alpha', 'queued behind it')
  const capped = cliFails('wait', 'alpha', slow, '--timeout', '1', '--abort', '--out', dest)
  assert.equal(capped.code, 2)
  assert.match(capped.out, /no valid findings: the run did not finish/)
  assert.ok(!fs.existsSync(dest))
})

test('an extension that keeps asking ends the session with the reason, instead of looping', async () => {
  const end = await runOnce(['nagged', ...AT, 'nag'])
  assert.equal(end.code, 1, end.err)
  assert.match(end.err, /kept asking after 100 declined questions; last: Your name\?/)
  assert.equal(status('nagged').state, 'stopped')
  assert.ok(cli('read', 'nagged', '--tail', '500').match(/! declined/g).length <= 100)
  assert.ok(status('nagged').declined.length <= 20)
  cli('forget', 'nagged')
})

test('run ends with the reason when pi cannot report its state, or never does', async () => {
  const failed = await runOnce(['nostate', ...AT, 'hi'], { ...env, FAKE_PI_STATE: 'fail' })
  assert.equal(failed.code, 1, failed.err)
  assert.match(failed.err, /pi could not report its state: bad config/)
  cli('forget', 'nostate')
  const silent = await runOnce(['nostate', ...AT, 'hi'], { ...env, FAKE_PI_STATE: 'silent', PI_SESSION_START_MS: '500' })
  assert.equal(silent.code, 1, silent.err)
  assert.match(silent.err, /pi did not report its state within/)
  cli('forget', 'nostate')
})

test('a question declined as pi starts is still named when the first run ends, then not again', async () => {
  const run = startRun(['startup', ...AT, '--keep', 'first'], { ...env, FAKE_PI_STARTUP_DIALOG: 'Trust this project?' })
  await until(() => /echo: first/.test(run.seen.out))
  assert.match(run.seen.err, /startup declined a question from an extension \(confirm\): Trust this project\?/)
  const id = cli('send', 'startup', 'second').trim()
  const next = spawnSync('node', [SCRIPT, 'wait', 'startup', id, '--timeout', '5'], { env, encoding: 'utf8' })
  assert.equal(next.stderr, '')
  cli('stop', 'startup')
  await run.done
  cli('forget', 'startup')
})

test("a failed restart keeps the path to pi's copy, so forget --purge can still find it", async () => {
  const first = await runOnce(['kept-path', ...AT, 'hi'])
  assert.equal(first.code, 0, first.err)
  const known = status('kept-path').sessionFile
  assert.ok(known)
  const failed = await runOnce(['kept-path', ...AT, 'hi'], { ...env, PI_SESSION_PI: path.join(root, 'no-such-pi') })
  assert.notEqual(failed.code, 0)
  assert.equal(status('kept-path').state, 'failed')
  assert.equal(status('kept-path').sessionFile, known)
  cli('forget', 'kept-path')
})

test('a serve from before dialogs were declined, still waiting, counts as running', () => {
  fs.mkdirSync(path.join(root, 'legacy'), { recursive: true })
  const at = path.join(root, 'legacy', 'status.json')
  fs.writeFileSync(at, JSON.stringify({ name: 'legacy', state: 'waiting', heartbeatAt: Date.now(), prompts: {}, promptSeq: 1, settledSeq: 1 }))
  assert.match(cliFails('forget', 'legacy').out, /running/)
  assert.equal(cliFails('wait', 'legacy', '--timeout', '1').code, 2)
  fs.rmSync(path.join(root, 'legacy'), { recursive: true })
})

test('a question does not hold up run: it is declined, the reply comes, and the session stops', async () => {
  const end = await runOnce(['asks', ...AT, 'please ask me'])
  assert.equal(end.code, 0, end.err)
  assert.equal(end.out, 'echo: please ask me (declined)\n')
  assert.match(end.err, /asks declined a question from an extension \(confirm\): Proceed\?/)
  assert.equal(status('asks').state, 'stopped')
  cli('forget', 'asks')
})

test('run --timeout: exit 2, with --abort as wait does it, and the session stops', async () => {
  const dest = path.join(fs.realpathSync(root), 'run-capped.md')
  const first = await runOnce(['capped', ...AT, 'before the cap'])
  assert.equal(first.code, 0, first.err)
  const aborted = await runOnce(['capped', '--timeout', '1', '--abort', '--out', dest, 'slow: a long job'])
  assert.equal(aborted.code, 2, aborted.err)
  assert.match(aborted.err, /timed out after 1s; its run was aborted/)
  assert.equal(aborted.out, `${dest} (21 bytes)\n`)
  assert.equal(fs.readFileSync(dest, 'utf8'), 'echo: before the cap\n')
  assert.equal(status('capped').state, 'stopped')
  assert.match(cli('read', 'capped', '--tail', '6'), /settled \(aborted\)/)
  fs.rmSync(dest)
  const plain = await runOnce(['capped', '--timeout', '1', 'slow: a long job'])
  assert.equal(plain.code, 2, plain.err)
  assert.match(plain.err, /still busy after 1s/)
  assert.equal(status('capped').state, 'stopped')
  cli('forget', 'capped')
})

test('run --keep under a cap stays up, and reports the code when the session ends', async () => {
  const run = startRun(['capped-keep', ...AT, '--keep', '--timeout', '1', 'slow: a long job'])
  await until(() => /still busy after 1s/.test(run.seen.err), 8000)
  assert.ok(stillRunning(run.child))
  assert.equal(status('capped-keep').state, 'busy')
  cli('stop', 'capped-keep')
  assert.equal((await run.done).code, 2)
  cli('forget', 'capped-keep')
})

test('run --out and findings go through the wait path: path and size, the array alone, exit 4', async () => {
  const dest = path.join(fs.realpathSync(root), 'run-out', 'report.md')
  const written = await runOnce(['outs', ...AT, '--out', dest, 'written'])
  assert.equal(written.code, 0, written.err)
  assert.equal(written.out, `${dest} (14 bytes)\n`)
  assert.equal(fs.readFileSync(dest, 'utf8'), 'echo: written\n')
  const good = await runOnce(['outs', '--format', 'findings', scripted(fence([finding]))])
  assert.equal(good.code, 0, good.err)
  assert.deepEqual(JSON.parse(good.out), [finding])
  fs.rmSync(dest)
  const bad = await runOnce(['outs', '--format', 'findings', '--out', dest, scripted('not findings')])
  assert.equal(bad.code, 4)
  assert.equal(bad.out, '')
  assert.match(bad.err, /no valid findings: expected one fenced JSON block, found 0/)
  assert.ok(!fs.existsSync(dest))
  // Stopped all the same, with the raw reply kept.
  assert.equal(status('outs').state, 'stopped')
  assert.equal(cli('read', 'outs', '--last'), 'not findings\n')
  fs.rmSync(path.dirname(dest), { recursive: true })
  cli('forget', 'outs')
})

test('a prompt pi refuses ends run with the error, as it does wait', async () => {
  const run = await runOnce(['refused', ...AT, 'please reject this'])
  assert.equal(run.code, 0, run.err)
  assert.match(run.out, /^error: prompt: no model selected\n/)
  assert.equal(status('refused').state, 'stopped')
  cli('forget', 'refused')
})

test('a run told to stop mid-run ends cleanly, and says it did not settle', async () => {
  const run = startRun(['killed-soft', ...AT, 'slow: a long job'])
  await until(() => fs.existsSync(path.join(root, 'killed-soft', 'status.json')) && status('killed-soft').state === 'busy')
  run.child.kill('SIGTERM')
  const end = await run.done
  assert.equal(end.code, 1)
  assert.match(end.err, /killed-soft stopped before settling/)
  assert.equal(status('killed-soft').state, 'stopped')
  cli('forget', 'killed-soft')
})

test('a run killed with Claude Code shows as lost, and serving the name again resumes it', async () => {
  const run = startRun(['killed', ...AT, 'slow: a long job'])
  await until(() => fs.existsSync(path.join(root, 'killed', 'status.json')) && status('killed').state === 'busy')
  const { sessionId, promptSeq } = status('killed')
  run.child.kill('SIGKILL')
  await run.done
  const file = path.join(root, 'killed', 'status.json')
  fs.writeFileSync(file, JSON.stringify({ ...status('killed'), heartbeatAt: Date.now() - 60000 }))
  assert.match(cli('status', 'killed'), /killed {2}lost/)
  const again = spawn('node', [SCRIPT, 'serve', 'killed'], { env, stdio: 'ignore' })
  await until(() => status('killed').state === 'idle', 12000)
  assert.equal(status('killed').sessionId, sessionId)
  assert.equal(status('killed').promptSeq, promptSeq)
  const id = cli('send', 'killed', 'carry on').trim()
  assert.equal(cli('wait', 'killed', id, '--timeout', '5'), 'echo: carry on\n')
  cli('stop', 'killed')
  await until(() => status('killed').state === 'stopped')
  again.kill()
  cli('forget', 'killed')
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

// forget --purge: everything stays inside this test's own HOME.
const conversations = path.join(home, '.pi', 'agent', 'sessions')
const conversation = (name, text = 'conversation') => {
  const at = path.join(conversations, '--project--', `${name}.jsonl`)
  fs.mkdirSync(path.dirname(at), { recursive: true })
  fs.writeFileSync(at, text)
  return at
}
// A stopped session whose pi reported this sessionFile (null: reported none).
const stoppedWith = async (name, sessionFile) => {
  const child = spawn('node', [SCRIPT, 'serve', name, '--cwd', root, '--model', 'opencode-go/echo'], { env: { ...env, FAKE_PI_SESSION_FILE: sessionFile ?? '' }, stdio: 'ignore' })
  await until(() => fs.existsSync(path.join(root, name, 'status.json')) && status(name).state === 'idle')
  assert.equal(status(name).sessionFile, sessionFile)
  cli('stop', name)
  await until(() => status(name).state === 'stopped')
  child.kill()
}
const refusedPurge = (name, why) => {
  const refused = cliFails('forget', name, '--purge')
  assert.equal(refused.code, 1)
  assert.match(refused.out, why)
  assert.match(refused.out, /Nothing was deleted/)
  assert.doesNotMatch(refused.out, /^forgot/m)
  // The session's folder stays too, and plain forget still clears it.
  assert.ok(fs.existsSync(path.join(root, name, 'status.json')))
  assert.match(cli('forget', name), /^forgot /)
}

test("forget --purge deletes pi's copy and the session, and leaves other conversations", async () => {
  const mine = conversation('purge-mine')
  const other = conversation('purge-other')
  await stoppedWith('purged', mine)
  const real = fs.realpathSync(mine)
  assert.equal(cli('forget', '--purge', 'purged'), `forgot purged and deleted pi's copy, ${real}\n`)
  assert.ok(!fs.existsSync(mine))
  assert.ok(!fs.existsSync(path.join(root, 'purged')))
  assert.equal(fs.readFileSync(other, 'utf8'), 'conversation')
  assert.ok(fs.statSync(path.dirname(mine)).isDirectory())
})

test("plain forget keeps pi's copy", async () => {
  const mine = conversation('plain-kept')
  await stoppedWith('plain', mine)
  assert.equal(cli('forget', 'plain'), 'forgot plain\n')
  assert.ok(!fs.existsSync(path.join(root, 'plain')))
  assert.equal(fs.readFileSync(mine, 'utf8'), 'conversation')
})

test('forget --purge refuses a live session, and keeps its copy', async () => {
  const mine = conversation('purge-live')
  const child = spawn('node', [SCRIPT, 'serve', 'purge-live', '--cwd', root, '--model', 'opencode-go/echo'], { env: { ...env, FAKE_PI_SESSION_FILE: mine }, stdio: 'ignore' })
  await until(() => fs.existsSync(path.join(root, 'purge-live', 'status.json')) && status('purge-live').state === 'idle')
  assert.match(cliFails('forget', 'purge-live', '--purge').out, /running; stop it first/)
  assert.ok(fs.existsSync(mine))
  assert.equal(status('purge-live').state, 'idle')
  cli('stop', 'purge-live')
  await until(() => status('purge-live').state === 'stopped')
  child.kill()
  cli('forget', 'purge-live')
})

test('forget --purge refuses a link, and neither it nor what it points at is deleted', async () => {
  const target = conversation('link-target')
  const link = path.join(conversations, '--project--', 'link.jsonl')
  fs.symlinkSync(target, link)
  await stoppedWith('linked', link)
  refusedPurge('linked', /is a link/)
  assert.ok(fs.lstatSync(link).isSymbolicLink())
  assert.equal(fs.readFileSync(target, 'utf8'), 'conversation')
})

test('forget --purge refuses a path outside the sessions folder, also dressed as inside', async () => {
  const outside = path.join(home, '.pi', 'agent', 'auth-copy.json')
  fs.writeFileSync(outside, 'keep me')
  await stoppedWith('outside', outside)
  refusedPurge('outside', /is outside/)

  // A status file a sandboxed command rewrote, climbing out of the folder.
  await stoppedWith('climbs', conversation('climbs'))
  const statusFile = path.join(root, 'climbs', 'status.json')
  fs.writeFileSync(statusFile, JSON.stringify({ ...status('climbs'), sessionFile: `${conversations}/../auth-copy.json` }))
  refusedPurge('climbs', /is outside/)

  // A sibling whose name only starts like the folder's.
  const sibling = `${conversations}-old.jsonl`
  fs.writeFileSync(sibling, 'keep me')
  await stoppedWith('sibling', sibling)
  refusedPurge('sibling', /is outside/)

  // A file reached through a folder link planted inside the sessions folder.
  const away = fs.mkdtempSync(path.join(home, 'away-'))
  fs.writeFileSync(path.join(away, 'victim.jsonl'), 'keep me')
  const through = path.join(conversations, 'through')
  fs.symlinkSync(away, through)
  await stoppedWith('through', path.join(through, 'victim.jsonl'))
  refusedPurge('through', /is outside/)
  // And one that leads back inside it: still not the path pi would report.
  const inner = path.join(conversations, 'inner')
  fs.symlinkSync(path.join(conversations, '--project--'), inner)
  const reached = conversation('reached')
  await stoppedWith('inner', path.join(inner, 'reached.jsonl'))
  refusedPurge('inner', /goes through a link/)

  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep me')
  assert.equal(fs.readFileSync(sibling, 'utf8'), 'keep me')
  assert.equal(fs.readFileSync(path.join(away, 'victim.jsonl'), 'utf8'), 'keep me')
  assert.equal(fs.readFileSync(reached, 'utf8'), 'conversation')
  fs.rmSync(through)
  fs.rmSync(inner)
})

test('forget --purge refuses a folder, a pipe and the sessions folder itself', async () => {
  const inside = conversation('in-folder')
  await stoppedWith('folder', path.dirname(inside))
  refusedPurge('folder', /not a plain file/)

  await stoppedWith('whole', conversations)
  refusedPurge('whole', /sessions folder itself/)

  const pipe = path.join(conversations, 'a.pipe')
  assert.equal(spawnSync('mkfifo', [pipe]).status, 0)
  await stoppedWith('piped', pipe)
  refusedPurge('piped', /not a plain file/)
  assert.ok(fs.lstatSync(pipe).isFIFO())
  fs.rmSync(pipe)

  assert.equal(fs.readFileSync(inside, 'utf8'), 'conversation')
})

test('forget --purge refuses when the sessions folder itself is a link, as a planted one would be', async () => {
  const victim = fs.mkdtempSync(path.join(home, 'victim-'))
  fs.writeFileSync(path.join(victim, 'file.jsonl'), 'keep me')
  await stoppedWith('swapped', conversation('swapped'))
  const moved = `${conversations}.real`
  fs.renameSync(conversations, moved)
  fs.symlinkSync(victim, conversations)
  try {
    const statusFile = path.join(root, 'swapped', 'status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ ...status('swapped'), sessionFile: path.join(conversations, 'file.jsonl') }))
    refusedPurge('swapped', /is not a real folder/)
    assert.equal(fs.readFileSync(path.join(victim, 'file.jsonl'), 'utf8'), 'keep me')
  } finally {
    fs.rmSync(conversations)
    fs.renameSync(moved, conversations)
  }
})

test("forget --purge says pi's copy was not found when there is no path, or nothing there, and never guesses", async () => {
  // Named like the session, so a search by session id would find it.
  await stoppedWith('unreported', null)
  const lookalike = conversation(status('unreported').sessionId)
  refusedPurge('unreported', /pi's copy was not found: status\.json has no sessionFile/)
  assert.equal(fs.readFileSync(lookalike, 'utf8'), 'conversation')

  await stoppedWith('gone', path.join(conversations, '--project--', 'never-written.jsonl'))
  refusedPurge('gone', /pi's copy was not found: nothing at/)

  // A status file that is unreadable, or holds something that is no path.
  await stoppedWith('garbled', null)
  fs.writeFileSync(path.join(root, 'garbled', 'status.json'), 'not json')
  refusedPurge('garbled', /no sessionFile/)
  await stoppedWith('typed', null)
  for (const sessionFile of [7, ['a'], 'relative/path.jsonl']) {
    fs.writeFileSync(path.join(root, 'typed', 'status.json'), JSON.stringify({ state: 'stopped', sessionFile }))
    const refused = cliFails('forget', 'typed', '--purge')
    assert.match(refused.out, /not an absolute path/)
    assert.ok(fs.existsSync(path.join(root, 'typed', 'status.json')))
  }
  cli('forget', 'typed')
})

test('forget --purge that cannot delete the file keeps the session too', { skip: process.getuid?.() === 0 }, async () => {
  const mine = conversation('locked')
  await stoppedWith('locked', mine)
  fs.chmodSync(path.dirname(mine), 0o555)
  try {
    refusedPurge('locked', /EACCES/)
    assert.ok(fs.existsSync(mine))
  } finally {
    fs.chmodSync(path.dirname(mine), 0o755)
  }
})

test('--purge means nothing in the commands that do not take it, and forget takes nothing else', async () => {
  const child = await serve('words-purge')
  const id = cli('send', 'words-purge', 'mention', '--purge', 'here').trim()
  assert.equal(cli('wait', 'words-purge', id, '--timeout', '5'), 'echo: mention --purge here\n')
  cli('stop', 'words-purge')
  await until(() => status('words-purge').state === 'stopped')
  child.kill()
  // A mistyped flag would otherwise lose the only record of where pi's copy is.
  assert.match(cliFails('forget', 'words-purge', '--purg').out, /takes one name.*Nothing was deleted/)
  assert.ok(fs.existsSync(path.join(root, 'words-purge', 'status.json')))
  cli('forget', 'words-purge')
})
