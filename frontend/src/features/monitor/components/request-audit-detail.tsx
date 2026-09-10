import { type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import {
  ExternalLink,
  FileText,
  Receipt,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  Stethoscope,
  type LucideIcon,
} from 'lucide-react'
import {
  type RequestAuditPreDisableCheck,
  type RequestAuditProbeContext,
  type RequestAuditRecord,
  type RequestAuditRiskLevel,
  type RequestAuditThresholds,
} from '@/lib/api'
import { StatusBadge } from '@/lib/status'
import { cn, formatDate, formatNumber } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CopyButton, CopyableText } from '@/components/copy-button'
import { InfoTooltip } from '@/components/info-tooltip'
import {
  auditErrorCode,
  auditErrorLabel,
} from '@/features/monitor/components/audit-status'
import {
  AuditAttemptsPanel,
  AuditBillingPanel,
  AuditGatewayFields,
  AuditRequestPanel,
  GatewayHydrationNote,
  reasoningEffortLabel,
} from '@/features/monitor/pages/request-audit-gateway-view'
import {
  formatSampleWindow,
  streamSampleDiagnostics,
  streamSampleWarnings,
} from '@/features/monitor/pages/request-audit-stream-sample'
import { runsSearchFromAccount } from '@/features/monitor/pages/runs-search'

const riskVariant: Record<
  RequestAuditRiskLevel,
  'success' | 'warning' | 'destructive'
> = {
  normal: 'success',
  watch: 'warning',
  high: 'destructive',
}

const autoDisableHelp = (
  <div className='space-y-2'>
    <p>
      自动停用要同时满足：命中停用规则、达到次数，且「请求审计账号处置」已开启。
    </p>
    <p>
      页面高风险本身不会停用。高速 TPS 连续达到次数后先冷却账号；冷却后再连续
      达到次数且没有正常 TPS，才永久停用并移入隔离区。无媒体输入时思考为 0
      连续达到策略次数后仍会直接停用。Media Input 不会因此停用。
    </p>
    <p>
      不再做停用前 SSO 复检，也不再把 TPS-only
      只当观察。探针「自动停用高风险账号」不会处理请求审计高风险。
    </p>
  </div>
)

type RequestAuditDetailProbeState = {
  samples: RequestAuditProbeContext[]
  loading: boolean
  error: string
  onRetry: () => void
}

export function RequestAuditDetailBody({
  record,
  thresholds,
  gatewayLoading,
  gatewayError,
  probe,
}: {
  record: RequestAuditRecord
  thresholds: RequestAuditThresholds
  gatewayLoading: boolean
  gatewayError: string
  probe?: RequestAuditDetailProbeState
}) {
  const attemptCount = record.attemptCount ?? record.attempts?.length ?? 0
  const probeCount = probe?.samples.length ?? 0
  const hasBilling = Boolean(
    record.billing || record.costInUsdTicks || record.estimatedCostInUsdTicks
  )
  const tabs: Array<{
    value: 'overview' | 'request' | 'content' | 'billing' | 'diagnosis'
    label: string
    icon: LucideIcon
    count?: number
  }> = [
    { value: 'overview', label: '概览', icon: ShieldAlert },
    { value: 'request', label: '请求', icon: ScrollText },
    { value: 'content', label: '内容', icon: FileText },
    { value: 'billing', label: '计费', icon: Receipt },
    {
      value: 'diagnosis',
      label: '诊断',
      icon: Stethoscope,
      count:
        attemptCount +
        (record.preDisableCheck ? 1 : 0) +
        (probe ? probeCount : 0),
    },
  ]

  return (
    <div className='flex min-h-0 flex-1 flex-col overflow-hidden'>
      <div className='shrink-0 space-y-3'>
        <GatewayHydrationNote
          loading={gatewayLoading}
          error={gatewayError}
          hydrated={record.gatewayHydrated}
        />
        <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
          <DetailStat label='速度'>
            <Tps value={record.tps} />
          </DetailStat>
          <DetailStat label='输出 Token'>
            {formatNumber(record.outputTokens, 0)}
          </DetailStat>
          <DetailStat label='耗时'>
            {record.durationMs
              ? `${formatNumber(record.durationMs, 0)} ms`
              : '未测量'}
          </DetailStat>
          <DetailStat label='风险' plain>
            <div className='flex flex-wrap items-center gap-1.5'>
              <RiskBadge value={record.riskLevel} thresholds={thresholds} />
              <PreDisableCheckBadge check={record.preDisableCheck} compact />
            </div>
          </DetailStat>
        </div>
      </div>

      <Tabs
        key={record.id}
        defaultValue='overview'
        className='mt-4 flex min-h-0 flex-1 flex-col overflow-hidden'
      >
        <TabsList className='h-auto w-full shrink-0 justify-start overflow-x-auto sm:w-fit'>
          {tabs.map((tab) => {
            const Icon = tab.icon
            return (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                className='flex-none'
              >
                <Icon />
                {tab.label}
                {tab.count ? (
                  <Badge variant='secondary'>
                    {formatNumber(tab.count, 0)}
                  </Badge>
                ) : null}
              </TabsTrigger>
            )
          })}
        </TabsList>

        <div className='min-h-0 flex-1 overflow-y-auto overscroll-contain pe-1 pt-3'>
          <TabsContent value='overview' className='mt-0 space-y-5'>
            <OverviewPanel record={record} />
          </TabsContent>
          <TabsContent value='request' className='mt-0'>
            <AuditRequestPanel record={record} />
          </TabsContent>
          <TabsContent value='content' className='mt-0'>
            <StreamSamplePanel record={record} />
          </TabsContent>
          <TabsContent value='billing' className='mt-0'>
            {hasBilling ? (
              <AuditBillingPanel record={record} />
            ) : (
              <EmptyHint text='这条请求还没有计费拆分。新流量才会带上 grok2api 账单。' />
            )}
          </TabsContent>
          <TabsContent value='diagnosis' className='mt-0 space-y-5'>
            <DispositionPanel record={record} />
            <AuditAttemptsPanel record={record} />
            {probe ? (
              <ProbeSamplesPanel
                samples={probe.samples}
                loading={probe.loading}
                error={probe.error}
                onRetry={probe.onRetry}
              />
            ) : null}
          </TabsContent>
        </div>
      </Tabs>
    </div>
  )
}

function OverviewPanel({ record }: { record: RequestAuditRecord }) {
  const errorCode = auditErrorCode(record)
  return (
    <>
      <Section
        title='请求身份'
        description='这条请求打到了哪个账号、节点和客户端。'
      >
        <dl className='grid gap-3 sm:grid-cols-2 lg:grid-cols-3'>
          <AuditDetailField
            label='请求 ID'
            value={record.requestId || '—'}
            mono
            copyValue={record.requestId || undefined}
          />
          <AuditDetailField
            label='审计 ID'
            value={record.id}
            mono
            copyValue={record.id}
          />
          <AuditDetailField
            label='账号'
            value={`${record.accountName || `账号 ${record.accountId ?? '未知'}`} · ID ${record.accountId ?? '未知'}`}
            copyValue={
              record.accountId != null ? String(record.accountId) : undefined
            }
          />
          <AuditDetailField
            label='客户端 Key'
            value={
              record.clientKeyName
                ? `${record.clientKeyName}${record.clientKeyId ? ` · ID ${record.clientKeyId}` : ''}`
                : record.clientKeyId
                  ? `#${record.clientKeyId}`
                  : '—'
            }
          />
          <AuditDetailField
            label='当前上游状态'
            value={upstreamAccountStatusText(record)}
          />
          <AuditDetailField
            label='代理节点'
            value={`${record.egressNodeName || '未映射代理节点'} · ID ${record.egressNodeId ?? '未知'}`}
          />
          <AuditDetailField
            label='创建时间'
            value={formatDate(record.createdAt)}
          />
        </dl>
      </Section>

      <Section
        title='模型与用量'
        description='这次调用用了什么模型，以及 Token / 思考情况。'
      >
        <dl className='grid gap-3 sm:grid-cols-2 lg:grid-cols-3'>
          <AuditDetailField
            label='模型'
            value={record.modelPublicId || record.modelUpstreamModel || '—'}
          />
          <AuditDetailField
            label='操作'
            value={record.operation || 'responses'}
          />
          <AuditDetailField
            label='首 Token 延迟'
            value={
              record.firstTokenMs == null
                ? '—'
                : `${formatNumber(record.firstTokenMs, 0)} ms`
            }
          />
          <AuditDetailField
            label='状态码'
            value={
              errorCode
                ? `${record.statusCode || '—'} · ${auditErrorLabel(errorCode)}`
                : String(record.statusCode || '—')
            }
            mono
          />
          {errorCode ? (
            <AuditDetailField
              label='上游错误'
              value={`${auditErrorLabel(errorCode)} · ${errorCode}`}
              mono
              copyValue={errorCode}
            />
          ) : null}
          <AuditDetailField
            label='输入 Token'
            value={formatNumber(record.inputTokens, 0)}
            mono
          />
          <AuditDetailField
            label='Media Input'
            value={
              record.hasMediaInput
                ? `${formatNumber(record.mediaInputImages, 0)} 张`
                : '无'
            }
          />
          <AuditDetailField
            label='推理 Token'
            value={formatNumber(record.reasoningTokens, 0)}
            mono
          />
          <AuditDetailField
            label='思考等级'
            value={reasoningEffortLabel(record.reasoningEffort) || '未记录'}
          />
          <AuditDetailField
            label='总 Token'
            value={formatNumber(record.totalTokens, 0)}
            mono
          />
          <AuditGatewayFields record={record} />
        </dl>
      </Section>

      {record.riskReasons.length > 0 ? (
        <div className='rounded-lg border border-amber-500/25 bg-amber-500/5 p-3'>
          <div className='text-sm font-medium text-amber-800 dark:text-amber-200'>
            风险依据
          </div>
          <ul className='mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground'>
            {record.riskReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className='rounded-lg border border-sky-500/25 bg-sky-500/5 p-3 text-sm'>
        <div className='font-medium text-sky-800 dark:text-sky-200'>
          节点归因说明
        </div>
        <p className='mt-1 leading-5 text-muted-foreground'>
          历史请求保留代理节点标识；动态 IP
          只在节点视角显示最近探测快照，不代表本条请求当时使用的 IP。
          账号启停与鉴权同样来自最近的上游查询快照，不回写为历史状态。
        </p>
      </div>
    </>
  )
}

function DispositionPanel({ record }: { record: RequestAuditRecord }) {
  const check = record.preDisableCheck
  return (
    <div className='rounded-lg border border-primary/25 bg-primary/5 p-3'>
      <div className='flex flex-wrap items-center gap-2'>
        <div className='flex items-center gap-1.5 text-sm font-medium'>
          自动处置
          <InfoTooltip
            label='自动处置'
            content={autoDisableHelp}
            contentClassName='max-w-[28rem]'
          />
        </div>
        <PreDisableCheckBadge check={check} compact />
      </div>
      {check ? (
        <div className='mt-3 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4'>
          <AuditDetailField
            label='最终动作'
            value={check.actionStatus || '—'}
          />
          <AuditDetailField
            label='处置时间'
            value={formatDate(check.checkedAt)}
          />
          <AuditDetailField
            label='优先级调整'
            value={
              check.appliedPriority != null
                ? `${check.previousPriority ?? '未知'} → ${check.appliedPriority}`
                : '—'
            }
            mono
          />
          {check.ssoVerdict && check.ssoVerdict !== 'skipped' ? (
            <>
              <AuditDetailField
                label='历史 SSO 判定'
                value={check.ssoVerdict}
              />
              <AuditDetailField
                label='bot source'
                value={
                  check.botFlag.found
                    ? String(check.botFlag.source ?? '—')
                    : '未下发'
                }
                mono
              />
            </>
          ) : null}
        </div>
      ) : (
        <p className='mt-2 text-xs leading-5 text-muted-foreground'>
          该请求尚未产生处置记录；只有达到规则阈值的高风险请求才会进入自动停用流程。
        </p>
      )}
      {check?.botFlag.details ? (
        <div className='mt-3 rounded-md border bg-background/70 p-2 text-xs text-muted-foreground'>
          {check.botFlag.details}
        </div>
      ) : null}
      {check?.checkError ? (
        <div className='mt-3 text-xs text-destructive'>{check.checkError}</div>
      ) : null}
      {check?.actionError ? (
        <div className='mt-1 text-xs text-destructive'>{check.actionError}</div>
      ) : null}
      {check?.egressRecommendation?.type === 'change_egress' ? (
        <div className='mt-3 rounded-md border border-amber-500/30 bg-amber-500/8 p-2 text-xs'>
          <div className='font-medium text-amber-700 dark:text-amber-300'>
            {check.egressRecommendation.label}
          </div>
          <div className='mt-1 text-muted-foreground'>
            {check.egressRecommendation.reason}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function StreamSamplePanel({ record }: { record: RequestAuditRecord }) {
  const sample = record.streamSample
  const diagnostics = streamSampleDiagnostics(record)
  const warnings = streamSampleWarnings(diagnostics)
  return (
    <div className='space-y-3'>
      <div>
        <h3 className='text-sm font-semibold'>内容样本</h3>
        <p className='mt-1 text-xs text-muted-foreground'>
          截取思考和输出的开头/结尾。流式来自实时分片；非流式来自内部完整结果，方便人工核对。
        </p>
      </div>
      {!diagnostics.hasSample || !sample ? (
        <EmptyHint text='该请求没有保存思考/输出样本。升级前的历史记录不会有样本。' />
      ) : (
        <>
          <div className='flex flex-wrap gap-1.5'>
            <SampleChip ok={diagnostics.hasThinking} label='明文思考' />
            <SampleChip
              ok={diagnostics.hasEncryptedThinking}
              label='加密思考'
              hideWhenFalse
            />
            <SampleChip ok={diagnostics.hasOutput} label='实体输出' />
            <SampleChip
              ok={diagnostics.thinkingThenOutput}
              label='思考后有输出'
              hideWhenFalse
            />
            {sample.truncated ? (
              <Badge variant='outline' className='text-[10px]'>
                样本已裁剪
              </Badge>
            ) : null}
          </div>
          {warnings.length > 0 ? (
            <div className='space-y-1.5 rounded-lg bg-amber-500/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200'>
              {warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </div>
          ) : null}
          <dl className='grid gap-3 sm:grid-cols-2'>
            <AuditDetailField
              label='思考字符 · 分片'
              value={`${formatNumber(sample.thinkingChars ?? 0, 0)} · ${formatNumber(sample.thinkingChunks ?? 0, 0)} 片`}
            />
            <AuditDetailField
              label='输出字符 · 分片'
              value={`${formatNumber(sample.outputChars ?? 0, 0)} · ${formatNumber(sample.outputChunks ?? 0, 0)} 片`}
            />
            <AuditDetailField
              label='思考时间窗'
              value={formatSampleWindow(
                sample.firstThinkingMs,
                sample.lastThinkingMs,
                formatNumber
              )}
            />
            <AuditDetailField
              label='输出时间窗'
              value={formatSampleWindow(
                sample.firstOutputMs,
                sample.lastOutputMs,
                formatNumber
              )}
            />
          </dl>
          <SampleSnippet title='思考开头' value={sample.thinkingHead} />
          <SampleSnippet title='思考结尾' value={sample.thinkingTail} />
          <SampleSnippet title='输出开头' value={sample.outputHead} />
          <SampleSnippet title='输出结尾' value={sample.outputTail} />
        </>
      )}
    </div>
  )
}

function ProbeSamplesPanel({
  samples,
  loading,
  error,
  onRetry,
}: RequestAuditDetailProbeState) {
  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div>
          <h3 className='text-sm font-semibold'>关联探针任务样本</h3>
          <p className='mt-1 text-xs text-muted-foreground'>
            这里展示 GrokIQ 本地探针任务与这条请求审计的交叉证据。
          </p>
        </div>
        {loading ? (
          <RefreshCw className='size-4 animate-spin text-primary' />
        ) : null}
      </div>
      {error ? (
        <div className='flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm sm:flex-row sm:items-center sm:justify-between'>
          <span className='text-destructive'>探针样本读取异常：{error}</span>
          <Button variant='outline' size='sm' onClick={onRetry}>
            <RefreshCw />
            重试
          </Button>
        </div>
      ) : null}
      {!loading && !error && !samples.length ? (
        <EmptyHint text='未找到关联的本地探针样本' />
      ) : null}
      <div className='space-y-3'>
        {samples.map((context) => (
          <ProbeAuditSampleCard key={context.sample.id} context={context} />
        ))}
      </div>
    </div>
  )
}

function ProbeAuditSampleCard({
  context,
}: {
  context: RequestAuditProbeContext
}) {
  const sample = context.sample
  const run = context.run
  const target =
    sample.target_kind === 'current'
      ? '账号当前节点'
      : sample.target_kind === 'direct'
        ? '上游调度诊断'
        : sample.egress_name || sample.target_key
  return (
    <div className='rounded-xl border bg-card'>
      <div className='flex flex-wrap items-center gap-2 border-b px-4 py-3'>
        <span className='text-sm font-semibold'>
          {run.planName || '手动探针任务'}
        </span>
        <Badge variant='outline'>第 {sample.round_number} 轮</Badge>
        <Badge variant='secondary'>{target}</Badge>
        <StatusBadge value={sample.classification || sample.status} />
        <span className='ms-auto text-xs text-muted-foreground'>
          {formatDate(sample.created_at)}
        </span>
        <Button asChild variant='ghost' size='sm'>
          <Link
            to='/runs'
            search={runsSearchFromAccount(sample.account_id, run.id) as never}
          >
            <ExternalLink />
            任务中心
          </Link>
        </Button>
      </div>
      <div className='grid gap-3 border-b bg-muted/15 p-4 sm:grid-cols-2 lg:grid-cols-5'>
        <AuditSampleMetric label='任务状态' value={run.status} />
        <AuditSampleMetric
          label='TPS'
          value={`${formatNumber(sample.tps)} Token/s`}
          mono
        />
        <AuditSampleMetric
          label='首 Token'
          value={`${formatNumber(sample.first_token_ms, 0)} ms`}
          mono
        />
        <AuditSampleMetric
          label='总耗时'
          value={`${formatNumber(sample.duration_ms, 0)} ms`}
          mono
        />
        <AuditSampleMetric
          label='输出 Token'
          value={formatNumber(sample.output_tokens, 0)}
          mono
        />
      </div>
      <div className='grid gap-3 p-4 text-xs sm:grid-cols-2 lg:grid-cols-4'>
        <AuditSampleEvidence label='任务 ID' value={run.id} mono />
        <AuditSampleEvidence
          label='Profile'
          value={run.profileName || run.profileId}
        />
        <AuditSampleEvidence label='触发方式' value={run.trigger || 'manual'} />
        <AuditSampleEvidence
          label='Request ID'
          value={sample.request_id || '—'}
          mono
        />
        <AuditSampleEvidence
          label='审计 ID'
          value={sample.audit_id ?? '—'}
          mono
        />
        <AuditSampleEvidence
          label='核验账号'
          value={sample.verified_account_id ?? '—'}
          mono
        />
        <AuditSampleEvidence
          label='核验节点'
          value={sample.verified_egress_node_id ?? '—'}
          mono
        />
        <AuditSampleEvidence
          label='HTTP 状态'
          value={sample.status_code || '—'}
          mono
        />
      </div>
      {sample.error ? (
        <div className='mx-4 mb-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive'>
          {sample.error}
        </div>
      ) : null}
      {sample.responsePreview || sample.response_text ? (
        <details className='mx-4 mb-4 rounded-lg border bg-muted/10 p-3'>
          <summary className='cursor-pointer text-sm font-medium'>
            查看响应摘要
            {sample.responseLength
              ? ` · ${formatNumber(sample.responseLength, 0)} 字符`
              : ''}
          </summary>
          <pre className='mt-3 max-h-64 overflow-auto text-xs leading-5 break-words whitespace-pre-wrap text-muted-foreground'>
            {sample.response_text || sample.responsePreview}
          </pre>
        </details>
      ) : null}
    </div>
  )
}

function Section({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <div className='space-y-3'>
      <div>
        <h3 className='text-sm font-semibold'>{title}</h3>
        <p className='mt-1 text-xs text-muted-foreground'>{description}</p>
      </div>
      {children}
    </div>
  )
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className='rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground'>
      {text}
    </div>
  )
}

function DetailStat({
  label,
  children,
  plain = false,
}: {
  label: string
  children: ReactNode
  plain?: boolean
}) {
  return (
    <div className='rounded-lg border bg-muted/15 p-3'>
      <div className='text-[11px] text-muted-foreground'>{label}</div>
      <div
        className={
          plain ? 'mt-1' : 'mt-1 font-mono text-lg font-semibold tabular-nums'
        }
      >
        {children}
      </div>
    </div>
  )
}

function AuditDetailField({
  label,
  value,
  mono = false,
  copyValue,
}: {
  label: string
  value: string
  mono?: boolean
  copyValue?: string
}) {
  return (
    <div className='min-w-0 rounded-lg border bg-background p-3'>
      <dt className='text-[11px] text-muted-foreground'>{label}</dt>
      <dd
        className={cn(
          'mt-1 text-sm break-words',
          mono && 'font-mono break-all tabular-nums'
        )}
      >
        {copyValue ? (
          <CopyableText value={copyValue} className='max-w-full'>
            <span className='min-w-0 break-all'>{value}</span>
          </CopyableText>
        ) : (
          value
        )}
      </dd>
    </div>
  )
}

function SampleChip({
  ok,
  label,
  hideWhenFalse = false,
}: {
  ok: boolean
  label: string
  hideWhenFalse?: boolean
}) {
  if (!ok && hideWhenFalse) return null
  return (
    <Badge
      variant={ok ? 'secondary' : 'outline'}
      className={cn(
        'text-[10px]',
        ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground'
      )}
    >
      {ok ? '✓' : '✗'} {label}
    </Badge>
  )
}

function SampleSnippet({ title, value }: { title: string; value?: string }) {
  if (!value) return null
  return (
    <section className='overflow-hidden rounded-lg border bg-muted/20'>
      <div className='flex h-9 items-center justify-between gap-2 px-3'>
        <span className='text-[11px] font-medium'>{title}</span>
        <CopyButton value={value} className='size-6' />
      </div>
      <pre className='max-h-64 overflow-auto px-3 pb-3 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap'>
        {value}
      </pre>
    </section>
  )
}

function AuditSampleMetric({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className='min-w-0'>
      <div className='text-[11px] text-muted-foreground'>{label}</div>
      <div
        className={cn(
          'mt-1 text-sm font-medium break-words',
          mono && 'font-mono tabular-nums'
        )}
      >
        {value}
      </div>
    </div>
  )
}

function AuditSampleEvidence({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string | number
  mono?: boolean
}) {
  return (
    <div className='min-w-0'>
      <div className='text-[11px] text-muted-foreground'>{label}</div>
      <div
        className={cn('mt-1 break-all text-foreground', mono && 'font-mono')}
      >
        {value}
      </div>
    </div>
  )
}

function RiskBadge({
  value,
  thresholds,
}: {
  value: RequestAuditRiskLevel
  thresholds: RequestAuditThresholds
}) {
  const label =
    value === 'normal' ? '正常' : value === 'watch' ? '观察' : '高风险'
  return (
    <Badge
      variant={riskVariant[value]}
      title={
        value === 'high'
          ? `达到 ${formatNumber(thresholds.high)} TPS，或命中已启用的连续高风险规则`
          : value === 'watch'
            ? `达到 ${formatNumber(thresholds.watch)} TPS，或命中观察型规则`
            : undefined
      }
    >
      {label}
    </Badge>
  )
}

function Tps({
  value,
  className,
}: {
  value: number | null | undefined
  className?: string
}) {
  return (
    <span className={cn('font-mono tabular-nums', className)}>
      {value == null ? '—' : `${formatNumber(value)} Token/s`}
    </span>
  )
}

function PreDisableCheckBadge({
  check,
  compact = false,
}: {
  check: RequestAuditPreDisableCheck | null
  compact?: boolean
}) {
  const label = preDisableStatusLabel(check)
  if (!label) return null
  const tone =
    check?.actionStatus === 'disabled' ||
    check?.actionStatus === 'already_disabled' ||
    check?.actionStatus === 'already_quarantined' ||
    check?.status === 'flagged'
      ? 'destructive'
      : check?.actionStatus === 'deprioritized' ||
          check?.actionStatus === 'already_deprioritized' ||
          check?.actionStatus === 'cooled' ||
          check?.actionStatus === 'already_cooling'
        ? 'warning'
        : check?.status === 'clean' || check?.status === 'session_confirmed'
          ? check?.egressRecommendation?.type === 'change_egress'
            ? 'warning'
            : 'success'
          : check?.actionStatus === 'action_failed' ||
              check?.actionStatus === 'deprioritize_failed' ||
              check?.status === 'check_failed'
            ? 'warning'
            : 'outline'
  return (
    <Badge
      variant={tone}
      className={cn(compact && 'h-5 px-1.5 text-[10px]')}
      title={
        check
          ? `${label}${check.proxyUsed ? ' · 已通过 SSO 代理' : ''}${check.checkError ? ` · ${check.checkError}` : ''}`
          : '高风险请求达到处置阈值后会按规则自动停用并隔离。'
      }
    >
      {label}
    </Badge>
  )
}

function preDisableStatusLabel(check: RequestAuditPreDisableCheck | null) {
  if (!check) return ''
  if (check.actionStatus === 'disabled') return '已自动停用'
  if (check.actionStatus === 'already_disabled') return '已记录停用'
  if (check.actionStatus === 'restored') return '已恢复'
  if (check.actionStatus === 'already_quarantined') return '已隔离'
  if (check.actionStatus === 'task_protected') return '任务保护'
  if (check.actionStatus === 'auto_quarantine_disabled') return '自动停用未开启'
  if (check.actionStatus === 'cooled') return '已冷却'
  if (check.actionStatus === 'already_cooling') return '冷却中'
  if (check.actionStatus === 'cooldown_expired') return '冷却已结束'
  if (check.actionStatus === 'deprioritized') return '已降低优先级'
  if (check.actionStatus === 'already_deprioritized') return '已是低优先级'
  if (check.actionStatus === 'deprioritize_disabled') return '优先级降级未开启'
  if (check.actionStatus === 'deprioritize_failed') return '降低优先级失败'
  if (check.actionStatus === 'action_failed') return '处置失败'
  if (check.status === 'checking') return '处置中'
  if (check.status === 'flagged') return 'SSO 已标记'
  if (check.status === 'session_confirmed') return 'SSO 会话有效'
  if (check.status === 'clean') return 'SSO 正常'
  if (check.status === 'missing_sso') return '缺少 SSO'
  if (check.status === 'proxy_required') return '未配置代理'
  if (check.status === 'invalid_session') return 'SSO 会话无效'
  if (check.status === 'email_mismatch') return '邮箱不匹配'
  if (check.status === 'isolation_disabled') return '隔离开关关闭'
  if (check.status === 'check_failed') return '复检失败'
  if (check.status === 'sso_skipped') return '已按规则处置'
  return '等待处置'
}

function upstreamAuthLabel(status: string) {
  if (status === 'active') return '鉴权有效'
  if (status === 'reauthRequired') return '需要授权'
  if (status === 'cooldown') return '冷却中'
  if (status === 'waitingReset') return '待重置'
  if (status === 'probing') return '检测中'
  return status ? status : '鉴权未知'
}

function upstreamAccountStatusText(account: {
  upstreamAccountFound?: boolean
  upstreamEnabled?: boolean | null
  upstreamAuthStatus?: string
}) {
  if (
    !account.upstreamAccountFound &&
    account.upstreamEnabled == null &&
    !account.upstreamAuthStatus
  ) {
    return '当前状态未获取'
  }
  const enabled =
    account.upstreamEnabled == null
      ? '启停未知'
      : account.upstreamEnabled
        ? '启用'
        : '停用'
  return `${enabled} · ${upstreamAuthLabel(account.upstreamAuthStatus || '')}`
}
