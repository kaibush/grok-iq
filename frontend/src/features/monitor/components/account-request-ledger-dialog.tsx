import { useEffect, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft,
  Eye,
  RefreshCw,
  ScrollText,
} from 'lucide-react'
import {
  api,
  type RequestAuditRecord,
  type RequestAuditRiskLevel,
  type RequestAuditThresholds,
  type RequestAuditWindowPreset,
} from '@/lib/api'
import { slimRequestAuditRecord } from '@/lib/preview-payload'
import { cn, formatDate, formatNumber, getErrorMessage } from '@/lib/utils'
import { CopyButton, CopyableText } from '@/components/copy-button'
import { EmptyState, LoadingState } from '@/components/page'
import { ServerPagination } from '@/components/server-pagination'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  formatSampleWindow,
  streamSampleDiagnostics,
  streamSampleWarnings,
} from '@/features/monitor/pages/request-audit-stream-sample'
import type { AccountIdentity } from '@/features/monitor/components/account-upstream-dialog'

const WINDOW_OPTIONS: Array<{
  value: Exclude<RequestAuditWindowPreset, 'custom'>
  label: string
}> = [
  { value: 'today', label: '当天' },
  { value: '24h', label: '最近 24 小时' },
  { value: '7d', label: '最近 7 天' },
  { value: '30d', label: '最近 30 天' },
]

const RISK_OPTIONS: Array<{
  value: 'all' | 'risky' | RequestAuditRiskLevel
  label: string
}> = [
  { value: 'all', label: '所有记录' },
  { value: 'risky', label: '所有异常' },
  { value: 'high', label: '仅高风险' },
  { value: 'watch', label: '仅观察' },
  { value: 'normal', label: '仅正常' },
]

const FALLBACK_THRESHOLDS: RequestAuditThresholds = { watch: 150, high: 500 }

const AUDIT_ERROR_LABELS: Record<string, string> = {
  upstream_stream_interrupted: '上游流中断',
  upstream_stream_idle_timeout: '上游流空闲超时',
  upstream_stream_error: '上游流错误',
  upstream_stream_incomplete: '上游流不完整',
  stream_interrupted: '流中断',
  upstream_model_cooling: '模型冷却',
  upstream_cooling: '上游冷却',
  upstream_quota_exhausted: '配额耗尽',
  upstream_rate_limited: '上游限流',
  upstream_rate_limited_subscription_free_usage_exhausted: '免费额度耗尽',
  upstream_rate_limited_resource_exhausted: '资源耗尽',
  upstream_rate_limited_someresourcehasbeenexhausted: '资源耗尽',
  upstream_network_error: '上游网络错误',
  upstream_saturated: '上游饱和',
  upstream_unavailable: '上游不可用',
  upstream_server_error_unavailable: '上游服务不可用',
  upstream_header_timeout: '上游头超时',
  upstream_error: '上游错误',
  upstream_forbidden_permission_denied: '上游拒绝访问',
  quality_degraded: '质量降级',
  request_canceled: '请求已取消',
  client_key_account_scope_unavailable: 'Key 账号范围不可用',
}

const REASONING_EFFORT_LABELS: Record<string, string> = {
  auto: '自动',
  none: '关闭',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  fixed: '固定',
}

function auditErrorCode(row: { errorCode?: string | null }) {
  return row.errorCode?.trim() || ''
}

function auditErrorLabel(code: string) {
  return AUDIT_ERROR_LABELS[code] || code
}

function isSuccessfulAuditStatus(row: {
  statusCode: number
  errorCode?: string | null
}) {
  return row.statusCode >= 200 && row.statusCode < 300 && !auditErrorCode(row)
}

function reasoningEffortLabel(value?: string | null) {
  return REASONING_EFFORT_LABELS[value?.trim().toLowerCase() || ''] || ''
}

function reasoningEffortClass(value?: string | null) {
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

function actionStatusLabel(record: RequestAuditRecord) {
  const check = record.preDisableCheck
  if (!check) return ''
  if (check.actionStatus === 'disabled') return '已自动停用'
  if (check.actionStatus === 'already_disabled') return '已记录停用'
  if (check.actionStatus === 'restored') return '已恢复'
  if (check.actionStatus === 'already_quarantined') return '已隔离'
  if (check.actionStatus === 'cooled') return '已冷却'
  if (check.actionStatus === 'already_cooling') return '冷却中'
  if (check.actionStatus === 'cooldown_expired') return '冷却已结束'
  if (check.actionStatus === 'deprioritized') return '已降低优先级'
  if (check.actionStatus === 'action_failed') return '处置失败'
  return ''
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
      variant={
        value === 'high' ? 'destructive' : value === 'watch' ? 'warning' : 'success'
      }
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

export function AccountRequestLedgerDialog({
  open,
  account,
  onOpenChange,
}: {
  open: boolean
  account: AccountIdentity | null
  onOpenChange: (open: boolean) => void
}) {
  const accountId = account ? Number(account.id) : 0
  const accountLabel =
    account?.name || account?.email || (accountId ? `账号 ${accountId}` : '账号')
  const [windowPreset, setWindowPreset] = useState<
    Exclude<RequestAuditWindowPreset, 'custom'>
  >('7d')
  const [risk, setRisk] = useState<(typeof RISK_OPTIONS)[number]['value']>('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [selected, setSelected] = useState<RequestAuditRecord | null>(null)

  useEffect(() => {
    if (!open) return
    setWindowPreset('7d')
    setRisk('all')
    setPage(1)
    setPageSize(25)
    setSelected(null)
  }, [open, accountId])

  const query = useQuery({
    queryKey: [
      'request-audits',
      'account-ledger',
      accountId,
      windowPreset,
      risk,
      page,
      pageSize,
    ],
    queryFn: async () => {
      const pageData = await api.requestAudits({
        window: windowPreset,
        accountId,
        risk: risk === 'all' ? '' : risk,
        page,
        pageSize,
      })
      return {
        ...pageData,
        items: pageData.items.map(slimRequestAuditRecord),
      }
    },
    enabled: open && accountId > 0,
    placeholderData: (previous) => previous,
  })
  const thresholds = query.data?.thresholds ?? FALLBACK_THRESHOLDS
  const items = query.data?.items ?? []
  const windowLabel = query.data?.window.label ?? (
    WINDOW_OPTIONS.find((option) => option.value === windowPreset)?.label ?? '当前窗口'
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size='wide' className='overflow-hidden'>
        <DialogHeader className='shrink-0'>
          <DialogTitle className='flex items-center gap-2'>
            {selected ? (
              <Button
                type='button'
                size='sm'
                variant='ghost'
                className='h-8 px-2'
                onClick={() => setSelected(null)}
              >
                <ArrowLeft />
                返回流水
              </Button>
            ) : (
              <ScrollText className='size-5 text-primary' />
            )}
            <span className='min-w-0 truncate'>
              {selected ? '请求审计详情' : '请求流水'}
            </span>
          </DialogTitle>
          <DialogDescription className='break-all'>
            {selected
              ? `${accountLabel} · ${selected.requestId || selected.id}`
              : `${accountLabel} · 仅显示该账号在${windowLabel}内的请求审计，不跳转到请求审计页`}
          </DialogDescription>
        </DialogHeader>

        {selected ? (
          <LedgerDetail record={selected} thresholds={thresholds} />
        ) : (
          <div className='flex min-h-0 flex-1 flex-col overflow-hidden'>
            <div className='flex shrink-0 flex-wrap items-center gap-2 pb-3'>
              <Select
                value={windowPreset}
                onValueChange={(value) => {
                  setWindowPreset(value as Exclude<RequestAuditWindowPreset, 'custom'>)
                  setPage(1)
                }}
              >
                <SelectTrigger className='h-8 w-40' aria-label='请求流水时间窗口'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WINDOW_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={risk}
                onValueChange={(value) => {
                  setRisk(value as (typeof RISK_OPTIONS)[number]['value'])
                  setPage(1)
                }}
              >
                <SelectTrigger className='h-8 w-36' aria-label='按风险筛选请求流水'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RISK_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type='button'
                size='sm'
                variant='outline'
                className='h-8'
                disabled={query.isFetching}
                onClick={() => void query.refetch()}
              >
                <RefreshCw className={query.isFetching ? 'animate-spin' : undefined} />
                刷新
              </Button>
              {query.data?.window ? (
                <span className='text-xs text-muted-foreground'>
                  {formatDate(query.data.window.startAt)} ~{' '}
                  {formatDate(query.data.window.endAt)}
                </span>
              ) : null}
            </div>
            <div className='min-h-0 flex-1 overflow-auto'>
              {query.isLoading && !query.data ? (
                <LoadingState />
              ) : query.isError && !query.data ? (
                <EmptyState
                  compact
                  icon={ScrollText}
                  title='无法加载请求流水'
                  description={getErrorMessage(query.error)}
                />
              ) : (
                <div
                  className={cn(
                    'overflow-x-auto',
                    query.isFetching && query.isPlaceholderData && 'opacity-70'
                  )}
                  aria-busy={query.isFetching}
                >
                  <Table
                    className='min-w-[980px] text-xs leading-4 [&_td]:py-1.5 [&_th]:h-9'
                    rememberRowKey='quarantine-account-ledger'
                  >
                    <TableHeader>
                      <TableRow>
                        <TableHead>时间 / 请求</TableHead>
                        <TableHead>模型</TableHead>
                        <TableHead>输出 Token</TableHead>
                        <TableHead>速度</TableHead>
                        <TableHead>状态</TableHead>
                        <TableHead>风险</TableHead>
                        <TableHead className='text-right'>详情</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items.map((row) => (
                        <LedgerRow
                          key={row.id}
                          row={row}
                          thresholds={thresholds}
                          onOpenDetail={setSelected}
                        />
                      ))}
                      {!items.length ? (
                        <TableRow>
                          <TableCell colSpan={7}>
                            <EmptyState
                              compact
                              icon={ScrollText}
                              title='当前窗口暂无该账号请求'
                              description='可以换一个时间范围，或确认请求审计已经扫描过这段时间。'
                            />
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
            <div className='shrink-0'>
              <ServerPagination
                page={query.data?.page ?? page}
                pageSize={pageSize}
                total={query.data?.total ?? 0}
                disabled={query.isFetching}
                loading={query.isFetching}
                itemLabel='请求'
                pageSizeOptions={[25, 50, 100]}
                onPageChange={setPage}
                onPageSizeChange={(value) => {
                  setPageSize(value)
                  setPage(1)
                }}
              />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function LedgerRow({
  row,
  thresholds,
  onOpenDetail,
}: {
  row: RequestAuditRecord
  thresholds: RequestAuditThresholds
  onOpenDetail: (row: RequestAuditRecord) => void
}) {
  const errorCode = auditErrorCode(row)
  const actionLabel = actionStatusLabel(row)
  const diagnostics = streamSampleDiagnostics(row)
  const warn = diagnostics.reasoningMismatch || diagnostics.thinkingBurst
  return (
    <TableRow rowId={row.id}>
      <TableCell className='align-middle !whitespace-normal'>
        <div className='text-[11px] tabular-nums'>{formatDate(row.createdAt)}</div>
        <CopyableText
          value={row.requestId || row.id}
          className='max-w-full items-start'
        >
          <span
            className='max-w-64 font-mono text-[10px] break-all text-muted-foreground'
            title={row.requestId}
          >
            {row.requestId || row.id}
          </span>
        </CopyableText>
      </TableCell>
      <TableCell className='align-middle !whitespace-normal'>
        <div className='max-w-56 text-xs break-words' title={row.modelPublicId || undefined}>
          {row.modelPublicId || '—'}
        </div>
        <div
          className='max-w-56 text-[11px] break-words text-muted-foreground'
          title={row.modelUpstreamModel || row.operation || undefined}
        >
          {row.modelUpstreamModel || row.operation || 'responses'}
        </div>
      </TableCell>
      <TableCell className='align-middle font-mono text-xs tabular-nums'>
        {formatNumber(row.outputTokens, 0)}
        {(row.reasoningTokens > 0 || reasoningEffortLabel(row.reasoningEffort)) && (
          <div className='text-[10px] text-muted-foreground'>
            {row.reasoningTokens > 0
              ? `推理 ${formatNumber(row.reasoningTokens, 0)}`
              : '推理 0'}
            {reasoningEffortLabel(row.reasoningEffort) ? (
              <span
                className={cn(
                  'ms-1 font-medium',
                  reasoningEffortClass(row.reasoningEffort)
                )}
              >
                · 思考 {reasoningEffortLabel(row.reasoningEffort)}
              </span>
            ) : null}
          </div>
        )}
      </TableCell>
      <TableCell className='align-middle'>
        <Tps
          value={row.tps}
          className={warn ? 'text-amber-700 dark:text-amber-300' : undefined}
        />
        <div className='text-[10px] text-muted-foreground'>
          {row.durationMs ? `${formatNumber(row.durationMs, 0)} ms` : '未测量'}
        </div>
      </TableCell>
      <TableCell className='align-middle'>
        <Badge
          variant={isSuccessfulAuditStatus(row) ? 'success' : 'destructive'}
          title={errorCode ? `${row.statusCode || '—'} · ${errorCode}` : undefined}
        >
          {row.statusCode || '—'}
        </Badge>
        {errorCode ? (
          <div
            className='mt-0.5 max-w-[9rem] truncate text-[10px] text-destructive'
            title={errorCode}
          >
            {auditErrorLabel(errorCode)}
          </div>
        ) : null}
      </TableCell>
      <TableCell className='align-middle'>
        <div className='flex flex-wrap items-center gap-1.5'>
          <RiskBadge value={row.riskLevel} thresholds={thresholds} />
          {actionLabel ? (
            <Badge variant='outline' className='h-5 px-1.5 text-[10px]'>
              {actionLabel}
            </Badge>
          ) : null}
        </div>
      </TableCell>
      <TableCell className='text-right align-middle'>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size='icon'
              variant='ghost'
              className='size-7'
              aria-label='查看请求审计详情'
              onClick={() => onOpenDetail(row)}
            >
              <Eye />
            </Button>
          </TooltipTrigger>
          <TooltipContent>查看完整请求审计</TooltipContent>
        </Tooltip>
      </TableCell>
    </TableRow>
  )
}

function LedgerDetail({
  record,
  thresholds,
}: {
  record: RequestAuditRecord
  thresholds: RequestAuditThresholds
}) {
  const errorCode = auditErrorCode(record)
  const actionLabel = actionStatusLabel(record)
  const sample = record.streamSample
  const diagnostics = streamSampleDiagnostics(record)
  const warnings = streamSampleWarnings(diagnostics)
  return (
    <div className='min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain pe-1'>
      <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
        <DetailStat label='速度'>
          <Tps value={record.tps} />
        </DetailStat>
        <DetailStat label='输出 Token'>
          {formatNumber(record.outputTokens, 0)}
        </DetailStat>
        <DetailStat label='耗时'>
          {record.durationMs ? `${formatNumber(record.durationMs, 0)} ms` : '未测量'}
        </DetailStat>
        <DetailStat label='风险'>
          <div className='flex flex-wrap items-center gap-1.5'>
            <RiskBadge value={record.riskLevel} thresholds={thresholds} />
            {actionLabel ? (
              <Badge variant='outline' className='h-5 px-1.5 text-[10px]'>
                {actionLabel}
              </Badge>
            ) : null}
          </div>
        </DetailStat>
      </div>

      <dl className='grid gap-3 sm:grid-cols-2 lg:grid-cols-3'>
        <DetailField
          label='请求 ID'
          value={record.requestId || '—'}
          copyValue={record.requestId || undefined}
        />
        <DetailField label='审计 ID' value={record.id} copyValue={record.id} />
        <DetailField
          label='客户端 Key'
          value={
            record.clientKeyName
              ? `${record.clientKeyName}${record.clientKeyId ? ` · ID ${record.clientKeyId}` : ''}`
              : record.clientKeyId
                ? `#${record.clientKeyId}`
                : '—'
          }
        />
        <DetailField
          label='代理节点'
          value={`${record.egressNodeName || '未映射代理节点'} · ID ${record.egressNodeId ?? '未知'}`}
        />
        <DetailField
          label='模型'
          value={record.modelPublicId || record.modelUpstreamModel || '—'}
        />
        <DetailField label='创建时间' value={formatDate(record.createdAt)} />
        <DetailField
          label='状态码'
          value={
            errorCode
              ? `${record.statusCode || '—'} · ${auditErrorLabel(errorCode)}`
              : String(record.statusCode || '—')
          }
        />
        {errorCode ? (
          <DetailField
            label='上游错误'
            value={`${auditErrorLabel(errorCode)} · ${errorCode}`}
            copyValue={errorCode}
          />
        ) : null}
        <DetailField
          label='思考等级'
          value={reasoningEffortLabel(record.reasoningEffort) || '未记录'}
        />
        <DetailField
          label='推理 Token'
          value={formatNumber(record.reasoningTokens, 0)}
        />
        <DetailField
          label='Media Input'
          value={
            record.hasMediaInput
              ? `${formatNumber(record.mediaInputImages, 0)} 张`
              : '无'
          }
        />
      </dl>

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

      <div className='space-y-3'>
        <div>
          <h3 className='text-sm font-semibold'>内容样本</h3>
          <p className='mt-1 text-xs text-muted-foreground'>
            截取思考和输出的开头/结尾，用来核对高 Token/s 是否真有推理正文。
          </p>
        </div>
        {!diagnostics.hasSample || !sample ? (
          <div className='rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground'>
            该请求没有保存思考/输出样本。升级前的历史记录不会有样本。
          </div>
        ) : (
          <>
            {warnings.length > 0 ? (
              <div className='space-y-1.5 rounded-lg bg-amber-500/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200'>
                {warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </div>
            ) : null}
            <dl className='grid gap-3 sm:grid-cols-2'>
              <DetailField
                label='思考字符 · 分片'
                value={`${formatNumber(sample.thinkingChars ?? 0, 0)} · ${formatNumber(sample.thinkingChunks ?? 0, 0)} 片`}
              />
              <DetailField
                label='输出字符 · 分片'
                value={`${formatNumber(sample.outputChars ?? 0, 0)} · ${formatNumber(sample.outputChunks ?? 0, 0)} 片`}
              />
              <DetailField
                label='思考时间窗'
                value={formatSampleWindow(
                  sample.firstThinkingMs,
                  sample.lastThinkingMs,
                  formatNumber
                )}
              />
              <DetailField
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
    </div>
  )
}

function DetailStat({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className='rounded-lg border bg-muted/15 p-3'>
      <div className='text-[11px] text-muted-foreground'>{label}</div>
      <div className='mt-1 font-mono text-lg font-semibold tabular-nums'>
        {children}
      </div>
    </div>
  )
}

function DetailField({
  label,
  value,
  copyValue,
}: {
  label: string
  value: string
  copyValue?: string
}) {
  return (
    <div className='rounded-lg border bg-muted/10 px-3 py-2'>
      <div className='text-[11px] text-muted-foreground'>{label}</div>
      <div className='mt-1 flex items-start gap-1 text-sm break-all'>
        <span className='min-w-0 flex-1'>{value}</span>
        {copyValue ? (
          <CopyButton value={copyValue} className='size-6 shrink-0' />
        ) : null}
      </div>
    </div>
  )
}

function SampleSnippet({ title, value }: { title: string; value?: string }) {
  if (!value) return null
  return (
    <div className='rounded-lg border bg-muted/10 p-3'>
      <div className='text-[11px] text-muted-foreground'>{title}</div>
      <pre className='mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-5'>
        {value}
      </pre>
    </div>
  )
}
