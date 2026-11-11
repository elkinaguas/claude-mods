/** One pi session as its status.json says (written by scripts/pi-session.mjs serve). */
export type PiSession = {
  name: string
  /** starting | idle | busy | stopped | failed, or `lost` when a live state's heartbeat went stale. */
  state: string
  cwd: string | null
  model: string | null
  lastActivity: number | null
  /** When pi's current run started (agent_start); null between runs or from an older serve. */
  runStartedAt: number | null
  /** The tool pi runs now, in one line. */
  lastTool: string | null
  /** The start of pi's last reply. */
  lastReply: string | null
  error: string | null
  /** false when serve ran outside Claude Code's sandbox (allowUnsandboxed); null from an older serve. */
  sandboxed: boolean | null
  /** pi's turns over the whole conversation; 0 from an older serve. */
  turns: number
  /** pi's tokens over the conversation (input, output, cache read and write), or null when it reported none. */
  tokens: number | null
  /** pi's cost in dollars over the conversation, or null when it reported none. */
  cost: number | null
}

/** A card's Live view: its session, and the lines of serve's live tail (live.json) last read. */
export type PiLive = {
  name: string
  /** pi's last tool calls (`→ tool args`) and reply text, the reply streaming now included; never tool output. */
  lines: string[]
}

declare module 'claude-code' {
  interface PluginState {
    pi: {
      /** Every session in ~/.pi/agent/claude-sessions, by name. */
      sessions: Shaped<PiSession[]>
      /** What the setup check found wrong with the key-masking settings. */
      warnings: string[]
      /** The session the panel's card shows, picked from its grid; null shows the one needing you most. */
      selected: string | null
      /** Bumped by the poll while the pane is on screen, to redraw the card's age. */
      tick: number
      /** The one card whose Live view is open, with the tail it shows; null when none is. */
      live: PiLive | null
    }
  }
}
