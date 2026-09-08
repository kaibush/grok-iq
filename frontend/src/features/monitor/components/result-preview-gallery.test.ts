import { describe, expect, it } from 'vitest'
import type { ProbeRun, UpstreamAccount } from '@/lib/api'
import type { AccountPreviewPayload } from '@/lib/preview-payload'
import {
  previewItemsFromAccountPreview,
  previewItemsFromAccounts,
  previewItemsFromRuns,
  previewThumbColumns,
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
