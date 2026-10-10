# todo

A task board in one `TODO.md` at the project root, with `## Todo`, `## Doing` and `## Done`, and a panel beside the transcript to work it.

- **Capture fast.** Type a task in the panel's field, run `/todo <task>`, or write `- <task>` under `## Todo` yourself. No ID, no format to remember.
- **Enrich later.** *Enrich* (panel, hotkey `a`, or `/todo enrich`) asks Claude to give every task without an ID the next free `T-<n>` and 3 to 4 lines of context: where it lands in the code, what to reuse, risks, the decisions that are yours.
- **Work it.** The panel lists Doing (yellow), Todo (cyan) and Done (green); Tab / Shift+Tab move from task to task (action buttons are skipped: press them by their letters), Enter on a task opens its notes and actions under it, and Enter again or *Close* (`c`) folds them. Press *Start* (`s`): the panel moves it to Doing and asks Claude to start. Claude records the questions it asks you, and your answers, under the task. A `?` marks a task with an open question; opening it shows an *Answer* field that writes `> A: …` under the question and tells Claude to carry on (a question asked in a chat dialog is still answered there). The task in Doing is pinned in the status line.
- **Fix it.** *Rename* (`r`) edits a Todo or Doing task's title in place; its ID and notes stay, and when it has notes Claude checks them against the new title.
- **Batch it.** *Mark* (`m`) the Todo task the focus is on (or the open one) to add it to a batch: its row shows `●` and the focus moves to the next Todo task, so `m`, `m`, `m` marks a run; *Start N marked* (`g`) moves them all to Doing and asks Claude to work them one at a time, in Todo order, each finished and logged before the next.
- **Reorder it.** *Up* (`k`) and *Down* (`j`) move a Todo or Doing task within its section. *Back to Todo* (`b`) returns a Doing task to the top of Todo and tells Claude to stop on it.
- **Close it quickly.** *Quick done* (`q`) moves a trivial Todo or Doing task to the top of Done with today's date, keeping its notes and adding "Done from the panel, no log."; Claude is not asked.
- **Drop it.** *Drop* (`x`, pressed twice) gives up on a Todo or Doing task: one with an ID goes to the top of Done marked `(dropped <date>)` with its notes, so its ID stays taken; one without an ID is deleted.
- **Log it.** *Done* (`d`) asks Claude to move the task to Done with the date and replace its notes with a log: what was done, the decisions and why, the result, the files touched.
  In Done, a task's log shows folded to its first line; *Open log* (`o`) unfolds it.

**Dependencies.** At enrichment Claude adds `> Depends: T-3, T-5` to a task that waits on others. Once an open task has one, a graph appears under the lists, flowing left to right: each task a thin oval with its ID in its section's colour (the open task in white), arrows to what it unblocks. *Zoom* (`z`) cycles pills, ovals, and ovals with titles; `h` / `l` scroll it when it is wider than the panel. Starting a task whose dependencies aren't done shows a warning (it still starts), and a batch runs each task after the ones it waits on.

Done keeps itself short: when a task starts and Done holds more than 20 tasks, the oldest move to `TODO-archive.md` and the newest 10 stay (option `autoArchive`; 0 turns it off).

```md
## Todo

- T-14 Add retry to upload client
  > Uploads fail silently on 5xx: src/upload/client.ts:88 has no retry.
  > lib/backoff.ts already has an exponential helper.
  > Decision: how many retries, and is the upload idempotent?
- add dark mode to settings
```

## Safety

`TODO.md` may come from someone else's repo, so the mod treats it as data:

- It never reads or writes `TODO.md`, `TODO-archive.md`, `CLAUDE.md` or `AGENTS.md` when one is a symbolic link (even one leading nowhere) or not a regular file; the panel says so instead.
- A file it can't read is never overwritten as if it were missing.
- Prompts it sends Claude name tasks by ID. A task without an ID is quoted as a one-line, capped title marked as data, never as an instruction.
- Text typed into the panel is written as one clean line, and a very large dependency graph is not drawn.

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
