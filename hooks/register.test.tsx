import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'forge',
  component: 'Pane',
  requestId: 'forge',
  props: {
    title: 'Forge',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const NOW = Date.parse('2026-10-23T12:19:00Z')

const pr = (repo: string, n: number, title: string, isDraft = false) => ({
  repository: { nameWithOwner: repo },
  number: n,
  title,
  url: `https://github.com/${repo}/pull/${n}`,
  isDraft,
  updatedAt: '2026-10-22T10:00:00Z',
  closedAt: '2026-10-22T10:00:00Z',
})

const CALENDAR = {
  events: [
    {
      summary: 'Team standup',
      start: { dateTime: '2026-10-23T09:00:00Z' },
      end: { dateTime: '2026-10-23T09:15:00Z' },
      attendees: [{ self: true, responseStatus: 'declined' }],
    },
    {
      summary: 'Project check-in',
      start: { dateTime: '2026-10-23T15:00:00Z' },
      end: { dateTime: '2026-10-23T15:30:00Z' },
      attendees: [{ self: true, responseStatus: 'needsAction' }],
    },
    {
      summary: 'Weekly kick-off',
      start: { dateTime: '2026-10-26T10:00:00Z' },
      end: { dateTime: '2026-10-26T10:30:00Z' },
    },
  ],
}

const AGENTS = `This session is Coordinator [a1a1a1].

Peer sessions (1):
  Other Session [b2b2b2]  ·  interactive  ·  idle  ·  Claude Desktop session  ·  started 2m ago`

test('a refresh fills the board from gh and the calendar, and shows no other session', async ($, on) => {
  const store = new Map<string, unknown>()
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('clock.every', () => ({ deny: 'no timers in the test' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: NOW }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)

    return { value: undefined }
  })
  on('process.run', (_, e) => {
    const argv = e.argv.join(' ')
    let out: unknown[] = []
    if (argv.includes('--review-requested')) out = [pr('example/docs', 2018, 'docs: explain the setup'), pr('example/deploy', 2250, 'chore: add a billing field', true)]
    else if (argv.includes('--merged-at')) out = [pr('example/app', 17128, 'fix: retry the login call')]
    else if (argv.includes('--author=@me')) out = [pr('example/app', 17036, 'feat: add the status page'), pr('example/infra', 1397, 'feat: draft the deploy script', true)]
    else if (argv.includes('issues') && argv.includes('closed')) out = [pr('example/app', 17122, 'Cache misses after restart')]
    else if (argv.includes('issues')) out = [pr('example/app', 16658, '[epic] Status pages'), pr('example/infra', 1260, 'Install the runtime from a release')]
    else if (argv.includes('--assignee=@me')) out = [pr('example/app', 17036, 'feat: add the status page')]

    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '' } }
  })
  on('tool.list', () => ({ value: [{ name: 'ListAgents' }, { name: 'mcp__claude_ai_Google_Calendar__list_events' }] }))
  on('tool.call', (_, e) => {
    if (e.tool === 'ListAgents') return { result: {}, text: AGENTS }

    return { result: {}, text: JSON.stringify(CALENDAR) }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'forge-refresh', args: '' } as never)
  await new Promise(r => setTimeout(r, 50))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Other Session/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /Standup skipped/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Project check-in/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Review requested from you \(2\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /First refresh/ })).toBeTruthy()
  await ui.unmount()
})

test('the pane draws before the first refresh, on every surface', async ($, on) => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Loading/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('running subagents of this session show, finished ones do not', async ($, on) => {
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('clock.every', () => ({ deny: 'no timers in the test' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'offline' } }))
  on('tool.call', () => ({ isError: true, result: undefined, text: 'offline' }))
  on('clock.now', () => ({ value: NOW }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  let viewed = ''
  on('ui.view', (_, e) => {
    viewed = (e as { agentId?: string }).agentId ?? ''

    return { value: {} }
  })
  on('agent.list', () => ({
    value: [
      { id: 'a1', description: 'Review remote inference PR', type: 'general-purpose', status: 'running' },
      { id: 'a2', description: 'Search farm runbooks', type: 'Explore', status: 'running', parentId: 'a1' },
      { id: 'a3', description: 'Finished search', type: 'Explore', status: 'completed' },
      { id: 'a4', description: 'Idle after its task', type: 'Explore', status: 'idle' },
      { id: 'a5', description: 'Teammate on hold', type: 'teammate', status: 'idle', teammateId: 'pat@team' },
    ],
  }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await new Promise(r => setTimeout(r, 50))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Review remote inference PR/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Search farm runbooks/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Finished search/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /Idle after its task/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /Teammate on hold/ })).toBeTruthy()
  await ui.press({ key: 'sub-a1' })
  expect(viewed).toBe('a1')
  await ui.unmount()
})

test('the meetings wait for the calendar connector', async ($, on) => {
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('clock.every', () => ({ deny: 'no timers in the test' }))
  on('clock.after', () => ({ deny: 'no timers in the test' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '[]', stderr: '' } }))
  on('tool.list', () => ({ value: [{ name: 'ListAgents' }] }))
  on('tool.call', () => ({ result: {}, text: AGENTS }))
  on('clock.now', () => ({ value: NOW }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await new Promise(r => setTimeout(r, 50))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Waiting for the Google Calendar connector/ })).toBeTruthy()
  await ui.unmount()
})

test('PR health, alerts and the GitHub toggle', async ($, on) => {
  const store = new Map<string, unknown>()
  const alerts: string[] = []
  let failing = false
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    alerts.push(String((e as { text?: string }).text ?? ''))

    return { value: undefined }
  })
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' } }))
  on('clock.every', () => ({ deny: 'no timers in the test' }))
  on('clock.after', () => ({ deny: 'no timers in the test' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: NOW }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)

    return { value: undefined }
  })
  on('agent.list', () => ({ value: [] }))
  on('tool.list', () => ({ value: [{ name: 'ListAgents' }] }))
  on('tool.call', () => ({
    result: {},
    text: `This session is Coordinator [a1a1a1].\n\nPeer sessions (2):\n  Coordinator [a1a1a1]  ·  interactive  ·  busy  ·  x  ·  y\n  Other Session [b2b2b2]  ·  interactive  ·  idle  ·  x  ·  y`,
  }))
  on('process.run', (_, e) => {
    if (e.argv.includes('graphql')) {
      const node = {
        ...pr('example/app', 17036, 'feat: add the status page'),
        reviewDecision: 'REVIEW_REQUIRED',
        commits: { nodes: [{ commit: { statusCheckRollup: { state: failing ? 'FAILURE' : 'SUCCESS' } } }] },
      }

      return { value: { exitCode: 0, stdout: JSON.stringify({ data: { search: { nodes: [node] } } }), stderr: '' } }
    }

    return { value: { exitCode: 0, stdout: '[]', stderr: '' } }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await new Promise(r => setTimeout(r, 50))
  expect(alerts.length).toBe(0)

  failing = true
  await $.command.run({ command: 'forge-refresh', args: '' } as never)
  await new Promise(r => setTimeout(r, 50))
  expect(alerts.some(a => a.startsWith('CI failed: app#17036'))).toBe(true)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /waiting for review/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /1 CI failing/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Other Session|^Coordinator$/ })).toBeFalsy()
  await ui.press({ key: 'github' })
  expect(await ui.find({ type: 'Text', text: /Hidden\. Press g/ })).toBeTruthy()
  await ui.unmount()
})

test('after a /clear the last board comes back at once', async ($, on) => {
  const store = new Map<string, unknown>([
    ['lastBoard', { ...{ updated: 'Fri 23 Oct, 18:40 UTC', changed: 'No change since 18:25 UTC.', errors: [], agents: [], today: null, next: null, later: [], tasks: [], reviews: [], prs: [], issues: [], issueCount: 0, merged: [], mergedUrl: 'https://github.com/pulls', seed: 3 } }],
  ])
  const timers: (() => void)[] = []
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('clock.every', () => ({ deny: 'no timers in the test' }))
  on('clock.after', () => ({ deny: 'no timers in the test' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: (e as { sessionId: string }).sessionId }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'offline' } }))
  on('tool.list', () => ({ value: [] }))
  on('clock.now', () => ({ value: NOW }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)

    return { value: undefined }
  })
  on('agent.list', () => ({ value: [] }))
  void timers

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await new Promise(r => setTimeout(r, 30))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /18:40 UTC|Some sources failed/ })).toBeTruthy()
  await ui.unmount()
})

test('times follow the time zone option', { options: { timeZone: 'Europe/Berlin', timeZoneLabel: 'CEST' } }, async ($, on) => {
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('clock.every', () => ({ deny: 'no timers in the test' }))
  on('clock.after', () => ({ deny: 'no timers in the test' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '[]', stderr: '' } }))
  on('tool.list', () => ({ value: [{ name: 'mcp__claude_ai_Google_Calendar__list_events' }] }))
  on('tool.call', () => ({ result: {}, text: JSON.stringify(CALENDAR) }))
  on('clock.now', () => ({ value: NOW }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await new Promise(r => setTimeout(r, 50))

  // 15:00 UTC is 17:00 in Berlin in October, daylight saving included.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /17:00-17:30/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /\(CEST\)/ })).toBeTruthy()
  await ui.unmount()
})

test('an empty time zone label comes from this computer', { options: { timeZone: '', timeZoneLabel: '' } }, async ($, on) => {
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('clock.every', () => ({ deny: 'no timers in the test' }))
  on('clock.after', () => ({ deny: 'no timers in the test' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'readlink') return { value: { exitCode: 0, stdout: '/usr/share/zoneinfo/Europe/Berlin\n', stderr: '' } }
    if (e.argv[0] === 'date') return { value: { exitCode: 0, stdout: 'CEST\n', stderr: '' } }

    return { value: { exitCode: 0, stdout: '[]', stderr: '' } }
  })
  on('tool.list', () => ({ value: [{ name: 'mcp__claude_ai_Google_Calendar__list_events' }] }))
  on('tool.call', () => ({ result: {}, text: JSON.stringify(CALENDAR) }))
  on('clock.now', () => ({ value: NOW }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await new Promise(r => setTimeout(r, 50))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /\(CEST\)/ })).toBeTruthy()
  await ui.unmount()
})

test('demo mode shows sample data and goes back', async ($, on) => {
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('clock.every', () => ({ deny: 'no timers in the test' }))
  on('clock.after', () => ({ deny: 'no timers in the test' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '[]', stderr: '' } }))
  on('tool.list', () => ({ value: [] }))
  on('clock.now', () => ({ value: NOW }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await new Promise(r => setTimeout(r, 50))

  await $.command.run({ command: 'forge-demo', args: '' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Review the release notes/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Pairing on the deploy script/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /changes requested/ })).toBeTruthy()
  await ui.unmount()

  await $.command.run({ command: 'forge-demo', args: '' } as never)
  const back = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await back.find({ type: 'Text', text: /Review the release notes/ })).toBeFalsy()
  await back.unmount()
})
