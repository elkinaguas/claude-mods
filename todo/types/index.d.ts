/** TODO.md as last read: whether it exists, its text (and TODO-archive.md's), and why it was refused (a link, not a file). */
export type TodoFile = { exists: boolean; text: string; archive?: string; refused?: string }

/** The panel's settings, remembered per project: Done unfolded, stats shown, the graph's zoom (1 pills, 2 ovals, 3 ovals with titles). */
export type PanelFlags = { doneOpen: boolean; statsOpen: boolean; graphZoom: 1 | 2 | 3 }

/** Which tasks the panel lists: all, Claude's (T-) or the engineer's (H-). */
export type TypeFilter = 'all' | 'T' | 'H'

/** A long run (/todo run) while on: the task in Doing and since when (ms), the task past its time cap, what the mod last saw (to notify on changes), and whether it already woke Claude since the last turn. */
export type RunState = {
  task: { id: string; since: number } | null
  overCap: string | null
  review: string[]
  asked: string[]
  prompted: boolean
  idleNotified: boolean
}

declare module 'claude-code' {
  interface PluginState {
    todo: {
      file: TodoFile
      /** The task the panel shows in detail: its ID, or `raw:<title>` for one without an ID. */
      selected: string | null
      /** What is typed in the panel's add field. */
      draft: string
      /** Whether CLAUDE.md or AGENTS.md holds the task board rules. */
      hasRules: boolean
      /** The done task whose log is unfolded in the panel (its key), if any. */
      expanded: string | null
      /** The task being renamed in the panel (its key), if any. */
      renaming: string | null
      /** The Review task whose Reject field is open, asking what to fix (its key), if any. */
      rejecting: string | null
      /** The Todo tasks marked to start together (their keys), in no order. */
      marked: string[]
      /** The panel element the person's focus is on (`task:<key>` for a row), if known. */
      focused: string | null
      /** The task whose Drop was pressed once and waits for a second press (its key). */
      dropping: string | null
      /** How many columns the dependency graph is scrolled to the right. */
      graphScroll: number
      /** The panel's settings; null until read from the plugin's store. */
      flags: PanelFlags | null
      /** Which tasks the lists show (`v` cycles it). */
      typeFilter: TypeFilter
      /** The long run, while one is on; null otherwise. */
      run: RunState | null
    }
  }
}
