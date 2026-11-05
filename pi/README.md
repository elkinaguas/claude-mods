# pi

Long-lived [pi](https://github.com/earendil-works/pi) coding-agent sessions run from Claude Code, with pi kept inside Claude Code's Bash sandbox so it only ever sees a masked provider key.

> **Setup required before first use.** This mod is safe by default: it refuses to start pi until Claude Code's Bash sandbox is on and masks your provider key. The sandbox is off by default in Claude Code, so out of the box `/pi check` reports problems and pi won't start. Set it up once, as described in [Why the sandbox setup](#why-the-sandbox-setup), then run `/pi check` until it says the setup looks right.
>
> Without the setup, pi and Claude could both read your provider key, and through Claude it could end up in the conversation sent to the model. To run pi without the sandbox anyway, turn on the option `allowUnsandboxed` (`/plugin configure pi@claude-mods`). Only you can do this, never Claude. Use a separate, low-limit key you can revoke, and treat it as exposed.
>
> Never print your key with a `!` command or paste it into a session: `!` output and pastes go into the conversation, where no guard can stop them.

- **Sessions.** Ask Claude to start a pi session in a folder and give it work. Claude runs `scripts/pi-session.mjs` through the Bash tool: `serve` keeps one `pi --mode rpc` process running as a background task, `send` queues prompts (as follow-ups while pi works, or `--steer` to redirect it), `wait` returns pi's reply when it settles, `read` shows the transcript. Several sessions can run at once, each by name.
- **Panel.** `/pi` opens a panel beside the transcript: one tile per session, named and coloured by state (idle, busy, waiting on a question, failed, stopped, or lost when its process died with an earlier Claude Code session), with a count of each. Click a tile, or Tab to it and press Enter, to see that session's card: model, folder, current tool, error and last reply, with Abort, Stop and Forget (run by the mod) and Answer, Resume and Transcript (put in your prompt for Claude). The card starts on the session most likely to need you. The panel opens by itself when a session starts running (option `autoOpen`).
- **Resume.** pi saves each conversation. After a restart, Claude serves the session again under the same name and the conversation reloads. Work that was mid-run is lost: ask pi to continue.
- **Guard.** Claude's file tools (Read, Edit, Write, Grep, Glob) are refused anywhere in `~/.pi`, including through links and searches of your home folder or above it, because they run outside the sandbox and would see the real key. When a Bash command would run outside the sandbox (the sandbox is off, the call asks to leave it, or it runs a command in `sandbox.excludedCommands`), it is refused if it names pi, `pi-session`, `~/.pi` or `auth.json`, also through quotes and globs such as `~/.p?/agent/auth*`. Matching text can't catch every spelling (a shell variable, say): only the sandbox truly hides the key. The settings are read again for each Bash call, so turning the sandbox off mid-session counts at once. No command may set `SANDBOX_RUNTIME`.
- **Sandbox required.** `pi-session serve` refuses to start pi outside Claude Code's Bash sandbox (it checks for `SANDBOX_RUNTIME`, which the sandbox sets). To run pi without it anyway, turn on the option `allowUnsandboxed` yourself (`/plugin configure pi@claude-mods`): the mod then adds `--allow-unsandboxed` to every `serve` Claude runs. Claude never passes it itself, and the guard refuses it when the option is off. pi then reads your real key and Claude's unsandboxed commands could too, so use a separate key you can revoke. Such a session shows a red `!` on its tile and a warning on its card.
- **Setup check.** At session start and on `/pi check`, the mod checks the settings: the sandbox is on (managed, project-local, project and user settings, the first that sets it wins), `auth.json` is masked, no `Read(...)` rule overrides the mask, TLS termination is set, and its CA is readable and not about to expire (option `caWarnDays`, 30). It also names any session running outside the sandbox, and warns about `sandbox.excludedCommands` and `allowUnsandboxedCommands`, which let commands run outside it. A toast and the panel show what is wrong.

## Why the sandbox setup

The mod never starts pi itself: a mod's code runs outside the sandbox, where pi would read your real key, and so would Claude through it. pi runs from Claude's Bash tool instead, and the sandbox does the rest:

```jsonc
// ~/.claude/settings.json
{
  "sandbox": {
    "enabled": true,
    "network": {
      "allowedDomains": ["opencode.ai"],
      // The proxy opens pi's HTTPS with a certificate signed by this CA (RSA),
      // so it can swap the placeholder for the real key.
      "tlsTerminate": { "caCertPath": "~/.config/claude-sandbox-ca/ca.crt", "caKeyPath": "~/.config/claude-sandbox-ca/ca.key" }
    },
    // pi writes its sessions, locks and this mod's session files here.
    "filesystem": { "allowWrite": ["~/.pi/agent"], "denyRead": ["~/.config/claude-sandbox-ca/ca.key"] },
    "credentials": {
      "files": [
        // Commands see a placeholder; the proxy puts the real key back on requests to opencode.ai only.
        { "path": "~/.pi/agent/auth.json", "mode": "mask", "extract": "\"key\"\\s*:\\s*\"([^\"]+)\"", "injectHosts": ["opencode.ai"] }
      ]
    }
  }
}
```

Make the CA once with `openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=Claude sandbox CA" -keyout ~/.config/claude-sandbox-ca/ca.key -out ~/.config/claude-sandbox-ca/ca.crt` (the proxy reads RSA keys only), and replace `opencode.ai` with your provider's host.

## pi-session

```
pi-session serve <name> [--cwd DIR] [--model PROVIDER/ID] [--thinking LEVEL] [--allow-unsandboxed] [-- PI_ARGS...]
pi-session send <name> [--steer] <prompt...> | --file FILE | -
pi-session wait <name> [ID] [--timeout SECONDS [--abort]]   # exit 3: pi asks; 2: timed out (--abort stops the run)
pi-session read <name> [--last | --tail N | --since LINE]
pi-session status [name] [--json]
pi-session answer <name> <request-id> <value...> | --cancel
pi-session abort | stop | forget <name>
```

Each session keeps `status.json`, `transcript.md`, `last-reply.md`, `events.jsonl` (pi's raw event stream) and `stderr.log` in `~/.pi/agent/claude-sessions/<name>/` (`PI_SESSIONS_DIR` overrides it). pi keeps its own copy of the conversation under `~/.pi/agent/sessions/`, as session `claude-<name>-<id>`. Serving a session again reopens that conversation; after `forget`, the same name starts a new one. Prompts too long for one pipe write go through the session's `inbox/` folder.

## Develop

```bash
claude plugin validate pi
claude plugin test pi          # the mod: guard, setup check, panel
node --test 'pi/tests/*.test.mjs'   # pi-session against a fake pi
```
