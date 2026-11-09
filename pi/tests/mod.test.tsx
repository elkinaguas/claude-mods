import { expect, test } from 'claude-code/testing'

import {
  bashRefusal,
  daysLeft,
  parseTrustedHosts,
  reachesPiDir,
  resolvePath,
  runsExcluded,
  sandboxEscapes,
  sandboxSetting,
  settingsProblems,
  optionsText,
  writesOptions,
} from '../hooks/register'

declare const setTimeout: (fn: (value?: unknown) => void, ms: number) => unknown

const HOME = '/home/u'

const goodSettings = {
  sandbox: {
    enabled: true,
    network: { tlsTerminate: { caCertPath: '/home/u/ca/ca.crt', caKeyPath: '/home/u/ca/ca.key' } },
    credentials: { files: [{ path: '/home/u/.pi/agent/auth.json', mode: 'mask', injectHosts: ['opencode.ai'] }] },
  },
  permissions: { deny: ['Edit(//home/u/.pi/agent/auth.json)'] },
}

test('paths resolve ~, relative parts and ..', () => {
  expect(resolvePath('~/.pi/x', '/w', HOME)).toBe('/home/u/.pi/x')
  expect(resolvePath('../u/.pi', '/home/proj', HOME)).toBe('/home/u/.pi')
  expect(resolvePath('src/a.ts', '/home/u/proj', HOME)).toBe('/home/u/proj/src/a.ts')
})

test('the guard catches every way a file tool reaches ~/.pi', () => {
  const hit = (tool: string, input: Record<string, unknown>) => reachesPiDir(tool, input, '/home/u/proj', HOME)
  expect(hit('Read', { file_path: '/home/u/.pi/agent/auth.json' })).toBe('/home/u/.pi/agent/auth.json')
  expect(hit('Read', { file_path: '../.pi/agent/settings.json' })).toBe('/home/u/.pi/agent/settings.json')
  expect(hit('Edit', { file_path: '~/.pi/agent/auth.json' })).toBe('/home/u/.pi/agent/auth.json')
  expect(hit('Grep', { pattern: 'key', path: '/home/u' })).toBe('a search of /home/u')
  expect(hit('Grep', { pattern: 'key', path: '/home/u/proj', glob: '**/auth.json' })).toBe('the pattern **/auth.json')
  expect(hit('Glob', { pattern: '~/.pi/**' })).toBe('the pattern ~/.pi/**')
  expect(hit('Glob', { pattern: '/home/u/**/*.json' })).toBe('the pattern /home/u/**/*.json')
  expect(hit('Grep', { pattern: 'key', path: '/home' })).toBe('a search of /home')
  expect(hit('Glob', { pattern: '**/*.json', path: '/' })).toBe('a search of /')
  expect(reachesPiDir('Grep', { pattern: 'key' }, HOME, HOME)).toBe('a search of /home/u')
  expect(reachesPiDir('Glob', { pattern: '**/*' }, HOME, HOME)).toBe('a search of /home/u')
  expect(reachesPiDir('Glob', { pattern: '/home/u/proj/**' }, HOME, HOME)).toBe(null)
})

test('a relative Glob pattern that climbs out to ~/.pi is caught', () => {
  const hit = (input: Record<string, unknown>) => reachesPiDir('Glob', input, '/home/u/proj', HOME)
  expect(hit({ pattern: '../.p*/agent/*' })).toBe('the pattern ../.p*/agent/*')
  expect(hit({ pattern: '../../u/.p?/**' })).toBe('the pattern ../../u/.p?/**')
  expect(hit({ pattern: '*/agent/*', path: '/home/u/.pi' })).toBe('/home/u/.pi')
  expect(hit({ pattern: '../other/*.ts' })).toBe(null)
  expect(hit({ pattern: 'src/**/*.ts' })).toBe(null)
})

test('the guard lets ordinary calls through', () => {
  const hit = (tool: string, input: Record<string, unknown>) => reachesPiDir(tool, input, '/home/u/proj', HOME)
  expect(hit('Read', { file_path: '/home/u/proj/README.md' })).toBe(null)
  expect(hit('Read', { file_path: '/home/u/.pirate/notes' })).toBe(null)
  expect(hit('Grep', { pattern: 'func main' })).toBe(null)
  expect(hit('Glob', { pattern: 'src/**/*.ts' })).toBe(null)
  expect(hit('Bash', { command: 'cat ~/.pi/agent/auth.json' })).toBe(null)
})

test('a file tool call into ~/.pi is refused before it runs', async ($, on) => {
  on('env.get', () => ({ value: HOME }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false, realPath: '/home/u/proj/README.md' } }))
  on('tool.call', () => ({ result: {} }))
  const refused = await $.tool.call({ tool: 'Read', file_path: '/home/u/.pi/agent/auth.json' })
  expect(refused.deny).toMatch(/holds your provider key/)
  const allowed = await $.tool.call({ tool: 'Read', file_path: '/home/u/proj/README.md' })
  expect(allowed.deny).toBe(undefined)
})

test('a Bash call that asks to leave the sandbox is refused when it reaches pi', async ($, on) => {
  on('env.get', () => ({ value: HOME }))
  on('fs.read', (_, e) => {
    if (e.path === '/home/u/.claude/settings.json') return { value: JSON.stringify(goodSettings) }
    throw new Error('missing')
  })
  on('tool.call', () => ({ result: {} }))
  const refused = await $.tool.call({ tool: 'Bash', command: 'node /x/pi-session.mjs serve demo', dangerouslyDisableSandbox: true } as never)
  expect(refused.deny).toMatch(/outside the Bash sandbox/)
  const allowed = await $.tool.call({ tool: 'Bash', command: 'node /x/pi-session.mjs status' } as never)
  expect(allowed.deny).toBe(undefined)
})

test('with allowUnsandboxed on, serve may start outside the sandbox, and the command is not changed', { options: { allowUnsandboxed: true } }, async ($, on) => {
  on('env.get', () => ({ value: HOME }))
  const seen: string[] = []
  on('tool.call', (_, e) => {
    seen.push(String((e as unknown as { command?: string }).command))
    return { result: {} }
  })
  const ran = await $.tool.call({ tool: 'Bash', command: 'node /x/pi-session.mjs serve demo', dangerouslyDisableSandbox: true } as never)
  expect(ran.deny).toBe(undefined)
  expect(seen.at(-1)).toBe('node /x/pi-session.mjs serve demo')
  // auth.json stays out of reach even then.
  const cat = await $.tool.call({ tool: 'Bash', command: 'cat ~/.pi/agent/auth.json', dangerouslyDisableSandbox: true } as never)
  expect(cat.deny).toMatch(/names auth\.json/)
})

test('a search rooted at a link into ~/.pi is refused', async ($, on) => {
  on('env.get', () => ({ value: HOME }))
  const real: Record<string, string> = {
    '/home/u/proj/notes.txt': '/home/u/.pi/agent/auth.json',
    '/home/u/proj/cfg': '/home/u/.pi/agent',
    '/home/u/proj/up': '/home',
  }
  on('fs.stat', (_, e) => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: e.path in real, realPath: real[e.path] ?? e.path } }))
  on('tool.call', () => ({ result: {} }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', () => {
    throw new Error('missing')
  })
  on('fs.list', () => ({ value: [] }))
  on('clock.now', () => ({ value: 0 }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'pi' } }))
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/home/u/proj', surface: 'terminal', isInteractive: true })
  const grepFile = await $.tool.call({ tool: 'Grep', pattern: '.', path: 'notes.txt', output_mode: 'content' } as never)
  expect(grepFile.deny).toMatch(/notes\.txt \(a link to \/home\/u\/\.pi\/agent\/auth\.json\)/)
  expect((await $.tool.call({ tool: 'Grep', pattern: 'key', path: 'cfg' } as never)).deny).toMatch(/a link to \/home\/u\/\.pi\/agent/)
  expect((await $.tool.call({ tool: 'Glob', pattern: '**/*', path: 'up' } as never)).deny).toMatch(/a link to \/home\)/)
  expect((await $.tool.call({ tool: 'Grep', pattern: 'func main', path: 'src' } as never)).deny).toBe(undefined)
  expect((await $.tool.call({ tool: 'Grep', pattern: 'func main' } as never)).deny).toBe(undefined)
})

test('a link that leads into ~/.pi is refused too', async ($, on) => {
  on('env.get', () => ({ value: HOME }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: true, realPath: '/home/u/.pi/agent/auth.json' } }))
  on('tool.call', () => ({ result: {} }))
  const refused = await $.tool.call({ tool: 'Read', file_path: '/home/u/proj/innocent.txt' })
  expect(refused.deny).toMatch(/\/home\/u\/\.pi\/agent\/auth\.json/)
})

test('the setup check accepts the working setup', () => {
  expect(settingsProblems(JSON.stringify(goodSettings), HOME)).toEqual([])
})

test('the setup check names each broken piece', () => {
  const off = { ...goodSettings, sandbox: { ...goodSettings.sandbox, enabled: false } }
  expect(settingsProblems(JSON.stringify(off), HOME).join()).toMatch(/sandbox is off/)

  const noTls = { ...goodSettings, sandbox: { ...goodSettings.sandbox, network: {} } }
  expect(settingsProblems(JSON.stringify(noTls), HOME).join()).toMatch(/401 Invalid credential/)

  const readRule = { ...goodSettings, permissions: { deny: ['Read(//home/u/.pi/agent/auth.json)'] } }
  expect(settingsProblems(JSON.stringify(readRule), HOME).join()).toMatch(/turns the mask into a block/)

  const unmasked = { ...goodSettings, sandbox: { ...goodSettings.sandbox, credentials: { files: [] } } }
  expect(settingsProblems(JSON.stringify(unmasked), HOME).join()).toMatch(/is not masked/)

  expect(settingsProblems('{ "sandbox": ', HOME).join()).toMatch(/does not parse/)
  expect(settingsProblems(null, HOME).join()).toMatch(/missing/)
})

test('Bash: other spellings of the key file, SANDBOX_RUNTIME and excluded commands', () => {
  const off = { unsandboxed: true, allowUnsandboxed: false }
  const allowed = { unsandboxed: true, allowUnsandboxed: true }
  const on = { unsandboxed: false, allowUnsandboxed: false }
  expect(bashRefusal('cat ~/.p?/agent/auth*', off)).toMatch(/names auth\.json/)
  expect(bashRefusal('cat ~/.p"i"/agent/a*.json', allowed)).toMatch(/names auth\.json/)
  expect(bashRefusal('ls ~/.p\\i/agent', off)).toMatch(/outside the Bash sandbox/)
  expect(bashRefusal('SANDBOX_RUNTIME=1 node /x/pi-session.mjs serve x', on)).toMatch(/set by the sandbox itself/)
  expect(bashRefusal('export SANDBOX_""RUNTIME=1', on)).toMatch(/set by the sandbox itself/)
  expect(bashRefusal('npm test -- auth', allowed)).toBe(null)
  // Naming it is fine; only setting it is refused.
  expect(bashRefusal('grep -n SANDBOX_RUNTIME pi/scripts/pi-session.mjs', on)).toBe(null)
  expect(bashRefusal('unset SANDBOX_RUNTIME; node x', on)).toMatch(/set by the sandbox itself/)
  expect(bashRefusal('PI_SESSION_PI=/bin/sh node /x/pi-session.mjs serve x', on)).toMatch(/PI_SESSION_PI is for the mod/)
})

test('trusted model hosts: parsed from the option, valid entries only', () => {
  expect(parseTrustedHosts('llm.corp.example.com, *.corp.example.com:8443 localhost:* [::1]:8080 bad/host')).toEqual({
    valid: ['llm.corp.example.com', '*.corp.example.com:8443', 'localhost:*', '[::1]:8080'],
    invalid: ['bad/host'],
  })
  expect(parseTrustedHosts(undefined)).toEqual({ valid: [], invalid: [] })
})

test('the mod writes the options file pi-session reads when a session starts', { options: { trustedModelHosts: 'llm.corp.example.com bad/host', allowUnsandboxed: true } }, async ($, on) => {
  on('env.get', () => ({ value: HOME }))
  const writes: { path: string; text: string }[] = []
  on('fs.write', (_, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('fs.read', () => {
    throw new Error('missing')
  })
  on('fs.list', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 0 }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'pi' } }))
  on('ui.toast', () => ({ value: undefined }))
  const before = Date.now()
  await $.session.start({ cwd: '/home/u/proj', surface: 'terminal', isInteractive: true })
  const options = writes.filter(w => w.path === '/home/u/.claude/plugins/data/pi/options.json')
  expect(options.length).toBe(1)
  const o = JSON.parse(options[0]!.text)
  expect(o.allowUnsandboxed).toBe(true)
  expect(o.trustedModelHosts).toEqual(['llm.corp.example.com'])
  expect(o.writtenAt >= before && o.writtenAt <= Date.now()).toBe(true)
  expect(JSON.parse(optionsText({ allowUnsandboxed: false, trustedHosts: [] }, 5))).toEqual({ allowUnsandboxed: false, trustedModelHosts: [], writtenAt: 5 })
})

test("Claude's file tools can't write the options file, also through a link; reading it is fine", async ($, on) => {
  on('env.get', () => ({ value: HOME }))
  const real: Record<string, string> = { '/home/u/proj/opts.json': '/home/u/.claude/plugins/data/pi/options.json' }
  on('fs.stat', (_, e) => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: e.path in real, realPath: real[e.path] ?? e.path } }))
  on('tool.call', () => ({ result: {} }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.read', () => {
    throw new Error('missing')
  })
  on('fs.list', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 0 }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'pi' } }))
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/home/u/proj', surface: 'terminal', isInteractive: true })
  const file = '/home/u/.claude/plugins/data/pi/options.json'
  expect((await $.tool.call({ tool: 'Write', file_path: file, content: '{}' } as never)).deny).toMatch(/only the mod writes/)
  expect((await $.tool.call({ tool: 'Edit', file_path: '~/.claude/plugins/data/pi/options.json', old_string: 'a', new_string: 'b' } as never)).deny).toMatch(/only the mod writes/)
  expect((await $.tool.call({ tool: 'Write', file_path: 'opts.json', content: '{}' } as never)).deny).toMatch(/a link to .*options\.json\) is the pi mod's options file/)
  expect((await $.tool.call({ tool: 'Read', file_path: file } as never)).deny).toBe(undefined)
  expect(writesOptions('Write', { file_path: '/home/u/.claude/plugins/data/pix/x' }, '/w', HOME)).toBe(null)
})

test('the mod never rewrites a Bash command, whatever its options, so auto mode runs what it reviewed', { options: { trustedModelHosts: 'llm.corp', allowUnsandboxed: true } }, async ($, on) => {
  on('env.get', () => ({ value: HOME }))
  on('fs.read', (_, e) => {
    if (e.path === '/home/u/.claude/settings.json') return { value: JSON.stringify(goodSettings) }
    throw new Error('missing')
  })
  const seen: string[] = []
  on('tool.call', (_, e) => {
    seen.push(String((e as unknown as { command?: string }).command))
    return { result: {} }
  })
  for (const command of [
    'node /x/pi-session.mjs serve corp --model corp/m',
    'node /x/pi-session.mjs run demo --model corp/m --file p.md',
    'cat > notes.md <<EOF\nnode /x/pi-session.mjs run demo\nEOF',
    'timeout 900 node /x/pi-session.mjs run demo "hi"',
    'git commit -m "pi: pi-session run --trusted-hosts is gone"',
  ]) {
    expect((await $.tool.call({ tool: 'Bash', command } as never)).deny).toBe(undefined)
    expect(seen.at(-1)).toBe(command)
  }
})

test('the guard treats run as it does serve', () => {
  const on = { unsandboxed: false, allowUnsandboxed: false }
  const off = { unsandboxed: true, allowUnsandboxed: false }
  const allowed = { unsandboxed: true, allowUnsandboxed: true }
  const run = 'node /x/pi-session.mjs run demo --model opencode-go/echo "hi"'
  expect(bashRefusal(run, on)).toBe(null)
  expect(bashRefusal(run, off)).toMatch(/outside the Bash sandbox/)
  expect(bashRefusal(run, allowed)).toBe(null)
  // pi-session refuses the old flags itself, so the guard no longer reads them.
  expect(bashRefusal(`${run} --trusted-hosts api.openai.com`, on)).toBe(null)
  expect(bashRefusal(`PI_SESSION_OPTIONS=/tmp/o.json ${run}`, on)).toMatch(/PI_SESSION_OPTIONS is for the mod/)
  expect(bashRefusal('echo {} > ~/.claude/plugins/data/pi/options.json', allowed)).toMatch(/names the pi mod's options file/)
  expect(bashRefusal('cp x ~/.claude/plugins/data/p?/options.json', off)).toMatch(/names the pi mod's options file/)
  expect(bashRefusal('cat ~/.claude/plugins/data/pi/options.json', on)).toBe(null)
  expect(bashRefusal(`SANDBOX_RUNTIME=1 ${run}`, on)).toMatch(/set by the sandbox itself/)
  expect(bashRefusal(`PI_SESSION_PI=/bin/sh ${run}`, on)).toMatch(/PI_SESSION_PI is for the mod/)
})

test('a Bash run outside the sandbox is refused, and other commands go through unchanged', async ($, on) => {
  on('env.get', () => ({ value: HOME }))
  on('fs.read', (_, e) => {
    if (e.path === '/home/u/.claude/settings.json') return { value: JSON.stringify(goodSettings) }
    throw new Error('missing')
  })
  const seen: string[] = []
  on('tool.call', (_, e) => {
    seen.push(String((e as unknown as { command?: string }).command))
    return { result: {} }
  })
  const bash = (command: string, more = {}) => $.tool.call({ tool: 'Bash', command, ...more } as never)
  const run = 'node /x/pi-session.mjs run demo --model opencode-go/echo --file p.md'
  expect((await bash(run, { dangerouslyDisableSandbox: true })).deny).toMatch(/outside the Bash sandbox/)
  expect(seen).toEqual([])
  // Inside the sandbox with no options set, it goes through untouched.
  expect((await bash(run)).deny).toBe(undefined)
  expect(seen).toEqual([run])
})

test('with allowUnsandboxed on, run may start outside the sandbox, and the command is not changed', { options: { allowUnsandboxed: true } }, async ($, on) => {
  on('env.get', () => ({ value: HOME }))
  const seen: string[] = []
  on('tool.call', (_, e) => {
    seen.push(String((e as unknown as { command?: string }).command))
    return { result: {} }
  })
  const ran = await $.tool.call({ tool: 'Bash', command: 'node /x/pi-session.mjs run demo --file p.md', dangerouslyDisableSandbox: true } as never)
  expect(ran.deny).toBe(undefined)
  expect(seen.at(-1)).toBe('node /x/pi-session.mjs run demo --file p.md')
})

test("Claude's instructions cover run, and status over old task output after a restart", async ($, on) => {
  on('prompt.compose', () => ({ sections: [] }))
  const { sections } = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })
  const text = sections.find(s => s.id === 'pi:sessions')?.text ?? ''
  expect(text).toMatch(/`run <name> --model <provider>\/<id> .*--file <prompt file>`.* with run_in_background/)
  expect(text).toMatch(/`--keep` leaves the session running/)
  expect(text).toMatch(/Sessions never stop for questions/)
  expect(text).not.toMatch(/`answer|exit 3/)
  expect(text).toMatch(/`serve` and `run` refuse to start outside the sandbox/)
  expect(text).toMatch(/After a restart, use `status <name>`.*Never go by the output of a task from before the restart/)
  expect(text).toMatch(/add `--out FILE` to write it to a file/)
  expect(text).toMatch(/`send <name> --format findings "<prompt>"`.*exits 4/)
  expect(text).not.toMatch(/--purge/)
})

test('without the sandbox the check says so once, not the mask and TLS lines that only act inside it', () => {
  const off = JSON.stringify({ sandbox: { enabled: false } })
  const problems = settingsProblems(off, HOME)
  expect(problems.length).toBe(1)
  expect(problems[0]).toMatch(/sandbox is off.*refuses to start pi/)
})

test('the opencode-go gate: pi only through pi-session, the key only on opencode.ai', () => {
  const on = { unsandboxed: false, allowUnsandboxed: false }
  for (const c of ['pi --list-models', 'pi auth print anthropic', 'cd x && pi -p "hi" --provider anthropic', '~/.npm-global/bin/pi --mode rpc'])
    expect(bashRefusal(c, on)).toMatch(/run pi only through pi-session.*only with an opencode-go API key/)
  expect(bashRefusal('node /x/pi/scripts/pi-session.mjs serve demo --model opencode-go/glm-5.3', on)).toBe(null)
  expect(bashRefusal('ls pi/tests && git log -- pi', on)).toBe(null)
  const wide = {
    ...goodSettings,
    sandbox: { ...goodSettings.sandbox, credentials: { files: [{ path: '/home/u/.pi/agent/auth.json', mode: 'mask', injectHosts: ['opencode.ai', 'api.anthropic.com'] }] } },
  }
  expect(settingsProblems(JSON.stringify(wide), HOME).join()).toMatch(/also put back on api\.anthropic\.com.*only with an opencode-go API key/)
  expect(runsExcluded('docker run -v ~/.pi/agent:/k alpine cat /k/auth.json', ['docker'])).toBe(true)
  expect(runsExcluded('cd x && FOO=1 sudo /usr/bin/docker ps', ['docker:*'])).toBe(true)
  expect(runsExcluded('ls; git status', ['docker'])).toBe(false)
  expect(sandboxEscapes([JSON.stringify({ sandbox: { excludedCommands: ['docker'], allowUnsandboxedCommands: true } }), null, '{'])).toEqual({ excluded: ['docker'], unsandboxedAllowed: true })
})

test('each Bash call reads the settings again, so a sandbox turned off mid-session or an excluded command counts as unsandboxed', async ($, on) => {
  on('env.get', () => ({ value: HOME }))
  on('tool.call', () => ({ result: {} }))
  let user = JSON.stringify(goodSettings)
  on('fs.read', (_, e) => {
    if (e.path === '/home/u/.claude/settings.json') return { value: user }
    throw new Error('missing')
  })
  const serveCmd = { tool: 'Bash', command: 'node /x/pi-session.mjs serve demo' } as never
  expect((await $.tool.call(serveCmd)).deny).toBe(undefined)
  user = JSON.stringify({ ...goodSettings, sandbox: { ...goodSettings.sandbox, enabled: false } })
  expect((await $.tool.call(serveCmd)).deny).toMatch(/outside the Bash sandbox/)
  user = JSON.stringify({ ...goodSettings, sandbox: { ...goodSettings.sandbox, excludedCommands: ['docker'] } })
  expect((await $.tool.call({ tool: 'Bash', command: 'docker run -v ~/.pi/agent:/k alpine cat /k/auth.json' } as never)).deny).toMatch(/names auth\.json/)
  expect((await $.tool.call(serveCmd)).deny).toBe(undefined)
})

test('the sandbox setting is read from the file that wins', () => {
  const user = JSON.stringify(goodSettings)
  const off = JSON.stringify({ sandbox: { enabled: false } })
  expect(sandboxSetting([], user)).toEqual({ enabled: true, source: '~/.claude/settings.json' })
  expect(sandboxSetting([{ name: '.claude/settings.local.json', text: off }], user)).toEqual({ enabled: false, source: '.claude/settings.local.json' })
  // A layer that does not set it, or does not exist, leaves it to the next.
  expect(sandboxSetting([{ name: 'managed settings', text: null }, { name: '.claude/settings.json', text: '{}' }], user).enabled).toBe(true)
  expect(settingsProblems(user, HOME, [{ name: '.claude/settings.json', text: off }]).join()).toMatch(/sandbox is off \(\.claude\/settings\.json\)/)
})

test('unsandboxed, Bash commands that reach pi or its key are refused', () => {
  const off = { unsandboxed: true, allowUnsandboxed: false }
  const on = { unsandboxed: false, allowUnsandboxed: false }
  const allowed = { unsandboxed: true, allowUnsandboxed: true }
  expect(bashRefusal('node /x/pi-session.mjs serve demo', off)).toMatch(/outside the Bash sandbox/)
  expect(bashRefusal('cat ~/.pi/agent/auth.json', off)).toMatch(/names auth\.json/)
  expect(bashRefusal('pi --mode rpc', off)).toMatch(/run pi only through pi-session/)
  expect(bashRefusal('ls ~/.pi', off)).toMatch(/outside the Bash sandbox/)
  expect(bashRefusal('git status', off)).toBe(null)
  expect(bashRefusal('ls pi/tests', off)).toBe(null)
  // Sandboxed, pi-session runs; its way past the sandbox is the person's to allow.
  expect(bashRefusal('node /x/pi-session.mjs serve demo', on)).toBe(null)
  expect(bashRefusal('node /x/pi-session.mjs serve demo', allowed)).toBe(null)
  expect(bashRefusal('cat ~/.pi/agent/auth.json', allowed)).toMatch(/names auth\.json/)
})

test('CA expiry is read from openssl output', () => {
  const now = Date.parse('2026-10-28T00:00:00Z')
  expect(daysLeft('notAfter=Oct 28 17:03:57 2027 GMT\n', now)).toBe(365)
  expect(daysLeft('notAfter=Oct 20 00:00:00 2026 GMT', now)).toBe(-8)
  expect(daysLeft('garbage', now)).toBe(null)
})

const PANE = {
  plugin: 'pi',
  component: 'Pane',
  requestId: 'pi',
  props: { title: 'pi sessions', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('the panel lists sessions from their status files', async ($, on) => {
  const now = Date.parse('2026-10-28T18:00:00Z')
  const status = {
    demo: { state: 'busy', cwd: '/home/u/proj', model: 'opencode-go/glm-5.3', heartbeatAt: now - 1000, lastActivity: now - 5000, lastTool: 'read src/a.ts' },
    old: { state: 'idle', cwd: '/home/u/x', model: 'opencode-go/glm-5.3', heartbeatAt: now - 600000, lastActivity: now - 600000 },
  } as Record<string, object>
  on('env.get', () => ({ value: HOME }))
  on('clock.now', () => ({ value: now }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'pi' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  const dirEntry = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
  on('fs.list', () => ({ value: [dirEntry('demo'), dirEntry('old')] }))
  on('fs.read', (_, e) => {
    const m = /claude-sessions\/(\w+)\/status\.json$/.exec(e.path)
    if (m) return { value: JSON.stringify(status[m[1]!]) }
    if (e.path.endsWith('/.claude/settings.json')) return { value: JSON.stringify(goodSettings) }
    throw new Error('missing')
  })
  on('process.run', () => ({
    value: { exitCode: 0, stdout: 'notAfter=Oct 28 17:03:57 2027 GMT\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/home/u/proj', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^demo/ }))?.text).toMatch(/demo busy 5s/)
  expect((await ui.find({ type: 'Text', text: /→ read src\/a\.ts/ }))?.text).toBe('→ read src/a.ts')
  // One tile per session; the busy one is picked before the lost one.
  expect(await ui.find({ key: 'session:demo' })).toBeDefined()
  expect(await ui.find({ key: 'session:old' })).toBeDefined()
  expect(await ui.find({ key: 'abort' })).toBeDefined()
  expect(await ui.find({ key: 'forget' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /~\/proj/ }))?.text).toMatch(/opencode-go\/glm-5\.3 {2}~\/proj/)
  // Pressing a tile shows that session's card instead. Its heartbeat
  // stopped ten minutes ago: the serve is gone.
  await ui.press({ key: 'session:old' })
  expect((await ui.find({ type: 'Text', text: /^old/ }))?.text).toMatch(/old lost 10m/)
  expect((await ui.find({ type: 'Text', text: /~\/x/ }))?.text).toMatch(/~\/x/)
  expect(await ui.find({ key: 'abort' })).toBeUndefined()
  expect(await ui.find({ key: 'forget' })).toBeDefined()
  expect(await ui.find({ key: 'resume' })).toBeDefined()
  await ui.unmount()
})

// One session and a hand on the poll: each tick() lets one period of
// clock.every through, then waits for what it set off.
const pollingPane = async ($: any, on: any, session: object, startAt: number) => {
  const clock = { now: startAt, panes: [] as object[], writes: [] as string[] }
  let release = () => {}
  on('env.get', () => ({ value: HOME }))
  on('clock.now', () => ({ value: clock.now }))
  on('clock.every', () => new Promise(resolve => (release = () => resolve({ value: undefined }))))
  on('command.register', () => ({ value: { command: 'pi' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: clock.panes }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [{ name: 'demo', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }] }))
  on('fs.read', (_: unknown, e: { path: string }) => {
    if (e.path.endsWith('/demo/status.json')) return { value: JSON.stringify(session) }
    throw new Error('missing')
  })
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/home/u/proj', surface: 'terminal', isInteractive: true })
  const tick = async () => {
    release()
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return { clock, tick }
}

const OPEN = { id: 'pi', title: 'pi sessions', isShown: true, isFocused: false, isPlaced: true }
const T0 = Date.parse('2026-10-28T18:00:00Z')

test('a busy card counts from the run start, and the poll moves it while the pane is open', async ($, on) => {
  const session = { state: 'busy', heartbeatAt: T0 + 3600000, lastActivity: T0 - 1000, runStartedAt: T0 - 30000 }
  const { clock, tick } = await pollingPane($, on, session, T0)
  clock.panes = [OPEN]
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^demo/ }))?.text).toMatch(/demo busy 30s/)
  clock.now += 10000
  await tick()
  expect((await ui.find({ type: 'Text', text: /^demo/ }))?.text).toMatch(/demo busy 40s/)
  await ui.unmount()
})

test('an idle card keeps the time since the last activity', async ($, on) => {
  const session = { state: 'idle', heartbeatAt: T0 + 3600000, lastActivity: T0 - 7000, runStartedAt: T0 - 30000 }
  const { clock, tick } = await pollingPane($, on, session, T0)
  clock.panes = [OPEN]
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^demo/ }))?.text).toMatch(/demo idle 7s/)
  clock.now += 2000
  await tick()
  expect((await ui.find({ type: 'Text', text: /^demo/ }))?.text).toMatch(/demo idle 9s/)
  await ui.unmount()
})

test('with the pane closed or behind another tab, the poll redraws nothing', async ($, on) => {
  const session = { state: 'busy', heartbeatAt: T0 + 3600000, lastActivity: T0 - 1000, runStartedAt: T0 - 30000 }
  const { clock, tick } = await pollingPane($, on, session, T0)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const panes of [[], [{ ...OPEN, isShown: false }]]) {
    clock.panes = panes
    clock.now += 10000
    await tick()
    expect((await ui.find({ type: 'Text', text: /^demo/ }))?.text).toMatch(/demo busy 30s/)
  }
  // The same poll with the pane on screen does redraw, so the above is not a dead poll.
  clock.panes = [OPEN]
  await tick()
  expect((await ui.find({ type: 'Text', text: /^demo/ }))?.text).toMatch(/demo busy 50s/)
  await ui.unmount()
})

test('/pi check reports settings that do not parse instead of failing', async ($, on) => {
  on('env.get', () => ({ value: HOME }))
  on('fs.read', (_, e) => {
    if (e.path.endsWith('/.claude/settings.json')) return { value: '{ "sandbox": ' }
    throw new Error('missing')
  })
  const ran = await $.command.run({ command: 'pi', args: 'check', origin: { kind: 'user' }, presentation: { isFullscreen: false, columns: 120 } } as never)
  expect(JSON.stringify(ran)).toMatch(/does not parse/)
})
