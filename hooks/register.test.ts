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

/** Answers git as a worktree at `toplevel` on branch `me/feature-x`. */
function mockGit(on: On, toplevel: string): void {
  on('process.run', ($, e) => {
    const stdout = e.argv.includes('--show-toplevel')
      ? `${toplevel}\n`
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

test('leaves the hint line alone when the edit fails', async ($, on) => {
  on('tool.call', () => ({ result: {} as never, isError: true }))
  const drawn = captureTail(on)

  await $.tool.call(edit('/repos/wt/feature-x/src/a.ts'))
  await drawHint($)

  expect(drawn.tail).toBeUndefined()
})
