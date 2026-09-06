import type {
  RequestAuditAttempt,
  RequestAuditBilling,
  RequestAuditRecord,
} from '@/lib/api'

export const USD_TICKS_PER_DOLLAR = 10_000_000_000

const USAGE_SOURCE_LABELS: Record<string, string> = {
  upstream: '上游上报',
  estimated: '估算',
  none: '无用量',
}

const BILLING_SOURCE_LABELS: Record<string, string> = {
  upstream: '上游账单',
  official: '官方费率',
}

const BILLING_METHOD_LABELS: Record<string, string> = {
  upstream_reported: '上游原值',
  official_rates: '官方费率拆分',
  stored_estimate: '已存估算',
}

const BILLING_COMPONENT_LABELS: Record<string, string> = {
  uncached_input: '未缓存输入',
  cached_input: '缓存输入',
  output: '输出',
  input_image: '输入图片',
  output_image: '输出图片',
  output_second: '输出时长',
}

const ATTEMPT_SOURCE_LABELS: Record<string, string> = {
  upstream_http: '上游 HTTP',
  gateway_transport: '网关传输',
  credential: '凭证',
}

export function formatUsdTicks(ticks?: number | null, digits = 6): string {
  const value = Number(ticks)
  if (!Number.isFinite(value) || value <= 0) return ''
  return `$${(value / USD_TICKS_PER_DOLLAR).toFixed(digits)}`
}

export function auditCostLabel(record: Pick<
  RequestAuditRecord,
  'costInUsdTicks' | 'estimatedCostInUsdTicks' | 'billing'
>): string {
  const billed = formatUsdTicks(
    record.billing?.totalInUsdTicks || record.costInUsdTicks,
    6
  )
  if (billed) return billed
  const estimated = formatUsdTicks(record.estimatedCostInUsdTicks, 6)
  return estimated ? `${estimated} 估` : ''
}

export function usageSourceLabel(value?: string | null): string {
  const key = String(value || '').trim()
  return USAGE_SOURCE_LABELS[key] || key
}

export function billingSourceLabel(value?: string | null): string {
  const key = String(value || '').trim()
  return BILLING_SOURCE_LABELS[key] || key
}

export function billingMethodLabel(value?: string | null): string {
  const key = String(value || '').trim()
  return BILLING_METHOD_LABELS[key] || key
}

export function billingComponentLabel(value?: string | null): string {
  const key = String(value || '').trim()
  return BILLING_COMPONENT_LABELS[key] || key
}

export function attemptSourceLabel(value?: string | null): string {
  const key = String(value || '').trim()
  return ATTEMPT_SOURCE_LABELS[key] || key
}

export function hasGatewayUsage(record: RequestAuditRecord): boolean {
  return Boolean(
    record.inputTokens ||
      record.cachedInputTokens ||
      record.outputTokens ||
      record.reasoningTokens ||
      record.mediaInputImages ||
      record.mediaOutputImages ||
      record.mediaOutputSeconds ||
      record.costInUsdTicks ||
      record.estimatedCostInUsdTicks ||
      record.billing?.totalInUsdTicks
  )
}

export function compactRequestPath(record: RequestAuditRecord): string {
  const method = String(record.requestMethod || '').trim()
  const path = String(record.requestPath || '').trim()
  if (method && path) return `${method} ${path}`
  return path || method
}

export function headerEntries(
  headers?: Record<string, string[]> | null
): Array<[string, string]> {
  return Object.entries(headers || {})
    .map(([key, values]) => [key, (values || []).filter(Boolean).join(', ')] as [string, string])
    .filter(([, value]) => value)
    .sort(([left], [right]) => left.localeCompare(right))
}

export function sortedAttempts(attempts?: RequestAuditAttempt[] | null): RequestAuditAttempt[] {
  return [...(attempts || [])].sort((left, right) => (left.number || 0) - (right.number || 0))
}

function overlayGatewayValue<T>(
  current: T | undefined,
  next: T | undefined | null
): T | undefined {
  if (next === undefined || next === null) return current
  if (typeof next === 'string' && next === '') return current
  return next
}

export function mergeRequestAuditDetail(
  base: RequestAuditRecord,
  extra: RequestAuditRecord
): RequestAuditRecord {
  return {
    ...base,
    clientIp: overlayGatewayValue(base.clientIp, extra.clientIp),
    modelRouteId: overlayGatewayValue(base.modelRouteId, extra.modelRouteId),
    usageSource: overlayGatewayValue(base.usageSource, extra.usageSource),
    cachedInputTokens: overlayGatewayValue(
      base.cachedInputTokens,
      extra.cachedInputTokens
    ),
    mediaOutputImages: overlayGatewayValue(
      base.mediaOutputImages,
      extra.mediaOutputImages
    ),
    mediaOutputSeconds: overlayGatewayValue(
      base.mediaOutputSeconds,
      extra.mediaOutputSeconds
    ),
    costInUsdTicks: overlayGatewayValue(base.costInUsdTicks, extra.costInUsdTicks),
    estimatedCostInUsdTicks: overlayGatewayValue(
      base.estimatedCostInUsdTicks,
      extra.estimatedCostInUsdTicks
    ),
    pricingModel: overlayGatewayValue(base.pricingModel, extra.pricingModel),
    pricingVersion: overlayGatewayValue(base.pricingVersion, extra.pricingVersion),
    billing: overlayGatewayValue(base.billing, extra.billing),
    numSourcesUsed: overlayGatewayValue(base.numSourcesUsed, extra.numSourcesUsed),
    numServerSideToolsUsed: overlayGatewayValue(
      base.numServerSideToolsUsed,
      extra.numServerSideToolsUsed
    ),
    contextInputTokens: overlayGatewayValue(
      base.contextInputTokens,
      extra.contextInputTokens
    ),
    contextOutputTokens: overlayGatewayValue(
      base.contextOutputTokens,
      extra.contextOutputTokens
    ),
    requestMethod: overlayGatewayValue(base.requestMethod, extra.requestMethod),
    requestPath: overlayGatewayValue(base.requestPath, extra.requestPath),
    requestHeaders: overlayGatewayValue(base.requestHeaders, extra.requestHeaders),
    attemptCount: overlayGatewayValue(base.attemptCount, extra.attemptCount),
    attempts: overlayGatewayValue(base.attempts, extra.attempts),
    streamSample: overlayGatewayValue(base.streamSample, extra.streamSample),
    gatewayHydrated: overlayGatewayValue(base.gatewayHydrated, extra.gatewayHydrated),
    gatewayError: overlayGatewayValue(base.gatewayError, extra.gatewayError),
  }
}

export function billingSummary(billing?: RequestAuditBilling | null): string {
  if (!billing) return ''
  const parts = [
    billingSourceLabel(billing.source),
    billingMethodLabel(billing.method),
    billing.model,
    billing.tier === 'long_context' ? '长上下文' : '',
  ].filter(Boolean)
  return parts.join(' · ')
}
