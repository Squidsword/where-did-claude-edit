export type Label = string | null

declare module 'claude-code' {
  interface PluginState {
    'where-did-claude-edit': { label: Label }
  }
}
