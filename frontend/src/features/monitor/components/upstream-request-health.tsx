import { useMemo } from 'react'
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Gauge,
  HeartPulse,
  ShieldCheck,
} from 'lucide-react'
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type {
  PublicUpstreamHealth,
  PublicUpstreamHealthError,
  PublicUpstreamHealthModel,
  PublicUpstreamHealthSeriesPoint,
} from '@/lib/api'
import { cn, formatNumber } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { ProgressBar } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/page'
import { StatCard, type StatTone } from '@/components/stat-card'
import { TitledCard } from '@/components/titled-card'
import {
  auditErrorLabel,
  isInternalAuditError,
} from '@/features/monitor/components/audit-status'

const HEALTH_WINDOWS = [
  { key: '15m', label: '最近 15 分钟', icon: Gauge, buckets: 3 },
  { key: '30m', label: '最近 30 分钟', icon: HeartPulse, buckets: 6 },
  { key: '1h', label: '最近 1 小时', icon: Activity, buckets: 12 },
] as const

type HealthLevel = 'none' | 'healthy' | 'watch' | 'degraded' | 'down'
type OverallLevel = HealthLevel | 'recovering'

const HEALTH_BADGES: Record<
  OverallLevel,
  {
    label: string
    variant: 'outline' | 'success' | 'info' | 'warning' | 'destructive'
    icon: typeof ShieldCheck
  }
> = {
  none: { label: '暂无请求', variant: 'outline', icon: Gauge },
  healthy: { label: '上游稳定', variant: 'success', icon: ShieldCheck },
  watch: { label: '轻微波动', variant: 'info', icon: Activity },
  recovering: { label: '刚刚恢复', variant: 'info', icon: HeartPulse },
  degraded: { label: '失败较多', variant: 'warning', icon: AlertTriangle },
  down: { label: '严重异常', variant: 'destructive', icon: AlertTriangle },
}

const HEALTH_TONES: Record<HealthLevel, StatTone> = {
  none: 'sky',
  healthy: 'emerald',
  watch: 'sky',
  degraded: 'amber',
  down: 'red',
}

function healthLevel(requests: number, successRate: number): HealthLevel {
  if (!requests) return 'none'
  if (successRate >= 99) return 'healthy'
  if (successRate >= 95) return 'watch'
  if (successRate >= 85) return 'degraded'
  return 'down'
}

function overallLevel(windows?: PublicUpstreamHealth['windows']): OverallLevel {
  if (!windows) return 'none'
  const latest = windows['15m']
  const hour = windows['1h']
  const latestLevel = healthLevel(
    latest?.requests ?? 0,
    latest?.successRate ?? 0
  )
  const hourLevel = healthLevel(hour?.requests ?? 0, hour?.successRate ?? 0)
  const latestOk = latestLevel === 'healthy' || latestLevel === 'watch'
  const hourBad = hourLevel === 'degraded' || hourLevel === 'down'
  if (
    (latest?.requests ?? 0) > 0 &&
    (hour?.requests ?? 0) > 0 &&
    latestOk &&
    hourBad
  ) {
    return 'recovering'
  }
  if ((latest?.requests ?? 0) > 0) return latestLevel
  const halfHour = windows['30m']
  if ((halfHour?.requests ?? 0) > 0) {
    return healthLevel(halfHour.requests, halfHour.successRate)
  }
  return hourLevel
}

function rateTextClass(successRate: number) {
  if (successRate >= 95) return 'text-foreground'
  if (successRate >= 85) return 'text-warning-foreground'
  return 'text-destructive'
}

function formatRate(value: number) {
  return `${formatNumber(value, 1)}%`
}

function formatClock(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date)
}

function formatBucketTick(value: string) {
  return formatClock(value)
}

function describeError(statusCode: number, errorCode: string) {
  const label = auditErrorLabel(errorCode)
  if (statusCode >= 400) {
    return label ? `${statusCode} · ${label}` : `HTTP ${statusCode}`
  }
  return label || errorCode || '未知错误'
}

function sparklineForWindow(
  series: PublicUpstreamHealthSeriesPoint[] | undefined,
  bucketCount: number
) {
  const values = (series ?? [])
    .slice(-bucketCount)
    .filter((point) => point.requests > 0)
    .map((point) => point.successRate)
  return values.length >= 2 ? values : undefined
}

function statusDescription(
  data: PublicUpstreamHealth | undefined,
  level: OverallLevel
) {
  if (data?.enabled === false) {
    return '请求审计已停用，此看板基于本地最近一次同步的数据。'
  }
  if (level === 'recovering' && data?.windows?.['1h']) {
    const hour = data.windows['1h']
    return `近 15 分钟已恢复 · 近 1 小时成功率 ${formatRate(hour.successRate)}，失败 ${formatNumber(hour.failedRequests, 0)} 次`
  }
  const parts = ['Build 通道请求成功率']
  if (data?.asOf) parts.push(`截至 ${formatClock(data.asOf)}`)
  parts.push('基于请求审计实时统计')
  return parts.join(' · ')
}

type HealthSeriesPayload = Omit<
  PublicUpstreamHealthSeriesPoint,
  'successRate'
> & {
  successRate: number | null
  label?: string
}

export function UpstreamRequestHealth({
  data,
  loading,
  error,
}: {
  data?: PublicUpstreamHealth
  loading: boolean
  error?: string
}) {
  const level = overallLevel(data?.windows)
  const badge = HEALTH_BADGES[level]
  const BadgeIcon = badge.icon
  const chartData = useMemo(() => {
    const points = (data?.series ?? []).map((point) => ({
      ...point,
      label: `${formatBucketTick(point.start)}–${formatBucketTick(point.end)}`,
      successRate: point.requests > 0 ? point.successRate : null,
    }))
    while (
      points.length > 1 &&
      (points[points.length - 1]?.requests ?? 0) <= 0
    ) {
      points.pop()
    }
    return points
  }, [data?.series])
  const models = (data?.models ?? []).map((model) =>
    model.mainError && isInternalAuditError(model.mainError.errorCode)
      ? { ...model, mainError: null }
      : model
  )
  const visibleModels = models.slice(0, 6)
  const errors = (data?.errors ?? []).filter(
    (item) => !isInternalAuditError(item.errorCode)
  )
  const failedTotal =
    data?.windows?.['1h']?.failedRequests ??
    errors.reduce((sum, item) => sum + item.requests, 0)
  const hasTrend = chartData.some((point) => point.requests > 0)
  const isLoading = loading && !data

  return (
    <section className='space-y-4'>
      <div className='flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between'>
        <div>
          <div className='flex items-center gap-2'>
            <HeartPulse className='size-4 text-primary' />
            <h2 className='text-base font-medium'>近期请求成功率</h2>
          </div>
          <p className='mt-1 text-xs text-muted-foreground'>
            {statusDescription(data, level)}
          </p>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          {data?.stale ? (
            <Badge variant='warning'>
              <AlertTriangle className='size-3' />
              审计数据延迟
            </Badge>
          ) : null}
          {isLoading ? (
            <Skeleton className='h-6 w-24 rounded-full' />
          ) : error ? (
            <Badge variant='destructive'>
              <AlertTriangle className='size-3' />
              读取失败
            </Badge>
          ) : (
            <Badge variant={badge.variant}>
              <BadgeIcon className='size-3' />
              {badge.label}
            </Badge>
          )}
        </div>
      </div>

      {error ? (
        <Card className='border-destructive/30 bg-destructive/5'>
          <CardContent className='p-4 text-sm text-destructive'>
            请求健康数据读取失败：{error}
          </CardContent>
        </Card>
      ) : null}

      <div className='grid gap-4 sm:grid-cols-3'>
        {HEALTH_WINDOWS.map((window, index) => {
          const stats = data?.windows?.[window.key]
          const requests = stats?.requests ?? 0
          const failed = stats?.failedRequests ?? 0
          const rate = stats?.successRate ?? 0
          const windowLevel = healthLevel(requests, rate)
          return (
            <StatCard
              key={window.key}
              label={window.label}
              value={requests > 0 ? formatRate(rate) : '—'}
              detail={
                requests > 0
                  ? `${formatNumber(requests, 0)} 请求 · ${formatNumber(failed, 0)} 失败`
                  : '该时间窗口暂无请求'
              }
              icon={window.icon}
              tone={requests > 0 ? HEALTH_TONES[windowLevel] : 'sky'}
              sparkline={
                isLoading
                  ? undefined
                  : sparklineForWindow(data?.series, window.buckets)
              }
              loading={isLoading}
              index={index}
            />
          )
        })}
      </div>

      <TitledCard
        icon={<BarChart3 />}
        iconTone='sky'
        title='请求走势'
        description={
          data?.asOf
            ? `近 1 小时 · 柱高是请求量 · 截至 ${formatClock(data.asOf)}`
            : '近 1 小时 · 柱高是请求量，绿成功 / 红失败'
        }
        hint='成功指 HTTP 2xx 且没有错误码。上游 503、流中断等都计为失败。'
        className='min-h-[300px]'
        contentClassName='flex h-[240px] flex-col'
      >
        {isLoading ? (
          <Skeleton className='h-full w-full rounded-xl' />
        ) : !hasTrend ? (
          <EmptyState
            compact
            icon={Activity}
            title='近 1 小时暂无请求'
            description='还没有可用于统计成功率的审计记录。'
            className='h-full border-0 bg-transparent'
          />
        ) : (
          <HealthTrendChart data={chartData} />
        )}
      </TitledCard>

      <div className='grid items-stretch gap-4 lg:grid-cols-2'>
        <TitledCard
          icon={<Gauge />}
          iconTone='violet'
          title='上游模型健康'
          description='近 1 小时 · 按请求量排序'
          className='h-full'
        >
          {isLoading ? (
            <div className='space-y-3'>
              {Array.from({ length: 3 }, (_, index) => (
                <Skeleton key={index} className='h-10 w-full rounded-lg' />
              ))}
            </div>
          ) : visibleModels.length === 0 ? (
            <EmptyState
              compact
              icon={ShieldCheck}
              title='近 1 小时暂无模型请求'
              description='当前窗口还没有按模型拆分的审计记录。'
              className='border-0 bg-transparent'
            />
          ) : (
            <ModelHealthList
              models={visibleModels}
              hiddenCount={Math.max(0, models.length - visibleModels.length)}
            />
          )}
        </TitledCard>

        <TitledCard
          icon={<AlertTriangle />}
          iconTone='amber'
          title='失败原因'
          description={
            failedTotal > 0
              ? `近 1 小时 · ${formatNumber(failedTotal, 0)} 次失败`
              : '近 1 小时 · 非 2xx 或带错误码的请求'
          }
          className='h-full'
        >
          {isLoading ? (
            <div className='space-y-3'>
              {Array.from({ length: 3 }, (_, index) => (
                <Skeleton key={index} className='h-8 w-full rounded-lg' />
              ))}
            </div>
          ) : errors.length === 0 ? (
            <EmptyState
              compact
              icon={ShieldCheck}
              title='近 1 小时没有失败请求'
              description='当前窗口的请求都已成功完成。'
              className='border-0 bg-transparent'
            />
          ) : (
            <ErrorList errors={errors} failedTotal={failedTotal} />
          )}
        </TitledCard>
      </div>
    </section>
  )
}

function HealthTrendChart({ data }: { data: HealthSeriesPayload[] }) {
  return (
    <div className='flex h-full flex-col'>
      <div className='min-h-0 flex-1'>
        <ResponsiveContainer width='100%' height='100%'>
          <ComposedChart
            data={data}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          >
            <CartesianGrid
              strokeDasharray='3 3'
              vertical={false}
              stroke='var(--border)'
            />
            <XAxis
              dataKey='start'
              interval={0}
              minTickGap={16}
              tick={{ fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={formatBucketTick}
            />
            <YAxis
              allowDecimals={false}
              tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
              tickLine={false}
              axisLine={false}
              width={36}
              tickFormatter={(value) => formatNumber(Number(value), 0)}
            />
            <ChartTooltip
              cursor={{ fill: 'var(--muted)', opacity: 0.3 }}
              content={<HealthTooltip />}
            />
            <Bar
              dataKey='successfulRequests'
              name='成功'
              stackId='req'
              fill='var(--success)'
              maxBarSize={28}
              isAnimationActive={false}
            />
            <Bar
              dataKey='failedRequests'
              name='失败'
              stackId='req'
              fill='var(--destructive)'
              radius={[3, 3, 0, 0]}
              maxBarSize={28}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className='flex flex-wrap items-center justify-center gap-x-4 gap-y-2 pt-3 text-xs text-muted-foreground'>
        <span className='inline-flex items-center gap-1.5'>
          <span className='size-2 rounded-[2px] bg-success' />
          成功
        </span>
        <span className='inline-flex items-center gap-1.5'>
          <span className='size-2 rounded-[2px] bg-destructive' />
          失败
        </span>
      </div>
    </div>
  )
}

function HealthTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: readonly { payload?: HealthSeriesPayload }[]
}) {
  const point = payload?.[0]?.payload
  if (!active || !point) return null
  if (!point.requests) {
    return (
      <div className='rounded-xl border bg-popover px-3 py-2 text-xs shadow-sm'>
        <div className='mb-1.5 text-muted-foreground'>{point.label ?? '—'}</div>
        <div>该时间段暂无请求</div>
      </div>
    )
  }
  return (
    <div className='rounded-xl border bg-popover px-3 py-2 text-xs shadow-sm'>
      <div className='mb-1.5 text-muted-foreground'>{point.label ?? '—'}</div>
      <div className='space-y-1 tabular-nums'>
        <div>成功率 {formatRate(point.successRate ?? 0)}</div>
        <div>
          请求 {formatNumber(point.requests, 0)} · 成功{' '}
          {formatNumber(point.successfulRequests, 0)} · 失败{' '}
          {formatNumber(point.failedRequests, 0)}
        </div>
      </div>
    </div>
  )
}

function ModelHealthList({
  models,
  hiddenCount,
}: {
  models: PublicUpstreamHealthModel[]
  hiddenCount: number
}) {
  if (models.length === 1) {
    const model = models[0]
    return (
      <div>
        <div className='truncate text-sm font-medium' title={model.model}>
          {model.model}
        </div>
        <div
          className={cn(
            'mt-2 text-3xl font-semibold tracking-tight tabular-nums',
            rateTextClass(model.successRate)
          )}
        >
          {formatRate(model.successRate)}
        </div>
        <HealthShareBar
          success={model.successfulRequests}
          failed={model.failedRequests}
          className='mt-3 h-2'
        />
        <div className='mt-2 text-xs text-muted-foreground'>
          {formatNumber(model.requests, 0)} 请求 ·{' '}
          {formatNumber(model.failedRequests, 0)} 失败
          {model.mainError ? (
            <span className='text-destructive/80'>
              {' '}
              · 主要失败{' '}
              {describeError(
                model.mainError.statusCode,
                model.mainError.errorCode
              )}
            </span>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className='space-y-3'>
      {models.map((model) => (
        <div key={model.model}>
          <div className='flex items-center justify-between gap-2 text-sm'>
            <span className='min-w-0 truncate font-medium' title={model.model}>
              {model.model}
            </span>
            <span
              className={cn(
                'shrink-0 tabular-nums',
                rateTextClass(model.successRate)
              )}
            >
              {formatRate(model.successRate)}
            </span>
          </div>
          <HealthShareBar
            success={model.successfulRequests}
            failed={model.failedRequests}
          />
          <div className='mt-1 text-[11px] text-muted-foreground'>
            {formatNumber(model.requests, 0)} 请求 ·{' '}
            {formatNumber(model.failedRequests, 0)} 失败
            {model.mainError ? (
              <span className='text-destructive/80'>
                {' '}
                · 主要失败{' '}
                {describeError(
                  model.mainError.statusCode,
                  model.mainError.errorCode
                )}
              </span>
            ) : null}
          </div>
        </div>
      ))}
      {hiddenCount > 0 ? (
        <p className='text-[11px] text-muted-foreground'>
          其余 {formatNumber(hiddenCount, 0)} 个模型未列出
        </p>
      ) : null}
    </div>
  )
}

function ErrorList({
  errors,
  failedTotal,
}: {
  errors: PublicUpstreamHealthError[]
  failedTotal: number
}) {
  return (
    <div className='space-y-3'>
      {errors.map((item) => {
        const share = failedTotal ? (item.requests / failedTotal) * 100 : 0
        return (
          <div key={`${item.statusCode}:${item.errorCode}`}>
            <div className='flex items-center justify-between gap-2 text-sm'>
              <span className='flex min-w-0 items-center gap-1.5'>
                {item.statusCode >= 400 ? (
                  <Badge variant='destructive' className='px-1.5 text-[11px]'>
                    {item.statusCode}
                  </Badge>
                ) : (
                  <Badge variant='warning' className='px-1.5 text-[11px]'>
                    异常
                  </Badge>
                )}
                <span className='truncate' title={item.errorCode || undefined}>
                  {auditErrorLabel(item.errorCode) ||
                    item.errorCode ||
                    '未知错误'}
                </span>
              </span>
              <span className='shrink-0 text-muted-foreground tabular-nums'>
                {formatNumber(item.requests, 0)}
                {failedTotal > 0 ? ` · ${formatRate(share)}` : ''}
              </span>
            </div>
            <ProgressBar
              className='mt-1 h-1'
              value={share}
              indicatorClassName='bg-destructive'
            />
          </div>
        )
      })}
    </div>
  )
}

function HealthShareBar({
  success,
  failed,
  className,
}: {
  success: number
  failed: number
  className?: string
}) {
  const total = success + failed
  const successShare = total ? (success / total) * 100 : 0
  const failedShare = total ? (failed / total) * 100 : 0
  return (
    <div
      className={cn(
        'mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-muted',
        className
      )}
    >
      <span className='bg-emerald-500' style={{ width: `${successShare}%` }} />
      <span className='bg-rose-500' style={{ width: `${failedShare}%` }} />
    </div>
  )
}
