# claude-mods

Personal Claude Code mods, set up as a plugin marketplace.

## pixelbar

An animated pixel-art status band above the prompt, with a pixel crab that reacts to what Claude is doing.

![pixelbar demo](pixelbar/demo.gif)

Model and effort, path and git, context / 5h / weekly bars, session and turn cost, a context sparkline, a test/build badge, a turn summary, a 5h pace warning, an uncommitted-work nudge, a session files pane and a focus timer. See the [pixelbar README](pixelbar/README.md) for details and commands.

## todo

A `TODO.md` task board (Todo / Doing / Done) with a panel beside the transcript: capture tasks in one line, let Claude enrich them with IDs and context, and keep a log of what was done. See the [todo README](todo/README.md).

## Install

```bash
claude plugin marketplace add elkinaguas/claude-mods
claude plugin install pixelbar@claude-mods
claude plugin install todo@claude-mods
```

To update later:

```bash
claude plugin marketplace update claude-mods
claude plugin update pixelbar@claude-mods
claude plugin update todo@claude-mods
```

When the marketplace is added from a local clone instead (`claude plugin marketplace add /path/to/claude-mods`), the plugin is read straight from that folder: after editing, run `/reload-plugins` in a session.

## Develop

```bash
claude plugin validate pixelbar
claude plugin test pixelbar
claude plugin validate todo
claude plugin test todo
tools/pixelbar-demo/make-gif.sh   # rebuild pixelbar/demo.gif
```
