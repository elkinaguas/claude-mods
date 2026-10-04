# claude-mods

Personal Claude Code mods, set up as a plugin marketplace.

## pixelbar

An animated pixel-art band above the prompt: a pixel crab (with moods), model and effort, path and git, context / 5h / weekly bars, session and turn cost, a context sparkline, a test/build badge, a turn summary, a 5h pace warning, an uncommitted-work nudge and a focus timer.

Commands: `/pixelbar` shows or hides the band; `/focus-timer [minutes]` and `/focus-timer off`.

Needs a recent Claude Code (built on 2.1.289) and `git` for the git section. Rate-limit bars need a Pro or Max subscription.

## Install

```bash
# from a local clone
claude plugin marketplace add ~/claude-mods
# or from GitHub, once pushed
claude plugin marketplace add <github-user>/claude-mods

claude plugin install pixelbar@claude-mods
```

A plugin installed from a local folder marketplace is read from that folder: after editing, run `/reload-plugins` in a session.

## Develop

```bash
claude plugin validate pixelbar
claude plugin test pixelbar
```
