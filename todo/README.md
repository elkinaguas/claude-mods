# todo

A task board in one `TODO.md` at the project root, with `## Todo`, `## Doing` and `## Done`, and a panel beside the transcript to work it.

- **Capture fast.** Type a task in the panel's field, run `/todo <task>`, or write `- <task>` under `## Todo` yourself. No ID, no format to remember.
- **Enrich later.** *Enrich* (panel, hotkey `a`, or `/todo enrich`) asks Claude to give every task without an ID the next free `T-<n>` and 3 to 4 lines of context: where it lands in the code, what to reuse, risks, the decisions that are yours.
- **Work it.** Pick a task and press *Start* (`s`): the panel moves it to Doing and asks Claude to start. Claude records the questions it asks you, and your answers, under the task. A `?` marks a task with an open question. The task in Doing is pinned in the status line.
- **Log it.** *Done* (`d`) asks Claude to move the task to Done with the date and replace its notes with a log: what was done, the decisions and why, the result, the files touched.

```md
## Todo

- T-14 Add retry to upload client
  > Uploads fail silently on 5xx: src/upload/client.ts:88 has no retry.
  > lib/backoff.ts already has an exponential helper.
  > Decision: how many retries, and is the upload idempotent?
- add dark mode to settings
```

## Commands

| Command | Does |
| --- | --- |
| `/todo` | Opens the panel |
| `/todo <task>` | Adds a task under Todo |
| `/todo init` | Creates `TODO.md` and writes the rules into `CLAUDE.md` (and `AGENTS.md` if it exists) |
| `/todo enrich` | Asks Claude to enrich the tasks without an ID |
| `/todo archive` | Moves the Done tasks to `TODO-archive.md` |
| `/todo close` | Closes the panel (or press Esc in it) |

Run `/todo init` once per project. The rules it writes sit between `<!-- todo:start -->` and `<!-- todo:end -->`, and a rerun replaces them; any agent that reads `CLAUDE.md` or `AGENTS.md` follows the same board without the mod.

The panel opens by itself when a session starts in a project with a `TODO.md` (turn it off with the `autoOpen` option). On terminals narrower than 144 columns it waits until you run `/todo`.
