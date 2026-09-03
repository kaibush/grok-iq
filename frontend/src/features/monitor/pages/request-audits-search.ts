import { z } from 'zod'

export const REQUEST_AUDIT_TABS = [
  'overview',
  'workspace',
  'history',
  'ledger',
  'schedule',
] as const

export type RequestAuditTab = (typeof REQUEST_AUDIT_TABS)[number]

export const REQUEST_AUDIT_TAB_PATHS = {
  overview: '/request-audits',
  workspace: '/request-audits/workspace',
  history: '/request-audits/history',
  ledger: '/request-audits/ledger',
  schedule: '/request-audits/schedule',
} as const

export const requestAuditsSearchSchema = z.object({
  account: z.string().optional(),
  view: z.enum(['accounts', 'nodes']).optional(),
})

export type RequestAuditsSearch = z.infer<typeof requestAuditsSearchSchema>

export function isRequestAuditsPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '') || '/'
  return path === '/request-audits' || path.startsWith('/request-audits/')
}

export function requestAuditTabFromPath(pathname: string): RequestAuditTab {
  const path = pathname.replace(/\/+$/, '') || '/'
  if (path === '/request-audits/workspace') return 'workspace'
  if (path === '/request-audits/history') return 'history'
  if (path === '/request-audits/ledger') return 'ledger'
  if (path === '/request-audits/schedule') return 'schedule'
  return 'overview'
}

export function requestAuditPathForTab(tab: RequestAuditTab) {
  return REQUEST_AUDIT_TAB_PATHS[tab]
}

export function readRequestAuditsSearch(search: unknown): RequestAuditsSearch {
  const parsed = requestAuditsSearchSchema.safeParse(search)
  if (!parsed.success) return {}
  const account = parsed.data.account?.trim()
  const view = parsed.data.view
  return {
    ...(account ? { account } : {}),
    ...(view && view !== 'accounts' ? { view } : {}),
  }
}

export function pinnedAccountIdFromSearch(
  search: RequestAuditsSearch
): number | null {
  const raw = search.account?.trim() ?? ''
  if (!/^\d+$/.test(raw)) return null
  const id = Number(raw)
  return id > 0 ? id : null
}
