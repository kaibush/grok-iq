import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  CircleDollarSign,
  Gauge,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react'
import {
  api,
  type ManagedClientKeyUsagePeriod,
  type ManagedClientKeyUsageSummary,
} from '@/lib/api'
import { formatDate, formatNumber, getErrorMessage } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EmptyState, LoadingState } from '@/components/page'

const USD_TICKS = 10_000_000_000
const PERIODS: { value: ManagedClientKeyUsagePeriod; label: string }[] = [
  { value: '1h', label: '1小时' },
  { value: '6h', label: '6小时' },
  { value: '24h', label: '24小时' },
  { value: '7d', label: '7天' },
  { value: '30d', label: '30天' },
  { value: '90d', label: '90天' },
  { value: 'custom', label: '自定义' },
]

type ClientKeyUsageDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedIds: string[]
  names: Record<string, string>
}

type QuerySpec = {
  ids: string[]
  period: ManagedClientKeyUsagePeriod
  start?: string
  end?: string
}

function pad(value: number) {
  return String(value).padStart(2, '0')
}

function toLocalInput(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function toIso(local: string) {
  if (!local.trim()) return ''
  const date = new Date(local)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString()
}

function formatUsdTicks(ticks: number, digits = 4) {
  return `$${formatNumber(ticks / USD_TICKS, digits)}`
}

function providerLabel(value: string) {
  if (value === 'grok_build') return 'Build'
  if (value === 'grok_web') return 'Web'
  if (value === 'grok_console') return 'Console'
  return value
}

export function ClientKeyUsageDialog({
  open,
  onOpenChange,
  selectedIds,
  names,
}: ClientKeyUsageDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <ClientKeyUsageDialogBody
          key={selectedIds.join(',')}
          selectedIds={selectedIds}
          names={names}
        />
      ) : null}
    </Dialog>
  )
}

function ClientKeyUsageDialogBody({
  selectedIds,
  names,
}: Pick<ClientKeyUsageDialogProps, 'selectedIds' | 'names'>) {
  const [period, setPeriod] = useState<ManagedClientKeyUsagePeriod>('24h')
  const [customStart, setCustomStart] = useState(() =>
    toLocalInput(new Date(Date.now() - 24 * 60 * 60 * 1000))
  )
  const [customEnd, setCustomEnd] = useState(() => toLocalInput(new Date()))
  const [queried, setQueried] = useState<QuerySpec | null>(() =>
    selectedIds.length > 0 ? { ids: [...selectedIds], period: '24h' } : null
  )
  const customError =
    period === 'custom' && (!toIso(customStart) || !toIso(customEnd))
      ? '请填写自定义开始和结束时间'
      : ''

  const summaryQuery = useQuery({
    queryKey: ['client-keys', 'usage-summary', queried],
    queryFn: () =>
      api.clientKeyUsageSummary({
        ids: queried?.ids ?? [],
        period: queried?.period ?? '24h',
        start: queried?.start,
        end: queried?.end,
      }),
    enabled: Boolean(queried && queried.ids.length > 0),
  })

  const summary = summaryQuery.data
  const selectedNames = selectedIds.map(
    (id) => names[id] || summary?.keys.find((row) => row.id === id)?.name || id
  )

  function queryNow() {
    if (selectedIds.length === 0 || customError) return
    setQueried({
      ids: [...selectedIds],
      period,
      start: period === 'custom' ? toIso(customStart) : undefined,
      end: period === 'custom' ? toIso(customEnd) : undefined,
    })
  }

  return (
    <DialogContent
      size='wide'
      className='flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0'
    >
      <DialogHeader className='shrink-0 space-y-3 px-5 py-4 pr-12'>
        <div className='flex flex-wrap items-start justify-between gap-3'>
          <div>
            <DialogTitle>密钥用量</DialogTitle>
            <DialogDescription>
              查看已选 {formatNumber(selectedIds.length, 0)} 个密钥在 grok2api
              的请求、花费和剩余额度。
            </DialogDescription>
          </div>
          <Button
            type='button'
            size='sm'
            disabled={
              summaryQuery.isFetching ||
              selectedIds.length === 0 ||
              Boolean(customError)
            }
            onClick={queryNow}
          >
            {summaryQuery.isFetching ? (
              <RefreshCw className='animate-spin' />
            ) : (
              <RefreshCw />
            )}
            查询
          </Button>
        </div>
        <Tabs
          value={period}
          onValueChange={(value) =>
            setPeriod(value as ManagedClientKeyUsagePeriod)
          }
        >
          <TabsList className='h-auto max-w-full flex-wrap'>
            {PERIODS.map((item) => (
              <TabsTrigger key={item.value} value={item.value}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {period === 'custom' ? (
          <div className='grid gap-3 sm:grid-cols-2'>
            <div className='space-y-1.5'>
              <Label htmlFor='client-key-usage-start'>开始时间</Label>
              <Input
                id='client-key-usage-start'
                type='datetime-local'
                value={customStart}
                onChange={(event) => setCustomStart(event.target.value)}
              />
            </div>
            <div className='space-y-1.5'>
              <Label htmlFor='client-key-usage-end'>结束时间</Label>
              <Input
                id='client-key-usage-end'
                type='datetime-local'
                value={customEnd}
                onChange={(event) => setCustomEnd(event.target.value)}
              />
            </div>
          </div>
        ) : null}
        {selectedNames.length > 0 ? (
          <div className='flex flex-wrap gap-1.5'>
            {selectedNames.slice(0, 8).map((name, index) => (
              <Badge
                key={`${selectedIds[index]}-${name}`}
                variant='secondary'
                className='max-w-40 truncate'
                title={name}
              >
                {name}
              </Badge>
            ))}
            {selectedNames.length > 8 ? (
              <Badge variant='outline'>
                还有 {formatNumber(selectedNames.length - 8, 0)} 个
              </Badge>
            ) : null}
          </div>
        ) : null}
        {customError ? (
          <p className='text-sm text-destructive'>{customError}</p>
        ) : null}
      </DialogHeader>
      <div className='min-h-0 flex-1 overflow-auto px-5 pb-5'>
        {!queried ? (
          <EmptyState
            compact
            title='选择周期后查询用量'
            description='支持 1 小时到 90 天，或自定义时间范围。'
            className='border-0 bg-transparent'
          />
        ) : summaryQuery.isError ? (
          <p className='py-6 text-sm text-destructive'>
            用量读取失败：{getErrorMessage(summaryQuery.error)}
          </p>
        ) : summaryQuery.isPending ? (
          <LoadingState label='正在加载密钥用量' />
        ) : summary ? (
          <UsageSummaryBody summary={summary} names={names} />
        ) : null}
      </div>
    </DialogContent>
  )
}

function UsageSummaryBody({
  summary,
  names,
}: {
  summary: ManagedClientKeyUsageSummary
  names: Record<string, string>
}) {
  const total = summary.total
  const peakRpm = useMemo(
    () => summary.keys.reduce((max, row) => Math.max(max, row.peakRpm || 0), 0),
    [summary.keys]
  )
  const remaining = useMemo(() => {
    const limited = summary.keys.filter((row) => row.billingLimitUsdTicks > 0)
    return {
      limitedCount: limited.length,
      remainingTicks: limited.reduce(
        (sum, row) => sum + Math.max(0, row.quotaRemainingUsdTicks || 0),
        0
      ),
    }
  }, [summary.keys])

  return (
    <div className='space-y-4'>
      <p className='text-xs text-muted-foreground'>
        {formatDate(summary.start)} – {formatDate(summary.end)}
        {summary.missing > 0
          ? ` · ${formatNumber(summary.missing, 0)} 个密钥未找到`
          : ''}
      </p>
      <div className='grid gap-2 sm:grid-cols-2 xl:grid-cols-5'>
        <MetricCard
          icon={Gauge}
          label='请求'
          value={formatNumber(total.requests, 0)}
          detail={`成功 ${formatNumber(total.successfulRequests, 0)} · 失败 ${formatNumber(total.failedRequests, 0)}`}
        />
        <MetricCard
          icon={Activity}
          label='成功'
          value={formatNumber(total.successfulRequests, 0)}
          detail={`峰值 RPM ${formatNumber(peakRpm, 0)}`}
        />
        <MetricCard
          icon={ShieldAlert}
          label='失败'
          value={formatNumber(total.failedRequests, 0)}
          detail={
            total.requests > 0
              ? `成功率 ${formatNumber(total.successRate, 1)}%`
              : '暂无请求'
          }
        />
        <MetricCard
          icon={CircleDollarSign}
          label='花费'
          value={formatUsdTicks(total.billedCostUsdTicks)}
          detail={`估算 ${formatUsdTicks(total.estimatedCostUsdTicks)}`}
        />
        <MetricCard
          icon={CircleDollarSign}
          label='成功率'
          value={
            total.requests > 0 ? `${formatNumber(total.successRate, 1)}%` : '—'
          }
          detail={
            remaining.limitedCount > 0
              ? `剩余额度 ${formatUsdTicks(remaining.remainingTicks)}`
              : '所选密钥不限额'
          }
        />
      </div>
      <div className='grid gap-3 lg:grid-cols-3'>
        <BreakdownList
          title='模型'
          empty='这段时间没有模型用量'
          items={summary.models.map((item) => ({
            name: item.name,
            requests: item.requests,
            billed: item.billedCostUsdTicks,
          }))}
        />
        <BreakdownList
          title='通道'
          empty='这段时间没有通道用量'
          items={summary.providers.map((item) => ({
            name: providerLabel(item.name),
            requests: item.requests,
            billed: item.billedCostUsdTicks,
          }))}
        />
        <ErrorList items={summary.errors} />
      </div>
      <UsageTable rows={summary.keys} names={names} peakRpm={peakRpm} />
    </div>
  )
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof CircleDollarSign
  label: string
  value: string
  detail: string
}) {
  return (
    <article className='rounded-xl border bg-card px-3 py-2.5'>
      <header className='flex items-center justify-between gap-2'>
        <span className='truncate text-[11px] text-muted-foreground'>
          {label}
        </span>
        <Icon className='size-3.5 shrink-0 text-muted-foreground' />
      </header>
      <div className='mt-1 text-lg font-medium tracking-tight tabular-nums'>
        {value}
      </div>
      <p className='mt-0.5 truncate text-[11px] text-muted-foreground' title={detail}>
        {detail}
      </p>
    </article>
  )
}

function BreakdownList({
  title,
  empty,
  items,
}: {
  title: string
  empty: string
  items: Array<{ name: string; requests: number; billed: number }>
}) {
  return (
    <section className='min-w-0 rounded-xl border bg-card p-3'>
      <h3 className='mb-2 text-sm font-medium'>{title}</h3>
      {items.length === 0 ? (
        <p className='py-6 text-center text-xs text-muted-foreground'>{empty}</p>
      ) : (
        <ul className='divide-y'>
          {items.slice(0, 8).map((item) => (
            <li
              key={item.name}
              className='flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0'
            >
              <div className='min-w-0 truncate' title={item.name}>
                {item.name}
              </div>
              <div className='shrink-0 text-right text-xs tabular-nums text-muted-foreground'>
                <div>{formatNumber(item.requests, 0)} 次</div>
                <div>{formatUsdTicks(item.billed)}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ErrorList({
  items,
}: {
  items: ManagedClientKeyUsageSummary['errors']
}) {
  return (
    <section className='min-w-0 rounded-xl border bg-card p-3'>
      <h3 className='mb-2 text-sm font-medium'>错误</h3>
      {items.length === 0 ? (
        <p className='py-6 text-center text-xs text-muted-foreground'>
          这段时间没有错误码
        </p>
      ) : (
        <ul className='divide-y'>
          {items.slice(0, 8).map((item) => (
            <li
              key={item.code}
              className='flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0'
            >
              <span className='min-w-0 truncate font-mono text-xs' title={item.code}>
                {item.code}
              </span>
              <span className='shrink-0 tabular-nums text-xs text-muted-foreground'>
                {formatNumber(item.requests, 0)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function UsageTable({
  rows,
  names,
  peakRpm,
}: {
  rows: ManagedClientKeyUsageSummary['keys']
  names: Record<string, string>
  peakRpm: number
}) {
  const totalRequests = rows.reduce((sum, row) => sum + row.requests, 0)
  const totalBilled = rows.reduce((sum, row) => sum + row.billedCostUsdTicks, 0)
  const remainingTicks = rows
    .filter((row) => row.billingLimitUsdTicks > 0)
    .reduce((sum, row) => sum + Math.max(0, row.quotaRemainingUsdTicks || 0), 0)
  const limitedCount = rows.filter((row) => row.billingLimitUsdTicks > 0).length

  return (
    <div className='overflow-hidden rounded-xl border'>
      <Table className='min-w-[720px] text-xs'>
        <TableHeader>
          <TableRow className='hover:bg-transparent'>
            <TableHead>名称</TableHead>
            <TableHead className='text-right'>请求</TableHead>
            <TableHead className='text-right'>花费</TableHead>
            <TableHead className='text-right'>剩余额度</TableHead>
            <TableHead className='text-right'>峰值 RPM</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow className='hover:bg-transparent'>
              <TableCell colSpan={5} className='p-0'>
                <EmptyState
                  compact
                  title='这段时间没有密钥用量'
                  description='换一个周期后再查一次。'
                  className='border-0 bg-transparent'
                />
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className='min-w-0'>
                  <span
                    className='block truncate font-medium'
                    title={names[row.id] || row.name}
                  >
                    {names[row.id] || row.name || '未命名'}
                  </span>
                  <span className='mt-0.5 block truncate font-mono text-[10px] text-muted-foreground'>
                    {row.prefix || row.id}
                  </span>
                </TableCell>
                <TableCell className='text-right tabular-nums'>
                  {formatNumber(row.requests, 0)}
                </TableCell>
                <TableCell className='text-right tabular-nums'>
                  {formatUsdTicks(row.billedCostUsdTicks)}
                </TableCell>
                <TableCell className='text-right tabular-nums'>
                  {row.billingLimitUsdTicks > 0
                    ? formatUsdTicks(row.quotaRemainingUsdTicks)
                    : '不限额'}
                </TableCell>
                <TableCell className='text-right tabular-nums'>
                  {formatNumber(row.peakRpm, 0)}
                </TableCell>
              </TableRow>
            ))
          )}
          {rows.length > 0 ? (
            <TableRow className='bg-muted/20 font-medium'>
              <TableCell>{formatNumber(rows.length, 0)} 个密钥</TableCell>
              <TableCell className='text-right tabular-nums'>
                {formatNumber(totalRequests, 0)}
              </TableCell>
              <TableCell className='text-right tabular-nums'>
                {formatUsdTicks(totalBilled)}
              </TableCell>
              <TableCell className='text-right tabular-nums'>
                {limitedCount > 0 ? formatUsdTicks(remainingTicks) : '不限额'}
              </TableCell>
              <TableCell className='text-right tabular-nums'>
                {formatNumber(peakRpm, 0)}
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  )
}
