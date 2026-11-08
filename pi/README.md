# pi

Long-lived [pi](https://github.com/earendil-works/pi) coding-agent sessions run from Claude Code, with pi kept inside Claude Code's Bash sandbox so it only ever sees a masked provider key.

> **This mod works only with an opencode-go API key, or a model at a host you trust.** `pi-session serve` refuses to start unless one of these holds:
>
> - **opencode-go:** `--model opencode-go/<id>`, with an opencode-go API key (not OAuth) that is the only login in `~/.pi/agent/auth.json`;
> - **a trusted host:** `--model <provider>/<id>` for a provider that `~/.pi/agent/models.json` points at a host listed in the option `trustedModelHosts` (see [Trusted model hosts](#trusted-model-hosts)), with no login in `auth.json`.
>
> Either way, every provider in `models.json` must be at a trusted host, and extra pi arguments are refused. If pi still ends up on another provider, the session is stopped. Running `pi` directly, rather than through `pi-session`, is refused, and so are model switches sent to a session's pipe. The setup check also flags a mask that puts the key back on any host other than `opencode.ai`.
>
> This keeps the mod from becoming a way to reach other credentials, such as a Claude subscription login in pi, which must never be used outside Claude Code.

> **Setup required before first use.** This mod is safe by default: it refuses to start pi until Claude Code's Bash sandbox is on and masks your provider key. The sandbox is off by default in Claude Code, so out of the box `/pi check` reports problems and pi won't start. Set it up once, as described in [Why the sandbox setup](#why-the-sandbox-setup), then run `/pi check` until it says the setup looks right.
>
> Without the setup, pi and Claude could both read your provider key, and through Claude it could end up in the conversation sent to the model. To run pi without the sandbox anyway, turn on the option `allowUnsandboxed` (`/plugin configure pi@claude-mods`). Only you can do this, never Claude. Use a separate, low-limit key you can revoke, and treat it as exposed.
>
> Never print your key with a `!` command or paste it into a session: `!` output and pastes go into the conversation, where no guard can stop them.

- **Sessions.** Ask Claude to start a pi session in a folder and give it work. Claude runs `scripts/pi-session.mjs` through the Bash tool: `serve` keeps one `pi --mode rpc` process running as a background task, `send` queues prompts (as follow-ups while pi works, or `--steer` to redirect it), `wait` returns pi's reply when it settles, `read` shows the transcript. Several sessions can run at once, each by name.
- **Panel.** `/pi` opens a panel beside the transcript: one tile per session, named and coloured by state (idle, busy, waiting on a question, failed, stopped, or lost when its process died with an earlier Claude Code session), with a count of each. Click a tile, or Tab to it and press Enter, to see that session's card: model, folder, current tool, error and last reply, with Abort, Stop and Forget (run by the mod) and Answer, Resume and Transcript (put in your prompt for Claude). Its age moves while the panel is on screen: how long the current run has been going for a busy session, the time since pi's last event for any other. The card starts on the session most likely to need you. The panel opens by itself when a session starts running (option `autoOpen`).
- **Resume.** pi saves each conversation. After a restart, Claude serves the session again under the same name and the conversation reloads. Work that was mid-run is lost: ask pi to continue.
- **Guard.** Claude's file tools (Read, Edit, Write, Grep, Glob) are refused anywhere in `~/.pi`, including through links and searches of your home folder or above it, because they run outside the sandbox and would see the real key. When a Bash command would run outside the sandbox (the sandbox is off, the call asks to leave it, or it runs a command in `sandbox.excludedCommands`), it is refused if it names pi, `pi-session`, `~/.pi` or `auth.json`, also through quotes and globs such as `~/.p?/agent/auth*`. Matching text can't catch every spelling (a shell variable, say): only the sandbox truly hides the key. The settings are read again for each Bash call, so turning the sandbox off mid-session counts at once. No command may set `SANDBOX_RUNTIME` or `PI_SESSION_PI`, and `pi` itself runs only through `pi-session` (so `pi auth`, which prints keys, is refused too).
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

Make the CA once with `openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=Claude sandbox CA" -keyout ~/.config/claude-sandbox-ca/ca.key -out ~/.config/claude-sandbox-ca/ca.crt` (the proxy reads RSA keys only). Then log in to `opencode-go` in pi with an API key, and keep it the only login in `auth.json` (see the note at the top).

## Trusted model hosts

To run pi on a model your organisation hosts, such as an internal OpenAI-compatible endpoint, define it in pi's `~/.pi/agent/models.json` and list its host in the option `trustedModelHosts` (`/plugin configure pi@claude-mods`). Only you can set it: the mod passes the list to `serve` itself, and a command that passes `--trusted-hosts` is refused.

```jsonc
// ~/.pi/agent/models.json
{ "providers": { "corp": { "baseUrl": "https://llm.corp.example.com/v1", "api": "openai-completions", "apiKey": "dummy", "models": [{ "id": "corp-coder" }] } } }
```

With `trustedModelHosts` set to `llm.corp.example.com`, Claude serves it with `--model corp/corp-coder`. Entries are comma-separated, and ports are matched exactly:

| Entry | Matches |
| --- | --- |
| `llm.corp.example.com` | that host on the URL scheme's default port (443 for https, 80 for http) |
| `llm.corp.example.com:8443` | that host on port 8443 only |
| `localhost:*` | that host on any port |
| `*.corp.example.com` | its subdomains (not `corp.example.com` itself), default port; `*.corp.example.com:8443` for a port |

Every provider in `models.json` must be at a trusted host, and `auth.json` must be empty or missing, so no other service's key is within reach. `serve` reads only provider names and base URLs, never a key or token.

Without the sandbox (with `allowUnsandboxed` on), Claude could read `models.json`. That's harmless with a dummy token, but a real one would be exposed to Claude like any unsandboxed secret. What pi reads (your code, files) goes to that host: list only hosts your organisation runs.

## pi-session

```
pi-session serve <name> --model PROVIDER/ID [--cwd DIR] [--thinking LEVEL]   # --allow-unsandboxed, --trusted-hosts: added by the mod
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
