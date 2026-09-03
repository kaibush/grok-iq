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
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type {
  PublicUpstreamHealth,
  PublicUpstreamHealthSeriesPoint,
} from '@/lib/api'
import { cn, formatNumber } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { ProgressBar } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { StatCard, type StatTone } from '@/components/stat-card'
import { TitledCard } from '@/components/titled-card'
import { auditErrorLabel } from '@/features/monitor/components/audit-status'

const HEALTH_WINDOWS = [
  { key: '15m', label: '最近 15 分钟', icon: Gauge },
  { key: '30m', label: '最近 30 分钟', icon: HeartPulse },
  { key: '1h', label: '最近 1 小时', icon: Activity },
] as const

type HealthLevel = 'none' | 'healthy' | 'watch' | 'degraded' | 'down'

const HEALTH_BADGES: Record<
  HealthLevel,
  {
    label: string
    variant: 'outline' | 'success' | 'info' | 'warning' | 'destructive'
  }
> = {
  none: { label: '暂无请求', variant: 'outline' },
  healthy: { label: '上游稳定', variant: 'success' },
  watch: { label: '轻微波动', variant: 'info' },
  degraded: { label: '失败较多', variant: 'warning' },
  down: { label: '严重异常', variant: 'destructive' },
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

function rateFillClass(successRate: number) {
  if (successRate >= 95) return 'bg-success'
  if (successRate >= 85) return 'bg-warning'
  return 'bg-destructive'
}

function rateBarFill(successRate: number) {
  if (successRate >= 95) return 'var(--success)'
  if (successRate >= 85) return 'var(--warning)'
  return 'var(--destructive)'
}

function formatRate(value: number) {
  return `${formatNumber(value, 1)}%`
}

function describeError(statusCode: number, errorCode: string) {
  const label = auditErrorLabel(errorCode)
  const status = statusCode ? `${statusCode}` : ''
  if (label) return status ? `${status} · ${label}` : label
  return status ? `HTTP ${status}` : '未知错误'
}

function formatBucketTick(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date)
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
  const latest = data?.windows?.['15m']
  const level = healthLevel(latest?.requests ?? 0, latest?.successRate ?? 0)
  const badge = HEALTH_BADGES[level]
  const chartData = useMemo(
    () =>
      (data?.series ?? []).map((point) => ({
        ...point,
        label: `${formatBucketTick(point.start)}–${formatBucketTick(point.end)}`,
        successRate: point.requests > 0 ? point.successRate : null,
      })),
    [data?.series]
  )
  const models = (data?.models ?? []).slice(0, 6)
  const errors = data?.errors ?? []
  const hasTrend = chartData.some((point) => point.requests > 0)
  const maxError = errors[0]?.requests ?? 0
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
            {data?.enabled === false
              ? '请求审计已停用，此看板基于本地最近一次同步的数据。'
              : 'Build 通道请求成功率 · 基于请求审计记录实时统计'}
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
              <ShieldCheck className='size-3' />
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
              loading={isLoading}
              index={index}
            />
          )
        })}
      </div>

      <div className='grid gap-4 lg:grid-cols-5'>
        <TitledCard
          icon={<BarChart3 />}
          iconTone='sky'
          title='成功率走势'
          description='近 1 小时 · 每 5 分钟一段'
          className='lg:col-span-3'
          contentClassName='h-[232px]'
        >
          {isLoading ? (
            <Skeleton className='h-full w-full rounded-xl' />
          ) : !hasTrend ? (
            <div className='flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground'>
              <Activity className='size-5' />近 1 小时暂无请求记录
            </div>
          ) : (
            <div className='h-full'>
              <ResponsiveContainer width='100%' height='100%'>
                <BarChart
                  data={chartData}
                  margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray='3 3'
                    vertical={false}
                    stroke='var(--border)'
                  />
                  <XAxis
                    dataKey='start'
                    interval={1}
                    tick={{ fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={formatBucketTick}
                  />
                  <YAxis
                    domain={[0, 100]}
                    tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                    tickLine={false}
                    axisLine={false}
                    width={44}
                    tickFormatter={(value) => `${value}%`}
                  />
                  <ChartTooltip
                    cursor={{ fill: 'var(--muted)', opacity: 0.3 }}
                    content={<HealthTooltip />}
                  />
                  <Bar
                    dataKey='successRate'
                    name='成功率'
                    fill='var(--success)'
                    radius={[3, 3, 0, 0]}
                    maxBarSize={22}
                    isAnimationActive={false}
                  >
                    {chartData.map((point) => (
                      <Cell
                        key={point.start}
                        fill={rateBarFill(point.successRate ?? 0)}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </TitledCard>

        <TitledCard
          icon={<Gauge />}
          iconTone='violet'
          title='上游模型健康'
          description='近 1 小时 · 按请求量排序'
          className='lg:col-span-2'
        >
          {isLoading ? (
            <div className='space-y-3'>
              {Array.from({ length: 3 }, (_, index) => (
                <Skeleton key={index} className='h-10 w-full rounded-lg' />
              ))}
            </div>
          ) : models.length === 0 ? (
            <div className='flex flex-col items-center justify-center gap-2 py-8 text-center text-sm text-muted-foreground'>
              <ShieldCheck className='size-5' />近 1 小时暂无模型请求
            </div>
          ) : (
            <div className='space-y-3'>
              {models.map((model) => (
                <div key={model.model}>
                  <div className='flex items-center justify-between gap-2 text-sm'>
                    <span className='min-w-0 truncate font-medium'>
                      {model.model}
                    </span>
                    <span
                      className={cn(
                        'shrink-0 tabular-nums',
                        model.successRate >= 95
                          ? 'text-foreground'
                          : model.successRate >= 85
                            ? 'text-warning-foreground'
                            : 'text-destructive'
                      )}
                    >
                      {formatRate(model.successRate)}
                    </span>
                  </div>
                  <ProgressBar
                    className='mt-1.5 h-1.5'
                    value={model.successRate}
                    indicatorClassName={rateFillClass(model.successRate)}
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
            </div>
          )}
        </TitledCard>
      </div>

      <TitledCard
        icon={<AlertTriangle />}
        iconTone='amber'
        title='失败原因'
        description='近 1 小时 · 非 2xx 或带错误码的请求'
      >
        {isLoading ? (
          <div className='space-y-3'>
            {Array.from({ length: 2 }, (_, index) => (
              <Skeleton key={index} className='h-8 w-full rounded-lg' />
            ))}
          </div>
        ) : errors.length === 0 ? (
          <div className='flex items-center gap-2 py-2 text-sm text-muted-foreground'>
            <ShieldCheck className='size-4 text-success' />近 1 小时没有失败请求
          </div>
        ) : (
          <div className='grid gap-x-8 gap-y-3 sm:grid-cols-2'>
            {errors.map((item) => (
              <div key={`${item.statusCode}:${item.errorCode}`}>
                <div className='flex items-center justify-between gap-2 text-sm'>
                  <span className='flex min-w-0 items-center gap-1.5'>
                    <Badge variant='destructive' className='px-1.5 text-[11px]'>
                      {item.statusCode || '—'}
                    </Badge>
                    <span
                      className='truncate'
                      title={item.errorCode || undefined}
                    >
                      {auditErrorLabel(item.errorCode) ||
                        item.errorCode ||
                        '未知错误'}
                    </span>
                  </span>
                  <span className='shrink-0 text-muted-foreground tabular-nums'>
                    {formatNumber(item.requests, 0)}
                  </span>
                </div>
                <ProgressBar
                  className='mt-1 h-1'
                  value={maxError ? (item.requests / maxError) * 100 : 0}
                  indicatorClassName='bg-destructive'
                />
              </div>
            ))}
          </div>
        )}
      </TitledCard>
    </section>
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
