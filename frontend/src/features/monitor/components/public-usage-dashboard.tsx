import { useMemo, useState } from 'react'
import {
  Activity,
  BarChart3,
  CircleDollarSign,
  Gauge,
  WholeWord,
} from 'lucide-react'
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  type PublicUpstreamUsageOverview,
  type PublicUpstreamUsagePeriod,
} from '@/lib/api'
import { cn, formatDate, formatNumber } from '@/lib/utils'
import { EmptyState } from '@/components/page'
import { SegmentedControl } from '@/components/segmented-control'
import { StatCard } from '@/components/stat-card'
import { TitledCard } from '@/components/titled-card'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

const USD_TICKS = 10_000_000_000
const TIMEZONE = 'Asia/Shanghai'
const STRIPE_COUNT = 40
const PERIODS: Array<{ value: PublicUpstreamUsagePeriod; label: string }> = [
  { value: '24h', label: '24 小时' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
  { value: '90d', label: '90 天' },
]
const PROVIDERS = [
  { key: 'grok_build', label: 'Build', color: 'bg-sky-500', dot: 'bg-sky-500' },
  {
    key: 'grok_web',
    label: 'Web',
    color: 'bg-emerald-500',
    dot: 'bg-emerald-500',
  },
  {
    key: 'grok_console',
    label: 'Console',
    color: 'bg-violet-500',
    dot: 'bg-violet-500',
  },
] as const
const INTENSITY_CLASSES = [
  'bg-muted',
  'bg-emerald-500/20',
  'bg-emerald-500/45',
  'bg-emerald-500/70',
  'bg-emerald-500',
] as const
const TREND_SERIES = ['billing', 'tokens', 'requests'] as const
type TrendSeries = (typeof TREND_SERIES)[number]

const emptyUsage: PublicUpstreamUsageOverview = {
  reachable: false,
  period: '24h',
  generatedAt: null,
  range: { start: null, end: null },
  usage: {
    requests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    tokens: 0,
    billedCostUsdTicks: 0,
    successRate: 0,
    cacheHitRate: 0,
    averageFirstTokenMs: 0,
    outputTokensPerSecond: 0,
    firstTokenSamples: 0,
    throughputSamples: 0,
  },
  series: [],
  activity: [],
  topModels: [],
  providers: [],
}

export function PublicUsageDashboard({
  period,
  onPeriodChange,
  data,
  loading,
  error,
}: {
  period: PublicUpstreamUsagePeriod
  onPeriodChange: (period: PublicUpstreamUsagePeriod) => void
  data?: PublicUpstreamUsageOverview
  loading: boolean
  error?: string
}) {
  const dashboard = data ?? emptyUsage
  const ready = Boolean(data?.reachable) && !error
  const usage = dashboard.usage
  const cacheHitRate =
    usage.inputTokens > 0
      ? (usage.cachedInputTokens / usage.inputTokens) * 100
      : usage.cacheHitRate
  const averageRequestCost =
    usage.requests > 0 ? usage.billedCostUsdTicks / USD_TICKS / usage.requests : 0
  const hasFirstTokenSamples = usage.firstTokenSamples > 0
  const hasThroughputSamples = usage.throughputSamples > 0
  const latencyDetail = hasThroughputSamples
    ? `平均输出 ${formatNumber(usage.outputTokensPerSecond, 1)} tok/s · ${formatNumber(usage.throughputSamples, 0)} 个样本`
    : hasFirstTokenSamples
      ? '吞吐样本不足'
      : '暂无性能样本'

  return (
    <section className='space-y-4'>
      <div className='flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between'>
        <div>
          <div className='flex items-center gap-2'>
            <BarChart3 className='size-4 text-primary' />
            <h2 className='text-base font-medium'>请求看板</h2>
          </div>
          <p className='mt-1 text-xs text-muted-foreground'>
            {ready
              ? `${formatDate(dashboard.range.start)} ~ ${formatDate(dashboard.range.end)}`
              : '按时间窗口汇总请求、Tokens、计费和模型分布'}
          </p>
        </div>
        <SegmentedControl
          ariaLabel='请求看板时间范围'
          value={period}
          onChange={onPeriodChange}
          options={PERIODS}
        />
      </div>

      {error ? (
        <Card className='border-destructive/30 bg-destructive/5'>
          <CardContent className='p-4 text-sm text-destructive'>
            请求统计读取失败：{error}
          </CardContent>
        </Card>
      ) : null}
      {!error && data && !data.reachable ? (
        <Card className='border-amber-500/30 bg-amber-500/5'>
          <CardContent className='p-4 text-sm text-amber-800 dark:text-amber-300'>
            上游暂时不可达，当前不展示请求统计。
          </CardContent>
        </Card>
      ) : null}

      <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-4'>
        <StatCard
          label='请求'
          value={ready ? formatNumber(usage.requests, 0) : '—'}
          detail={
            ready
              ? `成功率 ${formatNumber(usage.successRate, 1)}% · 失败 ${formatNumber(usage.failedRequests, 0)}`
              : '读取中'
          }
          icon={Activity}
          tone='sky'
          loading={loading}
          index={0}
        />
        <StatCard
          label='Tokens'
          value={ready ? formatNumber(usage.tokens, 0) : '—'}
          detail={
            ready
              ? `缓存命中 ${formatNumber(cacheHitRate, 1)}% · 输入 ${formatNumber(usage.inputTokens, 0)}`
              : '读取中'
          }
          icon={WholeWord}
          tone='violet'
          loading={loading}
          index={1}
        />
        <StatCard
          label='计费'
          value={ready ? formatUsd(usage.billedCostUsdTicks) : '—'}
          detail={
            ready
              ? `单次均价 ${formatUsdValue(averageRequestCost)}`
              : '读取中'
          }
          icon={CircleDollarSign}
          tone='emerald'
          loading={loading}
          index={2}
        />
        <StatCard
          label='首字延迟'
          value={
            ready && hasFirstTokenSamples
              ? formatDurationMs(usage.averageFirstTokenMs)
              : '—'
          }
          detail={ready ? latencyDetail : '读取中'}
          icon={Gauge}
          tone='amber'
          loading={loading}
          index={3}
        />
      </div>

      <div className='grid items-stretch gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(18rem,2fr)]'>
        <UsageTrend dashboard={dashboard} ready={ready} loading={loading} />
        <ProviderDistribution
          dashboard={dashboard}
          ready={ready}
          loading={loading}
        />
      </div>

      <div className='grid items-stretch gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(18rem,2fr)]'>
        <TopModels dashboard={dashboard} ready={ready} loading={loading} />
        <ActivityHeatmap dashboard={dashboard} ready={ready} loading={loading} />
      </div>
    </section>
  )
}

function UsageTrend({
  dashboard,
  ready,
  loading,
}: {
  dashboard: PublicUpstreamUsageOverview
  ready: boolean
  loading: boolean
}) {
  const [hiddenSeries, setHiddenSeries] = useState<Set<TrendSeries>>(
    () => new Set()
  )
  const chartData = useMemo(
    () =>
      dashboard.series.map((bucket) => ({
        start: bucket.start,
        requests: bucket.requests,
        tokens: bucket.tokens,
        billing: bucket.billedCostUsdTicks / USD_TICKS,
        tooltipLabel: formatBucketRange(
          bucket.start,
          bucket.end,
          dashboard.period
        ),
      })),
    [dashboard.period, dashboard.series]
  )
  const xTicks = useMemo(
    () =>
      chartData
        .filter((_point, index) =>
          shouldShowTick(index, chartData.length, dashboard.period)
        )
        .map((point) => point.start),
    [chartData, dashboard.period]
  )
  const hasData =
    ready &&
    dashboard.series.some(
      (bucket) =>
        bucket.requests > 0 ||
        bucket.tokens > 0 ||
        bucket.billedCostUsdTicks > 0
    )
  const axisSides = resolveTrendAxes(hiddenSeries)

  function toggleSeries(series: TrendSeries) {
    setHiddenSeries((current) => {
      const next = new Set(current)
      if (next.has(series)) next.delete(series)
      else next.add(series)
      return next
    })
  }

  return (
    <TitledCard
      icon={<Activity />}
      iconTone='sky'
      title='用量趋势'
      description='请求、Tokens 与计费随时间变化'
      className='h-full min-h-[360px]'
      contentClassName='flex h-[320px] flex-col'
    >
      {loading ? (
        <Skeleton className='h-full w-full rounded-xl' />
      ) : !hasData ? (
        <EmptyState
          compact
          icon={Activity}
          title='暂无趋势数据'
          description='所选时间窗口还没有请求记录。'
          className='h-full border-0 bg-transparent'
        />
      ) : (
        <div className='flex h-full flex-col'>
          <div className='min-h-0 flex-1'>
            <ResponsiveContainer width='100%' height='100%'>
              <ComposedChart
                data={chartData}
                margin={{ left: 0, right: 8, top: 8, bottom: 0 }}
              >
                <defs>
                  <linearGradient
                    id='public-usage-tokens-fill'
                    x1='0'
                    y1='0'
                    x2='0'
                    y2='1'
                  >
                    <stop
                      offset='5%'
                      stopColor='var(--chart-1)'
                      stopOpacity={0.28}
                    />
                    <stop
                      offset='95%'
                      stopColor='var(--chart-1)'
                      stopOpacity={0.02}
                    />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray='3 3'
                  vertical={false}
                  stroke='var(--border)'
                />
                <XAxis
                  dataKey='start'
                  ticks={xTicks}
                  interval={0}
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={12}
                  tickFormatter={(value) =>
                    formatBucketTick(String(value), dashboard.period)
                  }
                />
                <YAxis
                  yAxisId='tokens'
                  hide={!axisSides.tokens}
                  orientation={axisSides.tokens ?? 'left'}
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  width={axisSides.tokens ? 48 : 0}
                  allowDecimals={false}
                  tickFormatter={(value) => formatCompact(Number(value))}
                />
                <YAxis
                  yAxisId='billing'
                  hide={!axisSides.billing}
                  orientation={axisSides.billing ?? 'right'}
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  width={axisSides.billing ? 48 : 0}
                  tickFormatter={(value) => formatCompactUsd(Number(value))}
                />
                <YAxis yAxisId='requests' hide />
                <Tooltip
                  content={TrendTooltip}
                  cursor={{ stroke: 'var(--border)', strokeDasharray: '3 3' }}
                />
                <Bar
                  yAxisId='billing'
                  dataKey='billing'
                  name='计费'
                  fill='var(--chart-2)'
                  radius={[3, 3, 0, 0]}
                  hide={hiddenSeries.has('billing')}
                  maxBarSize={18}
                />
                <Area
                  yAxisId='tokens'
                  dataKey='tokens'
                  name='Tokens'
                  type='monotone'
                  stroke='var(--chart-1)'
                  strokeWidth={1.5}
                  fill='url(#public-usage-tokens-fill)'
                  hide={hiddenSeries.has('tokens')}
                  dot={false}
                  activeDot={{ r: 3 }}
                />
                <Line
                  yAxisId='requests'
                  dataKey='requests'
                  name='请求'
                  type='monotone'
                  stroke='var(--chart-3)'
                  strokeWidth={1.25}
                  strokeDasharray='5 4'
                  hide={hiddenSeries.has('requests')}
                  dot={false}
                  activeDot={{ r: 3 }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className='flex flex-wrap items-center justify-center gap-x-4 gap-y-2 pt-3 text-xs text-muted-foreground'>
            {TREND_SERIES.map((series) => {
              const hidden = hiddenSeries.has(series)
              return (
                <button
                  key={series}
                  type='button'
                  className={cn(
                    'flex items-center gap-1.5 rounded-md px-2 py-1 transition-opacity hover:bg-accent',
                    hidden && 'opacity-35'
                  )}
                  onClick={() => toggleSeries(series)}
                  aria-pressed={!hidden}
                >
                  <span
                    className={cn(
                      'h-2 w-3 shrink-0 border-t-2',
                      series === 'billing' && 'rounded-[2px] border-0 bg-[var(--chart-2)]',
                      series === 'tokens' && 'border-[var(--chart-1)]',
                      series === 'requests' &&
                        'border-dashed border-[var(--chart-3)]'
                    )}
                  />
                  {series === 'billing'
                    ? '计费'
                    : series === 'tokens'
                      ? 'Tokens'
                      : '请求'}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </TitledCard>
  )
}

function TrendTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: Array<{
    payload?: {
      tooltipLabel?: string
      requests?: number
      tokens?: number
      billing?: number
    }
  }>
}) {
  const point = payload?.[0]?.payload
  if (!active || !point) return null
  return (
    <div className='rounded-xl border bg-popover px-3 py-2 text-xs shadow-sm'>
      <div className='mb-1.5 text-muted-foreground'>
        {point.tooltipLabel ?? '—'}
      </div>
      <div className='space-y-1 tabular-nums'>
        <div>请求 {formatNumber(point.requests ?? 0, 0)}</div>
        <div>Tokens {formatNumber(point.tokens ?? 0, 0)}</div>
        <div>计费 {formatUsdValue(point.billing ?? 0)}</div>
      </div>
    </div>
  )
}

function ProviderDistribution({
  dashboard,
  ready,
  loading,
}: {
  dashboard: PublicUpstreamUsageOverview
  ready: boolean
  loading: boolean
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const providers = useMemo(
    () =>
      PROVIDERS.map((provider) => {
        const usage = dashboard.providers.find(
          (item) => item.provider === provider.key
        )
        return {
          ...provider,
          requests: usage?.requests ?? 0,
          successfulRequests: usage?.successfulRequests ?? 0,
          tokens: usage?.tokens ?? 0,
        }
      }),
    [dashboard.providers]
  )
  const totalRequests = providers.reduce((sum, item) => sum + item.requests, 0)
  const totalSuccessful = providers.reduce(
    (sum, item) => sum + item.successfulRequests,
    0
  )
  const averageSuccessRate =
    totalRequests > 0 ? (totalSuccessful / totalRequests) * 100 : 0
  const stripes = useMemo(
    () => buildProviderStripes(providers, totalRequests),
    [providers, totalRequests]
  )
  const hovered = hoverIndex == null ? null : stripes[hoverIndex]
  const hoveredShare =
    hovered && totalRequests > 0 ? (hovered.requests / totalRequests) * 100 : 0

  return (
    <TitledCard
      icon={<BarChart3 />}
      iconTone='violet'
      title='渠道分布'
      description={
        loading
          ? '读取中'
          : ready
            ? hovered
              ? `${hovered.label} ${formatNumber(hovered.requests, 0)} · ${formatNumber(hoveredShare, 1)}%`
              : `成功率 ${formatNumber(averageSuccessRate, 1)}%`
            : '按请求量统计'
      }
      className='h-full min-h-[360px]'
      contentClassName='flex flex-1 flex-col'
    >
      {loading ? (
        <Skeleton className='h-[260px] w-full rounded-xl' />
      ) : (
        <div className='flex flex-1 flex-col'>
          <div
            className='flex h-12 cursor-default items-stretch gap-1'
            onPointerMove={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect()
              const position = Math.min(
                0.999,
                Math.max(0, (event.clientX - bounds.left) / Math.max(1, bounds.width))
              )
              setHoverIndex(Math.floor(position * STRIPE_COUNT))
            }}
            onPointerLeave={() => setHoverIndex(null)}
          >
            {stripes.map((provider, index) => (
              <span
                key={index}
                className={cn(
                  'min-w-0 flex-1 rounded-[2px] transition-[transform,opacity] duration-150',
                  hoverIndex === index && '-translate-y-1 opacity-75',
                  provider ? provider.color : 'bg-muted'
                )}
              />
            ))}
          </div>
          <div className='mt-3 grid flex-1 grid-rows-3 divide-y'>
            {providers.map((provider) => {
              const share =
                totalRequests > 0 ? (provider.requests / totalRequests) * 100 : 0
              const successRate =
                provider.requests > 0
                  ? (provider.successfulRequests / provider.requests) * 100
                  : 0
              return (
                <div
                  key={provider.key}
                  className='flex min-h-16 items-center justify-between gap-4 py-3 first:pt-0 last:pb-0'
                >
                  <div className='flex min-w-0 items-center gap-2.5'>
                    <span
                      className={cn('size-2 shrink-0 rounded-full', provider.dot)}
                    />
                    <div className='min-w-0'>
                      <p className='truncate text-sm'>{provider.label}</p>
                      <p className='mt-0.5 truncate text-[11px] text-muted-foreground'>
                        成功率 {formatNumber(successRate, 1)}% · Tokens{' '}
                        {formatNumber(provider.tokens, 0)}
                      </p>
                    </div>
                  </div>
                  <div className='shrink-0 text-right'>
                    <p className='text-sm font-medium tabular-nums'>
                      {ready ? formatNumber(provider.requests, 0) : '—'}
                    </p>
                    <p className='mt-0.5 text-[11px] tabular-nums text-muted-foreground'>
                      {ready ? `${formatNumber(share, 1)}%` : '—'}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </TitledCard>
  )
}

function TopModels({
  dashboard,
  ready,
  loading,
}: {
  dashboard: PublicUpstreamUsageOverview
  ready: boolean
  loading: boolean
}) {
  const models = dashboard.topModels
  return (
    <TitledCard
      icon={<WholeWord />}
      iconTone='emerald'
      title='热门模型'
      description='按请求量排序'
      className='h-full'
      contentClassName='overflow-x-auto p-0'
    >
      <Table className='min-w-[520px]'>
        <TableHeader>
          <TableRow className='hover:bg-transparent'>
            <TableHead>模型</TableHead>
            <TableHead className='w-28 text-right'>计费</TableHead>
            <TableHead className='w-28 text-right'>Tokens</TableHead>
            <TableHead className='w-24 text-right'>请求</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            Array.from({ length: 4 }, (_, index) => (
              <TableRow key={index} className='hover:bg-transparent'>
                <TableCell colSpan={4}>
                  <Skeleton className='h-8 w-full' />
                </TableCell>
              </TableRow>
            ))
          ) : !ready || models.length === 0 ? (
            <TableRow className='hover:bg-transparent'>
              <TableCell colSpan={4} className='p-0'>
                <EmptyState
                  compact
                  icon={WholeWord}
                  title='暂无模型统计'
                  description='所选时间窗口还没有模型请求。'
                  className='border-0 bg-transparent'
                />
              </TableCell>
            </TableRow>
          ) : (
            models.map((item) => {
              const inactive = item.requests === 0
              const details = [
                `输入 ${formatNumber(item.inputTokens, 0)}`,
                `输出 ${formatNumber(item.outputTokens, 0)}`,
                item.cachedInputTokens > 0
                  ? `缓存 ${formatNumber(item.cachedInputTokens, 0)}`
                  : null,
                item.reasoningTokens > 0
                  ? `推理 ${formatNumber(item.reasoningTokens, 0)}`
                  : null,
              ].filter(Boolean)
              return (
                <TableRow key={item.model} className='h-14'>
                  <TableCell>
                    <span
                      className={cn(
                        'block truncate text-xs font-medium',
                        inactive && 'font-normal text-muted-foreground'
                      )}
                      title={item.model}
                    >
                      {item.model}
                    </span>
                    <p className='mt-1 truncate text-[10px] text-muted-foreground/80'>
                      {details.join(' · ')}
                    </p>
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-right text-xs font-medium tabular-nums text-emerald-600 dark:text-emerald-400',
                      item.billedCostUsdTicks === 0 &&
                        'font-normal text-muted-foreground'
                    )}
                  >
                    {formatUsd(item.billedCostUsdTicks)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-right text-xs font-medium tabular-nums text-violet-600 dark:text-violet-400',
                      item.tokens === 0 && 'font-normal text-muted-foreground'
                    )}
                  >
                    {formatCompactTokens(item.tokens)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-right text-xs font-medium tabular-nums text-sky-600 dark:text-sky-400',
                      inactive && 'font-normal text-muted-foreground'
                    )}
                  >
                    {formatNumber(item.requests, 0)}
                  </TableCell>
                </TableRow>
              )
            })
          )}
        </TableBody>
      </Table>
    </TitledCard>
  )
}

function ActivityHeatmap({
  dashboard,
  ready,
  loading,
}: {
  dashboard: PublicUpstreamUsageOverview
  ready: boolean
  loading: boolean
}) {
  const [hover, setHover] = useState<{ start: string; requests: number } | null>(
    null
  )
  const activity = dashboard.activity
  const weeks = useMemo(
    () =>
      Array.from({ length: Math.ceil(activity.length / 7) }, (_, index) =>
        activity.slice(index * 7, index * 7 + 7)
      ),
    [activity]
  )
  const maxRequests = Math.max(0, ...activity.map((point) => point.requests))
  const totalRequests = activity.reduce((sum, point) => sum + point.requests, 0)
  const generatedAt = dashboard.generatedAt
    ? new Date(dashboard.generatedAt).getTime()
    : Number.POSITIVE_INFINITY
  const rangeLabel = formatActivityRange(activity, generatedAt)

  return (
    <TitledCard
      icon={<Activity />}
      iconTone='amber'
      title='近 180 天活跃'
      description={
        hover
          ? `${formatActivityDate(hover.start)} · ${formatNumber(hover.requests, 0)} 次请求`
          : '按天统计请求量'
      }
      className='h-full min-h-[210px]'
    >
      {loading ? (
        <Skeleton className='h-32 w-full rounded-xl' />
      ) : !ready || activity.length === 0 ? (
        <EmptyState
          compact
          icon={Activity}
          title='暂无活跃数据'
          description='还没有足够的历史请求来绘制热力图。'
          className='border-0 bg-transparent'
        />
      ) : (
        <div>
          <div className='flex items-baseline justify-between gap-3'>
            <p className='text-xl font-medium tabular-nums'>
              {formatNumber(totalRequests, 0)}
            </p>
            <p className='text-[11px] text-muted-foreground'>{rangeLabel}</p>
          </div>
          <div className='mt-4 w-full pb-1'>
            <div className='flex w-full gap-1'>
              {weeks.map((week, weekIndex) => (
                <div
                  key={weekIndex}
                  className='grid min-w-0 flex-1 grid-rows-7 gap-1'
                >
                  {week.map((point) => {
                    const future =
                      new Date(point.start).getTime() > generatedAt
                    return (
                      <span
                        key={point.start}
                        className={cn(
                          'aspect-square w-full rounded-[3px]',
                          future
                            ? 'bg-muted/40'
                            : INTENSITY_CLASSES[
                                activityLevel(point.requests, maxRequests)
                              ]
                        )}
                        onPointerEnter={() => setHover(point)}
                        onPointerLeave={() => setHover(null)}
                      />
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
          <div className='mt-3 flex items-center justify-end gap-1.5 text-[10px] text-muted-foreground'>
            <span>少</span>
            {INTENSITY_CLASSES.map((className) => (
              <span
                key={className}
                className={cn('size-2.5 rounded-[2px]', className)}
              />
            ))}
            <span>多</span>
          </div>
        </div>
      )}
    </TitledCard>
  )
}

function buildProviderStripes<T extends { requests: number }>(
  providers: T[],
  totalRequests: number
): Array<T | null> {
  if (totalRequests <= 0) return Array.from({ length: STRIPE_COUNT }, () => null)
  const boundaries: number[] = []
  let cumulative = 0
  for (const provider of providers) {
    cumulative += provider.requests
    boundaries.push(cumulative / totalRequests)
  }
  return Array.from({ length: STRIPE_COUNT }, (_, index) => {
    const position = (index + 0.5) / STRIPE_COUNT
    const providerIndex = boundaries.findIndex((boundary) => position <= boundary)
    return providers[providerIndex >= 0 ? providerIndex : providers.length - 1] ?? null
  })
}

function resolveTrendAxes(
  hiddenSeries: ReadonlySet<TrendSeries>
): Partial<Record<TrendSeries, 'left' | 'right'>> {
  const visible = TREND_SERIES.filter((series) => !hiddenSeries.has(series))
  if (visible.length === 3) return { tokens: 'left', billing: 'right' }
  if (visible.length === 2) {
    if (visible.includes('tokens')) {
      return {
        tokens: 'left',
        [visible.includes('billing') ? 'billing' : 'requests']: 'right',
      }
    }
    return { requests: 'left', billing: 'right' }
  }
  return visible.length === 1 ? { [visible[0]]: 'left' } : {}
}

function shouldShowTick(
  index: number,
  count: number,
  period: PublicUpstreamUsagePeriod
) {
  const step = period === '24h' ? 3 : period === '30d' ? 5 : 1
  return index % step === 0 || index === count - 1
}

function formatBucketTick(value: string, period: PublicUpstreamUsagePeriod) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: TIMEZONE,
    ...(period === '24h'
      ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' as const }
      : { month: 'numeric', day: 'numeric' }),
  }).format(date)
}

function formatBucketRange(
  startValue: string,
  endValue: string,
  period: PublicUpstreamUsagePeriod
) {
  if (period === '24h') {
    return `${formatBucketTick(startValue, period)}–${formatBucketTick(endValue, period)}`
  }
  if (period === '90d') {
    const end = new Date(endValue)
    const inclusive = Number.isNaN(end.getTime())
      ? endValue
      : formatBucketTick(
          new Date(end.getTime() - 1).toISOString(),
          period
        )
    return `${formatBucketTick(startValue, period)}–${inclusive}`
  }
  return formatBucketTick(startValue, period)
}

function activityLevel(value: number, maximum: number) {
  if (value <= 0 || maximum <= 0) return 0
  const ratio = Math.log1p(value) / Math.log1p(maximum)
  if (ratio <= 0.25) return 1
  if (ratio <= 0.5) return 2
  if (ratio <= 0.75) return 3
  return 4
}

function formatActivityDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: TIMEZONE,
    month: 'short',
    day: 'numeric',
  }).format(new Date(value))
}

function formatActivityRange(
  activity: PublicUpstreamUsageOverview['activity'],
  generatedAt: number
) {
  if (activity.length === 0) return '—'
  let lastVisible = activity[0]
  for (let index = activity.length - 1; index >= 0; index -= 1) {
    if (new Date(activity[index].start).getTime() <= generatedAt) {
      lastVisible = activity[index]
      break
    }
  }
  return `${formatActivityDate(activity[0].start)} – ${formatActivityDate(lastVisible.start)}`
}

function formatUsd(ticks: number) {
  return formatUsdValue(ticks / USD_TICKS)
}

function formatUsdValue(value: number) {
  return `$${new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)}`
}

function formatCompact(value: number) {
  return new Intl.NumberFormat('zh-CN', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)
}

function formatCompactUsd(value: number) {
  return `$${new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)}`
}

function formatCompactTokens(value: number) {
  const absolute = Math.abs(value)
  if (absolute < 10_000) return formatNumber(value, 0)
  const units = [
    { threshold: 1_000_000_000, suffix: 'B' },
    { threshold: 1_000_000, suffix: 'M' },
    { threshold: 1_000, suffix: 'K' },
  ]
  const unit = units.find((candidate) => absolute >= candidate.threshold)
  if (!unit) return formatNumber(value, 0)
  const compact = value / unit.threshold
  const digits = Math.abs(compact) < 10 && !Number.isInteger(compact) ? 1 : 0
  return `${formatNumber(compact, digits)}${unit.suffix}`
}

function formatDurationMs(milliseconds: number) {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`
  return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 2 : 1)} s`
}
