import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BarChart3, CalendarDays, Eye, Users } from 'lucide-react'
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  api,
  type PublicVisitOverview,
  type PublicVisitPeriod,
  type PublicVisitSeriesPoint,
} from '@/lib/api'
import { formatNumber, getErrorMessage } from '@/lib/utils'
import { EmptyState } from '@/components/page'
import { SegmentedControl } from '@/components/segmented-control'
import { StatCard } from '@/components/stat-card'
import { TitledCard } from '@/components/titled-card'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  StatusVisitDetailsDialog,
  visitDeviceLabel,
} from '@/features/monitor/components/status-visit-details-dialog'

const PV_COLOR = 'rgb(14 165 233)'
const UV_COLOR = 'rgb(16 185 129)'
const PERIODS: Array<{ value: PublicVisitPeriod; label: string }> = [
  { value: '24h', label: '24 小时' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
  { value: '90d', label: '90 天' },
]

export function StatusVisitStats({
  period,
  onPeriodChange,
  data,
  loading,
  error,
  isAdmin,
}: {
  period: PublicVisitPeriod
  onPeriodChange: (period: PublicVisitPeriod) => void
  data?: PublicVisitOverview
  loading: boolean
  error?: string
  isAdmin: boolean
}) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const detailsQuery = useQuery({
    queryKey: ['page-stats', 'details', period],
    queryFn: () => api.adminPageStats({ period }),
    enabled: detailsOpen && isAdmin,
    staleTime: 15_000,
  })
  const totals = data?.totals
  const comparison = data?.comparison
  const isEmpty = !loading && !error && (totals?.pv ?? 0) === 0
  const devices = (data?.devices ?? []).filter((device) => device.pv > 0)
  const todayWindow = period === '24h'
  const chartData = useMemo(() => data?.series ?? [], [data?.series])
  const pvSpark = chartData.length > 1 ? chartData.map((point) => point.pv) : undefined
  const uvSpark = chartData.length > 1 ? chartData.map((point) => point.uv) : undefined

  return (
    <>
      <TitledCard
        icon={<Eye />}
        iconTone='sky'
        title='页面访问'
        description='状态页浏览量与独立访客'
        hint='PV 是打开次数，UV 是同一浏览器去重后的访客。不记录 IP，管理员刷新不计入公开统计。'
        action={
          <SegmentedControl
            ariaLabel='页面访问时间范围'
            value={period}
            onChange={onPeriodChange}
            options={PERIODS}
          />
        }
      >
        <div className='space-y-4'>
          {error ? (
            <Card className='border-destructive/30 bg-destructive/5'>
              <CardContent className='p-4 text-sm text-destructive'>
                访问统计读取失败：{error}
              </CardContent>
            </Card>
          ) : null}

          <div className='grid gap-4 sm:grid-cols-3'>
            <StatCard
              compact
              label='浏览量'
              value={totals ? formatNumber(totals.pv, 0) : '—'}
              detail={deltaLabel(comparison?.pvDelta, '本窗口打开次数')}
              icon={Eye}
              tone='sky'
              sparkline={pvSpark}
              loading={loading}
              index={0}
            />
            <StatCard
              compact
              label='独立访客'
              value={totals ? formatNumber(totals.uv, 0) : '—'}
              detail={deltaLabel(comparison?.uvDelta, '去重后的浏览器')}
              icon={Users}
              tone='emerald'
              sparkline={uvSpark}
              loading={loading}
              index={1}
            />
            <StatCard
              compact
              label={todayWindow ? '今日访客' : '日均浏览'}
              value={
                totals
                  ? todayWindow
                    ? formatNumber(totals.todayUv, 0)
                    : formatNumber(totals.avgDailyPv, 1)
                  : '—'
              }
              detail={
                todayWindow
                  ? `昨日 ${formatNumber(totals?.yesterdayUv ?? 0, 0)}`
                  : '窗口内日均 PV'
              }
              icon={todayWindow ? CalendarDays : BarChart3}
              tone={todayWindow ? 'emerald' : 'sky'}
              sparkline={todayWindow ? uvSpark : pvSpark}
              loading={loading}
              index={2}
            />
          </div>

          {loading ? (
            <Skeleton className='h-48 w-full rounded-xl' />
          ) : isEmpty ? (
            <EmptyState
              compact
              icon={Eye}
              title='还没有访问记录'
              description='这个时间窗口还没有公开访客。'
              className='border-0 bg-transparent'
            />
          ) : chartData.length > 0 ? (
            <VisitTrendChart
              data={chartData}
              peakLabel={
                data?.peak
                  ? `峰值 ${data.peak.label} · 浏览 ${formatNumber(data.peak.pv, 0)}`
                  : undefined
              }
            />
          ) : null}

          {isAdmin || (!isEmpty && devices.length > 0) ? (
            <div className='flex flex-wrap items-center justify-between gap-3'>
              {!isEmpty && devices.length > 0 ? (
                <div className='flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground'>
                  {devices.map((device) => (
                    <span
                      key={device.id}
                      className='rounded-full bg-muted/70 px-2 py-0.5 tabular-nums'
                    >
                      {visitDeviceLabel(device)} {formatNumber(device.pv, 0)}
                    </span>
                  ))}
                </div>
              ) : null}
              {isAdmin ? (
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  className='ms-auto'
                  onClick={() => setDetailsOpen(true)}
                >
                  访问明细
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </TitledCard>

      {isAdmin ? (
        <StatusVisitDetailsDialog
          open={detailsOpen}
          onOpenChange={setDetailsOpen}
          data={detailsQuery.data}
          loading={detailsQuery.isLoading}
          error={
            detailsQuery.isError
              ? getErrorMessage(detailsQuery.error)
              : undefined
          }
        />
      ) : null}
    </>
  )
}

function VisitTrendChart({
  data,
  peakLabel,
}: {
  data: PublicVisitSeriesPoint[]
  peakLabel?: string
}) {
  return (
    <div>
      <div className='h-48'>
        <ResponsiveContainer width='100%' height='100%'>
          <ComposedChart
            data={data}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          >
            <defs>
              <linearGradient
                id='status-visit-pv-fill'
                x1='0'
                y1='0'
                x2='0'
                y2='1'
              >
                <stop offset='5%' stopColor={PV_COLOR} stopOpacity={0.28} />
                <stop offset='95%' stopColor={PV_COLOR} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid
              strokeDasharray='3 3'
              vertical={false}
              stroke='var(--border)'
            />
            <XAxis
              dataKey='label'
              interval='preserveStartEnd'
              minTickGap={24}
              tick={{ fontSize: 11 }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              allowDecimals={false}
              tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
              tickLine={false}
              axisLine={false}
              width={32}
              tickFormatter={(value) => formatNumber(Number(value), 0)}
            />
            <Tooltip
              content={VisitTooltip}
              cursor={{ stroke: 'var(--border)', strokeDasharray: '3 3' }}
            />
            <Area
              dataKey='pv'
              name='浏览'
              type='monotone'
              stroke={PV_COLOR}
              strokeWidth={1.5}
              fill='url(#status-visit-pv-fill)'
              dot={false}
              activeDot={{ r: 3 }}
              isAnimationActive={false}
            />
            <Line
              dataKey='uv'
              name='访客'
              type='monotone'
              stroke={UV_COLOR}
              strokeWidth={1.75}
              dot={false}
              activeDot={{ r: 3 }}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className='flex flex-wrap items-center justify-center gap-x-4 gap-y-2 pt-2 text-xs text-muted-foreground'>
        <span className='inline-flex items-center gap-1.5'>
          <span
            className='size-2 rounded-[2px]'
            style={{ backgroundColor: PV_COLOR }}
          />
          浏览
        </span>
        <span className='inline-flex items-center gap-1.5'>
          <span
            className='size-2 rounded-[2px]'
            style={{ backgroundColor: UV_COLOR }}
          />
          访客
        </span>
        {peakLabel ? <span>{peakLabel}</span> : null}
      </div>
    </div>
  )
}

function VisitTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: readonly {
    payload?: PublicVisitSeriesPoint
  }[]
}) {
  const point = payload?.[0]?.payload
  if (!active || !point) return null
  return (
    <div className='rounded-xl border bg-popover px-3 py-2 text-xs shadow-sm'>
      <div className='mb-1.5 text-muted-foreground'>{point.label || '—'}</div>
      <div className='space-y-1 tabular-nums'>
        <div>浏览 {formatNumber(point.pv, 0)}</div>
        <div>访客 {formatNumber(point.uv, 0)}</div>
      </div>
    </div>
  )
}

function deltaLabel(delta: number | undefined, fallback: string) {
  if (delta == null) return fallback
  if (delta === 0) return '较上期持平'
  const sign = delta > 0 ? '+' : ''
  return `较上期 ${sign}${formatNumber(delta, 0)}`
}
