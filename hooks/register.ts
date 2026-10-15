import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register, ToolCallResult } from 'claude-code'

import type { Label } from '../types'

const label = atom({ plugin: 'where-did-claude-edit', key: 'label' } as const, null as Label)

const SEPARATOR = ' · '
/**
 * Cells drawn before the hint that its text leaves out: the indent and the permission-mode pill,
 * which no hook can read. Sized for the widest (`⏵⏵ bypass permissions on `) plus slack.
 */
const PILL_RESERVE = 30

/** The worktree the session runs in; an edit there leaves it out of the label. */
let sessionTop: string | undefined
/** The worktree of the last pinned edit, where a Bash edit most likely lands next. */
let lastTop: string | undefined

/** Most paths in one command looked up as a possible worktree. */
const MAX_COMMAND_PATHS = 5
/** Absolute or `~/` paths in a command, the way a `cd`, `-C` or file argument names them. */
const COMMAND_PATH = /(?:^|[\s"'=])((?:~\/|\/)[^\s"';|&<>()]+)/g

const dirname = (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/'
const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** `~/…` under home, so it stays short and still `cd`-able; absolute otherwise. */
const tildify = (path: string, home: string | undefined): string =>
  home !== undefined && (path === home || path.startsWith(`${home}/`))
    ? `~${path.slice(home.length)}`
    : path

async function git($: Engine, dir: string | undefined, ...args: string[]): Promise<string | undefined> {
  const ran = await $.process.run(['git', ...(dir === undefined ? [] : ['-C', dir]), ...args])
  return ran.exitCode === 0 ? ran.stdout.trim() : undefined
}

async function pin($: Engine, filePath?: string): Promise<void> {
  const dir = filePath === undefined ? undefined : dirname(filePath)
  const [toplevel, current] = await Promise.all([
    git($, dir, 'rev-parse', '--show-toplevel'),
    git($, dir, 'branch', '--show-current'),
  ])
  if (toplevel === undefined) {
    return
  }
  if (filePath !== undefined) {
    lastTop = toplevel
  }
  // Empty on a detached HEAD, where the commit names it instead.
  const branch = current || (await git($, dir, 'rev-parse', '--short', 'HEAD'))
  const parts = [
    `⎇ ${branch}`,
    ...(toplevel === sessionTop ? [] : [tildify(toplevel, await $.env.get('HOME'))]),
    ...(filePath === undefined ? [] : [basename(filePath)]),
  ]
  await update($, label, () => parts.join(SEPARATOR))
}

/** Hands the edit's result back, re-pinning first when the edit went through. */
async function pinAfter($: Engine, ran: ToolCallResult, filePath: string): Promise<ToolCallResult> {
  if (ran.deny === undefined && ran.isError !== true) {
    await pin($, filePath)
  }
  return ran
}

/** The worktrees a Bash command could have edited: the session's, the last edit's, and any it names. */
async function candidateTops($: Engine, command: string): Promise<string[]> {
  const home = await $.env.get('HOME')
  const named = [...command.matchAll(COMMAND_PATH)]
    .flatMap(([, path = '']) => (path.startsWith('~/') && home !== undefined ? home + path.slice(1) : path))
    .slice(0, MAX_COMMAND_PATHS)
  const tops = await Promise.all(
    named.map(async path => {
      const isDir = (await $.fs.stat(path).catch(() => undefined))?.kind === 'dir'
      return git($, isDir ? path : dirname(path), 'rev-parse', '--show-toplevel')
    }),
  )
  return [...new Set([sessionTop, lastTop, ...tops].filter(top => top !== undefined))]
}

/** The dirty file in `top` written most recently, if that was at or after `since`. */
async function newestDirty($: Engine, top: string, since: number): Promise<{ path: string; mtimeMs: number } | undefined> {
  // Untrimmed: an entry's status can open with a space (` M path`).
  const status = await $.process.run(['git', '-C', top, 'status', '--porcelain', '-z'])
  if (status.exitCode !== 0) {
    return undefined
  }
  // `XY path` entries; a rename or copy follows its with the original path, skipped here.
  const entries = status.stdout.split('\0')
  const paths: string[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? ''
    if (entry.length < 4 || entry[0] === 'D' || entry[1] === 'D') {
      continue
    }
    paths.push(`${top}/${entry.slice(3).replace(/\/$/, '')}`)
    if (entry[0] === 'R' || entry[0] === 'C') {
      i++
    }
  }
  const stats = await Promise.all(
    paths.map(async path => ({ path, mtimeMs: (await $.fs.stat(path).catch(() => undefined))?.mtimeMs ?? 0 })),
  )
  const newest = stats.reduce<(typeof stats)[number] | undefined>(
    (best, stat) => (best === undefined || stat.mtimeMs > best.mtimeMs ? stat : best),
    undefined,
  )
  return newest !== undefined && newest.mtimeMs >= since ? newest : undefined
}

/** The file a Bash command edited: the engine's own diff when it has one, else git's newest dirty file. */
async function bashEditedFile($: Engine, command: string, since: number, ran: ToolCallResult): Promise<string | undefined> {
  const diff = (ran.result as { bashEditDiff?: { files?: { filePath: string }[]; changedFiles?: string[] } } | undefined)
    ?.bashEditDiff
  const reported = diff?.changedFiles ?? diff?.files?.map(file => file.filePath)
  if (reported !== undefined && reported.length > 0) {
    return reported[reported.length - 1]
  }
  const found = await Promise.all((await candidateTops($, command)).map(top => newestDirty($, top, since)))
  return found.reduce<(typeof found)[number]>(
    (best, file) => (file !== undefined && (best === undefined || file.mtimeMs > best.mtimeMs) ? file : best),
    undefined,
  )?.path
}

export const register: Register = on => {
  // Starts on the session folder's branch; a reload keeps the last edit's.
  on('session.start', async ($, e, next) => {
    sessionTop = await git($, undefined, 'rev-parse', '--show-toplevel')
    if ((await read($, label)) === null) {
      await pin($)
    }
    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const text = await read($, label)
    if (text === null) {
      return next(e)
    }
    // The engine joins a tail with ` · ` and cuts it at the row's end, so a label that won't fit
    // gets a line of its own instead, cut only past that.
    const fits =
      e.viewport === undefined ||
      PILL_RESERVE + e.props.hint.length + SEPARATOR.length + text.length <= e.viewport.columns
    if (fits) {
      return next({ ...e, props: { ...e.props, tail: text } })
    }
    return {
      type: 'Box',
      props: { flexDirection: 'column' },
      children: [await next(e), { type: 'Text', props: { dimColor: true, wrap: 'truncate-end' }, children: [text] }],
    }
  })

  // A `.catch` so a failing pin never costs the tool its result.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => pinAfter($, await next(e), e.file_path)).catch(
    ($, e, next) => next(e),
  )
  on('tool.call', { tool: 'Write' }, async ($, e, next) => pinAfter($, await next(e), e.file_path)).catch(
    ($, e, next) => next(e),
  )
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) =>
    pinAfter($, await next(e), e.notebook_path),
  ).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // A second's slack: a file system's mtime can trail the clock by its granularity.
    const since = (await $.clock.now()) - 1000
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) {
      return ran
    }
    const filePath = await bashEditedFile($, e.command, since, ran)
    return filePath === undefined ? ran : pinAfter($, ran, filePath)
  }).catch(($, e, next) => next(e))
}
