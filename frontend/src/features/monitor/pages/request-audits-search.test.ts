import { describe, expect, it } from 'vitest'
import {
  isRequestAuditsPath,
  pinnedAccountIdFromSearch,
  readRequestAuditsSearch,
  requestAuditPathForTab,
  requestAuditTabFromPath,
} from './request-audits-search'

describe('request audit tab routes', () => {
  it('reads the tab from nested paths', () => {
    expect(requestAuditTabFromPath('/request-audits')).toBe('overview')
    expect(requestAuditTabFromPath('/request-audits/')).toBe('overview')
    expect(requestAuditTabFromPath('/request-audits/workspace')).toBe(
      'workspace'
    )
    expect(requestAuditTabFromPath('/request-audits/history')).toBe('history')
    expect(requestAuditTabFromPath('/request-audits/ledger/')).toBe('ledger')
    expect(requestAuditTabFromPath('/request-audits/schedule')).toBe('schedule')
  })

  it('does not treat other workspace pages as request-audit tabs', () => {
    expect(isRequestAuditsPath('/request-audits/ledger')).toBe(true)
    expect(isRequestAuditsPath('/accounts')).toBe(false)
    expect(isRequestAuditsPath('/settings/workspace')).toBe(false)
    expect(requestAuditTabFromPath('/settings/workspace')).toBe('overview')
  })

  it('builds tab paths', () => {
    expect(requestAuditPathForTab('overview')).toBe('/request-audits')
    expect(requestAuditPathForTab('history')).toBe('/request-audits/history')
    expect(requestAuditPathForTab('ledger')).toBe('/request-audits/ledger')
  })

  it('reads account and node view from search', () => {
    expect(
      readRequestAuditsSearch({ account: ' 42 ', view: 'nodes', extra: 1 })
    ).toEqual({ account: '42', view: 'nodes' })
    expect(readRequestAuditsSearch({ view: 'accounts' })).toEqual({})
    expect(readRequestAuditsSearch({ view: 'nope' })).toEqual({})
  })

  it('treats numeric account search as a pinned account id', () => {
    expect(pinnedAccountIdFromSearch({ account: '42' })).toBe(42)
    expect(pinnedAccountIdFromSearch({ account: ' 7 ' })).toBe(7)
    expect(pinnedAccountIdFromSearch({ account: 'alice' })).toBeNull()
    expect(pinnedAccountIdFromSearch({})).toBeNull()
  })
})
