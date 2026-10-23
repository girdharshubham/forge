import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Agent, Board, Ci, Meeting, Pr, Ref, RepoIssues, Status, Task } from '../types'

type Api = EngineInterface

const PANE = 'forge'
const TITLE = 'Forge'
const EVERY_MS = 15 * 60 * 1000
const SUBAGENTS_MS = 5000
// The banner moves and the schedule's now line follows the clock at this pace.
const FRAME_MS = 3000
// Set from the plugin's options in register: the GitHub orgs to search (none
// searches everywhere), the time zone and its label, and short repo names.
let ORGS: string[] = []
let TZ = 'UTC'
let TZ_LABEL = 'UTC'
let ALIASES = new Map<string, string>()

// The zone's offset from UTC at that moment, daylight saving included. Where
// the runtime cannot tell, times show in UTC.
function offsetMs(ms: number): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(ms))
    const part = (type: string) => Number(parts.find(x => x.type === type)?.value)
    const local = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'))

    return local - Math.floor(ms / 1000) * 1000
  } catch {
    return 0
  }
}
const DAY_MS = 24 * 60 * 60 * 1000
// The connector's tools arrive after the session starts, under a name that ends so.
const CALENDAR = /Google_Calendar__list_events$/
const CALENDAR_RETRY_MS = 15_000
const CALENDAR_TRIES = 40

// The statusline's palette: bold yellow, magenta, cyan, white, and plain yellow.
const NAVY = '#0b1026'
const YELLOW = '#ffd75f'
const MAGENTA = '#ff87ff'
const CYAN = '#5fd7ff'
const WHITE = '#ffffff'
const GOLD = '#d7af00'
const FAINT = '#4e4e6e'
const GREEN = '#5fd75f'
const AMBER = '#ffaf00'
const BLUE = '#5f87ff'
const RED = '#ff5f5f'
const ORANGE = '#ff8700'

const STAR_COLORS = [YELLOW, MAGENTA, CYAN, WHITE, GOLD]

// Claude's robot, drawn small, in the row's status color.
const ROBOT = '▐▛▜▌'

const EMPTY: Board = {
  updated: '',
  changed: 'Loading.',
  errors: [],
  agents: [],
  today: null,
  next: null,
  later: [],
  tasks: [],
  reviews: [],
  prs: [],
  issues: [],
  issueCount: 0,
  merged: [],
  mergedUrl: 'https://github.com/pulls',
  seed: 1,
}

const board = atom({ plugin: 'forge', key: 'board' } as const, EMPTY, { shape: 'board-1' })
const subagents = atom({ plugin: 'forge', key: 'subagents' } as const, [] as Agent[], { shape: 'subagents-1' })
// The clock, one value a frame, so the banner and the schedule move on their own.
const clock = atom({ plugin: 'forge', key: 'now' } as const, 0, { shape: 'now-1' })
const githubHidden = atom({ plugin: 'forge', key: 'githubHidden' } as const, false, { shape: 'hidden-1' })
// The step of the duck's saber routine, -1 while it stands on guard.
const fu = atom({ plugin: 'forge', key: 'fu' } as const, -1, { shape: 'fu-1' })

let isRunning = false
let fuTimer: { cancel: () => void } | undefined
// Demo mode: sample data for screenshots. While it is on, nothing real is read,
// drawn or alerted, and the real board waits here.
let isDemo = false
let realBoard: Board | undefined
let realSubagents: Agent[] | undefined
let realZone = { zone: 'UTC', label: 'UTC' }
// Work that started before the demo may finish during it, so every write of
// real data checks isDemo at the moment it lands and leaves the demo alone.
// The demo's own clock and zone, so a screenshot shows neither your time nor
// your time zone: a fixed Thursday morning in UTC, under the night sky.
const DEMO_NOW = Date.parse('2026-01-15T10:20:00Z')
// A shooting star every 5 beats, 15 seconds, so a short recording catches one.
const DEMO_STAR_EVERY = 5
let calendarTries = 0
let isCalendarWaiting = false
let lastSubagents = ''
// What the alerts compare against. Empty until the first look, which alerts nothing.
let subagentStatus: Map<string, string> | undefined
const meetingAlerts = new Set<string>()
// The dock width asked for, 45% of the terminal, the most a dock takes. A render records the terminal
// width it sees; the 5 second poll opens the pane again when the ask changes.
const SHARE = 0.45
let wantColumns = 0
let askedColumns = 0
const share = (columns: number) => Math.max(24, Math.floor(columns * SHARE))
const openPane = ($: Api, columns?: number) => {
  if (columns) askedColumns = columns

  return $.ui.open(columns ? { id: PANE, title: TITLE, columns } : { id: PANE, title: TITLE })
}

// ---------------------------------------------------------------- data

type GhItem = {
  repository: { nameWithOwner: string }
  number: number
  title: string
  url: string
  isDraft?: boolean
  updatedAt?: string
  closedAt?: string
}

const short = (repo: string) =>
  ALIASES.get(repo) ?? repo.split('/')[1] ?? repo

const refOf = (i: GhItem): Ref => ({ text: `${short(i.repository.nameWithOwner)}#${i.number}`, url: i.url })

const prOf = (i: GhItem): Pr => ({
  ref: refOf(i),
  title: i.title,
  isDraft: i.isDraft === true,
  repo: short(i.repository.nameWithOwner),
  day: (i.closedAt ?? i.updatedAt ?? '').slice(0, 10),
})

async function gh($: Api, kind: 'prs' | 'issues', filters: string[], fields: string): Promise<GhItem[]> {
  const owners = ORGS.flatMap(o => ['--owner', o])
  const argv = ['gh', 'search', kind, ...owners, ...filters, '--json', fields, '--limit', '100']
  const run = await $.process.run(argv, { timeoutMs: 90_000 })
  if (run.exitCode !== 0) throw new Error(`gh search ${kind}: ${run.stderr.trim().split('\n')[0]}`)

  return JSON.parse(run.stdout || '[]') as GhItem[]
}

// Your open PRs with their CI and review state, in one read-only GraphQL call.
// Built at call time: the orgs come from the options.
const prQuery = () => `query {
  search(query: "is:pr is:open author:@me ${ORGS.map(o => `org:${o}`).join(' ')}", type: ISSUE, first: 100) {
    nodes {
      ... on PullRequest {
        url number title isDraft updatedAt reviewDecision
        repository { nameWithOwner }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`

type GqlPr = GhItem & {
  reviewDecision?: string | null
  commits?: { nodes?: { commit?: { statusCheckRollup?: { state?: string } | null } }[] }
}

const ciOf = (state?: string): Ci =>
  state === 'SUCCESS' ? 'pass' : state === 'FAILURE' || state === 'ERROR' ? 'fail' : state === 'PENDING' || state === 'EXPECTED' ? 'running' : 'none'

const REVIEWS: Record<string, string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes requested',
  REVIEW_REQUIRED: 'waiting for review',
}

async function myPrs($: Api): Promise<Pr[]> {
  const run = await $.process.run(['gh', 'api', 'graphql', '-f', `query=${prQuery()}`], { timeoutMs: 90_000 })
  if (run.exitCode !== 0) throw new Error(`gh api graphql: ${run.stderr.trim().split('\n')[0]}`)
  const nodes = ((JSON.parse(run.stdout) as { data?: { search?: { nodes?: GqlPr[] } } }).data?.search?.nodes ?? []).filter(
    n => n && n.repository,
  )

  return nodes.map(n => ({
    ...prOf(n),
    ci: ciOf(n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state),
    review: REVIEWS[n.reviewDecision ?? ''] ?? '',
  }))
}

// A toast in the session and a desktop notification.
function alert($: Api, text: string): void {
  void Promise.resolve($.ui.toast(text)).catch(() => undefined)
  void Promise.resolve($.ui.notify(text, { title: 'Forge' })).catch(() => undefined)
}

const tryJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// A tool result reaches a plugin as the model reads it. A large one is saved
// to a file and the text names the file, so read it from there.
async function toolJson($: Api, input: Record<string, unknown>): Promise<unknown> {
  const r = (await $.tool.call(input as never)) as { text?: string; result?: unknown; isError?: true; deny?: string }
  if (r.deny) throw new Error(`${String(input.tool)}: ${r.deny}`)
  if (r.isError) throw new Error(`${String(input.tool)}: ${r.text ?? 'error'}`)
  const text = r.text ?? ''
  const direct = tryJson(text)
  if (direct !== undefined) return direct
  const saved = text.match(/saved to (\/\S+?\.(?:txt|json))/)
  if (saved) {
    const file = (await $.fs.read(saved[1])) as unknown
    const body = typeof file === 'string' ? file : String((file as { text?: string }).text ?? '')

    return tryJson(body)
  }
  if (Array.isArray(r.result)) {
    const joined = (r.result as { text?: string }[]).map(b => b.text ?? '').join('')

    return tryJson(joined)
  }

  return r.result
}

type CalEvent = {
  summary?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  attendees?: { self?: boolean; responseStatus?: string }[]
}

async function events($: Api, tool: string, from: string, to: string): Promise<CalEvent[]> {
  const value = (await toolJson($, {
    tool,
    startTime: `${from}T00:00:00`,
    endTime: `${to}T00:00:00`,
    timeZone: TZ,
    orderBy: 'startTime',
    pageSize: 100,
  })) as { events?: CalEvent[] } | undefined
  if (!value || !Array.isArray(value.events)) throw new Error('calendar: no events in the answer')

  return value.events
}

// This session's subagents, read often: they start and end within minutes.
// A subagent that has finished its task goes idle until a message wakes it,
// so idle counts as done and drops off; a teammate idles while it waits for
// a message, so it stays. A failed one stays ten minutes, then drops off.
const FAILED_SHOWN_MS = 10 * 60 * 1000
const failedAt = new Map<string, number>()

async function pollSubagents($: Api): Promise<void> {
  if (isDemo) return
  const list = await $.agent.list()
  const now = await $.clock.now()
  const byId = new Map(list.map(a => [a.id, a]))
  const depth = (id?: string): number => (id && byId.has(id) ? 1 + depth(byId.get(id)?.parentId) : 0)
  const isDone = (a: (typeof list)[number]) =>
    a.status === 'completed' || a.status === 'killed' || (a.status === 'idle' && !a.teammateId)
  for (const a of list) {
    if (a.status === 'failed' && !failedAt.has(a.id)) failedAt.set(a.id, now)
    if (a.status !== 'failed') failedAt.delete(a.id)
  }
  const live: Agent[] = list
    .filter(a => !isDone(a))
    .filter(a => a.status !== 'failed' || now - (failedAt.get(a.id) ?? now) < FAILED_SHOWN_MS)
    .map(a => ({
      id: a.id,
      title: a.description || a.name || a.type,
      detail: a.type,
      depth: depth(a.parentId),
      status: a.status === 'failed' ? 'BLOCKED' : a.status === 'waiting' || a.status === 'idle' ? 'WAITING' : 'WORKING',
    }))
  const seen = new Map(list.map(a => [a.id, isDone(a) ? 'done' : (a.status as string)]))
  if (subagentStatus) {
    for (const a of list) {
      const was = subagentStatus.get(a.id)
      const state = seen.get(a.id)
      const title = a.description || a.name || a.type
      if (was === state || was === undefined) continue
      if (state === 'done') alert($, `Subagent finished: ${title}`)
      if (state === 'failed') alert($, `Subagent failed: ${title}`)
    }
  }
  subagentStatus = seen
  const json = JSON.stringify(live)
  if (json === lastSubagents) return
  lastSubagents = json
  await update($, subagents, old => (isDemo ? old : live))
}

// ---------------------------------------------------------------- dates

const localDate = (ms: number) => new Date(ms + offsetMs(ms))
const isoDay = (ms: number) => localDate(ms).toISOString().slice(0, 10)
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)

function meetingsByDay(list: CalEvent[], now: number): Map<string, Meeting[]> {
  const byDay = new Map<string, Meeting[]>()
  for (const ev of list) {
    const start = ev.start?.dateTime ?? ev.start?.date
    if (!start) continue
    const end = ev.end?.dateTime ?? ev.end?.date ?? start
    const title = ev.summary ?? '(no title)'
    const answer = ev.attendees?.find(a => a.self)?.responseStatus ?? 'accepted'
    let note = answer === 'needsAction' ? 'no reply' : answer === 'tentative' ? 'maybe' : ''
    if (answer === 'declined') {
      if (!/stand-?up/i.test(title)) continue
      note = 'skipped'
    }
    const isAllDay = !ev.start?.dateTime
    const meeting: Meeting = {
      time: isAllDay ? 'all day' : start.slice(11, 16),
      title,
      minutes: isAllDay ? 0 : Math.round((Date.parse(end) - Date.parse(start)) / 60000),
      note,
      isPast: Date.parse(end) < now,
      startMs: Date.parse(start),
      endMs: Date.parse(end),
    }
    const day = start.slice(0, 10)
    byDay.set(day, [...(byDay.get(day) ?? []), meeting])
  }

  return byDay
}

// ---------------------------------------------------------------- changes

type Snapshot = { at: string; reviews: string[]; prs: string[]; issues: string[]; merged: string[]; agents: string[]; failing?: string[] }

function changes(prev: Snapshot | undefined, now: Snapshot): string {
  if (!prev) return 'First refresh.'
  const added = (a: string[], b: string[]) => b.filter(x => !a.includes(x))
  const lines: string[] = []
  const say = (label: string, items: string[]) => {
    if (items.length > 0) lines.push(`${label}: ${items.slice(0, 3).join(', ')}${items.length > 3 ? ` and ${items.length - 3} more` : ''}.`)
  }
  say('New review request', added(prev.reviews, now.reviews))
  say('Review request gone', added(now.reviews, prev.reviews))
  say('Merged', added(prev.merged, now.merged))
  say('PR changed', added(prev.prs, now.prs))
  say('Newly assigned', added(prev.issues, now.issues))
  say('No longer open', added(now.issues, prev.issues))
  say('Agent', added(prev.agents, now.agents))

  return lines.length > 0 ? lines.join(' ') : `No change since ${prev.at} ${TZ_LABEL}.`
}

// ---------------------------------------------------------------- calendar

// Today's schedule. Until the connector is there, try again every 15 seconds.
async function refreshCalendar($: Api): Promise<void> {
  if (isDemo) return
  const tools = await $.tool.list()
  const tool = tools.find(t => CALENDAR.test(t.name))?.name
  if (!tool) {
    calendarTries += 1
    const isGivingUp = calendarTries > CALENDAR_TRIES
    if (!isGivingUp && !isCalendarWaiting) {
      isCalendarWaiting = true
      $.clock.after(CALENDAR_RETRY_MS, () => {
        isCalendarWaiting = false
        void refreshCalendar($).catch(() => undefined)
      })
    }
    await update($, board, b => (isDemo ? b : {
      ...b,
      calendarNote: isGivingUp
        ? 'The Google Calendar connector is not connected in this session.'
        : 'Waiting for the Google Calendar connector.',
    }))

    return
  }
  calendarTries = 0
  const now = await $.clock.now()
  const today = isoDay(now)
  try {
    const list = await events($, tool, today, addDays(today, 1))
    const meetings = (meetingsByDay(list, now).get(today) ?? []).sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0))
    const d = new Date(`${today}T00:00:00Z`)
    const label = `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
    await update($, board, b => (isDemo ? b : { ...b, today: { label, meetings }, next: null, later: [], calendarNote: '' }))
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    await update($, board, b => (isDemo ? b : { ...b, calendarNote: `Calendar failed: ${text}` }))
  }
}

// ---------------------------------------------------------------- refresh

async function refresh($: Api): Promise<void> {
  if (isRunning || isDemo) return
  isRunning = true
  try {
    await $.ui.status('forge: refreshing')
    const now = await $.clock.now()
    const today = isoDay(now)
    const since = isoDay(now - 14 * DAY_MS)
    const errors: string[] = []
    const guard = <T,>(p: Promise<T>, fallback: T): Promise<T> =>
      p.catch((err: unknown) => {
        errors.push(err instanceof Error ? err.message : String(err))

        return fallback
      })
    const prFields = 'repository,number,title,url,isDraft,updatedAt'

    const [reviews, mine, assignedPrs, issues, closed, merged] = await Promise.all([
      guard(gh($, 'prs', ['--state', 'open', '--review-requested=@me'], prFields), []),
      guard(myPrs($), []),
      guard(gh($, 'prs', ['--state', 'open', '--assignee=@me'], prFields), []),
      guard(gh($, 'issues', ['--state', 'open', '--assignee=@me'], 'repository,number,title,url,updatedAt'), []),
      guard(gh($, 'issues', ['--state', 'closed', '--assignee=@me', `--closed=>=${addDays(today, -3)}`], 'repository,number,title,url,closedAt'), []),
      guard(gh($, 'prs', ['--author=@me', `--merged-at=>=${since}`], 'repository,number,title,url,closedAt'), []),
    ])

    // GitHub.
    const reviewPrs = reviews.map(prOf).sort((a, b) => b.day.localeCompare(a.day))
    const prs = mine
    const mergedPrs = merged.map(prOf).sort((a, b) => b.day.localeCompare(a.day))
    const repoIssues = new Map<string, RepoIssues>()
    for (const i of [...issues].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))) {
      const repo = short(i.repository.nameWithOwner)
      const entry = repoIssues.get(repo) ?? { repo, count: 0, epics: [], recent: [] }
      entry.count += 1
      if (/epic/i.test(i.title)) entry.epics.push(refOf(i))
      else if (entry.recent.length < 4) entry.recent.push(refOf(i))
      repoIssues.set(repo, entry)
    }

    // Assigned to you: assigned PRs, the issues touched last, and what closed lately.
    const tasks: Task[] = [
      ...assignedPrs.map(i => ({ isDone: false, ref: refOf(i), title: i.title, source: i.isDraft ? 'your PR, draft' : 'your PR' })),
      ...issues
        .filter(i => !/epic/i.test(i.title))
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
        .slice(0, 4)
        .map(i => ({ isDone: false, ref: refOf(i), title: i.title, source: 'issue' })),
      ...closed.slice(0, 3).map(i => ({ isDone: true, ref: refOf(i), title: i.title, source: 'issue, closed' })),
    ]

    const at = localDate(now)
    const hhmm = at.toISOString().slice(11, 16)
    const snapshot: Snapshot = {
      at: hhmm,
      reviews: reviewPrs.map(p => p.ref.text),
      prs: prs.map(p => `${p.ref.text}${p.isDraft ? ' (draft)' : ''}`),
      issues: issues.map(i => refOf(i).text),
      merged: mergedPrs.map(p => p.ref.text),
      agents: [],
      failing: prs.filter(p => p.ci === 'fail').map(p => p.ref.text),
    }
    const prev = (await $.store.get('snapshot')) as Snapshot | undefined
    const seed = (((await $.store.get('seed')) as number | undefined) ?? 0) + 1
    await $.store.set('seed', seed)
    // Alerts for what is new since the last look; the first look alerts nothing.
    if (prev && errors.length === 0) {
      for (const p of reviewPrs) if (!prev.reviews.includes(p.ref.text)) alert($, `Review requested: ${p.ref.text} ${p.title}`)
      for (const p of prs) {
        if (p.ci === 'fail' && !(prev.failing ?? []).includes(p.ref.text)) alert($, `CI failed: ${p.ref.text} ${p.title}`)
      }
    }
    // A source that failed would read as everything gone, so keep the old snapshot then.
    if (errors.length === 0) await $.store.set('snapshot', snapshot)

    const next: Board = {
      updated: `${WEEKDAYS[at.getUTCDay()]} ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}, ${hhmm} ${TZ_LABEL}`,
      changed: errors.length === 0 ? changes(prev, snapshot) : 'Some sources failed. Changes are not compared.',
      errors,
      agents: [],
      today: null,
      next: null,
      later: [],
      tasks,
      reviews: reviewPrs,
      prs,
      issues: [...repoIssues.values()].sort((a, b) => b.count - a.count),
      issueCount: issues.length,
      merged: mergedPrs,
      mergedUrl: `https://github.com/pulls?q=${encodeURIComponent(`is:pr author:@me is:merged merged:>=${since}`)}`,
      seed,
    }
    // Meetings come from refreshCalendar; keep what it found last.
    await update($, board, old => (isDemo ? old : { ...next, today: old.today, next: old.next, later: old.later, calendarNote: old.calendarNote }))
    await refreshCalendar($).catch(async (err: unknown) => {
      const text = err instanceof Error ? err.message : String(err)
      await update($, board, b => (isDemo ? b : { ...b, calendarNote: `Calendar failed: ${text}` }))
    })
    // Keep only a board whose sources all answered, so a bad refresh is not what comes back.
    if (errors.length === 0 && !isDemo) await $.store.set('lastBoard', await read($, board))
    await $.ui.status(undefined)
  } finally {
    isRunning = false
  }
}

// A /clear ends the session and the process goes on under a new id, with no
// session.start and with the session's values gone. Put the last board back
// at once, then refresh.
async function restore($: Api): Promise<void> {
  if (isDemo) {
    TZ = realZone.zone
    TZ_LABEL = realZone.label
  }
  isDemo = false
  const saved = (await $.store.get('lastBoard')) as Board | undefined
  if (saved) await update($, board, () => saved)
  lastSubagents = ''
  subagentStatus = undefined
  calendarTries = 0
  await pollSubagents($).catch(() => undefined)
  void openPane($, askedColumns > 0 ? askedColumns : undefined)
  void refresh($)
}

// ---------------------------------------------------------------- banner

// The banner is a pixel canvas, two pixels to a cell: '▀' paints the top
// pixel in the text color and the bottom pixel in the background color.
type Seg = { t: string; c: string; bg?: string; b?: boolean }
// The banner's rows, and the columns the duck takes, for its click.
type Banner = { rows: Seg[][]; duck: [number, number] | null }
type Canvas = string[][]

const SHADOW = '#870000'
const FACE = ['#ffff87', '#ffd75f', '#ffd75f', '#ffaf00', '#ffaf00', '#ff8700', '#ff8700', '#ff5f00']
const HILL_FAR = '#1c2650'
const HILL_NEAR = '#131b3a'
const MOON_LIT = '#fff1c1'
const MOON_SHADE = '#e4d49a'
const CANVAS_H = 16

const FONT: Record<string, string[]> = {
  F: ['######', '######', '##....', '#####.', '#####.', '##....', '##....', '##....'],
  O: ['.####.', '######', '##..##', '##..##', '##..##', '##..##', '######', '.####.'],
  R: ['#####.', '######', '##..##', '######', '#####.', '##.##.', '##..##', '##..##'],
  G: ['.#####', '######', '##....', '##.###', '##.###', '##..##', '######', '.#####'],
  E: ['######', '######', '##....', '#####.', '#####.', '##....', '######', '######'],
}
const WORD = 'FORGE'
const WORD_W = WORD.length * 7 - 1 + 1

// A white duck holding a lightsaber upright: green glow around a pale core,
// a grey hilt in its wing.
const DUCK_SPRITE = [
  '.............GBG',
  '.............GBG',
  '....WWWW.....GBG',
  '...WWWWWW....GBG',
  '...WWWKWOO...GBG',
  '...WWWWWOOO..GBG',
  '....WWWW.....GBG',
  '..W.WWWWWW....H.',
  '.WWWWWWWWWWWWWH.',
  'WWWWSSSSWWWW..D.',
  'WWWWWSSSWWWW....',
  '.WWWWWWWWWW.....',
  '...FF...FF......',
]
const DUCK_COLORS: Record<string, string> = {
  W: WHITE,
  S: '#c6c6d8',
  K: '#262626',
  O: ORANGE,
  F: AMBER,
  G: GREEN,
  B: '#d7ffd7',
  H: '#9e9e9e',
  D: '#585858',
}
const DUCK_W = 16
// The duck without its saber, for the routine, which draws the saber itself.
const BODY_SPRITE = DUCK_SPRITE.map(row => row.replace(/[GBHD]/g, '.'))
// Lightsaber-fu: the blade's angle in degrees (-90 points up, 0 right; it
// never drops below -35, so it points up and away from the body), a hop, and a spark.
type Pose = { angle: number; hop?: number; spark?: boolean }
const FU_POSES: Pose[] = [
  { angle: -90 },
  { angle: -115 },
  { angle: -140 },
  { angle: -160 },
  { angle: -60 },
  { angle: -40, hop: 1 },
  { angle: -35, hop: 1, spark: true },
  { angle: -35, hop: 1, spark: true },
  { angle: -45 },
  { angle: -130 },
  { angle: -150 },
  { angle: -50, hop: 1 },
  { angle: -35, hop: 1, spark: true },
  { angle: -60 },
  { angle: -90 },
]
const FU_MS = 120
const MOON_W = 11

function rng(seed: number) {
  let s = seed >>> 0

  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// A number from 0 to 1 that stays the same for the same inputs.
const hash = (a: number, b: number) => {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12

  return (h >>> 0) / 4294967296
}

const DAY_SKY_TOP = '#4f7fd0'
const DAY_SKY_LOW = '#79a6e8'
const DAY_HILL_FAR = '#3f8f4a'
const DAY_HILL_NEAR = '#2e6e38'
const SUN = '#ffd75f'
const SUN_RAY = '#ffaf00'
const CLOUD = '#f2f6ff'
const CLOUD_SHADE = '#d0dcf0'
const TRAIL = [WHITE, '#d0d0ff', '#8a8ac0', FAINT]

// seed: where the stars sit, new on every refresh. frame: the 3 second beat that
// twinkles them, sends a shooting star now and then, and makes the saber hum.
// isDay: 07:00 to 18:00 local time, a blue sky with a sun and clouds.
// starEvery: beats between shooting stars, 40 (about two minutes) by default.
// fu: the step of the saber routine, -1 on guard.
function bannerRows(width: number, seed: number, frame: number, isDay: boolean, starEvery = 40, fuStep = -1): Banner {
  const full = DUCK_W + 3 + WORD_W + 4 + MOON_W
  const withDuck = DUCK_W + 3 + WORD_W
  if (width < WORD_W + 2) return { rows: [[{ t: ' FORGE ', c: ORANGE, bg: NAVY, b: true }]], duck: null }
  const hasDuck = width >= withDuck + 2
  const hasMoon = width >= full + 2
  const groupW = hasMoon ? full : hasDuck ? withDuck : WORD_W

  const skyAt = (y: number) => (isDay ? (y < 6 ? DAY_SKY_TOP : DAY_SKY_LOW) : NAVY)
  const cv: Canvas = Array.from({ length: CANVAS_H }, (_, y) => Array.from({ length: width }, () => skyAt(y)))
  const put = (x: number, y: number, c: string) => {
    if (y >= 0 && y < CANVAS_H && x >= 0 && x < width) cv[y][x] = c
  }
  const boxes: [number, number, number, number][] = []
  const isFree = (x: number, y: number) => !boxes.some(([bx, by, bw, bh]) => x >= bx - 1 && x <= bx + bw && y >= by - 1 && y <= by + bh)

  let x = Math.floor((width - groupW) / 2)
  const duckX = x
  if (hasDuck) x += DUCK_W + 3
  const wordX = x
  const moonX = wordX + WORD_W + 4
  if (hasDuck) boxes.push([duckX, 0, DUCK_W, 13])
  boxes.push([wordX, 3, WORD_W, 9])
  if (hasMoon) boxes.push([moonX, 1, MOON_W, 11])

  const rand = rng(seed * 7919 + 17)
  if (!isDay) {
    // Stars in the statusline's colors: single pixels, a few crosses, faint
    // dust. Each one twinkles on its own beat.
    const count = Math.floor((width * 12) / 9)
    for (let i = 0; i < count; i++) {
      const sx = Math.floor(rand() * width)
      const sy = Math.floor(rand() * 12)
      const kind = rand()
      const color = STAR_COLORS[Math.floor(rand() * STAR_COLORS.length)]
      const glow = hash(i, frame)
      if (!isFree(sx, sy)) continue
      if (kind < 0.12 && sy > 0 && sy < 11 && isFree(sx - 1, sy) && isFree(sx + 1, sy)) {
        const arm = glow < 0.3 ? FAINT : kind < 0.06 ? YELLOW : WHITE
        put(sx, sy, WHITE)
        if (glow >= 0.15) {
          put(sx - 1, sy, arm)
          put(sx + 1, sy, arm)
          put(sx, sy - 1, arm)
          put(sx, sy + 1, arm)
        }
      } else if (kind < 0.55) {
        put(sx, sy, glow < 0.2 ? FAINT : color)
      } else if (glow > 0.3) {
        put(sx, sy, FAINT)
      }
    }

    // A shooting star for a few beats, every starEvery beats.
    const period = starEvery
    const beat = frame % period
    if (beat < Math.min(6, period - 1)) {
      const run = Math.floor(frame / period)
      const x0 = Math.floor(hash(run, 7) * width * 0.6)
      const y0 = Math.floor(hash(run, 11) * 3)
      for (let t = 0; t < TRAIL.length; t++) {
        const px = x0 + (beat - t) * 4
        const py = y0 + beat - t
        if (beat - t >= 0 && py < 12 && isFree(px, py)) put(px, py, TRAIL[t])
      }
    }
  } else {
    // Clouds drift one pixel a beat.
    const clouds = [
      ['..CCCC...', '.CCCCCCC.', 'SSSSSSSSS'],
      ['...CCC..', '.CCCCCC.', 'SSSSSSSS'],
    ]
    clouds.forEach((cloud, ci) => {
      const span = width + 20
      const cx0 = ((Math.floor(hash(seed, ci) * span) + frame) % span) - 10
      const cy0 = ci === 0 ? 1 : 6
      cloud.forEach((row, ry) =>
        row.split('').forEach((px, rx) => {
          if (px === '.' || !isFree(cx0 + rx, cy0 + ry)) return
          put(cx0 + rx, cy0 + ry, px === 'C' ? CLOUD : CLOUD_SHADE)
        }),
      )
    })
  }

  // Two layers of hills along the bottom.
  for (let hx = 0; hx < width; hx++) {
    const far = 12 + Math.round(Math.sin(hx / 6 + seed) * 1.1 + Math.sin(hx / 2.7) * 0.5)
    const near = 14 + Math.round(Math.sin(hx / 4.3 + 1.3) * 0.9)
    for (let y = far; y < CANVAS_H; y++) put(hx, y, isDay ? DAY_HILL_FAR : HILL_FAR)
    for (let y = near; y < CANVAS_H; y++) put(hx, y, isDay ? DAY_HILL_NEAR : HILL_NEAR)
  }

  // By day a sun with rays that turn each beat.
  if (hasMoon && isDay) {
    const cx = moonX + 5
    const cy = 6
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        if (dx * dx + dy * dy <= 10) put(cx + dx, cy + dy, SUN)
      }
    }
    const rays = frame % 2 === 0 ? [[0, -5], [0, 5], [-5, 0], [5, 0]] : [[-4, -4], [4, -4], [-4, 4], [4, 4]]
    for (const [dx, dy] of rays) put(cx + dx, cy + dy, SUN_RAY)
  }

  // By night a crescent moon: a lit disc with a second disc cut out of its left side.
  if (hasMoon && !isDay) {
    const cx = moonX + 5
    const cy = 6
    for (let dy = -5; dy <= 5; dy++) {
      for (let dx = -5; dx <= 5; dx++) {
        const isLit = dx * dx + dy * dy <= 21
        const isCut = (dx + 3) * (dx + 3) + dy * dy <= 15
        if (isLit && !isCut) put(cx + dx, cy + dy, dx > 2 || dy > 3 ? MOON_SHADE : MOON_LIT)
      }
    }
  }

  // FORGE: a red drop shadow, then the letters in a yellow to orange gradient.
  WORD.split('').forEach((letter, i) => {
    const lx = wordX + i * 7
    FONT[letter].forEach((row, ry) =>
      row.split('').forEach((px, rx) => {
        if (px === '#') put(lx + rx + 1, 3 + ry + 1, SHADOW)
      }),
    )
  })
  WORD.split('').forEach((letter, i) => {
    const lx = wordX + i * 7
    FONT[letter].forEach((row, ry) =>
      row.split('').forEach((px, rx) => {
        if (px === '#') put(lx + rx, 3 + ry, FACE[ry])
      }),
    )
  })

  // The saber hums: core and glow brighten on alternate beats.
  const hum = frame % 2 === 0
  const core = hum ? WHITE : DUCK_COLORS.B
  const glow = hum ? '#87ff87' : GREEN
  const pose = fuStep >= 0 ? FU_POSES[Math.min(fuStep, FU_POSES.length - 1)] : undefined
  if (hasDuck && !pose) {
    DUCK_SPRITE.forEach((row, ry) =>
      row.split('').forEach((px, rx) => {
        const c = px === 'B' ? core : px === 'G' ? glow : DUCK_COLORS[px]
        if (c) put(duckX + rx, ry, c)
      }),
    )
  }
  if (hasDuck && pose) {
    const lift = pose.hop ?? 0
    const body = () =>
      BODY_SPRITE.forEach((row, ry) =>
        row.split('').forEach((px, rx) => {
          const c = DUCK_COLORS[px]
          if (c) put(duckX + rx, ry - lift, c)
        }),
      )
    const saber = () => {
      const rad = (pose.angle * Math.PI) / 180
      const dx = Math.cos(rad)
      const dy = Math.sin(rad)
      const at = (k: number): [number, number] => [Math.round(duckX + 14 + dx * k), Math.round(8 - lift + dy * k)]
      // The glow rings the blade on every side, so a diagonal blade has no gaps.
      for (let k = 1; k <= 7; k++) {
        const [x, y] = at(k)
        for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) put(x + ox, y + oy, glow)
      }
      for (let k = 1; k <= 7; k++) put(...at(k), core)
      put(...at(0), DUCK_COLORS.H)
      put(...at(-1), DUCK_COLORS.D)
      if (pose.spark) {
        const [x, y] = at(9)
        put(x, y, WHITE)
        for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) put(x + ox, y + oy, YELLOW)
      }
    }
    // A blade swung back passes behind the head; one in front, over the body.
    if (pose.angle < -100) {
      saber()
      body()
    } else {
      body()
      saber()
    }
  }

  // Two pixel rows to a cell, runs of the same pair joined into one segment.
  const rows: Seg[][] = []
  for (let y = 0; y < CANVAS_H; y += 2) {
    const segs: Seg[] = []
    for (let cx = 0; cx < width; cx++) {
      const top = cv[y][cx]
      const bottom = cv[y + 1][cx]
      const ch = top === bottom ? ' ' : '▀'
      const last = segs[segs.length - 1]
      if (last && last.c === top && last.bg === bottom) last.t += ch
      else segs.push({ t: ch, c: top, bg: bottom })
    }
    rows.push(segs)
  }

  return { rows, duck: hasDuck ? [duckX, duckX + DUCK_W] : null }
}

// The cells from column `from` to `to` of a banner row.
function sliceRow(row: Seg[], from: number, to: number): Seg[] {
  const out: Seg[] = []
  let col = 0
  for (const seg of row) {
    const start = Math.max(from, col)
    const end = Math.min(to, col + seg.t.length)
    if (end > start) out.push({ ...seg, t: seg.t.slice(start - col, end - col) })
    col += seg.t.length
  }

  return out
}

// ---------------------------------------------------------------- saber-fu

// A click on the duck plays the routine once; a click during it does nothing.
async function saberFu($: Api): Promise<void> {
  if (fuTimer) return
  let step = 0
  await update($, fu, () => step)
  fuTimer = $.clock.every(FU_MS, () => {
    step += 1
    if (step >= FU_POSES.length) {
      fuTimer?.cancel()
      fuTimer = undefined
      void update($, fu, () => -1)

      return
    }
    void update($, fu, () => step)
  })
}

// ---------------------------------------------------------------- demo

const DEMO_URL = 'https://github.com/girdharshubham/forge'
const demoRef = (text: string): Ref => ({ text, url: DEMO_URL })
const demoPr = (text: string, title: string, extra: Partial<Pr> = {}): Pr => ({
  ref: demoRef(text),
  title,
  isDraft: false,
  repo: text.split('#')[0],
  day: '',
  ...extra,
})

const DEMO_SUBAGENTS: Agent[] = [
  { title: 'Review the release notes', detail: 'general-purpose', depth: 0, status: 'WORKING' },
  { title: 'Find broken links in the docs', detail: 'Explore', depth: 1, status: 'WORKING' },
  { title: 'Run the integration tests', detail: 'general-purpose', depth: 0, status: 'WAITING' },
]

// Made-up work around the given moment: a meeting that ended, one under way,
// the next one, and a skipped standup.
function demoBoard(now: number): Board {
  const at = localDate(now)
  const minute = 60_000
  const meeting = (title: string, from: number, to: number, note = ''): Meeting => ({
    time: localDate(now + from * minute).toISOString().slice(11, 16),
    title,
    minutes: to - from,
    note,
    isPast: to < 0,
    startMs: now + from * minute,
    endMs: now + to * minute,
  })
  const day = (offset: number) => localDate(now - offset * 24 * 60 * minute).toISOString().slice(0, 10)

  return {
    updated: `${WEEKDAYS[at.getUTCDay()]} ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}, ${at.toISOString().slice(11, 16)} ${TZ_LABEL}`,
    changed: 'Sample data for screenshots. Run /forge-demo again to go back.',
    errors: [],
    agents: [],
    today: {
      label: `${WEEKDAYS[at.getUTCDay()]} ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`,
      meetings: [
        meeting('Team standup', -180, -165, 'skipped'),
        meeting('Design review: search', -120, -90),
        meeting('Pairing on the deploy script', -10, 20),
        meeting('Release planning', 90, 120, 'no reply'),
        meeting('One-on-one', 240, 270),
      ],
    },
    next: null,
    later: [],
    tasks: [
      { isDone: false, ref: demoRef('app#128'), title: 'feat: add the status page', source: 'your PR' },
      { isDone: false, ref: demoRef('app#140'), title: 'Cache misses after a restart', source: 'issue' },
      { isDone: false, ref: demoRef('infra#71'), title: 'Pin the build image to a digest', source: 'issue' },
      { isDone: true, ref: demoRef('infra#65'), title: 'Docs build fails on a clean checkout', source: 'issue, closed' },
    ],
    reviews: [
      demoPr('app#131', 'feat: add search to the docs site'),
      demoPr('app#126', 'fix: keep the session after a refresh'),
      demoPr('web#57', 'chore: move to the new icons', { isDraft: true }),
      demoPr('api#212', 'feat: page the list endpoint'),
    ],
    prs: [
      demoPr('app#128', 'feat: add the status page', { ci: 'pass', review: 'approved' }),
      demoPr('api#204', 'fix: retry the login call', { ci: 'fail', review: 'changes requested' }),
      demoPr('infra#77', 'chore: pin the build image', { ci: 'running', review: 'waiting for review' }),
      demoPr('web#61', 'feat: dark theme', { isDraft: true, ci: 'pass' }),
      demoPr('docs#19', 'docs: explain the setup', { isDraft: true, ci: 'none' }),
    ],
    issues: [
      { repo: 'app', count: 12, epics: [demoRef('app#90')], recent: [demoRef('app#140'), demoRef('app#139')] },
      { repo: 'infra', count: 4, epics: [], recent: [demoRef('infra#71'), demoRef('infra#69')] },
    ],
    issueCount: 16,
    merged: [
      demoPr('app#124', 'feat: show build times', { day: day(0) }),
      demoPr('api#201', 'fix: close idle connections', { day: day(1) }),
      demoPr('infra#74', 'chore: rotate the staging certificate', { day: day(2) }),
      demoPr('app#119', 'fix: sort the table by date', { day: day(4) }),
      demoPr('web#55', 'feat: add the empty state', { day: day(6) }),
      demoPr('api#198', 'chore: update the client library', { day: day(9) }),
    ],
    mergedUrl: DEMO_URL,
    seed: 7,
    calendarNote: '',
  }
}

// ---------------------------------------------------------------- module

// This computer's time zone and its short name: the runtime's own zone first,
// then where /etc/localtime points, and the label from date(1).
async function computerZone($: Api): Promise<{ zone: string; label: string }> {
  let zone = ''
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''
  } catch {
    zone = ''
  }
  if (zone === '' || zone === 'UTC' || zone === 'Etc/UTC') {
    const link = await $.process.run(['readlink', '/etc/localtime']).catch(() => undefined)
    const found = link?.exitCode === 0 ? link.stdout.trim().match(/zoneinfo\/(.+)$/) : null
    if (found) zone = found[1]
  }
  const date = await $.process.run(['date', '+%Z']).catch(() => undefined)
  const label = date?.exitCode === 0 ? date.stdout.trim() : ''

  return { zone: zone || 'UTC', label: /^[A-Za-z0-9+-]{1,6}$/.test(label) ? label : '' }
}

const splitList = (value: unknown) =>
  String(value ?? '')
    .split(',')
    .map(x => x.trim())
    .filter(x => x !== '')

export const register: Register = (on, options) => {
  ORGS = splitList(options.githubOrgs)
  // An empty time zone or label is filled from this computer at session start.
  const zoneOption = String(options.timeZone ?? '').trim()
  const labelOption = String(options.timeZoneLabel ?? '').trim()
  TZ = zoneOption || 'UTC'
  TZ_LABEL = labelOption || TZ
  ALIASES = new Map(
    splitList(options.repoShortNames)
      .map(pair => pair.split('=').map(x => x.trim()))
      .filter(pair => pair.length === 2 && pair[0] !== '' && pair[1] !== '')
      .map(([repo, name]) => [repo, name] as [string, string]),
  )

  on('session.start', async ($, e, next) => {
    if (zoneOption === '' || labelOption === '') {
      const computer = await computerZone($).catch(() => ({ zone: 'UTC', label: '' }))
      if (zoneOption === '') TZ = computer.zone
      // The computer's short name fits only its own zone.
      if (labelOption === '') TZ_LABEL = zoneOption === '' && computer.label !== '' ? computer.label : TZ
    }
    await $.command.register({ name: 'forge', description: 'Open the Forge status board' })
    await $.command.register({ name: 'forge-refresh', description: 'Refresh the Forge status board now' })
    await $.command.register({ name: 'forge-demo', description: 'Show Forge with sample data, for screenshots; run again to go back' })
    $.clock.every(EVERY_MS, () => void refresh($))
    $.clock.every(SUBAGENTS_MS, () => {
      void pollSubagents($).catch(() => undefined)
      if (wantColumns > 0 && wantColumns !== askedColumns) void openPane($, wantColumns)
    })
    const tick = () =>
      void $.clock
        .now()
        .then(async now => {
          await update($, clock, () => now)
          const b = await read($, board)
          for (const m of b.today?.meetings ?? []) {
            const start = m.startMs ?? 0
            const key = `${start}:${m.title}`
            if (isDemo || m.note === 'skipped' || meetingAlerts.has(key)) continue
            if (start - now > 0 && start - now <= 5 * 60_000) {
              meetingAlerts.add(key)
              alert($, `Starts in 5 minutes: ${m.title}`)
            }
          }
        })
        .catch(() => undefined)
    $.clock.every(FRAME_MS, tick)
    tick()
    const saved = (await $.store.get('lastBoard')) as Board | undefined
    if (saved) await update($, board, () => saved)
    await update($, fu, () => -1)
    void pollSubagents($).catch(() => undefined)
    void refresh($)
    void openPane($)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    if (e.reason === 'clear') $.clock.after(500, () => void restore($).catch(() => undefined))

    return ended
  })

  on('command.run', { command: 'forge' }, async ($, e) => {
    await openPane($, e.presentation?.columns ? share(e.presentation.columns) : undefined)

    return { text: 'Forge is open.' }
  })

  on('command.run', { command: 'forge-refresh' }, async ($, e) => {
    void refresh($)
    await openPane($, e.presentation?.columns ? share(e.presentation.columns) : undefined)

    return { text: 'Forge is refreshing.' }
  })

  on('command.run', { command: 'forge-demo' }, async ($, e) => {
    if (!isDemo) {
      realBoard = await read($, board)
      realSubagents = await read($, subagents)
      isDemo = true
      realZone = { zone: TZ, label: TZ_LABEL }
      TZ = 'UTC'
      TZ_LABEL = 'UTC'
      await update($, board, () => demoBoard(DEMO_NOW))
      await update($, subagents, () => DEMO_SUBAGENTS)
      await openPane($, e.presentation?.columns ? share(e.presentation.columns) : undefined)

      return { text: 'Forge shows sample data. Run /forge-demo again to go back.' }
    }
    isDemo = false
    TZ = realZone.zone
    TZ_LABEL = realZone.label
    if (realBoard) await update($, board, () => realBoard as Board)
    await update($, subagents, () => realSubagents ?? [])
    lastSubagents = ''
    void pollSubagents($).catch(() => undefined)
    void refresh($)

    return { text: 'Forge shows your data again.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const b = await read($, board)
    const subs = await read($, subagents)
    const nowRead = await read($, clock)
    const isGithubHidden = await read($, githubHidden)
    const fuStep = await read($, fu)
    const props = e.props as { bodyColumns?: number }
    const width = Math.max(24, props.bodyColumns ?? e.viewport?.columns ?? 80)
    if (e.viewport?.isFullscreen && e.viewport.columns > 0) wantColumns = share(e.viewport.columns)

    const link = (r: Ref, color = CYAN) => (
      <Text color={color} underline>
        <Link href={r.url} label={r.text} />
      </Text>
    )
    // Every line fits the pane on its own, so nothing wraps: titles are cut to
    // the room the rest of the line leaves, and a list ends in "+N more".
    const room = width - 1
    const fit = (text: string, n: number) => (n < 2 ? '' : text.length > n ? `${text.slice(0, n - 1)}…` : text)
    type Item = { len: number; nodes: unknown[] }
    const list = (used: number, items: Item[]): unknown[] => {
      const total = items.reduce((n, it, i) => n + it.len + (i === 0 ? 0 : 2), used)
      const out: unknown[] = []
      let len = used + (total > room ? 9 : 0)
      let shown = 0
      for (const it of items) {
        const add = it.len + (shown === 0 ? 0 : 2)
        if (len + add > room) break
        if (shown > 0) out.push(<Text>, </Text>)
        out.push(...it.nodes)
        len += add
        shown += 1
      }
      if (shown < items.length) out.push(<Text color={FAINT}>{` +${items.length - shown} more`}</Text>)

      return out
    }
    const refItem = (r: Ref): Item => ({ len: r.text.length, nodes: [link(r)] })
    const header = (title: string) => (
      <Box marginTop={1}>
        <Text color={MAGENTA} bold>
          {title}{' '}
        </Text>
        <Text color={FAINT}>{'─'.repeat(Math.max(0, width - title.length - 1))}</Text>
      </Box>
    )
    const sub = (title: string) => (
      <Text color={YELLOW} bold>
        {title}
      </Text>
    )
    const tagColor: Record<Status, string> = { WORKING: GREEN, WAITING: AMBER, BLOCKED: AMBER, DONE: BLUE }

    // Today's schedule against the clock: done, now, next, later.
    const realNow = nowRead > 0 ? nowRead : Date.now()
    const nowMs = isDemo ? DEMO_NOW : realNow
    // The stars keep their real beat in the demo, so the banner still moves.
    const frame = Math.floor(realNow / FRAME_MS)
    const localHour = localDate(nowMs).getUTCHours()
    const hhmm = (ms: number) => localDate(ms).toISOString().slice(11, 16)
    const span = (ms: number) => {
      const mins = Math.max(0, Math.round(ms / 60000))

      return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`
    }
    const meetings = b.today?.meetings ?? []
    const nextIndex = meetings.findIndex(m => (m.startMs ?? 0) > nowMs && m.note !== 'skipped')
    const nowLine = (
      <Text color={GREEN} bold>
        {`  ▶ now ${hhmm(nowMs)} ${'─'.repeat(Math.max(0, room - 14))}`}
      </Text>
    )
    const schedule: unknown[] = []
    let isNowDrawn = false
    meetings.forEach((m, i) => {
      const start = m.startMs ?? 0
      const end = m.endMs ?? start
      const isDone = end <= nowMs
      const isOn = start <= nowMs && nowMs < end
      if (!isNowDrawn && !isDone && !isOn) {
        schedule.push(nowLine)
        isNowDrawn = true
      }
      if (isOn) isNowDrawn = true
      const range = m.time === 'all day' ? 'all day    ' : `${hhmm(start)}-${hhmm(end)}`
      const isSkipped = m.note === 'skipped'
      const isNext = i === nextIndex
      const lead = `${isOn ? '▶ ' : '  '}${range}  `
      const tail = isSkipped
        ? ' skipped'
        : isOn
          ? ` now, ends in ${span(end - nowMs)}`
          : isNext
            ? ` in ${span(start - nowMs)}`
            : isDone
              ? ' done'
              : ''
      const note = !isDone && m.note !== '' && !isSkipped ? ` ${m.note}` : ''
      const name = fit(isSkipped ? 'Standup' : m.title, room - lead.length - tail.length - note.length)
      schedule.push(
        <Text wrap="truncate-end">
          <Text color={isOn ? GREEN : isDone || isSkipped ? FAINT : isNext ? YELLOW : CYAN} bold={isOn || isNext}>
            {lead}
          </Text>
          <Text color={isDone || isSkipped ? FAINT : WHITE} bold={isOn || isNext} strikethrough={isSkipped}>
            {name}
          </Text>
          <Text color={isOn ? GREEN : isNext ? YELLOW : FAINT}>{tail}</Text>
          <Text color={AMBER}>{note}</Text>
        </Text>,
      )
    })
    if (!isNowDrawn) schedule.push(nowLine)

    const byRepo = (list: Pr[]) => {
      const map = new Map<string, Pr[]>()
      for (const p of list) map.set(p.repo, [...(map.get(p.repo) ?? []), p])

      return [...map.entries()]
    }
    const ready = b.prs.filter(p => !p.isDraft)
    const banner = bannerRows(width, b.seed, frame, !isDemo && localHour >= 7 && localHour < 18, isDemo ? DEMO_STAR_EVERY : 40, fuStep)
    const cells = (segs: Seg[]) =>
      segs.map(s => (
        <Text color={s.c} backgroundColor={s.bg ?? NAVY} bold={s.b === true}>
          {s.t}
        </Text>
      ))
    const working = subs.filter(a => a.status === 'WORKING').length
    const failing = b.prs.filter(p => p.ci === 'fail').length
    const nextMeeting = nextIndex >= 0 ? meetings[nextIndex] : undefined
    const ciColor: Record<Ci, string> = { pass: GREEN, fail: RED, running: AMBER, none: FAINT }
    const reviewColor = (r?: string) => (r === 'approved' ? GREEN : r === 'changes requested' ? RED : AMBER)
    const dot = (p: Pr) => <Text color={ciColor[p.ci ?? 'none']}>● </Text>
    const summaryLead = `${b.reviews.length} reviews  ${working} working  ${failing} CI failing  next: `.length
    const drafts = b.prs.filter(p => p.isDraft)
    const mergedRepos = byRepo(b.merged).map(([repo, list]) => `${repo} ${list.length}`)

    return (
      <Box flexDirection="column" width={width}>
        {banner.rows.map((row, r) =>
          banner.duck && r < 7 ? (
            <Box>
              <Text wrap="truncate-end">{cells(sliceRow(row, 0, banner.duck[0]))}</Text>
              <Button key={`duck-${r}`} plain onPress={() => saberFu($)}>
                {cells(sliceRow(row, banner.duck[0], banner.duck[1]))}
              </Button>
              <Text wrap="truncate-end">{cells(sliceRow(row, banner.duck[1], width))}</Text>
            </Box>
          ) : (
            <Text wrap="truncate-end">{cells(row)}</Text>
          ),
        )}
        <Text wrap="truncate-end">
          <Text color={YELLOW} bold>{`${b.reviews.length} reviews`}</Text>
          <Text color={FAINT}>{'  '}</Text>
          <Text color={working > 0 ? GREEN : FAINT} bold={working > 0}>{`${working} working`}</Text>
          <Text color={FAINT}>{'  '}</Text>
          <Text color={failing > 0 ? RED : FAINT} bold={failing > 0}>{`${failing} CI failing`}</Text>
          <Text color={FAINT}>{'  next: '}</Text>
          <Text color={CYAN}>
            {nextMeeting
              ? `${fit(nextMeeting.title, room - summaryLead - 4 - span((nextMeeting.startMs ?? 0) - nowMs).length)} in ${span((nextMeeting.startMs ?? 0) - nowMs)}`
              : fit('nothing today', room - summaryLead)}
          </Text>
        </Text>
        <Box>
          <Button key="refresh" hotkey="r" plain onPress={() => refresh($)}>
            <Text color={CYAN}>Refresh</Text>
          </Button>
          <Text>{'   '}</Text>
          <Button key="github" hotkey="g" plain onPress={() => update($, githubHidden, v => !v)}>
            <Text color={CYAN}>{isGithubHidden ? 'Show GitHub' : 'Hide GitHub'}</Text>
          </Button>
          <Text>{'   '}</Text>
          <Button key="saber" hotkey="d" plain onPress={() => saberFu($)}>
            <Text color={GREEN}>Saber-fu</Text>
          </Button>
        </Box>
        <Text>
          <Text color={GREEN} bold>Updated </Text>
          <Text color={WHITE}>{b.updated === '' ? 'not yet' : b.updated}</Text>
        </Text>
        <Text color={CYAN} wrap="truncate-end">
          {fit(b.changed, room)}
        </Text>
        {b.errors.map(err => (
          <Text color={RED} wrap="truncate-end">
            {fit(err, room)}
          </Text>
        ))}

        {header('SUBAGENTS')}
        {subs.length === 0 && <Text color={FAINT}>No subagents running in this session.</Text>}
        {subs.map(a => (
          <Box justifyContent="space-between" width={width}>
            <Button key={`sub-${a.id ?? a.title}`} plain onPress={() => (a.id ? $.ui.view({ agentId: a.id }) : undefined)}>
              <Text color={tagColor[a.status]}>{`${ROBOT} `}</Text>
              <Text color={FAINT}>{(a.depth ?? 0) > 0 ? `${'  '.repeat((a.depth ?? 1) - 1)}└ ` : ''}</Text>
              <Text color={WHITE} underline>
                {fit(a.title, room - 2 * (a.depth ?? 0) - 5 - (a.detail ?? '').length - 1 - (a.status.length + 3))}
              </Text>
              <Text color={FAINT}>{` ${a.detail ?? ''}`}</Text>
            </Button>
            <Text color={NAVY} backgroundColor={tagColor[a.status]} bold>
              {` ${a.status} `}
            </Text>
          </Box>
        ))}

        {header(`SCHEDULE ${b.today ? b.today.label.toUpperCase() : 'TODAY'} (${TZ_LABEL})`)}
        {(b.calendarNote ?? '') !== '' && (
          <Text color={AMBER} wrap="truncate-end">
            {fit(b.calendarNote ?? '', room)}
          </Text>
        )}
        {b.today && meetings.length === 0 && <Text color={FAINT}>No meetings today.</Text>}
        {b.today && meetings.length > 0 && schedule}

        {header('ASSIGNED TO YOU')}
        {b.tasks.length === 0 && <Text color={FAINT}>Nothing assigned.</Text>}
        {b.tasks.map(t => (
          <Text wrap="truncate-end">
            <Text color={t.isDone ? GREEN : YELLOW} bold>
              {t.isDone ? '[x] ' : '[ ] '}
            </Text>
            {link(t.ref)}
            <Text color={t.isDone ? FAINT : WHITE}>{` ${fit(t.title, room - 4 - t.ref.text.length - 1 - (t.source.length + 3))}`}</Text>
            <Text color={FAINT}>{` (${t.source})`}</Text>
          </Text>
        ))}

        {header('GITHUB')}
        {isGithubHidden && <Text color={FAINT}>Hidden. Press g or click Show GitHub.</Text>}
        {!isGithubHidden && sub(`Review requested from you (${b.reviews.length})`)}
        {!isGithubHidden && byRepo(b.reviews).map(([repo, prsOf]) => (
          <Text wrap="truncate-end">
            <Text color={WHITE}>{`  • ${repo}: `}</Text>
            {list(
              `  • ${repo}: `.length,
              prsOf.map(p => ({
                len: p.ref.text.length + (p.isDraft ? 6 : 0),
                nodes: [link(p.ref), ...(p.isDraft ? [<Text color={FAINT}> draft</Text>] : [])],
              })),
            )}
          </Text>
        ))}
        {!isGithubHidden && sub(`Your open PRs (${b.prs.length}, ${drafts.length} draft)`)}
        {!isGithubHidden &&
          ready.map(p => (
            <Text wrap="truncate-end">
              <Text color={FAINT}>{'  • '}</Text>
              {dot(p)}
              {link(p.ref, GREEN)}
              {p.review ? <Text color={reviewColor(p.review)}>{` ${p.review}`}</Text> : <Text></Text>}
              <Text color={WHITE}>
                {` ${fit(p.title, room - 6 - p.ref.text.length - (p.review ? p.review.length + 1 : 0) - 1)}`}
              </Text>
            </Text>
          ))}
        {!isGithubHidden && drafts.length > 0 && (
          <Text wrap="truncate-end">
            <Text color={FAINT}>{'  • Drafts: '}</Text>
            {list(12, drafts.map(p => ({ len: p.ref.text.length + 2, nodes: [dot(p), link(p.ref)] })))}
          </Text>
        )}
        {!isGithubHidden && sub(`Assigned issues (${b.issueCount})`)}
        {!isGithubHidden && b.issues.map(r => (
          <Text wrap="truncate-end">
            <Text color={WHITE}>{`  • ${r.repo}: ${r.count} open`}</Text>
            <Text color={WHITE}>{r.epics.length > 0 ? ', epics ' : r.recent.length > 0 ? ', latest ' : ''}</Text>
            {list(
              `  • ${r.repo}: ${r.count} open`.length + (r.epics.length > 0 ? 8 : 9),
              (r.epics.length > 0 ? r.epics : r.recent).map(refItem),
            )}
          </Text>
        ))}
        {!isGithubHidden && sub('Recently merged')}
        {!isGithubHidden && b.merged.slice(0, 3).map(p => (
          <Text wrap="truncate-end">
            <Text color={FAINT}>{`  • ${p.day.slice(5)} `}</Text>
            {link(p.ref, MAGENTA)}
            <Text color={WHITE}>{` ${fit(p.title, room - 10 - p.ref.text.length - 1)}`}</Text>
          </Text>
        ))}
        <Text wrap="truncate-end">
          <Text color={FAINT}>{'  • '}</Text>
          {link({ text: `${b.merged.length} merged in 14 days`, url: b.mergedUrl }, GREEN)}
          <Text color={FAINT}>
            {mergedRepos.length > 0 ? fit(`: ${mergedRepos.join(', ')}`, room - 4 - `${b.merged.length} merged in 14 days`.length) : ''}
          </Text>
        </Text>
        <Box marginTop={1}>
          <Text color={FAINT}>{fit('Refreshes every 15 min. /forge-refresh refreshes now.', room)}</Text>
        </Box>
      </Box>
    )
  })
}
