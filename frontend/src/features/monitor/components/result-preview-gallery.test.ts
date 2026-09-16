import { describe, expect, it } from 'vitest'
import type { ProbeRun, UpstreamAccount } from '@/lib/api'
import type { AccountPreviewPayload } from '@/lib/preview-payload'
import {
  isPreviewableAccountIsolated,
  previewItemsFromAccountPreview,
  previewItemsFromAccounts,
  previewItemsFromRuns,
  previewThumbColumns,
  previewThumbWindow,
  togglePreviewAccountId,
  uniquePreviewAccountIds,
} from './result-preview-gallery'

const run = (overrides: Partial<ProbeRun> = {}): ProbeRun =>
  ({
    id: 'run-1',
    account_id: 5239,
    account_name: 'LawerenceYankus314856@hotmail.com',
    account_email: 'LawerenceYankus314856@hotmail.com',
    profile_id: 'html-card',
    status: 'running',
    rounds: 3,
    total_steps: 3,
    completed_steps: 0,
    error: '',
    created_at: '2026-09-01T12:00:00Z',
    ...overrides,
  }) as ProbeRun

describe('previewItemsFromRuns', () => {
  it('keeps in-progress runs that do not have results yet', () => {
    const items = previewItemsFromRuns([
      run({ id: 'running' }),
      run({
        id: 'done',
        status: 'completed',
        completed_steps: 3,
      }),
    ])
    expect(items.map((item) => item.runId)).toEqual(['running', 'done'])
    expect(items[0]?.status).toBe('running')
  })

  it('copies missingUpstream from probe runs', () => {
    const items = previewItemsFromRuns([
      run({ id: 'gone', missingUpstream: true }),
      run({ id: 'live' }),
    ])
    expect(items[0]?.missingUpstream).toBe(true)
    expect(items[1]?.missingUpstream).toBeUndefined()
  })
})

describe('previewItemsFromAccountPreview', () => {
  it('shows running account tasks without waiting for sample text', () => {
    const payload = {
      accountId: 5239,
      account: {
        id: '5239',
        name: 'LawerenceYankus314856@hotmail.com',
        email: 'LawerenceYankus314856@hotmail.com',
        provider: 'grok',
        enabled: true,
        ssoAvailable: false,
        assessment: { sample_count: 1 },
      } as UpstreamAccount,
      samples: [],
      runs: [
        {
          id: 'run-live',
          account_id: 5239,
          account_name: 'LawerenceYankus314856@hotmail.com',
          account_email: 'LawerenceYankus314856@hotmail.com',
          profile_id: 'pelican',
          rounds: 3,
          completed_steps: 0,
          total_steps: 3,
          status: 'running',
          error: '',
          created_at: '2026-09-01T12:00:00Z',
        },
      ],
    } as AccountPreviewPayload
    const items = previewItemsFromAccountPreview(payload, {
      pelican: '鹈鹕骑自行车',
    })
    expect(items).toHaveLength(1)
    expect(items[0]?.status).toBe('running')
    expect(items[0]?.profileName).toBe('鹈鹕骑自行车')
    expect(items[0]?.missingUpstream).toBeUndefined()
  })

  it('copies missingUpstream from the account payload', () => {
    const payload = {
      accountId: 9003,
      account: {
        id: '9003',
        name: 'missing-upstream',
        email: 'missing@example.com',
        provider: 'grok',
        enabled: false,
        ssoAvailable: false,
        missingUpstream: true,
        assessment: { sample_count: 0 },
      } as UpstreamAccount,
      samples: [],
      runs: [
        {
          id: 'run-missing',
          account_id: 9003,
          account_name: 'missing-upstream',
          account_email: 'missing@example.com',
          profile_id: 'pelican',
          rounds: 1,
          completed_steps: 1,
          total_steps: 1,
          status: 'completed',
          error: '',
          created_at: '2026-09-01T12:00:00Z',
        },
      ],
    } as AccountPreviewPayload
    const items = previewItemsFromAccountPreview(payload)
    expect(items).toHaveLength(1)
    expect(items[0]?.missingUpstream).toBe(true)
  })
})

describe('previewItemsFromAccounts', () => {
  it('keeps listed accounts even when the risk window has no samples', () => {
    const items = previewItemsFromAccounts([
      {
        id: '7111',
        name: 'acu@example.com',
        email: 'acu@example.com',
        provider: 'grok',
        enabled: false,
        ssoAvailable: false,
        assessment: { sample_count: 0, latest_sample_at: null },
      } as UpstreamAccount,
    ])
    expect(items).toHaveLength(1)
    expect(items[0]?.accountId).toBe(7111)
    expect(items[0]?.source).toBe('account')
  })

  it('maps cooldown-listed accounts that do not include assessment', () => {
    const items = previewItemsFromAccounts([
      {
        id: 8821,
        name: 'cooldown-account',
        email: 'cooldown@example.com',
      },
    ])
    expect(items).toHaveLength(1)
    expect(items[0]?.accountId).toBe(8821)
    expect(items[0]?.accountName).toBe('cooldown-account')
    expect(items[0]?.source).toBe('account')
    expect(items[0]?.isolated).toBeUndefined()
    expect(items[0]?.missingUpstream).toBeUndefined()
  })

  it('marks missing-upstream accounts so preview delete stays disabled', () => {
    const items = previewItemsFromAccounts([
      {
        id: 9003,
        name: 'missing-upstream',
        missingUpstream: true,
      },
    ])
    expect(items[0]?.missingUpstream).toBe(true)
  })

  it('marks quarantined accounts so preview isolate can switch to view-only', () => {
    const items = previewItemsFromAccounts([
      {
        id: 9001,
        name: 'isolated-account',
        quarantined: true,
      },
      {
        id: 9002,
        name: 'zone-account',
        assessment: {
          monitor_status: 'quarantined',
          quarantine_until: null,
        },
      },
    ])
    expect(items.map((item) => item.isolated)).toEqual([true, true])
  })
})

describe('isPreviewableAccountIsolated', () => {
  it('treats permanent isolation as isolated and timed quarantine as not', () => {
    expect(
      isPreviewableAccountIsolated({
        id: 1,
        assessment: { monitor_status: 'quarantined' },
      })
    ).toBe(true)
    expect(
      isPreviewableAccountIsolated({
        id: 2,
        assessment: {
          monitor_status: 'quarantined',
          quarantine_until: '2026-09-16T00:00:00Z',
        },
      })
    ).toBe(false)
    expect(isPreviewableAccountIsolated({ id: 3, quarantined: true })).toBe(
      true
    )
  })
})

describe('uniquePreviewAccountIds', () => {
  it('keeps first-seen account ids and skips invalid values', () => {
    expect(
      uniquePreviewAccountIds([
        { accountId: 7 },
        { accountId: 7 },
        { accountId: 11 },
        { accountId: 0 },
        { accountId: -3 },
      ])
    ).toEqual([7, 11])
  })
})

describe('togglePreviewAccountId', () => {
  it('adds and removes a valid account id', () => {
    expect(togglePreviewAccountId([], 9)).toEqual([9])
    expect(togglePreviewAccountId([9, 12], 9)).toEqual([12])
    expect(togglePreviewAccountId([9], 0)).toEqual([9])
  })
})

describe('previewThumbColumns', () => {
  it('keeps desktop thumbnails in a multi-card grid', () => {
    expect(previewThumbColumns(0)).toBe(1)
    expect(previewThumbColumns(375)).toBe(1)
    expect(previewThumbColumns(640)).toBe(2)
    expect(previewThumbColumns(1280)).toBe(4)
    expect(previewThumbColumns(1600)).toBe(5)
  })
})

describe('previewThumbWindow', () => {
  it('keeps the first row mounted when padded scroll is still inside it', () => {
    const window = previewThumbWindow({
      itemCount: 40,
      columns: 5,
      rowHeight: 200,
      scrollTop: 200,
      viewportHeight: 400,
      offsetTop: 16,
      overscanRows: 0,
    })
    expect(window.visibleStartIndex).toBe(0)
    expect(window.startIndex).toBe(0)
  })

  it('includes the last cards when scrolled to the bottom', () => {
    const window = previewThumbWindow({
      itemCount: 47,
      columns: 5,
      rowHeight: 200,
      scrollTop: 1616,
      viewportHeight: 400,
      offsetTop: 16,
      overscanRows: 0,
    })
    expect(window.visibleEndIndex).toBe(47)
    expect(window.endIndex).toBe(47)
  })

  it('overscans extra rows without expanding the live iframe window', () => {
    const window = previewThumbWindow({
      itemCount: 50,
      columns: 5,
      rowHeight: 200,
      scrollTop: 416,
      viewportHeight: 600,
      offsetTop: 16,
      overscanRows: 2,
    })
    expect(window.visibleStartIndex).toBe(10)
    expect(window.visibleEndIndex).toBe(25)
    expect(window.startIndex).toBe(0)
    expect(window.endIndex).toBe(35)
  })
})
