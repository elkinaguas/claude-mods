# todo

A task board in one `TODO.md` at the project root, with `## Todo`, `## Doing`, `## Review` and `## Done`, and a panel beside the transcript to work it.

- **Capture fast.** Type a task in the panel's field, run `/todo <task>`, or write `- <task>` under `## Todo` yourself. No ID, no format to remember.
- **Enrich later.** *Enrich* (panel, hotkey `a`, or `/todo enrich`) asks Claude to give every task without an ID the next free `T-<n>` and 3 to 4 lines of context: where it lands in the code, what to reuse, risks, the decisions that are yours.
- **Work it.** The panel lists Doing (yellow), Review (magenta, when it holds a task), Todo (cyan) and Done (green); Tab / Shift+Tab move from task to task (action buttons are skipped: press them by their letters), Enter on a task opens its notes and actions under it, and Enter again or *Close* (`c`) folds them. Press *Start* (`s`): the panel moves it to Doing and asks Claude to start. Claude records the questions it asks you, and your answers, under the task. A `?` marks a task with an open question; opening it shows an *Answer* field that writes `> A: …` under the question and tells Claude to carry on (a question asked in a chat dialog is still answered there). The task in Doing is pinned in the status line.
- **Fix it.** *Rename* (`r`) edits a Todo or Doing task's title in place; its ID and notes stay, and when it has notes Claude checks them against the new title.
- **Yours or Claude's.** At enrichment Claude gives a task `T-<n>` when it can do it, `H-<n>` when only you can (a call, a purchase, a decision outside the code); both share one number sequence, and when a task would be better split Claude shows you the pieces and asks first. *Make it H-n / T-n* (`y`) flips a task's type, its number and the Depends lines naming it kept. An H- task is yours: *Start* and *Done* (`d`) just move it (straight to Done, no Review), Claude is never asked to work on it, and it can't join a batch. *View* (`v`, shown once an H- task exists) cycles the lists between all tasks, Claude's and yours; the graph always shows all, T- nodes cyan and H- nodes orange, dimmer once done.
- **Realign it.** When the project changes direction, *Realign* (`u`) on an open task, *Realign all* (`w`), or `/todo realign [T-n]` asks Claude to check Todo and Doing tasks against the code as it stands now (references, context, Depends, open decisions, tasks gone obsolete). Claude shows you the changes it proposes and writes them only once you agree; IDs, your titles, Q/A answers and Review / Done logs are never touched.
- **Batch it.** *Mark* (`m`) the Todo task the focus is on (or the open one) to add it to a batch: its row shows `●` and the focus moves to the next Todo task, so `m`, `m`, `m` marks a run; *Start N marked* (`g`) moves them all to Doing and asks Claude to work them one at a time, in Todo order, each finished and logged before the next.
- **Run it.** *Run board* (`p`, shown while a task is ready) or `/todo run` hands the board to Claude as an orchestrator: it works the ready tasks (T- tasks in Todo with no open question and nothing they depend on still in Todo or Doing) one after another without waiting for you. Each runs in a worker subagent in its own git worktree, on a branch `todo/T-<n>` that is committed but never pushed or merged, and lands in Review with its log. A decision that is yours, or a task past its time cap (option `runTaskMinutes`, 60 minutes), is parked back at the top of Todo with a `> Q:`, and the run moves on; your `> A:` makes it ready again. Claude fixes drifted references itself but asks before changing a task's scope, dropping or splitting it.
  The run stays on until *Stop run* (`p`) or `/todo run stop`: whenever Claude is idle, nothing is in Doing and a task is ready (your answer, say), the panel sends the next prompt, so no turns are spent waiting. Past the cap, the worker's tool calls are refused, so it stops and reports back. You get a notification when a task is parked with a question, lands in Review, or the run goes idle; the status line shows the task's minutes against the cap and how many tasks wait on you.
- **Reorder it.** *Up* (`k`) and *Down* (`j`) move a Todo or Doing task within its section. *Back to Todo* (`b`) returns a Doing task to the top of Todo and tells Claude to stop on it.
- **Close it quickly.** *Quick done* (`q`) moves a trivial Todo or Doing task to the top of Done with today's date, keeping its notes and adding "Done from the panel, no log."; Claude is not asked.
- **Drop it.** *Drop* (`x`, pressed twice) gives up on a Todo or Doing task: one with an ID goes to the top of Done marked `(dropped <date>)` with its notes, so its ID stays taken; one without an ID is deleted.
- **Log it.** *To review* (`d`) on a Doing task asks Claude to move it to Review and replace its notes with a log: what was done, the decisions and why, the result, the files touched. Claude moves a task it finishes to Review the same way.
- **Review it.** On a Review task, *Done* (`d`) moves it to the top of Done with today's date, log kept, without asking Claude. *Reject* (`f`) asks what to fix, moves it back to Doing with a `> Review: …` note and tells Claude to fix it and bring it back to Review.
  Done starts folded to its heading so the lists stay short and the graph has room: Enter on the heading or `t` unfolds it, and the panel remembers your choice per project. In Done, a task's log shows folded to its first line; *Open log* (`o`) unfolds it.

**Dependencies.** At enrichment Claude adds `> Depends: T-3, T-5` to a task that waits on others. Once an open task has one, a graph appears under the lists, flowing left to right: each task a thin oval with its ID in its section's colour (the open task in white), arrows to what it unblocks. *Zoom* (`z`) cycles pills (the default), ovals, and ovals with titles, and the panel remembers the zoom per project; `h` / `l` scroll it when it is wider than the panel. Starting a task whose dependencies aren't done shows a warning (it still starts), and a batch runs each task after the ones it waits on.

**Stats.** *Stats* (`n`) shows, under the lists, the open work per section (split T / H once you have H- tasks) and a sparkline of tasks done in each of the last 8 weeks, oldest first, counting `TODO-archive.md` too; dropped tasks are counted apart. The panel remembers whether it is shown, per project.

Done keeps itself short: when a task starts and Done holds more than 20 tasks, the oldest move to `TODO-archive.md` and the newest 10 stay (option `autoArchive`; 0 turns it off).

```md
## Todo

- T-14 Add retry to upload client
  > Uploads fail silently on 5xx: src/upload/client.ts:88 has no retry.
  > lib/backoff.ts already has an exponential helper.
  > Decision: how many retries, and is the upload idempotent?
- add dark mode to settings
```

## Boards outside the project

To keep every board in one folder you can back up (a git repo of its own, say), set the `boardsDir` option (`/config`, todo), e.g. `~/todos`, and run `/todo move` in a project: its `TODO.md` and `TODO-archive.md` go to `~/todos/<owner>/<repo>/` (from the git remote; the folder's name without one), and `CLAUDE.local.md` gets a note pointing Claude and the panel there. Projects you don't move keep their local board. The project's own copies are then deleted (a copy edited after the move is kept for you to merge; `/todo move` run again tidies up, and puts back a moved board that went missing; a project copy is never deleted while its moved copy is missing), and `CLAUDE.local.md` is added to the project's `.gitignore` when it has one. The mod does no git in the boards folder.

## Safety

`TODO.md` may come from someone else's repo, so the mod treats it as data:

- A board recorded in `CLAUDE.local.md` is used only inside the `boardsDir` folder, so a repo shipping its own `CLAUDE.local.md` can't send the board's writes elsewhere.
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
| `/todo realign [T-n]` | Asks Claude to realign every open task, or one |
| `/todo run [stop]` | Starts a long run: Claude works the ready tasks one after another, woken by the panel until stopped |
| `/todo archive` | Moves the Done tasks to `TODO-archive.md` |
| `/todo move` | Moves this project's board to the `boardsDir` folder |
| `/todo close` | Closes the panel (or press Esc in it) |

Run `/todo init` once per project. The rules it writes sit between `<!-- todo:start -->` and `<!-- todo:end -->`, and a rerun replaces them; any agent that reads `CLAUDE.md` or `AGENTS.md` follows the same board without the mod.

The panel opens by itself when a session starts in a project with a `TODO.md` (turn it off with the `autoOpen` option). On terminals narrower than 144 columns it waits until you run `/todo`.
