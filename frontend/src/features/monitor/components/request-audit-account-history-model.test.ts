import { describe, expect, it } from 'vitest'
import type {
  RequestAuditHistoryAccount,
  RequestAuditHistoryBucket,
} from '@/lib/api'
import {
  accountMatchesHistoryFilter,
  historyAccountKey,
  historyAxisTicks,
  historyEpisodeAt,
  historyEpisodePlacement,
  paintHistorySwimlane,
  sortHistoryAccounts,
} from './request-audit-account-history-model'

function account(
  patch: Partial<RequestAuditHistoryAccount>
): RequestAuditHistoryAccount {
  return {
    accountId: 1,
    accountName: 'alice',
    requests: 10,
    successfulRequests: 10,
    failedRequests: 0,
    successRate: 100,
    normalRequests: 10,
    watchRequests: 0,
    highRiskRequests: 0,
    currentState: 'normal',
    pattern: 'always_normal',
    regular: false,
    periodMinutes: null,
    stillAbnormal: false,
    neverNormal: false,
    alwaysNormal: true,
    recovered: false,
    failing: false,
    firstSeenAt: '2026-09-04T00:00:00+08:00',
    lastSeenAt: '2026-09-04T01:00:00+08:00',
    lastNormalAt: '2026-09-04T01:00:00+08:00',
    lastAbnormalAt: null,
    abnormalEpisodes: 0,
    longestAbnormalMinutes: 0,
    totalAbnormalMinutes: 0,
    medianRecoveryMinutes: null,
    lastRecoveryMinutes: null,
    buckets: [],
    episodes: [],
    ...patch,
  }
}

function bucket(
  start: string,
  end: string,
  patch: Partial<RequestAuditHistoryBucket> = {}
): RequestAuditHistoryBucket {
  return {
    start,
    end,
    requests: 0,
    normalRequests: 0,
    watchRequests: 0,
    highRiskRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    dominant: 'empty',
    ...patch,
  }
}

describe('request audit account history helpers', () => {
  it('keys unlabeled accounts separately', () => {
    expect(
      historyAccountKey(account({ accountId: null, accountName: 'ghost' }))
    ).toBe('unknown:ghost')
  })

  it('filters recovered and failing independently of pattern', () => {
    const recovered = account({
      pattern: 'occasional',
      recovered: true,
      alwaysNormal: false,
    })
    expect(accountMatchesHistoryFilter(recovered, 'recovered')).toBe(true)
    expect(accountMatchesHistoryFilter(recovered, 'occasional')).toBe(true)
    expect(accountMatchesHistoryFilter(recovered, 'failing')).toBe(false)
  })

  it('sorts still abnormal accounts first', () => {
    const ordered = sortHistoryAccounts(
      [
        account({ accountId: 1, accountName: 'ok', stillAbnormal: false }),
        account({
          accountId: 2,
          accountName: 'bad',
          stillAbnormal: true,
          pattern: 'still_abnormal',
          alwaysNormal: false,
        }),
      ],
      'still_abnormal'
    )
    expect(ordered.map((item) => item.accountName)).toEqual(['bad', 'ok'])
  })

  it('keeps zero-width episodes visible on the timeline', () => {
    const place = historyEpisodePlacement(
      {
        start: '2026-09-04T01:00:00+08:00',
        end: '2026-09-04T01:00:00+08:00',
      },
      '2026-09-04T00:00:00+08:00',
      '2026-09-04T04:00:00+08:00',
      4
    )
    expect(place.left).toBeCloseTo(25, 5)
    expect(place.width).toBe(4)
  })

  it('places more than three time-axis ticks for a long window', () => {
    const buckets = Array.from({ length: 24 }, (_, index) => {
      const startHour = String(index).padStart(2, '0')
      const end =
        index === 23
          ? '2026-09-05T00:00:00+08:00'
          : `2026-09-04T${String(index + 1).padStart(2, '0')}:00:00+08:00`
      return bucket(`2026-09-04T${startHour}:00:00+08:00`, end)
    })
    const ticks = historyAxisTicks(buckets)
    expect(ticks.length).toBeGreaterThanOrEqual(4)
    expect(ticks[0]?.align).toBe('start')
    expect(ticks[ticks.length - 1]?.align).toBe('end')
    expect(ticks[ticks.length - 1]?.percent).toBe(100)
  })

  it('finds the episode covering a hovered bucket', () => {
    const episode = {
      start: '2026-09-04T01:00:00+08:00',
      end: '2026-09-04T02:00:00+08:00',
      severity: 'high' as const,
    }
    expect(
      historyEpisodeAt(
        [episode],
        bucket('2026-09-04T01:15:00+08:00', '2026-09-04T01:30:00+08:00')
      )?.severity
    ).toBe('high')
    expect(
      historyEpisodeAt(
        [episode],
        bucket('2026-09-04T03:00:00+08:00', '2026-09-04T03:15:00+08:00')
      )
    ).toBeNull()
  })

  it('compresses empty swimlane color stops', () => {
    const buckets = Array.from({ length: 24 }, (_, index) => {
      const startHour = String(index).padStart(2, '0')
      const end =
        index === 23
          ? '2026-09-05T00:00:00+08:00'
          : `2026-09-04T${String(index + 1).padStart(2, '0')}:00:00+08:00`
      return bucket(`2026-09-04T${startHour}:00:00+08:00`, end)
    })
    buckets[4] = {
      ...buckets[4],
      requests: 6,
      normalRequests: 6,
      successfulRequests: 6,
      dominant: 'normal',
    }
    const paint = paintHistorySwimlane({ buckets, episodes: [] })
    expect(paint.activityGradient).toBeTruthy()
    expect((paint.activityGradient?.match(/rgb\(/g) ?? []).length).toBeLessThan(
      6
    )
  })
})
