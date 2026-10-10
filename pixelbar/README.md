# pixelbar

An animated pixel-art status band for Claude Code, drawn above the prompt.

![pixelbar demo](demo.gif)

*Demo data, generated from pixelbar's own drawing code (`tools/pixelbar-demo/make-gif.sh`).*

## What it shows

| Row | What's there |
| --- | --- |
| 1 | Model and effort, context window size, folder, git branch with uncommitted (`●`) and unpushed (`↑`) counts |
| 2 | Context, 5-hour and weekly usage bars, stretched to the terminal's width, with time to reset; how much of the session the prompt cache served and when it expires; a warning if you'd hit the 5h limit before it resets at your current pace |
| 3 | Status (`working` / `ready` / mood), last test or build result, session cost, session time, context-usage sparkline |
| 4 | Live stats for the current turn, then the last turn's summary: time, tools, files and lines changed, cache hit rate, cost |

The crab works along with Claude: it waves its claws while working, celebrates passing tests, worries about failures, turns red and sweats as the context fills, shivers when the prompt cache is about to go cold, and falls asleep after 10 idle minutes.

### The prompt cache

The context bar's length is how full the context window is. Below 70% its colors split the session's tokens (every model request, subagents included) by how the prompt cache served them:

| Color | Tokens |
| --- | --- |
| Blue | Read from the cache: cheap |
| Yellow | Written to the cache: a cache miss, paid at a premium |
| Red | New: uncached input, and output |

Each part is drawn to the eighth of a cell, and one above zero always shows. From 70% the bar goes back to green-to-red, since how full it is matters more by then.

After the context percentage, `· 90.8% cached` is the share of the session's input the cache served, and `expires 4:59` counts down to the cache lapsing (it blinks in the last minute). Once it reads `❄ cold`, your next prompt re-pays for the whole context. The countdown assumes a 5-minute cache until a model switch, or a request that still hits the cache after a longer pause, shows it lasts an hour; that is then remembered.

More signals:

- **Context warning:** above 80% context the percentage blinks and `/compact?` appears.
- **Uncommitted-work nudge:** `⚑` when 10+ files are uncommitted, or changes have sat uncommitted for 30 minutes.
- **Files button:** `[ N files ]` appears once a file is edited, and opens the files pane.

## Settings

| Setting | Values | Default |
| --- | --- | --- |
| Bar ends (`barEnds`) | `auto`, `rounded`, `square` | `auto` |

Change it in `/config`. `auto` rounds the bars' ends in terminals that draw the rounded glyphs themselves (Ghostty, kitty, WezTerm) and keeps them square elsewhere, where they would show as boxes. Over SSH the terminal can't be detected: choose `rounded` if your terminal is one of those, or your font is a [Nerd Font](https://www.nerdfonts.com/).

## Commands

| Command | What it does |
| --- | --- |
| `/pixelbar` | Show or hide the band |
| `/session-files` | Open a pane listing the files edited this session, with their diffs (also the `[ N files ]` button, hotkey `f`) |
| `/focus-timer [minutes]` | Start a focus timer (default 25 minutes) shown under the crab; `/focus-timer off` stops it |

## Requirements

- A recent Claude Code (built on 2.1.289)
- `git`, for the git section and the uncommitted-work nudge
- A Pro or Max subscription, for the 5-hour and weekly bars
- A terminal font with good block characters

## Install

See the [repository README](../README.md#install).

## Develop

```bash
claude plugin validate pixelbar
claude plugin test pixelbar
tools/pixelbar-demo/make-gif.sh   # rebuild demo.gif after visual changes
```
