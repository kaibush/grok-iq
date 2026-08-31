import { useRef, useState, type FormEvent } from 'react'
import { AlertTriangle, KeyRound, Loader2 } from 'lucide-react'
import {
  api,
  type ClientKeyUsagePeriod,
  type ClientKeyUsageTotals,
  type PublicClientKeyQuota,
  type PublicClientKeyQuotaLookup,
  type PublicClientKeyUsage,
} from '@/lib/api'
import { formatDate, formatNumber, getErrorMessage } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ProgressBar } from '@/components/ui/progress'

const USD_TICKS = 10_000_000_000
const PERIODS = [
  { value: '24h', label: '24小时' },
  { value: '7d', label: '7天' },
  { value: '30d', label: '30天' },
  { value: '90d', label: '90天' },
  { value: 'custom', label: '自定义' },
] as const

const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
})

function formatUsd(value: number) {
  return usdFormatter.format(value)
}

function formatUsdTicks(ticks: number) {
  return `$${formatNumber(ticks / USD_TICKS, 4)}`
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

export function ClientKeyQuotaDialog() {
  const [open, setOpen] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [pending, setPending] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [result, setResult] = useState<PublicClientKeyQuotaLookup | null>(null)
  const [period, setPeriod] = useState<ClientKeyUsagePeriod>('24h')
  const [customStart, setCustomStart] = useState(() =>
    toLocalInput(new Date(Date.now() - 24 * 60 * 60 * 1000))
  )
  const [customEnd, setCustomEnd] = useState(() => toLocalInput(new Date()))
  const [usage, setUsage] = useState<PublicClientKeyUsage | null>(null)
  const [usagePending, setUsagePending] = useState(false)
  const [usageError, setUsageError] = useState('')
  const lookupGenerationRef = useRef(0)
  const usageGenerationRef = useRef(0)
  const pendingRef = useRef(false)
  const lookedUpKeyRef = useRef('')
  const canSubmit = apiKey.trim().length > 0 && !pending

  function resetLookupState() {
    lookupGenerationRef.current += 1
    usageGenerationRef.current += 1
    pendingRef.current = false
    lookedUpKeyRef.current = ''
    setApiKey('')
    setPending(false)
    setErrorMessage('')
    setResult(null)
    setPeriod('24h')
    setCustomStart(toLocalInput(new Date(Date.now() - 24 * 60 * 60 * 1000)))
    setCustomEnd(toLocalInput(new Date()))
    setUsage(null)
    setUsagePending(false)
    setUsageError('')
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    if (!nextOpen) resetLookupState()
  }

  async function lookupUsage(
    trimmedKey: string,
    nextPeriod: ClientKeyUsagePeriod = period
  ) {
    if (nextPeriod === 'custom' && (!toIso(customStart) || !toIso(customEnd))) {
      setUsage(null)
      setUsageError('请填写自定义开始和结束时间')
      return
    }
    const usageGeneration = usageGenerationRef.current + 1
    usageGenerationRef.current = usageGeneration
    setUsagePending(true)
    setUsageError('')
    try {
      const usageResult = await api.lookupPublicClientKeyUsage({
        apiKey: trimmedKey,
        period: nextPeriod,
        start: nextPeriod === 'custom' ? toIso(customStart) : undefined,
        end: nextPeriod === 'custom' ? toIso(customEnd) : undefined,
      })
      if (usageGenerationRef.current !== usageGeneration) return
      if (!usageResult.found) {
        setUsage(null)
        setUsageError('未找到该密钥，或密钥无效')
        return
      }
      setUsage(usageResult)
    } catch (error) {
      if (usageGenerationRef.current !== usageGeneration) return
      setUsage(null)
      setUsageError(getErrorMessage(error))
    } finally {
      if (usageGenerationRef.current === usageGeneration) {
        setUsagePending(false)
      }
    }
  }

  async function lookupQuota() {
    const trimmedKey = apiKey.trim()
    if (!trimmedKey || pendingRef.current) return
    const lookupGeneration = lookupGenerationRef.current + 1
    lookupGenerationRef.current = lookupGeneration
    pendingRef.current = true
    setPending(true)
    setErrorMessage('')
    setResult(null)
    setUsage(null)
    setUsageError('')
    try {
      const lookupResult = await api.lookupPublicClientKeyQuota(trimmedKey)
      if (lookupGenerationRef.current !== lookupGeneration) return
      setResult(lookupResult)
      if (lookupResult.found) {
        lookedUpKeyRef.current = trimmedKey
        void lookupUsage(trimmedKey)
      } else {
        lookedUpKeyRef.current = ''
      }
    } catch (error) {
      if (lookupGenerationRef.current !== lookupGeneration) return
      setErrorMessage(getErrorMessage(error))
    } finally {
      if (lookupGenerationRef.current === lookupGeneration) {
        pendingRef.current = false
        setPending(false)
      }
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void lookupQuota()
  }

  function handleUsageQuery() {
    const trimmedKey = lookedUpKeyRef.current || apiKey.trim()
    if (!trimmedKey) return
    void lookupUsage(trimmedKey)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type='button' size='sm' variant='outline'>
          <KeyRound />
          查询密钥额度
        </Button>
      </DialogTrigger>
      <DialogContent className='sm:max-w-xl'>
        <DialogHeader>
          <DialogTitle>查询密钥额度</DialogTitle>
          <DialogDescription>
            输入 grok2api Client Key，查看剩余额度和时间窗口使用量。
          </DialogDescription>
        </DialogHeader>
        <form className='space-y-3' onSubmit={handleSubmit}>
          <div className='space-y-1.5'>
            <Label htmlFor='public-client-key-quota'>Client Key</Label>
            <Input
              id='public-client-key-quota'
              type='password'
              autoComplete='off'
              spellCheck={false}
              placeholder='g2a_********'
              className='font-mono'
              maxLength={256}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </div>
          {errorMessage ? (
            <p className='text-sm text-destructive'>{errorMessage}</p>
          ) : null}
          {result && !result.found ? (
            <p className='text-sm text-muted-foreground'>
              未找到该密钥，或密钥无效
            </p>
          ) : null}
          {result && result.found ? <QuotaResult quota={result} /> : null}
          {result && result.found ? (
            <UsageSection
              period={period}
              customStart={customStart}
              customEnd={customEnd}
              pending={usagePending}
              errorMessage={usageError}
              usage={usage}
              onPeriodChange={setPeriod}
              onCustomStartChange={setCustomStart}
              onCustomEndChange={setCustomEnd}
              onQuery={handleUsageQuery}
            />
          ) : null}
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              onClick={() => handleOpenChange(false)}
            >
              取消
            </Button>
            <Button type='submit' disabled={!canSubmit}>
              {pending ? <Loader2 className='animate-spin' /> : null}
              查询
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function QuotaResult({ quota }: { quota: PublicClientKeyQuota }) {
  return (
    <div className='space-y-3'>
      <div className='flex items-start justify-between gap-2'>
        <div className='min-w-0'>
          <div className='truncate font-medium'>{quota.name}</div>
          {quota.prefix ? (
            <div className='mt-0.5 truncate font-mono text-xs text-muted-foreground'>
              {quota.prefix}
            </div>
          ) : null}
        </div>
        <div className='flex shrink-0 flex-wrap justify-end gap-1.5'>
          <Badge variant={quota.enabled ? 'success' : 'outline'}>
            {quota.enabled ? '已启用' : '已停用'}
          </Badge>
          {quota.expired ? <Badge variant='destructive'>已过期</Badge> : null}
        </div>
      </div>
      <div className='rounded-lg border bg-muted/20 px-3 py-3'>
        <div className='text-xs text-muted-foreground'>剩余额度</div>
        <div className='mt-1 text-xl font-semibold tabular-nums'>
          {quota.unlimited ? '不限额度' : formatUsd(quota.remainingUsd)}
        </div>
        {quota.unlimited ? (
          <p className='mt-1 text-sm text-muted-foreground tabular-nums'>
            已用 {formatUsd(quota.billedUsageUsd)}
          </p>
        ) : (
          <div className='mt-3 space-y-2'>
            <ProgressBar className='h-2' value={quota.usagePercent} />
            <p className='text-sm text-muted-foreground tabular-nums'>
              已用 {formatUsd(quota.billedUsageUsd)} / 总量{' '}
              {formatUsd(quota.billingLimitUsd)}
            </p>
          </div>
        )}
      </div>
      <div className='grid gap-2 sm:grid-cols-2'>
        <div className='rounded-lg border bg-muted/20 px-3 py-2'>
          <div className='text-xs text-muted-foreground'>最近使用</div>
          <div className='mt-1 text-sm tabular-nums'>
            {formatDate(quota.lastUsedAt)}
          </div>
        </div>
        <div className='rounded-lg border bg-muted/20 px-3 py-2'>
          <div className='text-xs text-muted-foreground'>过期时间</div>
          <div className='mt-1 text-sm tabular-nums'>
            {formatDate(quota.expiresAt)}
          </div>
        </div>
      </div>
    </div>
  )
}

function UsageSection({
  period,
  customStart,
  customEnd,
  pending,
  errorMessage,
  usage,
  onPeriodChange,
  onCustomStartChange,
  onCustomEndChange,
  onQuery,
}: {
  period: ClientKeyUsagePeriod
  customStart: string
  customEnd: string
  pending: boolean
  errorMessage: string
  usage: PublicClientKeyUsage | null
  onPeriodChange: (value: ClientKeyUsagePeriod) => void
  onCustomStartChange: (value: string) => void
  onCustomEndChange: (value: string) => void
  onQuery: () => void
}) {
  const totals = usage?.usage
  return (
    <div className='space-y-3 border-t pt-3'>
      <div className='flex flex-wrap items-center gap-2'>
        {PERIODS.map((item) => (
          <Button
            key={item.value}
            type='button'
            size='sm'
            variant={period === item.value ? 'default' : 'outline'}
            onClick={() => onPeriodChange(item.value)}
          >
            {item.label}
          </Button>
        ))}
        <Button
          type='button'
          size='sm'
          className='ml-auto'
          disabled={pending}
          onClick={onQuery}
        >
          {pending ? <Loader2 className='animate-spin' /> : null}
          查询使用量
        </Button>
      </div>
      {period === 'custom' ? (
        <div className='grid gap-3 sm:grid-cols-2'>
          <div className='space-y-1.5'>
            <Label htmlFor='public-client-key-usage-start'>开始时间</Label>
            <Input
              id='public-client-key-usage-start'
              type='datetime-local'
              value={customStart}
              onChange={(event) => onCustomStartChange(event.target.value)}
            />
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='public-client-key-usage-end'>结束时间</Label>
            <Input
              id='public-client-key-usage-end'
              type='datetime-local'
              value={customEnd}
              onChange={(event) => onCustomEndChange(event.target.value)}
            />
          </div>
        </div>
      ) : null}
      {errorMessage ? (
        <p className='text-sm text-destructive'>{errorMessage}</p>
      ) : null}
      {pending && !totals ? (
        <div className='flex items-center gap-2 text-sm text-muted-foreground'>
          <Loader2 className='size-4 animate-spin' />
          正在汇总使用量
        </div>
      ) : null}
      {totals ? (
        <UsageMetrics
          usage={totals}
          range={usage?.range}
          truncated={Boolean(usage?.truncated)}
        />
      ) : null}
    </div>
  )
}

function UsageMetrics({
  usage,
  range,
  truncated,
}: {
  usage: ClientKeyUsageTotals
  range?: { start: string; end: string }
  truncated: boolean
}) {
  return (
    <div className='space-y-3'>
      <div className='grid grid-cols-2 gap-2'>
        <Metric
          label='窗口额度'
          value={formatUsdTicks(usage.estimatedCostInUsdTicks)}
        />
        <Metric label='请求' value={formatNumber(usage.requests, 0)} />
        <Metric
          label='成功 / 失败'
          value={`${formatNumber(usage.successfulRequests, 0)} / ${formatNumber(usage.failedRequests, 0)}`}
        />
        <Metric label='Tokens' value={formatNumber(usage.totalTokens, 0)} />
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
    </div>
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
