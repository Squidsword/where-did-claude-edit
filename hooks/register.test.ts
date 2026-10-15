import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const edit = (file_path: string) =>
  ({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' }) as const

/** Records the `tail` the plugin hands the engine's hint line. */
function captureTail(on: On): { tail?: string } {
  const drawn: { tail?: string } = {}
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    drawn.tail = e.props.tail
    return { type: 'Text', props: {}, children: [e.props.hint] }
  })
  return drawn
}

const drawHint = ($: Engine, columns = 200) =>
  $.ui.render({
    surface: 'terminal',
    component: 'PromptHint',
    requestId: 'hint',
    viewport: { columns, rows: 24 },
    props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
  })

/** Answers git as a worktree at `toplevel` on branch `me/feature-x`, `status` its porcelain. */
function mockGit(on: On, toplevel: string, status = ''): void {
  on('process.run', ($, e) => {
    const stdout = e.argv.includes('--show-toplevel')
      ? `${toplevel}\n`
      : e.argv.includes('status')
        ? status
        : e.argv.includes('branch')
          ? 'me/feature-x\n'
          : 'abc1234\n'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

test('adds the edited file’s branch, worktree and name to the hint line', async ($, on) => {
  mockGit(on, '/Users/me/wt/feature-x')
  mock.env(on, { HOME: '/Users/me' })
  on('tool.call', () => ({ result: {} as never }))
  const drawn = captureTail(on)

  await $.tool.call(edit('/Users/me/wt/feature-x/src/a.ts'))
  await drawHint($)

  expect(drawn.tail).toBe('⎇ me/feature-x · ~/wt/feature-x · a.ts')
})

test('keeps the absolute path for a worktree outside home', async ($, on) => {
  mockGit(on, '/private/tmp/feature-x')
  mock.env(on, { HOME: '/Users/me' })
  on('tool.call', () => ({ result: {} as never }))
  const drawn = captureTail(on)

  await $.tool.call(edit('/private/tmp/feature-x/a.ts'))
  await drawHint($)

  expect(drawn.tail).toBe('⎇ me/feature-x · /private/tmp/feature-x · a.ts')
})

test('omits the worktree when the edit is in the session’s own', async ($, on) => {
  mockGit(on, '/Users/me/wt/feature-x')
  mock.env(on, { HOME: '/Users/me' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} as never }))
  const drawn = captureTail(on)

  await $.session.start({ cwd: '/Users/me/wt/feature-x', surface: 'terminal', isInteractive: true })
  await $.tool.call(edit('/Users/me/wt/feature-x/src/a.ts'))
  await drawHint($)

  expect(drawn.tail).toBe('⎇ me/feature-x · a.ts')
})

test('drops the label to its own line once the mode pill’s room is counted', async ($, on) => {
  mockGit(on, '/private/tmp/feature-x')
  mock.env(on, { HOME: '/Users/me' })
  on('tool.call', () => ({ result: {} as never }))
  const drawn = captureTail(on)

  await $.tool.call(edit('/private/tmp/feature-x/a.ts'))
  const tree = await drawHint($, 70)

  expect(drawn.tail).toBeUndefined()
  expect(tree).toEqual({
    type: 'Box',
    props: { flexDirection: 'column' },
    children: [
      // The line beneath, as captureTail draws it for the engine.
      { type: 'Text', props: {}, children: ['? for shortcuts'] },
      {
        type: 'Text',
        props: { dimColor: true, wrap: 'truncate-end' },
        children: ['⎇ me/feature-x · /private/tmp/feature-x · a.ts'],
      },
    ],
  })
})

const bash = (command: string) => ({ tool: 'Bash', command }) as const
const NOW = 1_000_000

/** Files' mtimes by path; a directory for any path not listed. */
function mockFs(on: On, mtimes: Record<string, number>): void {
  on('clock.now', () => ({ value: NOW }))
  on('fs.stat', ($, e) => {
    const mtimeMs = mtimes[e.path]
    return {
      value:
        mtimeMs === undefined
          ? { kind: 'dir', size: 0, mtimeMs: 0, isLink: false }
          : { kind: 'file', size: 1, mtimeMs, isLink: false },
    }
  })
}

test('follows a Bash edit to the file the engine’s diff names', async ($, on) => {
  mockGit(on, '/Users/me/wt/feature-x')
  mock.env(on, { HOME: '/Users/me' })
  mockFs(on, {})
  on('tool.call', () => ({
    result: { bashEditDiff: { files: [], moreFiles: 0, changedFiles: ['/Users/me/wt/feature-x/src/b.ts'] } } as never,
  }))
  const drawn = captureTail(on)

  await $.tool.call(bash("sed -i '' s/a/b/ src/b.ts"))
  await drawHint($)

  expect(drawn.tail).toBe('⎇ me/feature-x · ~/wt/feature-x · b.ts')
})

test('finds a Bash edit in a worktree the command names, by the newest dirty file', async ($, on) => {
  mockGit(on, '/Users/me/wt/feature-x', ' M src/old.ts\0M  src/new.ts\0')
  mock.env(on, { HOME: '/Users/me' })
  mockFs(on, { '/Users/me/wt/feature-x/src/old.ts': NOW - 60_000, '/Users/me/wt/feature-x/src/new.ts': NOW + 50 })
  on('tool.call', () => ({ result: {} as never }))
  const drawn = captureTail(on)

  await $.tool.call(bash("cd ~/wt/feature-x && python3 edit.py"))
  await drawHint($)

  expect(drawn.tail).toBe('⎇ me/feature-x · ~/wt/feature-x · new.ts')
})

test('leaves the hint line alone when a Bash command writes nothing', async ($, on) => {
  mockGit(on, '/Users/me/wt/feature-x', ' M src/old.ts\0')
  mock.env(on, { HOME: '/Users/me' })
  mockFs(on, { '/Users/me/wt/feature-x/src/old.ts': NOW - 60_000 })
  on('tool.call', () => ({ result: {} as never }))
  const drawn = captureTail(on)

  await $.tool.call(bash('cat ~/wt/feature-x/src/old.ts'))
  await drawHint($)

  expect(drawn.tail).toBeUndefined()
})

test('leaves the hint line alone when the edit fails', async ($, on) => {
  on('tool.call', () => ({ result: {} as never, isError: true }))
  const drawn = captureTail(on)

  await $.tool.call(edit('/repos/wt/feature-x/src/a.ts'))
  await drawHint($)

  expect(drawn.tail).toBeUndefined()
})
