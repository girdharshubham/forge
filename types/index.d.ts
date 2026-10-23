export type Ref = { text: string; url: string }
export type Status = 'WORKING' | 'WAITING' | 'BLOCKED' | 'DONE'
export type Agent = { title: string; status: Status; detail?: string; depth?: number; id?: string; address?: string }
export type Meeting = { time: string; title: string; minutes: number; note: string; isPast: boolean; startMs?: number; endMs?: number }
export type Day = { label: string; meetings: Meeting[] }
export type Task = { isDone: boolean; ref: Ref; title: string; source: string }
export type Ci = 'pass' | 'fail' | 'running' | 'none'
export type Pr = { ref: Ref; title: string; isDraft: boolean; repo: string; day: string; ci?: Ci; review?: string }
export type RepoIssues = { repo: string; count: number; epics: Ref[]; recent: Ref[] }

export type Board = {
  updated: string
  changed: string
  errors: string[]
  agents: Agent[]
  today: Day | null
  next: Day | null
  later: Day[]
  tasks: Task[]
  reviews: Pr[]
  prs: Pr[]
  issues: RepoIssues[]
  issueCount: number
  merged: Pr[]
  mergedUrl: string
  seed: number
  calendarNote?: string
}

declare module 'claude-code' {
  interface PluginState {
    forge: { board: Shaped<Board>; subagents: Shaped<Agent[]>; now: Shaped<number>; githubHidden: Shaped<boolean>; fu: Shaped<number> }
  }
}
