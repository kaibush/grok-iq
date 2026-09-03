import { useMemo, useState } from 'react'
import {
  BrainCircuit,
  Cpu,
  Globe2,
  KeyRound,
  Layers3,
  Percent,
  UsersRound,
} from 'lucide-react'
import {
  type RequestAuditQualityBreakdown,
  type RequestAuditQualityDimension,
  type RequestAuditQualityRow,
} from '@/lib/api'
import { cn, formatNumber } from '@/lib/utils'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { InfoTooltip } from '@/components/info-tooltip'
import { SegmentedControl } from '@/components/segmented-control'

const DIMENSIONS: Array<{
  value: RequestAuditQualityDimension
  label: string
  noun: string
  clickable: boolean
}> = [
  { value: 'clients', label: '客户端', noun: '客户端', clickable: true },
  { value: 'accounts', label: '账号', noun: '账号', clickable: true },
  { value: 'nodes', label: '节点', noun: '代理节点', clickable: true },
  { value: 'models', label: '模型', noun: '模型', clickable: false },
  { value: 'reasoning', label: '思考', noun: '思考等级', clickable: false },
  { value: 'operations', label: '操作', noun: '请求操作', clickable: false },
]

const REASONING_LABELS: Record<string, string> = {
  auto: '自动',
  none: '关闭',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  fixed: '固定',
  unlabeled: '未记录',
}

function formatRatePercent(part: number, total: number) {
  if (total <= 0) return '—'
  const percent = (part / total) * 100
  if (percent <= 0) return '0%'
  if (percent >= 100) return '100%'
  return `${formatNumber(percent, 1)}%`
}

function rowLabel(dimension: RequestAuditQualityDimension, row: RequestAuditQualityRow) {
  if (dimension !== 'reasoning') return row.label
  return REASONING_LABELS[row.id] || row.label
}

function isClickableRow(dimension: RequestAuditQualityDimension, row: RequestAuditQualityRow) {
  if (dimension === 'clients') return true
  if (dimension === 'accounts') return row.id !== 'unlabeled'
  if (dimension === 'nodes') return row.id !== 'unmapped'
  return false
}

export function RequestAuditQualityBoard({
  quality,
  onSelect,
}: {
  quality?: RequestAuditQualityBreakdown | null
  onSelect?: (dimension: RequestAuditQualityDimension, row: RequestAuditQualityRow) => void
}) {
  const [dimension, setDimension] =
    useState<RequestAuditQualityDimension>('clients')
  const meta = DIMENSIONS.find((item) => item.value === dimension) ?? DIMENSIONS[0]
  const group = quality?.[dimension]
  const items = group?.items ?? []
  const total = group?.total ?? 0
  const rows = useMemo(
    () =>
      items.map((item) => {
        const abnormal = item.watchRequests + item.highRiskRequests
        const normal = Math.max(0, item.requests - abnormal)
        return {
          ...item,
          abnormal,
          normal,
          normalShare: item.requests > 0 ? (normal / item.requests) * 100 : 0,
          watchShare:
            item.requests > 0 ? (item.watchRequests / item.requests) * 100 : 0,
          highShare:
            item.requests > 0 ? (item.highRiskRequests / item.requests) * 100 : 0,
        }
      }),
    [items]
  )

  if (!quality) return null

  return (
    <Card>
      <CardHeader className='gap-3 sm:flex-row sm:items-start sm:justify-between'>
        <div className='min-w-0'>
          <CardTitle className='flex items-center gap-2'>
            <Percent className='size-4 text-primary' />
            请求质量拆分
            <InfoTooltip
              label='请求质量拆分'
              content='和上方正常率同一套口径：异常 = 观察 + 高风险。默认列出异常最多的几项，方便看是客户端、账号还是节点在拉低窗口质量。可点击的行会跳到请求流水并带上对应筛选。'
            />
          </CardTitle>
          <CardDescription>
            同一窗口内的正常率 / 异常率，按维度拆开看。
          </CardDescription>
        </div>
        <SegmentedControl
          ariaLabel='质量拆分维度'
          value={dimension}
          onChange={setDimension}
          options={DIMENSIONS.map((item) => ({
            value: item.value,
            label: item.label,
          }))}
        />
      </CardHeader>
      <CardContent className='space-y-2 pb-4'>
        {rows.length === 0 ? (
          <p className='py-6 text-center text-sm text-muted-foreground'>
            当前窗口没有可按{meta.noun}拆分的请求。
          </p>
        ) : (
          <>
            <div className='space-y-1.5'>
              {rows.map((row) => {
                const clickable = Boolean(onSelect) && isClickableRow(dimension, row)
                const label = rowLabel(dimension, row)
                const tone =
                  row.highRiskRequests > 0
                    ? 'danger'
                    : row.watchRequests > 0
                      ? 'warning'
                      : 'ok'
                const content = (
                  <>
                    <div className='flex items-center justify-between gap-3'>
                      <span className='flex min-w-0 items-center gap-1.5'>
                        <DimensionIcon dimension={dimension} />
                        <span className='truncate text-sm font-medium'>{label}</span>
                      </span>
                      <span
                        className={cn(
                          'shrink-0 text-sm font-semibold tabular-nums',
                          tone === 'danger' && 'text-destructive',
                          tone === 'warning' &&
                            'text-amber-700 dark:text-amber-300',
                          tone === 'ok' && 'text-emerald-700 dark:text-emerald-300'
                        )}
                      >
                        {formatRatePercent(row.normal, row.requests)}
                      </span>
                    </div>
                    <div className='mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-muted'>
                      <span
                        className='bg-emerald-500'
                        style={{ width: `${row.normalShare}%` }}
                      />
                      <span
                        className='bg-amber-500'
                        style={{ width: `${row.watchShare}%` }}
                      />
                      <span
                        className='bg-rose-500'
                        style={{ width: `${row.highShare}%` }}
                      />
                    </div>
                    <div className='mt-1 truncate text-[11px] text-muted-foreground'>
                      {formatNumber(row.requests, 0)} 次 · 异常{' '}
                      {formatRatePercent(row.abnormal, row.requests)}
                      {row.abnormal > 0
                        ? ` · 观察 ${formatNumber(row.watchRequests, 0)} · 高风险 ${formatNumber(row.highRiskRequests, 0)}`
                        : ''}
                    </div>
                  </>
                )
                if (!clickable) {
                  return (
                    <div
                      key={row.id}
                      className='rounded-lg border bg-background px-3 py-2.5'
                    >
                      {content}
                    </div>
                  )
                }
                return (
                  <button
                    key={row.id}
                    type='button'
                    className='w-full rounded-lg border bg-background px-3 py-2.5 text-left transition-colors hover:bg-muted/45 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
                    onClick={() => onSelect?.(dimension, row)}
                  >
                    {content}
                  </button>
                )
              })}
            </div>
            <p className='text-[11px] text-muted-foreground'>
              {total > rows.length
                ? `共 ${formatNumber(total, 0)} 个${meta.noun}，列出异常最多的 ${formatNumber(rows.length, 0)} 个`
                : `共 ${formatNumber(total, 0)} 个${meta.noun}`}
              {meta.clickable ? '。点击可查看该维度的请求流水。' : '。'}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function DimensionIcon({
  dimension,
}: {
  dimension: RequestAuditQualityDimension
}) {
  const className = 'size-3.5 shrink-0 text-muted-foreground'
  if (dimension === 'clients') return <KeyRound className={className} />
  if (dimension === 'accounts') return <UsersRound className={className} />
  if (dimension === 'nodes') return <Globe2 className={className} />
  if (dimension === 'models') return <Cpu className={className} />
  if (dimension === 'reasoning') return <BrainCircuit className={className} />
  return <Layers3 className={className} />
}
