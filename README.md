# where-did-claude-edit

A Claude Code mod that shows where the session last edited, on the dim hint line under the prompt:

```
⏵⏵ bypass permissions on (shift+tab to cycle) · ⎇ my/feature-branch · ~/repos/my-worktree · Button.tsx
```

- **Branch**: the edited file's branch, or its short commit on a detached HEAD.
- **Worktree**: its root as a `cd`-able path, `~/…` under home. Left out when it's the session's own worktree.
- **File**: the edited file's name.

Before the first edit it shows the session folder's branch. It follows Claude's `Edit`, `Write` and `NotebookEdit` calls; edits made through Bash (`sed`, heredocs) don't move it. When the label won't fit beside the hint, it takes a line of its own and is cut with `…` past that line.

## Install

In a terminal Claude Code session:

```
/plugin install where-did-claude-edit --marketplace Squidsword/where-did-claude-edit
```

Answer `y` to add the marketplace, then pick the user scope so it loads in every session.

## Develop

```sh
claude plugin validate .
claude plugin test .
```

Run a session against your working copy with `claude --plugin-dir .`; saves hot-reload.

## License

MIT. See [LICENSE](LICENSE).
