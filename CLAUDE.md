<!-- todo:start -->
## Task board (TODO.md)

`TODO.md` at the project root is the task board, in three sections: `## Todo`, `## Doing`, `## Done`. Older done tasks move to `TODO-archive.md`.

- **Capture.** The engineer adds tasks as one short line under `## Todo` (`- fix flaky auth test`), with no ID. Keep their wording.
- **Enrichment.** When asked to enrich (any time, mid-project included), find every task line with no ID. Give each the next free ID, `T-<n>`: one more than the highest ID in TODO.md and TODO-archive.md. Never reuse or renumber an ID, and leave tasks that already have one alone. Under the task add 3 to 4 short lines of context for the engineer to decide on: where it lands in the code (`file:line`), related code or helpers to reuse, risks, and the decisions that are theirs. No more than 4 lines.
- **Doing.** A task being worked on sits under `## Doing`. When a decision is the engineer's, ask them; record each question under the task as `> Q: ...` and their answer as `> A: ...`.
- **Done.** When a task is finished, move it to the top of `## Done`, append the date to its line (`- T-12 Fix flaky auth test (2026-10-10)`), and replace its notes with the log: what was done, the decisions taken and why, the result (tests, behaviour), and the files or commits touched. This one may be longer; keep it to bullets.
- **Format.** A task is a line `- T-<n> <title>` (or `- <title>` before enrichment) at column 0; its notes follow on lines indented two spaces, each starting with `> `. Keep to it: the task panel parses this file.
<!-- todo:end -->
