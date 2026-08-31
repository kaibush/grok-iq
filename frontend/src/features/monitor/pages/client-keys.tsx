import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, KeyRound, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  type ClientKey,
  type ClientKeyUsagePeriod,
} from '@/lib/api'
import { cn, formatDate, formatNumber, getErrorMessage } from '@/lib/utils'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ProgressBar } from '@/components/ui/progress'
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { EmptyState, LoadingState, Page, PageHeader } from '@/components/page'

const USD_TICKS = 10_000_000_000
const PAGE_SIZE = 50
const MAX_USAGE_KEYS = 50
const PERIODS = [
  { value: '24h', label: '24小时' },
  { value: '7d', label: '7天' },
  { value: '30d', label: '30天' },
  { value: '90d', label: '90天' },
  { value: 'custom', label: '自定义' },
] as const

type UsageRequest = {
  keyIds: string[]
  period: ClientKeyUsagePeriod
  start?: string
  end?: string
}

function pad(value: number) {
  return String(value).padStart(2, '0')
}

function toLocalInput(date: Date) {
  const year = date.getFullYear()
  const month = pad(date.getMonth() + 1)
  const day = pad(date.getDate())
  const hours = pad(date.getHours())
  const minutes = pad(date.getMinutes())
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

function toIso(local: string) {
  if (!local.trim()) return ''
  const date = new Date(local)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString()
}

function formatUsd(value: number, maximumFractionDigits = 2) {
  return `$${formatNumber(value, maximumFractionDigits)}`
}

function formatUsdTicks(ticks: number) {
  return formatUsd(ticks / USD_TICKS, 4)
}

function remainingPercent(usagePercent: number) {
  return Math.min(100, Math.max(0, 100 - (Number(usagePercent) || 0)))
}

function remainingTone(percent: number) {
  if (percent <= 10) return 'bg-destructive'
  if (percent <= 30) return 'bg-amber-500'
  return 'bg-emerald-500'
}

export function ClientKeysPage() {
  const [search, setSearch] = useState('')
  const [debouncedSearch, searchPending] = useDebouncedValue(search.trim())
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<string[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [period, setPeriod] = useState<ClientKeyUsagePeriod>('24h')
  const [customStart, setCustomStart] = useState(() =>
    toLocalInput(new Date(Date.now() - 24 * 60 * 60 * 1000))
  )
  const [customEnd, setCustomEnd] = useState(() => toLocalInput(new Date()))
  const [requested, setRequested] = useState(0)
  const [usageRequest, setUsageRequest] = useState<UsageRequest | null>(null)

  const keys = useQuery({
    queryKey: ['client-keys', page, debouncedSearch],
    queryFn: () =>
      api.clientKeys({
        page,
        pageSize: PAGE_SIZE,
        search: debouncedSearch,
      }),
  })
  const items = keys.data?.items ?? []
  const totalKeys = keys.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(totalKeys / PAGE_SIZE))
  const pageSelected =
    items.length > 0 && items.every((item) => selected.includes(item.id))

  const summary = useQuery({
    queryKey: ['client-keys', 'usage', requested, usageRequest],
    queryFn: () => {
      if (!usageRequest) {
        return Promise.reject(new Error('Missing usage request'))
      }
      return api.clientKeyUsage(usageRequest)
    },
    enabled: requested > 0 && Boolean(usageRequest?.keyIds.length),
  })

  const namedRows = useMemo(() => {
    const data = summary.data
    if (!data) return []
    return data.keys.map((row) => ({
      ...row,
      name: names[row.id] || row.name || row.id,
    }))
  }, [names, summary.data])

  function toggle(id: string, name: string, checked: boolean) {
    setNames((current) => ({ ...current, [id]: name }))
    setSelected((current) =>
      checked
        ? [...new Set([...current, id])]
        : current.filter((item) => item !== id)
    )
  }

  function togglePage() {
    const pageIds = items.map((item) => item.id)
    if (pageSelected) {
      setSelected((current) =>
        current.filter((id) => !pageIds.includes(id))
      )
      return
    }
    setNames((current) => {
      const next = { ...current }
      for (const item of items) next[item.id] = item.name
      return next
    })
    setSelected((current) => [...new Set([...current, ...pageIds])])
  }

  function queryNow() {
    if (!selected.length) {
      toast.error('请先勾选要统计的密钥')
      return
    }
    if (selected.length > MAX_USAGE_KEYS) {
      toast.error(`单次最多统计 ${MAX_USAGE_KEYS} 个密钥`)
      return
    }
    if (period === 'custom') {
      const start = toIso(customStart)
      const end = toIso(customEnd)
      if (!start || !end) {
        toast.error('请填写自定义开始和结束时间')
        return
      }
      if (new Date(start) >= new Date(end)) {
        toast.error('自定义结束时间必须晚于开始时间')
        return
      }
      setUsageRequest({
        keyIds: [...selected],
        period,
        start,
        end,
      })
    } else {
      setUsageRequest({
        keyIds: [...selected],
        period,
      })
    }
    setRequested((current) => current + 1)
  }

  const total = summary.data?.total
  const showEmpty = requested === 0
  const showLoading =
    requested > 0 && summary.isFetching && !summary.data
  const showError =
    requested > 0 && summary.isError && !summary.data
  const showResults = requested > 0 && Boolean(total)

  return (
    <Page>
      <PageHeader
        title='密钥额度'
        description='查看 grok2api Client Key 的剩余额度，并按时间窗口汇总使用量。不会回显密钥明文。'
      />
      <div className='grid items-start gap-4 lg:grid-cols-[minmax(22rem,28rem)_minmax(0,1fr)]'>
        <Card className='gap-0 overflow-hidden py-0'>
          <CardContent className='flex min-h-0 flex-col p-0'>
            <div className='flex items-center gap-2 border-b px-4 py-3'>
              <Input
                className='h-8 min-w-0 flex-1'
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value)
                  setPage(1)
                }}
                placeholder='搜索密钥'
              />
              <Button
                type='button'
                size='sm'
                variant='outline'
                className='shrink-0'
                disabled={!items.length}
                onClick={togglePage}
              >
                {pageSelected ? '取消本页' : '全选本页'}
              </Button>
              <Button
                type='button'
                size='sm'
                variant='outline'
                className='shrink-0'
                disabled={keys.isFetching}
                onClick={() => void keys.refetch()}
              >
                {keys.isFetching ? (
                  <Loader2 className='animate-spin' />
                ) : (
                  <RefreshCw />
                )}
                刷新
              </Button>
            </div>
            <div className='max-h-[28rem] min-h-48 overflow-auto lg:max-h-[min(40rem,calc(100vh-16rem))]'>
              {keys.isLoading ? (
                <LoadingState label='正在加载密钥' />
              ) : null}
              {keys.isError ? (
                <EmptyState
                  compact
                  className='m-3'
                  icon={KeyRound}
                  title='密钥列表加载失败'
                  description={getErrorMessage(keys.error)}
                  action={
                    <Button
                      size='sm'
                      onClick={() => void keys.refetch()}
                    >
                      重试
                    </Button>
                  }
                />
              ) : null}
              {!keys.isLoading && !keys.isError && items.length === 0 ? (
                <EmptyState
                  compact
                  className='m-3'
                  icon={KeyRound}
                  title='没有密钥'
                  description={
                    search.trim()
                      ? '没有匹配的密钥，试试其他关键词。'
                      : '当前没有可查看的 Client Key。'
                  }
                />
              ) : null}
              {items.map((item) => (
                <KeyRow
                  key={item.id}
                  item={item}
                  checked={selected.includes(item.id)}
                  onCheckedChange={(checked) =>
                    toggle(item.id, item.name, checked)
                  }
                />
              ))}
            </div>
            <div className='flex items-center justify-between gap-2 border-t px-4 py-2.5 text-xs text-muted-foreground'>
              <span className='inline-flex items-center gap-2'>
                {keys.isFetching || searchPending ? (
                  <Loader2 className='size-3.5 animate-spin' />
                ) : null}
                <span className='tabular-nums'>
                  已选 {selected.length} 个
                  {selected.length > MAX_USAGE_KEYS
                    ? `（单次最多 ${MAX_USAGE_KEYS} 个）`
                    : ''}
                </span>
              </span>
              {totalKeys > PAGE_SIZE ? (
                <div className='flex gap-1'>
                  <Button
                    type='button'
                    size='sm'
                    variant='outline'
                    disabled={page <= 1}
                    onClick={() =>
                      setPage((current) => Math.max(1, current - 1))
                    }
                  >
                    上一页
                  </Button>
                  <Button
                    type='button'
                    size='sm'
                    variant='outline'
                    disabled={page >= pages}
                    onClick={() => setPage((current) => current + 1)}
                  >
                    下一页
                  </Button>
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card className='gap-0 overflow-hidden py-0'>
          <CardContent className='p-0'>
            <div className='flex flex-wrap items-center gap-2 border-b px-4 py-3'>
              {PERIODS.map((item) => (
                <Button
                  key={item.value}
                  type='button'
                  size='sm'
                  variant={period === item.value ? 'default' : 'outline'}
                  onClick={() => setPeriod(item.value)}
                >
                  {item.label}
                </Button>
              ))}
              <Button
                type='button'
                size='sm'
                className='ml-auto'
                disabled={summary.isFetching}
                onClick={queryNow}
              >
                {summary.isFetching ? (
                  <Loader2 className='animate-spin' />
                ) : (
                  <RefreshCw />
                )}
                查询合计
              </Button>
            </div>
            {period === 'custom' ? (
              <div className='grid gap-3 border-b px-4 py-3 sm:grid-cols-2'>
                <div className='space-y-1.5'>
                  <Label htmlFor='client-key-usage-start'>开始时间</Label>
                  <Input
                    id='client-key-usage-start'
                    type='datetime-local'
                    value={customStart}
                    onChange={(event) =>
                      setCustomStart(event.target.value)
                    }
                  />
                </div>
                <div className='space-y-1.5'>
                  <Label htmlFor='client-key-usage-end'>结束时间</Label>
                  <Input
                    id='client-key-usage-end'
                    type='datetime-local'
                    value={customEnd}
                    onChange={(event) =>
                      setCustomEnd(event.target.value)
                    }
                  />
                </div>
              </div>
            ) : null}
            <div className='space-y-4 p-4'>
              {showEmpty ? (
                <EmptyState
                  compact
                  icon={KeyRound}
                  title='勾选密钥后查询额度'
                  description='支持多选合计。时间窗口可选 24 小时、7 天、30 天、90 天，或自定义起止时间。'
                />
              ) : null}
              {showLoading ? (
                <LoadingState label='正在汇总使用量' />
              ) : null}
              {showError ? (
                <EmptyState
                  compact
                  icon={AlertTriangle}
                  title='统计失败'
                  description={getErrorMessage(summary.error)}
                  action={
                    <Button
                      size='sm'
                      onClick={() => void summary.refetch()}
                    >
                      重试
                    </Button>
                  }
                />
              ) : null}
              {showResults && total ? (
                <UsageResults
                  range={summary.data?.range}
                  truncated={Boolean(summary.data?.truncated)}
                  total={total}
                  rows={namedRows}
                />
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>
    </Page>
  )
}

function KeyRow({
  item,
  checked,
  onCheckedChange,
}: {
  item: ClientKey
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-3 border-b px-4 py-3 text-sm last:border-b-0',
        checked ? 'bg-muted/40' : 'hover:bg-muted/20'
      )}
    >
      <Checkbox
        className='mt-1'
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        aria-label={`选择密钥 ${item.name}`}
      />
      <div className='min-w-0 flex-1 space-y-2'>
        <div className='flex items-start justify-between gap-2'>
          <div className='min-w-0'>
            <div className='truncate font-medium'>{item.name}</div>
            <div className='mt-0.5 truncate font-mono text-xs text-muted-foreground'>
              {item.prefix || `#${item.id}`}
            </div>
          </div>
          <div className='flex shrink-0 flex-wrap justify-end gap-1.5'>
            <Badge variant={item.enabled ? 'success' : 'outline'}>
              {item.enabled ? '已启用' : '已停用'}
            </Badge>
            {item.expired ? (
              <Badge variant='destructive'>已过期</Badge>
            ) : null}
          </div>
        </div>
        <QuotaMeter keyItem={item} />
      </div>
    </label>
  )
}

function QuotaMeter({ keyItem }: { keyItem: ClientKey }) {
  if (keyItem.unlimited) {
    return (
      <div className='rounded-lg border bg-muted/20 px-2.5 py-2'>
        <div className='text-xs text-muted-foreground'>剩余额度</div>
        <div className='mt-0.5 text-sm font-semibold tabular-nums'>
          不限额度
        </div>
        <p className='mt-0.5 text-xs text-muted-foreground tabular-nums'>
          已用 {formatUsd(keyItem.billedUsageUsd)}
        </p>
      </div>
    )
  }

  const percent = remainingPercent(keyItem.usagePercent)
  const remaining = formatUsd(keyItem.remainingUsd)
  const limit = formatUsd(keyItem.billingLimitUsd)
  return (
    <div
      className='rounded-lg border bg-muted/20 px-2.5 py-2'
      title={`剩余 ${remaining} / 总量 ${limit}`}
    >
      <div className='flex items-end justify-between gap-3'>
        <div>
          <div className='text-xs text-muted-foreground'>剩余额度</div>
          <div className='mt-0.5 text-sm font-semibold tabular-nums'>
            {remaining}
          </div>
        </div>
        <div className='text-right text-xs text-muted-foreground tabular-nums'>
          / {limit}
        </div>
      </div>
      <ProgressBar
        className='mt-2 h-1.5'
        value={percent}
        indicatorClassName={remainingTone(percent)}
      />
    </div>
  )
}

function UsageResults({
  range,
  truncated,
  total,
  rows,
}: {
  range?: { start: string; end: string }
  truncated: boolean
  total: {
    estimatedCostInUsdTicks: number
    requests: number
    successfulRequests: number
    failedRequests: number
    totalTokens: number
  }
  rows: Array<{
    id: string
    name: string
    estimatedCostInUsdTicks: number
    requests: number
    successfulRequests: number
    totalTokens: number
  }>
}) {
  const successFailure = `${formatNumber(total.successfulRequests, 0)} / ${formatNumber(total.failedRequests, 0)}`
  return (
    <>
      <div className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
        <Metric
          label='合计额度'
          value={formatUsdTicks(total.estimatedCostInUsdTicks)}
        />
        <Metric label='请求' value={formatNumber(total.requests, 0)} />
        <Metric label='成功 / 失败' value={successFailure} />
        <Metric label='Tokens' value={formatNumber(total.totalTokens, 0)} />
      </div>
      <div className='text-xs text-muted-foreground'>
        窗口 {formatDate(range?.start)} ~ {formatDate(range?.end)}
      </div>
      {truncated ? (
        <div className='flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-800 dark:text-amber-300'>
          <AlertTriangle className='mt-0.5 size-4 shrink-0' />
          <span>
            结果已截断：自定义起点早于 grok2api 可查的 90 天，或记录过多。
          </span>
        </div>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>密钥</TableHead>
            <TableHead>额度</TableHead>
            <TableHead>请求</TableHead>
            <TableHead>成功</TableHead>
            <TableHead>Tokens</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id} rowId={row.id}>
              <TableCell>
                <div className='font-medium'>{row.name}</div>
                <div className='font-mono text-[11px] text-muted-foreground'>
                  #{row.id}
                </div>
              </TableCell>
              <TableCell className='tabular-nums'>
                {formatUsdTicks(row.estimatedCostInUsdTicks)}
              </TableCell>
              <TableCell className='tabular-nums'>
                {formatNumber(row.requests, 0)}
              </TableCell>
              <TableCell className='tabular-nums'>
                {formatNumber(row.successfulRequests, 0)}
              </TableCell>
              <TableCell className='tabular-nums'>
                {formatNumber(row.totalTokens, 0)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell className='font-medium'>
              合计 {rows.length} 个密钥
            </TableCell>
            <TableCell className='font-semibold tabular-nums'>
              {formatUsdTicks(total.estimatedCostInUsdTicks)}
            </TableCell>
            <TableCell className='font-semibold tabular-nums'>
              {formatNumber(total.requests, 0)}
            </TableCell>
            <TableCell className='font-semibold tabular-nums'>
              {formatNumber(total.successfulRequests, 0)}
            </TableCell>
            <TableCell className='font-semibold tabular-nums'>
              {formatNumber(total.totalTokens, 0)}
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className='rounded-lg border bg-muted/20 px-3 py-3'>
      <div className='text-xs text-muted-foreground'>{label}</div>
      <div className='mt-1 text-lg font-semibold tabular-nums'>{value}</div>
    </div>
  )
}
