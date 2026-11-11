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
  keepPlace,
  liveRows,
  liveWindow,
  optionsText,
  usageLine,
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

test('Bash: a heredoc fed to cat or tee is data, one a shell or interpreter could run is checked', () => {
  const on = { unsandboxed: false, allowUnsandboxed: false }
  const off = { unsandboxed: true, allowUnsandboxed: false }
  const body = 'Models:\npi --list-models\npi auth print anthropic\n'
  // Written to a file, or printed: <<WORD, <<'WORD', <<"WORD", <<-WORD, several in one command.
  for (const c of [
    `cat > notes.md <<'EOF'\n${body}EOF`,
    `cat <<"EOF" > notes.md\n${body}EOF`,
    `cat > notes.md <<EOF\n${body}EOF\necho done`,
    `tee -a notes.md <<-EOF\n\tpi --mode rpc\n\tEOF`,
    `cat <<\\EOF\n${body}EOF`,
    `cat > one.md <<'A' && cat > two.md <<'B'\n${body}A\n${body}B\n`,
    `mkdir -p docs\ncat > docs/one.md <<'A'\n${body}A\ncat >> docs/two.md <<'B' 2>/dev/null\n${body}B`,
  ])
    expect(bashRefusal(c, on)).toBe(null)
  expect(bashRefusal(`cat > notes.md <<'EOF'\nsee ~/.pi/agent\nEOF`, off)).toBe(null)
  // Run as shell commands, or by an interpreter that could start pi itself.
  for (const c of [
    `bash <<'EOF'\n${body}EOF`,
    `sh -s <<EOF\n${body}EOF`,
    `cat <<'EOF' | bash\n${body}EOF`,
    `{ cat <<'EOF'\n${body}EOF\n} | sh`,
    `cat > run.sh <<'EOF'\n${body}EOF\nbash run.sh`,
    `cat > run.sh <<'EOF'\n${body}EOF\nchmod +x run.sh && ./run.sh`,
    `cat > /tmp/d/run <<'EOF'\n${body}EOF\n/tmp/d/*`,
    `$(cat <<'EOF'\n${body}EOF\n)`,
    `eval "$(cat <<'EOF'\n${body}EOF\n)"`,
    `source /dev/stdin <<'EOF'\n${body}EOF`,
    `cat() { bash; }; cat <<'EOF'\n${body}EOF`,
    `cat <<'EOF' > >(bash)\n${body}EOF`,
    `python3 <<'EOF'\nimport os; os.system("pi auth print anthropic")\nEOF`,
    `python3 - <<'EOF'\nnew = """\npi --list-models\n"""\nEOF`,
    // An unquoted delimiter runs $( ) in the body.
    `cat > notes.md <<EOF\n$(pi auth print anthropic)\nEOF`,
    // Unterminated: bash reads to the end, so everything stays checked.
    `cat > notes.md <<'EOF'\n${body}`,
    // Not a heredoc: a comment, or a line after the heredoc.
    `cat # <<'EOF'\n${body}EOF`,
    `cat > notes.md <<'EOF'\nhi\nEOF\npi auth print anthropic`,
  ])
    expect(bashRefusal(c, on)).toMatch(/run pi only through pi-session/)
  // The refusal says what matched, and what to use instead.
  expect(bashRefusal('ls && pi --list-models', on)).toMatch(/read as running pi at: pi --list-models\. If it only mentions pi in its text, use the Edit or Write tool/)
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
  expect(text).toMatch(/`--model` may be left out when pi's own default model .* passes the gate/)
  expect(text).toMatch(/`models` lists the model ids the gate allows/)
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

test('the usage line shows turns, tokens and cost, each only when there is one', () => {
  expect(usageLine({ turns: 0, tokens: null, cost: null })).toBe('')
  expect(usageLine({ turns: 1, tokens: null, cost: null })).toBe('1 turn')
  expect(usageLine({ turns: 12, tokens: 48210, cost: 0.0312 })).toBe('12 turns · 48.2k tok · $0.031')
  expect(usageLine({ turns: 3, tokens: 950, cost: null })).toBe('3 turns · 950 tok')
  expect(usageLine({ turns: 3, tokens: 99960, cost: 0.0004 })).toBe('3 turns · 100k tok · <$0.001')
  expect(usageLine({ turns: 80, tokens: 999600, cost: 12.345 })).toBe('80 turns · 1.0M tok · $12.35')
  expect(usageLine({ turns: 200, tokens: 123456789, cost: null })).toBe('200 turns · 123M tok')
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
    demo: {
      state: 'busy',
      cwd: '/home/u/proj',
      model: 'opencode-go/glm-5.3',
      heartbeatAt: now - 1000,
      lastActivity: now - 5000,
      lastTool: 'read src/a.ts',
      turns: 12,
      usage: { input: 30000, output: 2200, cacheRead: 15000, cacheWrite: 1000, cost: 0.031 },
    },
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
  expect((await ui.find({ type: 'Text', text: /^demo/ }))?.text).toMatch(/demo busy 5s · 12 turns · 48\.2k tok · \$0\.031$/)
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
  // A status.json from before the counts shows none of them.
  expect((await ui.find({ type: 'Text', text: /^old/ }))?.text).toMatch(/old lost 10m$/)
  expect((await ui.find({ type: 'Text', text: /~\/x/ }))?.text).toMatch(/~\/x/)
  expect(await ui.find({ key: 'abort' })).toBeUndefined()
  expect(await ui.find({ key: 'forget' })).toBeDefined()
  expect(await ui.find({ key: 'resume' })).toBeDefined()
  await ui.unmount()
})

// One session and a hand on the poll: each tick() lets one period of
// clock.every through, then waits for what it set off.
// `files` are the session's other files by name (live.json), `links` the names that are links;
// `reads` counts what was read of them.
const pollingPane = async ($: any, on: any, session: object, startAt: number, files: Record<string, string> = {}, links: string[] = []) => {
  const clock = { now: startAt, panes: [] as object[], writes: [] as string[], reads: [] as string[] }
  // Every timer's period waits for the next tick (the poll's, and an open Live view's).
  let waiting: (() => void)[] = []
  const release = () => {
    const now = waiting
    waiting = []
    for (const go of now) go()
  }
  on('env.get', () => ({ value: HOME }))
  on('clock.now', () => ({ value: clock.now }))
  on('clock.every', () => new Promise(resolve => waiting.push(() => resolve({ value: undefined }))))
  on('fs.stat', (_: unknown, e: { path: string }) => {
    const f = e.path.split('/').pop()!
    if (!e.path.includes('/demo/') || !(f in files)) throw new Error('missing')
    return { value: { kind: 'file', size: files[f]!.length, mtimeMs: 0, isLink: links.includes(f) } }
  })
  on('command.register', () => ({ value: { command: 'pi' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: clock.panes }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [{ name: 'demo', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }] }))
  on('fs.read', (_: unknown, e: { path: string }) => {
    if (e.path.endsWith('/demo/status.json')) return { value: JSON.stringify(session) }
    const f = e.path.split('/').pop()!
    if (e.path.includes('/demo/') && f in files) {
      clock.reads.push(f)
      return { value: files[f] }
    }
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

const liveJson = (lines: string[]) => JSON.stringify({ updatedAt: T0, streaming: true, lines })
// Live's press takes a few state writes; let them land.
const pressLive = async (ui: any) => {
  await ui.press({ key: 'live' })
  await new Promise(resolve => setTimeout(resolve, 20))
}
const texts = async (ui: any) => ((await ui.findAll({ type: 'Text' })) as { text: string }[]).map(t => t.text)

test('Live expands the card with the tail serve writes, follows it while open, and stops reading when closed', async ($, on) => {
  const session = { state: 'busy', heartbeatAt: T0 + 3600000, lastActivity: T0 - 1000, runStartedAt: T0 - 30000, lastTool: 'bash npm test', lastReply: 'an older reply', turns: 3 }
  const long = `${'word '.repeat(30)}end`
  const files = { 'live.json': liveJson(['→ read README.md', long, `→ bash ${'x'.repeat(100)}`]) }
  const { clock, tick } = await pollingPane($, on, session, T0, files)
  clock.panes = [OPEN]
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Closed, the card is as before, and nothing reads live.json.
  expect(await ui.find({ type: 'Text', text: /→ bash npm test/ })).toBeDefined()
  expect((await ui.find({ key: 'live' }))?.props.label).toBe('Live')
  await tick()
  expect(clock.reads).toEqual([])
  await pressLive(ui)
  expect((await ui.find({ key: 'live' }))?.props.label).toBe('Live off')
  // Open: the header line stays; the tail takes the place of the tool line and the last reply.
  expect((await ui.find({ type: 'Text', text: /^demo/ }))?.text).toMatch(/demo busy 30s · 3 turns$/)
  expect(await ui.find({ type: 'Text', text: /^live · tool calls and reply/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /→ bash npm test/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /an older reply/ })).toBeUndefined()
  const shown = await texts(ui)
  expect(shown).toContain('→ read README.md')
  // Reply text wraps to the pane's 60 columns; a tool call is cut to them.
  const wrapped = shown.filter(t => t.startsWith('word') || t.endsWith('end'))
  expect(wrapped.length).toBe(3)
  expect(wrapped.every(t => t.length <= 60)).toBe(true)
  expect(shown.find(t => t.startsWith('→ bash x'))!.length).toBe(60)
  // Each period reads it again, and a new line shows.
  files['live.json'] = liveJson(['→ read README.md', 'Now running the tests'])
  await tick()
  expect(await ui.find({ type: 'Text', text: 'Now running the tests' })).toBeDefined()
  // Behind another tab it stops reading.
  clock.panes = [{ ...OPEN, isShown: false }]
  await tick()
  const hidden = clock.reads.length
  await tick()
  await tick()
  expect(clock.reads.length).toBe(hidden)
  clock.panes = [OPEN]
  await tick()
  await tick()
  expect(clock.reads.length > hidden).toBe(true)
  // Live off: the card is as before, and nothing reads it any more.
  await pressLive(ui)
  expect(await ui.find({ type: 'Text', text: /^live · / })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /→ bash npm test/ })).toBeDefined()
  const closed = clock.reads.length
  await tick()
  await tick()
  expect(clock.reads.length).toBe(closed)
  await ui.unmount()
})

test('a session that stops gets one last read of its tail, then none; a linked live.json is never read', async ($, on) => {
  const session = { state: 'busy', heartbeatAt: T0 + 3600000, lastActivity: T0 - 1000 }
  const files = { 'live.json': liveJson(['→ read README.md']) }
  const { clock, tick } = await pollingPane($, on, session, T0, files)
  clock.panes = [OPEN]
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pressLive(ui)
  expect(await ui.find({ type: 'Text', text: '→ read README.md' })).toBeDefined()
  Object.assign(session, { state: 'stopped' })
  files['live.json'] = liveJson(['→ read README.md', 'All done.'])
  await tick()
  await tick()
  expect(await ui.find({ type: 'Text', text: 'All done.' })).toBeDefined()
  const after = clock.reads.length
  await tick()
  await tick()
  expect(clock.reads.length).toBe(after)
  await ui.unmount()
})

test('a live.json that is a link shows nothing', async ($, on) => {
  const session = { state: 'busy', heartbeatAt: T0 + 3600000, lastActivity: T0 - 1000 }
  const { clock, tick } = await pollingPane($, on, session, T0, { 'live.json': liveJson(['id_rsa contents']) }, ['live.json'])
  clock.panes = [OPEN]
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pressLive(ui)
  await tick()
  expect(await ui.find({ type: 'Text', text: '(nothing yet)' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /id_rsa/ })).toBeUndefined()
  expect(clock.reads).toEqual([])
  await ui.unmount()
})

test('live rows: tool calls cut to the width, reply text wrapped at spaces, control characters gone, a long line its end', () => {
  expect(liveRows(['→ read a.ts', 'one two three four'], 10)).toEqual(['→ read a.ts'.slice(0, 9) + '…', 'one two', 'three four'])
  expect(liveRows(['abcdefghijklmnop'], 10)).toEqual(['abcdefghij', 'klmnop'])
  expect(liveRows(['red \u001b[31mtext'], 40)).toEqual(['red  [31mtext'])
  const many = Array.from({ length: 30 }, (_, i) => `line ${i}`)
  expect(liveRows(many, 40)).toEqual(many)
  // One line takes at most a view's 20 rows, from its end.
  const huge = liveRows(['x'.repeat(5000)], 10)
  expect(huge.length).toBe(20)
})

const numbered = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `line ${from + i}`)

test('the live window shows 20 rows, offset rows up from the end, with what is above and below', () => {
  const rows = numbered(0, 50)
  expect(liveWindow(rows, 0)).toEqual({ rows: numbered(30, 50), older: 30, newer: 0, offset: 0, max: 30 })
  expect(liveWindow(rows, 5)).toEqual({ rows: numbered(25, 45), older: 25, newer: 5, offset: 5, max: 30 })
  // Clamped to the top; a tail that fits never scrolls.
  expect(liveWindow(rows, 99)).toMatchObject({ rows: numbered(0, 20), older: 0, newer: 30, offset: 30 })
  expect(liveWindow(numbered(0, 5), 3)).toEqual({ rows: numbered(0, 5), older: 0, newer: 0, offset: 0, max: 0 })
})

test('a scrolled-up view keeps its place as lines come, also once old ones drop off the front', () => {
  const cur = { lines: numbered(0, 50), first: 0, done: 50, offset: 4 }
  // Three more lines: three rows more from the end.
  expect(keepPlace(cur, { lines: numbered(0, 53), first: 0, done: 53 }, 60)).toBe(7)
  // At the 200-line cap the front drops as lines come: still three.
  const full = { lines: numbered(100, 300), first: 100, done: 200, offset: 4 }
  expect(keepPlace(full, { lines: numbered(103, 303), first: 103, done: 200 }, 60)).toBe(7)
  // The reply streaming now grows a line, then finishes as two lines.
  const streaming = { lines: [...numbered(0, 30), 'partial'], first: 0, done: 30, offset: 2 }
  expect(keepPlace(streaming, { lines: [...numbered(0, 30), 'partial', 'more'], first: 0, done: 30 }, 60)).toBe(3)
  expect(keepPlace(streaming, { lines: [...numbered(0, 30), 'partial', 'more'], first: 0, done: 32 }, 60)).toBe(3)
  // Following the end stays following; a new serve (numbered afresh) goes back to the end.
  expect(keepPlace({ ...cur, offset: 0 }, { lines: numbered(0, 53), first: 0, done: 53 }, 60)).toBe(0)
  expect(keepPlace(full, { lines: numbered(0, 30), first: 0, done: 30 }, 60)).toBe(0)
  // Held to the top of what is kept.
  expect(keepPlace({ ...full, offset: 179 }, { lines: numbered(150, 350), first: 150, done: 200 }, 60)).toBe(180)
})

const liveFile = (lines: string[], first = 0, done = lines.length) => JSON.stringify({ updatedAt: T0, streaming: done < lines.length, first, done, lines })
const shownRows = async (ui: any) => (await texts(ui)).filter(t => /^line \d+$/.test(t))
const scrollEvent = (by: number, contentRows: number, bodyRows: number, extra: object = {}) =>
  ({ component: 'Pane', requestId: 'pi', offset: 0, by, bodyRows, contentRows, origin: { kind: 'person' }, ...extra }) as never

test('scrolled up, the Live view pauses: new lines leave the rows shown alone until ↓ newer goes back to the end', async ($, on) => {
  const session = { state: 'busy', heartbeatAt: T0 + 3600000, lastActivity: T0 - 1000 }
  const files = { 'live.json': liveFile(numbered(0, 50)) }
  const { clock, tick } = await pollingPane($, on, session, T0, files)
  clock.panes = [OPEN]
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pressLive(ui)
  // Following: the last 20, with how many are above, and nothing below.
  expect(await shownRows(ui)).toEqual(numbered(30, 50))
  expect(await ui.find({ type: 'Text', text: '↑ 30 older' })).toBeDefined()
  expect(await ui.find({ key: 'live-end' })).toBeUndefined()
  expect(await ui.find({ key: 'live-down' })).toBeUndefined()
  // k (▲) goes up a row and pauses.
  await ui.press({ key: 'live-up' })
  expect(await shownRows(ui)).toEqual(numbered(29, 49))
  expect((await ui.find({ key: 'live-end' }))?.props.label).toBe('↓ 1 newer')
  expect(await ui.find({ type: 'Text', text: /^live · .* · paused$/ })).toBeDefined()
  // Lines come, older ones go: the same rows stay on screen.
  files['live.json'] = liveFile(numbered(5, 58), 5)
  await tick()
  expect(await shownRows(ui)).toEqual(numbered(29, 49))
  expect((await ui.find({ key: 'live-end' }))?.props.label).toBe('↓ 9 newer')
  expect(await ui.find({ type: 'Text', text: '↑ 24 older' })).toBeDefined()
  // j (▼) comes down a row; ↓ newer back to the end, which it follows again.
  await ui.press({ key: 'live-down' })
  expect(await shownRows(ui)).toEqual(numbered(30, 50))
  await ui.press({ key: 'live-end' })
  expect(await shownRows(ui)).toEqual(numbered(38, 58))
  expect(await ui.find({ key: 'live-end' })).toBeUndefined()
  files['live.json'] = liveFile(numbered(5, 60), 5)
  await tick()
  expect(await shownRows(ui)).toEqual(numbered(40, 60))
  // Closed and opened again, it starts at the end.
  await ui.press({ key: 'live-up' })
  await pressLive(ui)
  await pressLive(ui)
  expect(await shownRows(ui)).toEqual(numbered(40, 60))
  await ui.unmount()
})

test('the wheel over the Live view scrolls it, elsewhere the pane; scroll keys move it by rows, pages and to its ends', async ($, on) => {
  const session = { state: 'busy', heartbeatAt: T0 + 3600000, lastActivity: T0 - 1000 }
  const files = { 'live.json': liveFile(numbered(0, 100)) }
  // The engine beneath: what reaches it moves the pane.
  const pane: number[] = []
  on('ui.scroll', (_: unknown, e: { by: number }) => {
    pane.push(e.by)
    return {}
  })
  const { clock } = await pollingPane($, on, session, T0, files)
  clock.panes = [OPEN]
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Closed, every move is the pane's.
  expect(await $.ui.scroll(scrollEvent(-1, 40, 30, { pointer: { column: 2, row: 38 } }))).toEqual({})
  expect(pane).toEqual([-1])
  await pressLive(ui)
  expect(await shownRows(ui)).toEqual(numbered(80, 100))
  // The view is the tree's last rows: its bar, ↑ older, its 20 rows (and ↓ newer once scrolled), the last 22 of 40 here.
  const over = { pointer: { column: 2, row: 30 } }
  await $.ui.scroll(scrollEvent(-3, 40, 50, over))
  expect(await shownRows(ui)).toEqual(numbered(77, 97))
  // Over the tiles above it, the pane moves.
  await $.ui.scroll(scrollEvent(-1, 41, 50, { pointer: { column: 2, row: 3 } }))
  expect(await shownRows(ui)).toEqual(numbered(77, 97))
  expect(pane).toEqual([-1, -1])
  // Down over it comes back toward the end; at the end the pane moves.
  await $.ui.scroll(scrollEvent(2, 41, 50, { pointer: { column: 2, row: 30 } }))
  expect(await shownRows(ui)).toEqual(numbered(79, 99))
  await $.ui.scroll(scrollEvent(1, 41, 50, { pointer: { column: 2, row: 30 } }))
  await $.ui.scroll(scrollEvent(1, 40, 50, { pointer: { column: 2, row: 30 } }))
  expect(await shownRows(ui)).toEqual(numbered(80, 100))
  expect(pane).toEqual([-1, -1, 1])
  // Keys (no pointer): an arrow a row, a page key 20 rows, Home the top, End the end.
  await $.ui.scroll(scrollEvent(-1, 40, 50))
  expect(await shownRows(ui)).toEqual(numbered(79, 99))
  await $.ui.scroll(scrollEvent(-50, 41, 50))
  expect(await shownRows(ui)).toEqual(numbered(59, 79))
  await $.ui.scroll(scrollEvent(-41, 41, 50))
  expect(await shownRows(ui)).toEqual(numbered(0, 20))
  expect(await ui.find({ type: 'Text', text: /older$/ })).toBeUndefined()
  // At the top, up again is the pane's.
  await $.ui.scroll(scrollEvent(-1, 40, 50))
  expect(pane).toEqual([-1, -1, 1, -1])
  await $.ui.scroll(scrollEvent(40, 40, 50))
  expect(await shownRows(ui)).toEqual(numbered(80, 100))
  // Scrolled away above the view, the keys move the pane (the tree is 100 rows, 30 shown from the top).
  await $.ui.scroll(scrollEvent(1, 100, 30, { offset: 1 }))
  expect(pane).toEqual([-1, -1, 1, -1, 1])
  expect(await shownRows(ui)).toEqual(numbered(80, 100))
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
