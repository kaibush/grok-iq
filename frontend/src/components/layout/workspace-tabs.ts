import {
  readRequestAuditsSearch,
  requestAuditPathForTab,
  requestAuditTabFromPath,
  type RequestAuditsSearch,
} from '@/features/monitor/pages/request-audits-search'
import {
  readRunsSearch,
  type RunsSearch,
} from '@/features/monitor/pages/runs-search'

export const WORKSPACE_TAB_IDS = [
  'accounts',
  'quarantine',
  'cooldown',
  'runs',
  'request-audits',
] as const

export type WorkspaceTabId = (typeof WORKSPACE_TAB_IDS)[number]

export const WORKSPACE_TAB_PATHS = {
  accounts: '/accounts',
  quarantine: '/quarantine',
  cooldown: '/cooldown',
  runs: '/runs',
  'request-audits': '/request-audits',
} as const

export const WORKSPACE_TAB_TITLES: Record<WorkspaceTabId, string> = {
  accounts: '账号探针',
  quarantine: '隔离区',
  cooldown: '冷却区',
  runs: '任务中心',
  'request-audits': '请求审计',
}

export type WorkspaceTabTo =
  | (typeof WORKSPACE_TAB_PATHS)[WorkspaceTabId]
  | '/request-audits/workspace'
  | '/request-audits/ledger'
  | '/request-audits/schedule'

export type WorkspaceTabLocation = {
  pathname: string
  search: Record<string, unknown>
}

export type WorkspaceTabSearch = RequestAuditsSearch | RunsSearch

export type WorkspaceTabLink = {
  to: WorkspaceTabTo
  search?: WorkspaceTabSearch
}

export function normalizePathname(pathname: string): string {
  const path = pathname.replace(/\/+$/, '')
  return path || '/'
}

export function matchWorkspaceTabId(pathname: string): WorkspaceTabId | null {
  const path = normalizePathname(pathname)
  if (path === '/request-audits' || path.startsWith('/request-audits/')) {
    return 'request-audits'
  }
  const matched = WORKSPACE_TAB_IDS.find(
    (id) => WORKSPACE_TAB_PATHS[id] === path
  )
  return matched ?? null
}

export function isWorkspaceTabPath(pathname: string): boolean {
  return matchWorkspaceTabId(pathname) != null
}

export function workspaceTabLink(
  id: WorkspaceTabId,
  last?: WorkspaceTabLocation
): WorkspaceTabLink {
  if (id === 'runs') {
    if (!last) return { to: '/runs' }
    const search = readRunsSearch(last.search)
    return {
      to: '/runs',
      ...(Object.keys(search).length > 0 ? { search } : {}),
    }
  }
  if (id !== 'request-audits') {
    return { to: WORKSPACE_TAB_PATHS[id] }
  }
  if (!last) {
    return { to: '/request-audits' }
  }
  const search = readRequestAuditsSearch(last.search)
  return {
    to: requestAuditPathForTab(requestAuditTabFromPath(last.pathname)),
    ...(Object.keys(search).length > 0 ? { search } : {}),
  }
}
