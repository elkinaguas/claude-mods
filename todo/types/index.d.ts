/** TODO.md as last read: whether it exists, its text, and its mtime (ms). */
export type TodoFile = { exists: boolean; text: string; mtime: number }

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
    }
  }
}
