/** Context fill (percent) after each measurement, oldest first. */
export type PixelbarHistory = number[]

/** The last test or build run: whether it passed, and the counts its output gave. */
export type PixelbarBadge = { kind: 'tests' | 'build'; isOk: boolean; passed?: number; failed?: number }

/** What the last finished turn did and cost. */
export type PixelbarTurn = {
  ms: number
  tools: number
  files: number
  added: number
  removed: number
  cost: number
  isOk: boolean
  /** Share of the turn's input tokens the prompt cache served (0-100, one decimal, rounded down); absent when no response counted. */
  cacheHit?: number
}

/** The first 5h-window reading this session: where the pace is measured from. */
export type PixelbarPace = { at: number; pct: number; resetsAt?: string }

/** A running focus timer: when it ends (ms) and how long it was set for. */
export type PixelbarFocus = { endsAt: number; minutes: number }

/** The last main-loop response's token counts, and when its request was sent (ms). */
export type PixelbarCache = { read: number; write: number; fresh: number; output: number; at: number }

/** Every model request's tokens this session, subagents' included, summed. */
export type PixelbarTotals = { read: number; write: number; fresh: number; output: number }

/** A file edited this session: lines changed, and its edits as unified-diff hunks. */
export type PixelbarFile = { path: string; added: number; removed: number; patches: string[]; at: number }

declare module 'claude-code' {
  interface PluginState {
    pixelbar: {
      history: PixelbarHistory
      /** The highest context warning already shown (0, 80 or 90). */
      warnedAt: number
      badge: PixelbarBadge | null
      lastTurn: PixelbarTurn | null
      pace: PixelbarPace | null
      /** When the working tree was first seen with uncommitted changes (ms), or null while clean. */
      dirtySince: number | null
      focus: PixelbarFocus | null
      /** Files edited this session, most recent last. */
      files: PixelbarFile[]
      /** The file whose diff the files pane shows; the most recent when null. */
      selectedFile: string | null
      cache: PixelbarCache | null
      totals: PixelbarTotals
    }
  }
}
