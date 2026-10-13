import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register, ToolCallResult } from 'claude-code'

import type { Label } from '../types'

const label = atom({ plugin: 'what-did-i-edit', key: 'label' } as const, null as Label)

const SEPARATOR = ' · '
/**
 * Cells drawn before the hint that its text leaves out: the indent and the permission-mode pill,
 * which no hook can read. Sized for the widest (`⏵⏵ bypass permissions on `) plus slack.
 */
const PILL_RESERVE = 30

/** The worktree the session runs in; an edit there leaves it out of the label. */
let sessionTop: string | undefined

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
}
