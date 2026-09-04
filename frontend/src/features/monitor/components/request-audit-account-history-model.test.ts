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
  historySortOptionsForFilter,
  paintHistorySwimlane,
  resolveHistorySort,
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
    spans: [],
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

  it('hides always-normal sort when viewing never-normal accounts', () => {
    const options = historySortOptionsForFilter('never_normal')
    expect(options.map((item) => item.value)).not.toContain('always_normal')
    expect(resolveHistorySort('always_normal', 'never_normal')).toBe(
      'still_abnormal'
    )
  })

  it('hides abnormal sorts when viewing always-normal accounts', () => {
    const options = historySortOptionsForFilter('always_normal')
    expect(options.map((item) => item.value)).toEqual(['recent'])
    expect(resolveHistorySort('longest', 'always_normal')).toBe('recent')
  })

  it('compresses empty swimlane color stops', () => {
    const buckets = hourBuckets()
    buckets[4] = {
      ...buckets[4],
      requests: 6,
      normalRequests: 6,
      successfulRequests: 6,
      dominant: 'normal',
    }
    const paint = paintHistorySwimlane({
      buckets,
      spans: [],
      normalRequests: 6,
      watchRequests: 0,
      highRiskRequests: 0,
    })
    expect(paint.spans).toHaveLength(1)
    expect(paint.spans[0]?.level).toBe('normal')
    expect(paint.title).toContain('正常 6 次')
  })

  it('paints never-normal swimlanes without green', () => {
    const buckets = hourBuckets()
    const paint = paintHistorySwimlane({
      buckets,
      spans: [
        {
          start: '2026-09-04T04:00:00+08:00',
          end: '2026-09-04T04:00:00+08:00',
          level: 'watch',
          requests: 4,
          successfulRequests: 0,
        },
        {
          start: '2026-09-04T12:00:00+08:00',
          end: '2026-09-04T12:00:00+08:00',
          level: 'high',
          requests: 3,
          successfulRequests: 0,
        },
      ],
      normalRequests: 0,
      watchRequests: 4,
      highRiskRequests: 3,
    })
    expect(paint.spans.map((item) => item.level)).toEqual(['watch', 'high'])
    expect(paint.spans[1]?.left ?? 0).toBeGreaterThan(paint.spans[0]?.left ?? 0)
    expect(paint.title).toBe('观察 4 次 · 高风险 3 次')
  })

  it('keeps recovered green after a same-time watch mark', () => {
    const paint = paintHistorySwimlane({
      buckets: hourBuckets(),
      spans: [
        {
          start: '2026-09-04T16:00:00+08:00',
          end: '2026-09-04T16:00:00+08:00',
          level: 'watch',
          requests: 1,
          successfulRequests: 1,
        },
        {
          start: '2026-09-04T16:00:00+08:00',
          end: '2026-09-04T16:00:00+08:00',
          level: 'normal',
          requests: 2,
          successfulRequests: 2,
        },
      ],
      normalRequests: 2,
      watchRequests: 1,
      highRiskRequests: 0,
    })
    expect(paint.spans.map((item) => item.level)).toEqual(['watch', 'normal'])
    expect(paint.spans[1]?.left ?? 0).toBeGreaterThanOrEqual(
      (paint.spans[0]?.left ?? 0) + (paint.spans[0]?.width ?? 0)
    )
    expect(paint.title).toContain('正常 2 次')
  })
})

function hourBuckets() {
  return Array.from({ length: 24 }, (_, index) => {
    const startHour = String(index).padStart(2, '0')
    const end =
      index === 23
        ? '2026-09-05T00:00:00+08:00'
        : `2026-09-04T${String(index + 1).padStart(2, '0')}:00:00+08:00`
    return bucket(`2026-09-04T${startHour}:00:00+08:00`, end)
  })
}
