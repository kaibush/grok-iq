import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  BarChart3,
  CalendarDays,
  Eye,
  RefreshCw,
  Search,
  Shield,
  Users,
} from 'lucide-react'
import {
  api,
  type AdminVisitAudienceFilter,
  type PublicVisitPeriod,
} from '@/lib/api'
import { formatDate, formatNumber, getErrorMessage } from '@/lib/utils'
import { usePersistedViewState } from '@/hooks/use-persisted-view-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ActionToolbar, ToolbarAction } from '@/components/action-toolbar'
import { EmptyState, LoadingState, Page, PageHeader } from '@/components/page'
import { SegmentedControl } from '@/components/segmented-control'
import { ServerPagination } from '@/components/server-pagination'
import { StatCard } from '@/components/stat-card'
import { TablePanel } from '@/components/table-panel'
import { TitledCard } from '@/components/titled-card'
import { visitDeviceLabel } from '@/features/monitor/components/status-visit-details-dialog'
import { VisitTrendChart } from '@/features/monitor/components/status-visit-stats'

const PERIOD_KEY = 'grokiq.monitor.page-visits-period.v1'
const PERIODS: Array<{ value: PublicVisitPeriod; label: string }> = [
  { value: '24h', label: '24 小时' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
  { value: '90d', label: '90 天' },
]
const AUDIENCE_OPTIONS: Array<{ value: AdminVisitAudienceFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'public', label: '公开访客' },
  { value: 'admin', label: '管理员' },
]
const DEVICE_OPTIONS = [
  { value: 'all', label: '全部设备' },
  { value: 'desktop', label: '桌面' },
  { value: 'mobile', label: '手机' },
  { value: 'tablet', label: '平板' },
  { value: 'other', label: '其他' },
] as const
const PAGE_SIZE_OPTIONS = [20, 50, 100]

export function PageVisitsPage() {
  const periodView = usePersistedViewState(PERIOD_KEY, { period: '24h' })
  const period = isVisitPeriod(periodView.value.period)
    ? periodView.value.period
    : '24h'
  const [audience, setAudience] = useState<AdminVisitAudienceFilter>('all')
  const [device, setDevice] = useState<(typeof DEVICE_OPTIONS)[number]['value']>('all')
  const [draftQuery, setDraftQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const todayWindow = period === '24h'

  const statsQuery = useQuery({
    queryKey: ['page-stats', 'details', period],
    queryFn: () => api.adminPageStats({ period, timezone: 'Asia/Shanghai' }),
    refetchInterval: 30_000,
    placeholderData: (previous) => previous,
  })
  const ledgerQuery = useQuery({
    queryKey: [
      'page-stats',
      'visits',
      period,
      page,
      pageSize,
      audience,
      device,
      appliedQuery,
    ],
    queryFn: () =>
      api.adminPageVisits({
        period,
        timezone: 'Asia/Shanghai',
        page,
        pageSize,
        audience,
        device: device === 'all' ? undefined : device,
        q: appliedQuery,
      }),
    placeholderData: (previous) => previous,
  })

  const stats = statsQuery.data
  const totals = stats?.totals
  const comparison = stats?.comparison
  const audienceTotals = stats?.audience
  const chartData = useMemo(() => stats?.series ?? [], [stats?.series])
  const referrers = stats?.referrers ?? []
  const paths = stats?.paths ?? []
  const devices = (stats?.devices ?? []).filter((item) => item.pv > 0)
  const ledger = ledgerQuery.data
  const rows = ledger?.items ?? []
  const statsError = statsQuery.isError ? getErrorMessage(statsQuery.error) : ''
  const ledgerError = ledgerQuery.isError ? getErrorMessage(ledgerQuery.error) : ''
  const statsLoading = statsQuery.isPending && !statsQuery.data
  const ledgerLoading = ledgerQuery.isPending && !ledgerQuery.data

  function changePeriod(next: PublicVisitPeriod) {
    periodView.setValue({ period: next })
    setPage(1)
  }

  function submitSearch() {
    setAppliedQuery(draftQuery.trim())
    setPage(1)
  }

  return (
    <Page>
      <PageHeader
        title='页面访问'
        description='状态页浏览量、独立访客和访问流水。不记录 IP，管理员刷新不计入公开统计。'
        actions={
          <div className='flex flex-wrap items-center justify-end gap-2'>
            <SegmentedControl
              ariaLabel='页面访问时间范围'
              value={period}
              onChange={changePeriod}
              options={PERIODS}
            />
            <ActionToolbar label='页面访问操作'>
              <ToolbarAction
                label='刷新页面访问'
                pending={statsQuery.isFetching || ledgerQuery.isFetching}
                onClick={() => {
                  void statsQuery.refetch()
                  void ledgerQuery.refetch()
                }}
              >
                <RefreshCw />
              </ToolbarAction>
            </ActionToolbar>
          </div>
        }
      />

      {statsError ? (
        <Card className='border-destructive/30 bg-destructive/5'>
          <CardContent className='p-4 text-sm text-destructive'>
            访问统计读取失败：{statsError}
          </CardContent>
        </Card>
      ) : null}

      <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-4'>
        <StatCard
          compact
          label='浏览量'
          value={totals ? formatNumber(totals.pv, 0) : '—'}
          detail={deltaLabel(comparison?.pvDelta, '公开打开次数')}
          icon={Eye}
          tone='sky'
          loading={statsLoading}
          index={0}
        />
        <StatCard
          compact
          label='独立访客'
          value={totals ? formatNumber(totals.uv, 0) : '—'}
          detail={deltaLabel(comparison?.uvDelta, '公开去重访客')}
          icon={Users}
          tone='emerald'
          loading={statsLoading}
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
          loading={statsLoading}
          index={2}
        />
        <StatCard
          compact
          label='管理员自刷新'
          value={
            audienceTotals
              ? formatNumber(audienceTotals.admin.pv, 0)
              : '—'
          }
          detail={
            audienceTotals
              ? `${formatNumber(audienceTotals.admin.uv, 0)} 个浏览器`
              : '不计入公开统计'
          }
          icon={Shield}
          tone='violet'
          loading={statsLoading}
          index={3}
        />
      </div>

      <TitledCard
        icon={<Eye />}
        iconTone='sky'
        title='访问趋势'
        description='公开访客的浏览量与独立访客'
      >
        {statsLoading ? (
          <LoadingState label='正在加载访问趋势' />
        ) : chartData.length === 0 || (totals?.pv ?? 0) === 0 ? (
          <EmptyState
            compact
            icon={Eye}
            title='还没有公开访问'
            description='这个时间窗口还没有计入公开统计的浏览。'
            className='border-0 bg-transparent'
          />
        ) : (
          <VisitTrendChart
            data={chartData}
            peakLabel={
              stats?.peak
                ? `峰值 ${stats.peak.label} · 浏览 ${formatNumber(stats.peak.pv, 0)}`
                : undefined
            }
          />
        )}
      </TitledCard>

      <div className='grid gap-4 xl:grid-cols-2'>
        <TitledCard title='来源' description='按来源域名聚合'>
          <VisitStatTable
            nameHeader='来源'
            empty='暂无来源数据'
            loading={statsLoading}
            rows={referrers.map((item) => ({
              key: item.host || item.label || 'direct',
              name: item.label || item.host || '直接访问',
              pv: item.pv,
              uv: item.uv,
            }))}
          />
        </TitledCard>
        <TitledCard title='路径' description='状态页及相关路径'>
          <VisitStatTable
            nameHeader='路径'
            empty='暂无路径数据'
            loading={statsLoading}
            rows={paths.map((item) => ({
              key: item.path,
              name: item.path || '/',
              pv: item.pv,
              uv: item.uv,
            }))}
          />
        </TitledCard>
      </div>

      {devices.length > 0 ? (
        <div className='flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground'>
          {devices.map((item) => (
            <span
              key={item.id}
              className='rounded-full bg-muted/70 px-2 py-0.5 tabular-nums'
            >
              {visitDeviceLabel(item)} {formatNumber(item.pv, 0)}
            </span>
          ))}
        </div>
      ) : null}

      <TablePanel
        toolbar={
          <div className='flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between'>
            <div className='flex flex-wrap items-center gap-2'>
              <SegmentedControl
                ariaLabel='访问对象'
                value={audience}
                onChange={(value) => {
                  setAudience(value)
                  setPage(1)
                }}
                options={AUDIENCE_OPTIONS}
              />
              <SegmentedControl
                ariaLabel='设备类型'
                value={device}
                onChange={(value) => {
                  setDevice(value)
                  setPage(1)
                }}
                options={[...DEVICE_OPTIONS]}
              />
            </div>
            <form
              className='flex min-w-0 items-center gap-2'
              onSubmit={(event) => {
                event.preventDefault()
                submitSearch()
              }}
            >
              <div className='relative min-w-0 flex-1'>
                <Search className='absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground' />
                <Input
                  value={draftQuery}
                  onChange={(event) => setDraftQuery(event.target.value)}
                  placeholder='路径或来源，回车搜索'
                  aria-label='搜索路径或来源'
                  className='ps-9'
                />
              </div>
              <Button type='submit' variant='outline' size='sm'>
                搜索
              </Button>
            </form>
          </div>
        }
        footer={
          <ServerPagination
            page={page}
            pageSize={pageSize}
            total={ledger?.total ?? 0}
            disabled={ledgerLoading}
            loading={ledgerQuery.isFetching}
            itemLabel='次访问'
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size)
              setPage(1)
            }}
          />
        }
      >
        {ledgerError ? (
          <p className='px-1 py-3 text-sm text-destructive'>
            访问流水读取失败：{ledgerError}
          </p>
        ) : ledgerLoading ? (
          <LoadingState label='正在加载访问流水' />
        ) : rows.length === 0 ? (
          <EmptyState
            compact
            icon={Eye}
            title='没有匹配的访问'
            description='调整时间范围、对象或搜索词后再看。'
            className='border-0 bg-transparent'
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className='hover:bg-transparent'>
                <TableHead>时间</TableHead>
                <TableHead>路径</TableHead>
                <TableHead>来源</TableHead>
                <TableHead>设备</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, index) => {
                const referrer = row.referrerHost || '直接访问'
                return (
                  <TableRow
                    key={`${row.visitedAt}:${row.path}:${index}`}
                    className='hover:bg-transparent'
                  >
                    <TableCell className='whitespace-nowrap text-muted-foreground'>
                      {formatDate(row.visitedAt)}
                    </TableCell>
                    <TableCell className='max-w-[18rem] truncate' title={row.path}>
                      {row.path || '/'}
                    </TableCell>
                    <TableCell className='max-w-[14rem] truncate' title={referrer}>
                      {referrer}
                    </TableCell>
                    <TableCell>
                      <span className='inline-flex items-center gap-1.5'>
                        {visitDeviceLabel(row.device)}
                        {row.isAdmin ? (
                          <Badge
                            variant='outline'
                            className='h-5 px-1.5 text-[10px]'
                          >
                            管理员
                          </Badge>
                        ) : null}
                      </span>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </TablePanel>
    </Page>
  )
}

function VisitStatTable({
  nameHeader,
  empty,
  loading,
  rows,
}: {
  nameHeader: string
  empty: string
  loading: boolean
  rows: Array<{ key: string; name: string; pv: number; uv: number }>
}) {
  if (loading) return <LoadingState label={`正在加载${nameHeader}`} />
  if (rows.length === 0) {
    return <p className='text-sm text-muted-foreground'>{empty}</p>
  }
  return (
    <Table>
      <TableHeader>
        <TableRow className='hover:bg-transparent'>
          <TableHead>{nameHeader}</TableHead>
          <TableHead className='w-16 text-right'>PV</TableHead>
          <TableHead className='w-16 text-right'>UV</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.key} className='hover:bg-transparent'>
            <TableCell className='max-w-[18rem] truncate' title={row.name}>
              {row.name}
            </TableCell>
            <TableCell className='text-right text-xs tabular-nums text-sky-600 dark:text-sky-400'>
              {formatNumber(row.pv, 0)}
            </TableCell>
            <TableCell className='text-right text-xs tabular-nums text-emerald-600 dark:text-emerald-400'>
              {formatNumber(row.uv, 0)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function deltaLabel(delta: number | undefined, fallback: string) {
  if (delta == null) return fallback
  if (delta === 0) return '较上期持平'
  const sign = delta > 0 ? '+' : ''
  return `较上期 ${sign}${formatNumber(delta, 0)}`
}

function isVisitPeriod(value: string): value is PublicVisitPeriod {
  return PERIODS.some((item) => item.value === value)
}
