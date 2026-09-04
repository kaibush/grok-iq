import { describe, expect, it } from 'vitest'
import {
  isWorkspaceTabPath,
  matchWorkspaceTabId,
  normalizePathname,
  workspaceTabLink,
} from './workspace-tabs'

describe('workspace tabs', () => {
  it('normalizes trailing slashes', () => {
    expect(normalizePathname('/accounts/')).toBe('/accounts')
    expect(normalizePathname('/')).toBe('/')
    expect(normalizePathname('')).toBe('/')
  })

  it('matches the workspace pages', () => {
    expect(matchWorkspaceTabId('/accounts')).toBe('accounts')
    expect(matchWorkspaceTabId('/quarantine/')).toBe('quarantine')
    expect(matchWorkspaceTabId('/cooldown')).toBe('cooldown')
    expect(matchWorkspaceTabId('/cooldown/')).toBe('cooldown')
    expect(matchWorkspaceTabId('/runs/')).toBe('runs')
    expect(matchWorkspaceTabId('/request-audits/')).toBe('request-audits')
    expect(matchWorkspaceTabId('/request-audits/ledger')).toBe('request-audits')
    expect(matchWorkspaceTabId('/request-audits/workspace')).toBe(
      'request-audits'
    )
    expect(matchWorkspaceTabId('/request-audits/history')).toBe(
      'request-audits'
    )
    expect(matchWorkspaceTabId('/settings/risk')).toBeNull()
  })

  it('detects workspace paths', () => {
    expect(isWorkspaceTabPath('/runs')).toBe(true)
    expect(isWorkspaceTabPath('/quarantine')).toBe(true)
    expect(isWorkspaceTabPath('/cooldown')).toBe(true)
    expect(isWorkspaceTabPath('/playground')).toBe(false)
  })

  it('restores nested request-audit dock links', () => {
    expect(workspaceTabLink('accounts')).toEqual({ to: '/accounts' })
    expect(
      workspaceTabLink('request-audits', {
        pathname: '/request-audits/ledger',
        search: { account: '12', view: 'accounts' },
      })
    ).toEqual({
      to: '/request-audits/ledger',
      search: { account: '12' },
    })
    expect(
      workspaceTabLink('runs', {
        pathname: '/runs',
        search: { account: '12', run: 'run-1', extra: 1 },
      })
    ).toEqual({
      to: '/runs',
      search: { account: '12', run: 'run-1' },
    })
  })
})
