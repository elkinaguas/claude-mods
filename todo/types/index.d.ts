/** TODO.md as last read: whether it exists, its text, and why it was refused (a link, not a file). */
export type TodoFile = { exists: boolean; text: string; refused?: string }

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
      /** The Todo tasks marked to start together (their keys), in no order. */
      marked: string[]
      /** The panel element the person's focus is on (`task:<key>` for a row), if known. */
      focused: string | null
      /** The task whose Drop was pressed once and waits for a second press (its key). */
      dropping: string | null
      /** The dependency graph's zoom: 1 pills, 2 ovals, 3 ovals with titles. */
      graphZoom: number
      /** How many columns the dependency graph is scrolled to the right. */
      graphScroll: number
    }
  }
}
