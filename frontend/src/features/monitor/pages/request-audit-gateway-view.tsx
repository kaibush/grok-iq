import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  api,
  type RequestAuditAttempt,
  type RequestAuditRecord,
} from '@/lib/api'
import { cn, formatDate, formatNumber, getErrorMessage } from '@/lib/utils'
import { CopyButton } from '@/components/copy-button'
import {
  auditCostLabel,
  attemptSourceLabel,
  billingComponentLabel,
  billingMethodLabel,
  billingSourceLabel,
  compactRequestPath,
  formatUsdTicks,
  headerEntries,
  mergeRequestAuditDetail,
  sortedAttempts,
  usageSourceLabel,
} from '@/features/monitor/pages/request-audit-gateway'
import { parseRequestSample } from '@/features/monitor/pages/request-audit-request-sample'

const reasoningEffortLabels: Record<string, string> = {
  auto: '自动',
  none: '关闭',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  fixed: '固定',
}

export function reasoningEffortLabel(value?: string | null) {
  return reasoningEffortLabels[value?.trim().toLowerCase() || ''] || ''
}

export function reasoningEffortClass(value?: string | null) {
  switch (value?.trim().toLowerCase()) {
    case 'none':
      return 'text-muted-foreground'
    case 'low':
      return 'text-sky-700 dark:text-sky-300'
    case 'medium':
      return 'text-amber-700 dark:text-amber-300'
    case 'high':
      return 'text-orange-700 dark:text-orange-300'
    case 'xhigh':
      return 'text-rose-700 dark:text-rose-300'
    case 'auto':
      return 'text-violet-700 dark:text-violet-300'
    case 'fixed':
      return 'text-indigo-700 dark:text-indigo-300'
    default:
      return 'text-muted-foreground'
  }
}

export function useHydratedRequestAudit(
  record: RequestAuditRecord | null,
  open: boolean
) {
  const query = useQuery({
    queryKey: ['request-audits', 'detail', record?.id ?? ''],
    queryFn: () => api.requestAudit(record!.id),
    enabled: open && Boolean(record?.id),
    staleTime: 30_000,
    gcTime: 60_000,
    refetchOnWindowFocus: false,
  })
  const view =
    record && query.data ? mergeRequestAuditDetail(record, query.data) : record
  return {
    view,
    loading: query.isLoading,
    error: query.error ? getErrorMessage(query.error) : '',
    refetch: query.refetch,
  }
}

export function AuditUsageCell({ row }: { row: RequestAuditRecord }) {
  const cost = auditCostLabel(row)
  const effort = reasoningEffortLabel(row.reasoningEffort)
  const cached = row.cachedInputTokens ?? 0
  const mediaOutput =
    (row.mediaOutputImages ?? 0) > 0
      ? `${formatNumber(row.mediaOutputImages ?? 0, 0)} 张`
      : (row.mediaOutputSeconds ?? 0) > 0
        ? `${formatNumber(row.mediaOutputSeconds ?? 0, 0)} 秒`
        : ''
  return (
    <div className='font-mono text-xs tabular-nums'>
      <div>{formatNumber(row.outputTokens, 0)}</div>
      <div className='text-[10px] text-muted-foreground'>
        入 {formatNumber(row.inputTokens, 0)}
        {cached > 0 ? ` · 缓存 ${formatNumber(cached, 0)}` : ''}
      </div>
      {(row.reasoningTokens > 0 || effort) && (
        <div className='text-[10px] text-muted-foreground'>
          {row.reasoningTokens > 0
            ? `推理 ${formatNumber(row.reasoningTokens, 0)}`
            : '推理 0'}
          {effort ? (
            <span className={cn('ms-1 font-medium', reasoningEffortClass(row.reasoningEffort))}>
              · 思考 {effort}
            </span>
          ) : null}
        </div>
      )}
      {mediaOutput ? (
        <div className='text-[10px] text-muted-foreground'>媒体出 {mediaOutput}</div>
      ) : null}
      {cost ? <div className='text-[10px] text-muted-foreground'>{cost}</div> : null}
    </div>
  )
}

export function AuditGatewayFields({ record }: { record: RequestAuditRecord }) {
  const path = compactRequestPath(record)
  const cost = auditCostLabel(record)
  const latestUserTurn = parseRequestSample(record.requestSample).latestUserTurn
  return (
    <>
      {latestUserTurn ? (
        <div className='sm:col-span-2 lg:col-span-3'>
          <GatewayField
            label='用户原文'
            value={latestUserTurn}
            copyValue={latestUserTurn}
            preserve
          />
        </div>
      ) : null}
      {record.clientIp ? (
        <GatewayField label='客户端 IP' value={record.clientIp} mono copyValue={record.clientIp} />
      ) : null}
      {record.modelRouteId ? (
        <GatewayField
          label='模型路由'
          value={record.modelRouteId}
          mono
          copyValue={record.modelRouteId}
        />
      ) : null}
      {path ? (
        <GatewayField label='请求路径' value={path} mono copyValue={path} />
      ) : null}
      {record.usageSource ? (
        <GatewayField label='用量来源' value={usageSourceLabel(record.usageSource)} />
      ) : null}
      {(record.cachedInputTokens ?? 0) > 0 ? (
        <GatewayField
          label='缓存 Token'
          value={formatNumber(record.cachedInputTokens ?? 0, 0)}
          mono
        />
      ) : null}
      {(record.contextInputTokens ?? 0) > 0 || (record.contextOutputTokens ?? 0) > 0 ? (
        <GatewayField
          label='上下文 Token'
          value={`${formatNumber(record.contextInputTokens ?? 0, 0)} / ${formatNumber(record.contextOutputTokens ?? 0, 0)}`}
          mono
        />
      ) : null}
      {(record.numSourcesUsed ?? 0) > 0 || (record.numServerSideToolsUsed ?? 0) > 0 ? (
        <GatewayField
          label='检索 / 工具'
          value={`${formatNumber(record.numSourcesUsed ?? 0, 0)} 源 · ${formatNumber(record.numServerSideToolsUsed ?? 0, 0)} 工具`}
        />
      ) : null}
      {(record.mediaOutputImages ?? 0) > 0 || (record.mediaOutputSeconds ?? 0) > 0 ? (
        <GatewayField
          label='媒体输出'
          value={[
            (record.mediaOutputImages ?? 0) > 0
              ? `${formatNumber(record.mediaOutputImages ?? 0, 0)} 张`
              : '',
            (record.mediaOutputSeconds ?? 0) > 0
              ? `${formatNumber(record.mediaOutputSeconds ?? 0, 0)} 秒`
              : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        />
      ) : null}
      {cost ? <GatewayField label='费用' value={cost} mono /> : null}
      {(record.attemptCount ?? 0) > 0 ? (
        <GatewayField
          label='失败尝试'
          value={`${formatNumber(record.attemptCount ?? 0, 0)} 次`}
        />
      ) : null}
    </>
  )
}

export function AuditBillingPanel({ record }: { record: RequestAuditRecord }) {
  const billing = record.billing
  const total =
    formatUsdTicks(billing?.totalInUsdTicks || record.costInUsdTicks, 8) ||
    (record.estimatedCostInUsdTicks
      ? `${formatUsdTicks(record.estimatedCostInUsdTicks, 8)} 估`
      : '')
  if (!billing && !total) return null
  return (
    <div className='space-y-3'>
      <div>
        <h3 className='text-sm font-semibold'>计费</h3>
        <p className='mt-1 text-xs text-muted-foreground'>
          来自 grok2api 请求审计的账单拆分，不再需要切到网关控制台核对费用。
        </p>
      </div>
      <dl className='grid gap-3 sm:grid-cols-2 lg:grid-cols-3'>
        {total ? <GatewayField label='合计' value={total} mono /> : null}
        {billing?.source ? (
          <GatewayField label='来源' value={billingSourceLabel(billing.source)} />
        ) : null}
        {billing?.method ? (
          <GatewayField label='算法' value={billingMethodLabel(billing.method)} />
        ) : null}
        {billing?.model ? <GatewayField label='计价模型' value={billing.model} mono /> : null}
        {billing?.version ? (
          <GatewayField label='价表版本' value={billing.version} mono />
        ) : null}
        {billing?.tier === 'long_context' ? (
          <GatewayField label='档位' value='长上下文' />
        ) : null}
      </dl>
      {billing?.components?.length ? (
        <div className='overflow-hidden rounded-lg border'>
          {billing.components.map((component) => (
            <div
              key={`${component.kind}-${component.unit}`}
              className='flex items-center justify-between gap-3 border-b px-3 py-2 text-xs last:border-b-0'
            >
              <span className='text-muted-foreground'>
                {billingComponentLabel(component.kind)}
              </span>
              <span className='font-mono tabular-nums'>
                {formatNumber(component.quantity, 0)} ·{' '}
                {formatUsdTicks(component.subtotalInUsdTicks, 8) || '$0'}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function AuditRequestPanel({ record }: { record: RequestAuditRecord }) {
  const path = compactRequestPath(record)
  const headers = headerEntries(record.requestHeaders)
  const parsedSample = parseRequestSample(record.requestSample)
  const requestBody = parsedSample.bodyText
  return (
    <div className='space-y-3'>
      <div>
        <h3 className='text-sm font-semibold'>请求快照</h3>
        <p className='mt-1 text-xs text-muted-foreground'>
          网关记录的方法、路径、已脱敏请求头和原始请求体样本，方便核对客户端怎么打进来。
        </p>
      </div>
      {path ? (
        <div className='flex items-center gap-2 rounded-lg border bg-muted/15 px-3 py-2'>
          <span className='min-w-0 flex-1 font-mono text-xs break-all'>{path}</span>
          <CopyButton value={path} className='size-6 shrink-0' />
        </div>
      ) : (
        <div className='rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground'>
          这条记录还没有请求路径。历史投影补齐前，打开详情会尝试回源 grok2api。
        </div>
      )}
      <AuditHeadersPanel headers={headers} empty='没有保存请求头。' />
      {parsedSample.latestUserTurn ? (
        <div className='overflow-hidden rounded-lg border bg-muted/15'>
          <div className='flex items-center justify-between gap-2 px-3 py-2'>
            <span className='text-xs font-medium'>用户原文</span>
            <CopyButton value={parsedSample.latestUserTurn} className='size-6 shrink-0' />
          </div>
          <pre className='max-h-48 overflow-auto px-3 pb-3 text-xs leading-relaxed whitespace-pre-wrap break-words'>
            {parsedSample.latestUserTurn}
          </pre>
        </div>
      ) : null}
      {requestBody ? (
        <div className='overflow-hidden rounded-lg border bg-muted/15'>
          <div className='flex items-center justify-between gap-2 px-3 py-2'>
            <span className='text-xs font-medium'>请求体</span>
            <div className='flex items-center gap-2'>
              {record.requestSampleTruncated ? (
                <span className='text-[11px] text-muted-foreground'>已截断</span>
              ) : null}
              <CopyButton value={requestBody} className='size-6 shrink-0' />
            </div>
          </div>
          <pre className='max-h-80 overflow-auto px-3 pb-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all'>
            {requestBody}
          </pre>
        </div>
      ) : (
        <div className='rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground'>
          这条记录还没有请求体样本。新流量才会保存；打开详情会尝试回源 grok2api。
        </div>
      )}
    </div>
  )
}

export function AuditAttemptsPanel({ record }: { record: RequestAuditRecord }) {
  const attempts = sortedAttempts(record.attempts)
  const [selected, setSelected] = useState(attempts[0]?.number ?? 0)
  const attempt =
    attempts.find((item) => item.number === selected) ?? attempts[0] ?? null
  if (!attempts.length) {
    return (
      <div className='space-y-3'>
        <div>
          <h3 className='text-sm font-semibold'>失败尝试</h3>
          <p className='mt-1 text-xs text-muted-foreground'>
            grok2api 只在详情里保留脱敏后的失败快照。成功请求通常没有尝试记录。
          </p>
        </div>
        <div className='rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground'>
          {record.gatewayError
            ? `未能回源 grok2api：${record.gatewayError}`
            : (record.attemptCount ?? 0) > 0
              ? `网关标记了 ${formatNumber(record.attemptCount ?? 0, 0)} 次失败尝试，但详情还没拉到快照。`
              : '该请求没有失败尝试快照。'}
        </div>
      </div>
    )
  }
  return (
    <div className='space-y-3'>
      <div>
        <h3 className='text-sm font-semibold'>失败尝试</h3>
        <p className='mt-1 text-xs text-muted-foreground'>
          来自 grok2api 的脱敏诊断快照，包括上游状态、响应体和错误链。
        </p>
      </div>
      <div className='flex flex-wrap gap-1.5'>
        {attempts.map((item) => (
          <button
            key={item.id || item.number}
            type='button'
            className={cn(
              'rounded-md border px-2 py-1 text-[11px]',
              item.number === attempt?.number
                ? 'border-primary bg-primary/10 text-foreground'
                : 'text-muted-foreground'
            )}
            onClick={() => setSelected(item.number)}
          >
            #{item.number} {attemptSourceLabel(item.source)}
          </button>
        ))}
      </div>
      {attempt ? <AttemptCard attempt={attempt} /> : null}
    </div>
  )
}

function AttemptCard({ attempt }: { attempt: RequestAuditAttempt }) {
  const headers = headerEntries(attempt.responseHeaders)
  return (
    <div className='space-y-3 rounded-lg border p-3'>
      <dl className='grid gap-3 sm:grid-cols-2'>
        <GatewayField label='阶段' value={attempt.stage || '—'} />
        <GatewayField label='来源' value={attemptSourceLabel(attempt.source)} />
        <GatewayField
          label='开始时间'
          value={attempt.startedAt ? formatDate(attempt.startedAt) : '—'}
        />
        <GatewayField
          label='耗时'
          value={
            attempt.durationMs ? `${formatNumber(attempt.durationMs, 0)} ms` : '—'
          }
          mono
        />
        <GatewayField
          label='账号'
          value={
            attempt.accountName
              ? `${attempt.accountName}${attempt.accountId ? ` · ${attempt.accountId}` : ''}`
              : attempt.accountId
                ? String(attempt.accountId)
                : '—'
          }
        />
        <GatewayField
          label='上游状态'
          value={
            attempt.upstreamStatus ||
            (attempt.upstreamStatusCode != null
              ? String(attempt.upstreamStatusCode)
              : '—')
          }
          mono
        />
        {attempt.method || attempt.requestPath ? (
          <GatewayField
            label='请求'
            value={`${attempt.method || ''} ${attempt.requestPath || ''}`.trim()}
            mono
            copyValue={`${attempt.method || ''} ${attempt.requestPath || ''}`.trim()}
          />
        ) : null}
        {attempt.upstreamUrl ? (
          <GatewayField
            label='上游 URL'
            value={attempt.upstreamUrl}
            mono
            copyValue={attempt.upstreamUrl}
          />
        ) : null}
      </dl>
      {attempt.transportError ? (
        <div className='rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive'>
          {attempt.transportError}
        </div>
      ) : null}
      {attempt.errorChain?.length ? (
        <div className='space-y-1 rounded-md bg-muted/30 px-3 py-2 text-xs'>
          {attempt.errorChain.map((frame, index) => (
            <p key={`${frame.type}-${index}`}>
              <span className='font-medium'>{frame.type || 'Error'}</span>
              {frame.message ? `：${frame.message}` : ''}
            </p>
          ))}
        </div>
      ) : null}
      <AuditHeadersPanel headers={headers} empty='没有响应头。' />
      {attempt.responseBody ? (
        <section className='overflow-hidden rounded-lg border bg-muted/20'>
          <div className='flex h-9 items-center justify-between gap-2 px-3'>
            <span className='text-[11px] font-medium'>
              响应体
              {attempt.responseBodyTruncated ? ' · 已裁剪' : ''}
              {attempt.responseBodyEncoding === 'base64' ? ' · base64' : ''}
            </span>
            <CopyButton value={attempt.responseBody} className='size-6' />
          </div>
          <pre className='max-h-56 overflow-auto px-3 pb-3 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap'>
            {attempt.responseBody}
          </pre>
        </section>
      ) : null}
    </div>
  )
}

export function AuditHeadersPanel({
  headers,
  empty,
}: {
  headers: Array<[string, string]>
  empty: string
}) {
  const copyValue = useMemo(
    () =>
      headers
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n'),
    [headers]
  )
  if (!headers.length) {
    return (
      <div className='rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground'>
        {empty}
      </div>
    )
  }
  return (
    <section className='overflow-hidden rounded-lg border'>
      <div className='flex h-9 items-center justify-between gap-2 px-3'>
        <span className='text-[11px] font-medium'>请求头 / 响应头</span>
        <CopyButton value={copyValue} className='size-6' />
      </div>
      <div className='max-h-64 overflow-auto'>
        {headers.map(([key, value]) => (
          <div
            key={key}
            className='grid grid-cols-[minmax(7rem,12rem)_1fr] gap-3 border-t px-3 py-1.5 text-[11px]'
          >
            <span className='font-mono text-muted-foreground'>{key}</span>
            <span className='font-mono break-all'>{value}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

export function GatewayField({
  label,
  value,
  mono = false,
  copyValue,
  preserve = false,
}: {
  label: string
  value: string
  mono?: boolean
  copyValue?: string
  preserve?: boolean
}) {
  return (
    <div className='min-w-0 rounded-lg border bg-background p-3'>
      <dt className='text-[11px] text-muted-foreground'>{label}</dt>
      <dd
        className={cn(
          'mt-1 text-sm',
          preserve ? 'max-h-32 overflow-auto whitespace-pre-wrap break-words' : 'break-words',
          mono && 'font-mono break-all tabular-nums'
        )}
      >
        {copyValue ? (
          <span className='inline-flex max-w-full items-start gap-1'>
            <span className='min-w-0 break-all'>{value}</span>
            <CopyButton value={copyValue} className='size-6 shrink-0' />
          </span>
        ) : (
          value
        )}
      </dd>
    </div>
  )
}

export function GatewayHydrationNote({
  loading,
  error,
  hydrated,
}: {
  loading: boolean
  error: string
  hydrated?: boolean
}) {
  if (loading) {
    return (
      <p className='text-xs text-muted-foreground'>正在回源 grok2api 补齐请求头和失败尝试…</p>
    )
  }
  if (error) {
    return <p className='text-xs text-destructive'>回源 grok2api 失败：{error}</p>
  }
  if (hydrated) {
    return (
      <p className='text-xs text-muted-foreground'>
        已合并 grok2api 详情。列表里的风险判定仍以 GrokIQ 窗口规则为准。
      </p>
    )
  }
  return null
}

export function AttemptCountHint({ row }: { row: RequestAuditRecord }) {
  const count = row.attemptCount ?? 0
  if (count <= 0) return null
  return (
    <div className='mt-0.5 text-[10px] text-amber-700 dark:text-amber-300'>
      失败尝试 {formatNumber(count, 0)}
    </div>
  )
}

export function ClientIpHint({ row }: { row: RequestAuditRecord }) {
  if (!row.clientIp) return null
  return (
    <div className='text-[10px] text-muted-foreground' title={row.clientIp}>
      IP {row.clientIp}
    </div>
  )
}

export function SourcesHint({ row }: { row: RequestAuditRecord }) {
  const sources = row.numSourcesUsed ?? 0
  const tools = row.numServerSideToolsUsed ?? 0
  if (sources <= 0 && tools <= 0) return null
  return (
    <div className='text-[10px] text-muted-foreground'>
      {sources > 0 ? `${formatNumber(sources, 0)} 源` : ''}
      {sources > 0 && tools > 0 ? ' · ' : ''}
      {tools > 0 ? `${formatNumber(tools, 0)} 工具` : ''}
    </div>
  )
}
