export type Label = string | null

declare module 'claude-code' {
  interface PluginState {
    'what-did-i-edit': { label: Label }
  }
}
