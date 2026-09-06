import { describe, expect, it } from 'vitest'
import type { RequestAuditRecord } from '@/lib/api'
import {
  auditCostLabel,
  billingSummary,
  compactRequestPath,
  formatUsdTicks,
  hasGatewayUsage,
  headerEntries,
  mergeRequestAuditDetail,
  usageSourceLabel,
} from './request-audit-gateway'

function record(
  overrides: Partial<RequestAuditRecord> = {}
): RequestAuditRecord {
  return {
    id: '1',
    requestId: 'req-1',
    provider: 'grok_build',
    operation: 'chat',
    modelPublicId: 'grok-4.6',
    modelUpstreamModel: 'Build/grok-4.6',
    accountId: 7,
    accountName: 'alice',
    clientKeyId: '9',
    clientKeyName: 'production',
    upstreamAccountFound: true,
    upstreamEnabled: true,
    upstreamAuthStatus: 'valid',
    egressNodeId: 3,
    egressNodeName: 'node-3',
    egressMode: 'proxy',
    egressScope: 'grok_build',
    statusCode: 200,
    streaming: true,
    inputTokens: 80,
    mediaInputImages: 0,
    hasMediaInput: false,
    outputTokens: 40,
    reasoningTokens: 12,
    reasoningTokensReported: true,
    totalTokens: 132,
    firstTokenMs: 100,
    durationMs: 800,
    tps: 50,
    riskLevel: 'normal',
    riskReasons: [],
    riskRuleId: '',
    riskRuleIds: [],
    reasoningZeroRisk: false,
    reasoningZeroStreak: 0,
    reasoningZeroMinCount: 2,
    preDisableCheck: null,
    probeSampleCount: 0,
    probeSamples: [],
    createdAt: '2026-09-06T00:00:00Z',
    ...overrides,
  }
}

describe('formatUsdTicks', () => {
  it('formats grok2api ticks into dollars', () => {
    expect(formatUsdTicks(200_000_000, 6)).toBe('$0.020000')
    expect(formatUsdTicks(0)).toBe('')
  })
})

describe('auditCostLabel', () => {
  it('prefers billed ticks and marks estimates', () => {
    expect(auditCostLabel(record({ costInUsdTicks: 200_000_000 }))).toBe(
      '$0.020000'
    )
    expect(
      auditCostLabel(record({ estimatedCostInUsdTicks: 100_000_000 }))
    ).toBe('$0.010000 估')
  })
})

describe('compactRequestPath', () => {
  it('joins method and path', () => {
    expect(
      compactRequestPath(
        record({ requestMethod: 'POST', requestPath: '/v1/messages' })
      )
    ).toBe('POST /v1/messages')
  })
})

describe('usageSourceLabel', () => {
  it('translates grok2api usage sources', () => {
    expect(usageSourceLabel('upstream')).toBe('上游上报')
    expect(usageSourceLabel('estimated')).toBe('估算')
  })
})

describe('headerEntries', () => {
  it('sorts and joins header values', () => {
    expect(
      headerEntries({
        'X-B': ['2'],
        'X-A': ['1', '9'],
      })
    ).toEqual([
      ['X-A', '1, 9'],
      ['X-B', '2'],
    ])
  })
})

describe('hasGatewayUsage', () => {
  it('detects token, media, or billing evidence', () => {
    expect(hasGatewayUsage(record({ outputTokens: 0, inputTokens: 0, reasoningTokens: 0 }))).toBe(false)
    expect(hasGatewayUsage(record({ cachedInputTokens: 4 }))).toBe(true)
  })
})

describe('billingSummary', () => {
  it('joins source, method, and model', () => {
    expect(
      billingSummary({
        source: 'official',
        method: 'official_rates',
        model: 'grok-4',
        tier: 'long_context',
      })
    ).toBe('官方费率 · 官方费率拆分 · grok-4 · 长上下文')
  })
})

describe('mergeRequestAuditDetail', () => {
  it('overlays grok2api extras without dropping IQ risk fields', () => {
    const merged = mergeRequestAuditDetail(
      record({
        riskLevel: 'high',
        riskReasons: ['TPS 过高'],
        clientIp: '',
        cachedInputTokens: 4,
      }),
      record({
        riskLevel: 'normal',
        riskReasons: [],
        clientIp: '203.0.113.8',
        cachedInputTokens: 18,
        billing: { source: 'official', method: 'official_rates', totalInUsdTicks: 200_000_000 },
        attemptCount: 2,
        attempts: [
          {
            id: 'a1',
            number: 1,
            source: 'upstream_http',
            stage: 'adapter',
          },
        ],
        gatewayHydrated: true,
      })
    )
    expect(merged.riskLevel).toBe('high')
    expect(merged.riskReasons).toEqual(['TPS 过高'])
    expect(merged.clientIp).toBe('203.0.113.8')
    expect(merged.cachedInputTokens).toBe(18)
    expect(merged.billing?.source).toBe('official')
    expect(merged.attempts?.[0]?.stage).toBe('adapter')
    expect(merged.gatewayHydrated).toBe(true)
  })

  it('keeps existing gateway extras when the detail payload omits them', () => {
    const merged = mergeRequestAuditDetail(
      record({
        clientIp: '198.51.100.10',
        cachedInputTokens: 9,
        requestPath: '/v1/messages',
      }),
      record({
        clientIp: '',
        cachedInputTokens: undefined,
        requestPath: '',
      })
    )
    expect(merged.clientIp).toBe('198.51.100.10')
    expect(merged.cachedInputTokens).toBe(9)
    expect(merged.requestPath).toBe('/v1/messages')
  })
})
