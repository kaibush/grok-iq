import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Eye, RefreshCw, ScrollText } from 'lucide-react'
import {
  api,
  type RequestAuditRecord,
  type RequestAuditRiskLevel,
  type RequestAuditThresholds,
  type RequestAuditWindowInput,
  type RequestAuditWindowPreset,
} from '@/lib/api'
import { slimRequestAuditRecord } from '@/lib/preview-payload'
import { cn, formatDate, formatNumber, getErrorMessage } from '@/lib/utils'
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
import { CopyableText } from '@/components/copy-button'
import { EmptyState, LoadingState } from '@/components/page'
import { ServerPagination } from '@/components/server-pagination'
import type { AccountIdentity } from '@/features/monitor/components/account-upstream-dialog'
import {
  auditErrorCode,
  auditErrorLabel,
  isSuccessfulAuditStatus,
} from '@/features/monitor/components/audit-status'
import { RequestAuditDetailBody } from '@/features/monitor/components/request-audit-detail'
import {
  AuditUsageCell,
  AttemptCountHint,
  useHydratedRequestAudit,
} from '@/features/monitor/pages/request-audit-gateway-view'
import {
  streamSampleDiagnostics,
  streamSamplePreview,
} from '@/features/monitor/pages/request-audit-stream-sample'

const WINDOW_OPTIONS: Array<{
  value: Exclude<RequestAuditWindowPreset, 'custom'>
  label: string
}> = [
  { value: 'today', label: '当天' },
  { value: '1h', label: '最近 1 小时' },
  { value: '3h', label: '最近 3 小时' },
  { value: '6h', label: '最近 6 小时' },
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
        value === 'high'
          ? 'destructive'
          : value === 'watch'
            ? 'warning'
            : 'success'
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
  initialWindow,
}: {
  open: boolean
  account: AccountIdentity | null
  onOpenChange: (open: boolean) => void
  initialWindow?: RequestAuditWindowInput
}) {
  const accountId = account ? Number(account.id) : 0
  const accountLabel =
    account?.name ||
    account?.email ||
    (accountId ? `账号 ${accountId}` : '账号')
  const [windowPreset, setWindowPreset] = useState<RequestAuditWindowPreset>(
    initialWindow?.window ?? 'today'
  )
  const [customRange, setCustomRange] = useState<{
    startAt?: string
    endAt?: string
  }>(() =>
    initialWindow?.window === 'custom'
      ? { startAt: initialWindow.startAt, endAt: initialWindow.endAt }
      : {}
  )
  const [risk, setRisk] =
    useState<(typeof RISK_OPTIONS)[number]['value']>('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [selected, setSelected] = useState<RequestAuditRecord | null>(null)
  const [resetNonce, setResetNonce] = useState({ open, accountId })
  if (
    open &&
    (resetNonce.open !== open || resetNonce.accountId !== accountId)
  ) {
    setResetNonce({ open, accountId })
    const nextWindow = initialWindow?.window ?? 'today'
    setWindowPreset(nextWindow)
    setCustomRange(
      nextWindow === 'custom'
        ? { startAt: initialWindow?.startAt, endAt: initialWindow?.endAt }
        : {}
    )
    setRisk('all')
    setPage(1)
    setPageSize(25)
    setSelected(null)
  } else if (!open && resetNonce.open) {
    setResetNonce({ open, accountId })
  }

  const windowOptions =
    windowPreset === 'custom'
      ? [...WINDOW_OPTIONS, { value: 'custom' as const, label: '当前窗口' }]
      : WINDOW_OPTIONS

  const query = useQuery({
    queryKey: [
      'request-audits',
      'account-ledger',
      accountId,
      windowPreset,
      customRange.startAt ?? '',
      customRange.endAt ?? '',
      risk,
      page,
      pageSize,
    ],
    queryFn: async () => {
      const pageData = await api.requestAudits({
        window: windowPreset,
        startAt: windowPreset === 'custom' ? customRange.startAt : undefined,
        endAt: windowPreset === 'custom' ? customRange.endAt : undefined,
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
  const windowLabel =
    query.data?.window.label ??
    (windowPreset === 'custom'
      ? '当前窗口'
      : (WINDOW_OPTIONS.find((option) => option.value === windowPreset)
          ?.label ?? '当前窗口'))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size='wide'
        className='h-[min(52rem,calc(100dvh-2rem))] overflow-hidden'
      >
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
                  const next = value as RequestAuditWindowPreset
                  setWindowPreset(next)
                  if (next !== 'custom') setCustomRange({})
                  setPage(1)
                }}
              >
                <SelectTrigger
                  className='h-8 w-40'
                  aria-label='请求流水时间窗口'
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {windowOptions.map((option) => (
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
                <SelectTrigger
                  className='h-8 w-36'
                  aria-label='按风险筛选请求流水'
                >
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
                <RefreshCw
                  className={query.isFetching ? 'animate-spin' : undefined}
                />
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
                    className='min-w-[1080px] text-xs leading-4 [&_td]:py-1.5 [&_th]:h-9'
                    rememberRowKey='quarantine-account-ledger'
                  >
                    <TableHeader>
                      <TableRow>
                        <TableHead>时间 / 请求</TableHead>
                        <TableHead>模型</TableHead>
                        <TableHead>用量 / 计费</TableHead>
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
  const preview = streamSamplePreview(row.streamSample, 36)
  const previewText = [
    preview.thinking && `思 ${preview.thinking}`,
    preview.output && `出 ${preview.output}`,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <TableRow rowId={row.id}>
      <TableCell className='align-middle !whitespace-normal'>
        <div className='text-[11px] tabular-nums'>
          {formatDate(row.createdAt)}
        </div>
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
        <div
          className='max-w-56 text-xs break-words'
          title={row.modelPublicId || undefined}
        >
          {row.modelPublicId || '—'}
        </div>
        <div
          className='max-w-56 text-[11px] break-words text-muted-foreground'
          title={row.modelUpstreamModel || row.operation || undefined}
        >
          {row.modelUpstreamModel || row.operation || 'responses'}
        </div>
      </TableCell>
      <TableCell className='align-middle'>
        <AuditUsageCell row={row} />
      </TableCell>
      <TableCell className='align-middle'>
        <Tps
          value={row.tps}
          className={warn ? 'text-amber-700 dark:text-amber-300' : undefined}
        />
        <div className='text-[10px] text-muted-foreground'>
          {row.durationMs ? `${formatNumber(row.durationMs, 0)} ms` : '未测量'}
          {row.streaming ? '' : ' · 非流'}
        </div>
        {previewText ? (
          <div
            className='mt-0.5 max-w-[12rem] truncate text-[10px] text-muted-foreground'
            title={previewText}
          >
            {previewText}
          </div>
        ) : null}
      </TableCell>
      <TableCell className='align-middle'>
        <Badge
          variant={isSuccessfulAuditStatus(row) ? 'success' : 'destructive'}
          title={
            errorCode ? `${row.statusCode || '—'} · ${errorCode}` : undefined
          }
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
        <AttemptCountHint row={row} />
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
  record: source,
  thresholds,
}: {
  record: RequestAuditRecord
  thresholds: RequestAuditThresholds
}) {
  const {
    view,
    loading: gatewayLoading,
    error: gatewayError,
  } = useHydratedRequestAudit(source, true)
  const record = view ?? source
  return (
    <RequestAuditDetailBody
      record={record}
      thresholds={thresholds}
      gatewayLoading={gatewayLoading}
      gatewayError={gatewayError}
    />
  )
}
