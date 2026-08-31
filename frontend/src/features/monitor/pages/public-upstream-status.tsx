import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Compass,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  SquareTerminal,
  TimerReset,
  UsersRound,
  Webhook,
} from 'lucide-react'
import { IconGithub } from '@/assets/brand-icons'
import {
  api,
  type ClientKeyUsageTotals,
  type PublicUpstreamAccountSummary,
  type PublicUpstreamProvider,
  type PublicUpstreamUsagePeriod,
  type PublicUpstreamUsageWindow,
} from '@/lib/api'
import { formatDate, formatNumber, getErrorMessage } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { ProgressBar } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { StatCard } from '@/components/stat-card'
import { ThemeSwitch } from '@/components/theme-switch'
import { ClientKeyQuotaDialog } from '@/features/monitor/components/client-key-quota-dialog'

const providerMeta: Record<
  PublicUpstreamProvider,
  { label: string; hint: string; icon: typeof SquareTerminal }
> = {
  grok_build: {
    label: 'Build',
    hint: 'Grok Build 账号',
    icon: SquareTerminal,
  },
  grok_web: {
    label: 'Web',
    hint: 'Grok Web 账号',
    icon: Compass,
  },
  grok_console: {
    label: 'Console',
    hint: 'Grok Console 账号',
    icon: Webhook,
  },
}

const emptyUsageTotals: ClientKeyUsageTotals = {
  requests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  durationMs: 0,
  estimatedCostInUsdTicks: 0,
  averageDurationMs: 0,
  successRate: 0,
  cacheHitRate: 0,
}

function emptyUsageWindow(
  period: PublicUpstreamUsagePeriod
): PublicUpstreamUsageWindow {
  return {
    period,
    sourcePeriod: period,
    range: { start: null, end: null },
    truncated: false,
    usage: emptyUsageTotals,
  }
}

const emptySummary: PublicUpstreamAccountSummary = {
  reachable: false,
  updatedAt: null,
  total: 0,
  available: 0,
  recovering: 0,
  attention: 0,
  risk: 0,
  providers: {
    grok_build: { total: 0, available: 0 },
    grok_web: { total: 0, available: 0 },
    grok_console: { total: 0, available: 0 },
  },
  recovery: { cooldown: 0, waitingReset: 0, probing: 0 },
  issues: { disabled: 0, reauthRequired: 0 },
}

export function PublicUpstreamStatusPage() {
  const query = useQuery({
    queryKey: ['public', 'upstream-accounts'],
    queryFn: api.publicUpstreamAccounts,
    refetchInterval: 15_000,
    retry: 1,
  })
  const usageQuery = useQuery({
    queryKey: ['public', 'upstream-usage'],
    queryFn: api.publicUpstreamUsage,
    refetchInterval: 30_000,
    retry: 1,
  })
  const data = query.data ?? emptySummary
  const usageErrorMessage = usageQuery.isError
    ? getErrorMessage(usageQuery.error)
    : ''
  const usageReady =
    usageQuery.data != null && usageQuery.data.reachable && !usageQuery.isError
  const errorMessage = query.isError ? getErrorMessage(query.error) : ''
  const hasData = query.data != null
  const ready = hasData && data.reachable && !query.isError

  return (
    <div className='min-h-svh bg-background'>
      <header className='border-b bg-background/80 backdrop-blur-sm'>
        <div className='mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4'>
          <div className='flex min-w-0 items-center gap-2.5'>
            <span className='flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground'>
              <ShieldCheck className='size-4' />
            </span>
            <span className='min-w-0'>
              <span className='block truncate text-sm leading-4 font-semibold'>
                GrokIQ
              </span>
              <span className='block truncate text-[11px] text-muted-foreground'>
                上游账号状态
              </span>
            </span>
          </div>
          <div className='flex items-center gap-1'>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant='ghost'
                  size='icon'
                  className='text-muted-foreground'
                  asChild
                >
                  <a
                    href='https://github.com/kaibush/grok-iq'
                    target='_blank'
                    rel='noreferrer'
                    aria-label='查看 GrokIQ GitHub 仓库'
                  >
                    <IconGithub className='size-5' />
                  </a>
                </Button>
              </TooltipTrigger>
              <TooltipContent>GitHub 仓库</TooltipContent>
            </Tooltip>
            <ThemeSwitch />
          </div>
        </div>
      </header>

      <main className='mx-auto w-full max-w-6xl space-y-6 px-4 py-6 md:py-8'>
        <div className='flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between'>
          <div>
            <p className='text-xs font-medium tracking-[0.16em] text-primary uppercase'>
              Public status
            </p>
            <h1 className='mt-1 text-2xl font-semibold tracking-tight'>
              上游账号情况
            </h1>
            <p className='mt-1 text-sm text-muted-foreground'>
              默认展示上游账号聚合计数，以及近 24 小时和 7 天的请求统计。密钥额度需手动查询，不会回显明文。
            </p>
          </div>
          <div className='flex flex-wrap items-center gap-2'>
            <StatusBadge
              loading={query.isLoading && !query.data}
              reachable={data.reachable}
              error={Boolean(errorMessage)}
            />
            <ClientKeyQuotaDialog />
            <Button
              type='button'
              size='sm'
              variant='outline'
              onClick={() => {
                void query.refetch()
                void usageQuery.refetch()
              }}
              disabled={query.isFetching || usageQuery.isFetching}
            >
              {query.isFetching || usageQuery.isFetching ? (
                <Loader2 className='animate-spin' />
              ) : (
                <RefreshCw />
              )}
              刷新
            </Button>
          </div>
        </div>

        {errorMessage && (
          <Card className='border-destructive/30 bg-destructive/5'>
            <CardContent className='p-4 text-sm text-destructive'>
              状态读取失败：{errorMessage}
            </CardContent>
          </Card>
        )}

        {!errorMessage && !data.reachable && query.data && (
          <Card className='border-amber-500/30 bg-amber-500/5'>
            <CardContent className='p-4 text-sm text-amber-800 dark:text-amber-300'>
              上游暂时不可达，当前不展示账号计数。
            </CardContent>
          </Card>
        )}

        <section className='grid gap-4 sm:grid-cols-2 xl:grid-cols-5'>
          <StatCard
            label='账号总数'
            value={ready ? formatNumber(data.total, 0) : '—'}
            detail={
              ready
                ? `${formatNumber(data.available, 0)} 个当前可调度`
                : '读取中'
            }
            icon={UsersRound}
            tone='sky'
            loading={query.isLoading && !hasData}
            index={0}
          />
          <StatCard
            label='恢复中'
            value={ready ? formatNumber(data.recovering, 0) : '—'}
            detail='冷却、待重置或检测中'
            icon={TimerReset}
            tone='amber'
            loading={query.isLoading && !hasData}
            index={1}
          />
          <StatCard
            label='需关注'
            value={ready ? formatNumber(data.attention, 0) : '—'}
            detail={
              ready
                ? `${formatNumber(data.issues.disabled, 0)} 停用 · ${formatNumber(data.issues.reauthRequired, 0)} 失效`
                : '读取中'
            }
            icon={AlertTriangle}
            tone='amber'
            loading={query.isLoading && !hasData}
            index={2}
          />
          <StatCard
            label='风险标记'
            value={ready ? formatNumber(data.risk, 0) : '—'}
            detail='上游机器人风险账号'
            icon={ShieldAlert}
            tone='red'
            loading={query.isLoading && !hasData}
            index={3}
          />
          <StatCard
            label='可调度占比'
            value={ready ? percent(data.available, data.total) : '—'}
            detail='可调度 / 总数'
            icon={Activity}
            tone='emerald'
            loading={query.isLoading && !hasData}
            index={4}
          />
        </section>

        <section className='grid gap-4 lg:grid-cols-3'>
          {(Object.keys(providerMeta) as PublicUpstreamProvider[]).map(
            (provider) => (
              <ProviderCard
                key={provider}
                provider={provider}
                counts={data.providers[provider]}
                ready={ready}
              />
            )
          )}
        </section>

        <section className='space-y-3'>
          <div className='flex items-center gap-2'>
            <BarChart3 className='size-4 text-primary' />
            <h2 className='text-base font-medium'>请求看板</h2>
          </div>
          {usageErrorMessage ? (
            <Card className='border-destructive/30 bg-destructive/5'>
              <CardContent className='p-4 text-sm text-destructive'>
                请求统计读取失败：{usageErrorMessage}
              </CardContent>
            </Card>
          ) : null}
          {!usageErrorMessage && usageQuery.data && !usageQuery.data.reachable ? (
            <Card className='border-amber-500/30 bg-amber-500/5'>
              <CardContent className='p-4 text-sm text-amber-800 dark:text-amber-300'>
                上游暂时不可达，当前不展示请求统计。
              </CardContent>
            </Card>
          ) : null}
          <div className='grid gap-4 lg:grid-cols-2'>
            <UsageWindowCard
              title='近 24 小时'
              window={usageQuery.data?.windows['24h'] ?? emptyUsageWindow('24h')}
              ready={usageReady}
              loading={usageQuery.isLoading && usageQuery.data == null}
            />
            <UsageWindowCard
              title='近 7 天'
              window={usageQuery.data?.windows['7d'] ?? emptyUsageWindow('7d')}
              ready={usageReady}
              loading={usageQuery.isLoading && usageQuery.data == null}
            />
          </div>
        </section>

        <section className='grid gap-4 lg:grid-cols-2'>
          <Card>
            <CardHeader>
              <CardTitle className='flex items-center gap-2 text-base'>
                <TimerReset className='size-4 text-primary' />
                恢复队列
              </CardTitle>
            </CardHeader>
            <CardContent className='grid gap-3 sm:grid-cols-3'>
              <CountTile
                label='冷却中'
                value={ready ? data.recovery.cooldown : null}
              />
              <CountTile
                label='待重置'
                value={ready ? data.recovery.waitingReset : null}
              />
              <CountTile
                label='检测中'
                value={ready ? data.recovery.probing : null}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className='flex items-center gap-2 text-base'>
                <AlertTriangle className='size-4 text-primary' />
                账号问题
              </CardTitle>
            </CardHeader>
            <CardContent className='grid gap-3 sm:grid-cols-2'>
              <CountTile
                label='已停用'
                value={ready ? data.issues.disabled : null}
              />
              <CountTile
                label='需重新登录'
                value={ready ? data.issues.reauthRequired : null}
              />
            </CardContent>
          </Card>
        </section>

        <p className='text-xs text-muted-foreground'>
          最近更新：{hasData ? formatDate(data.updatedAt) : '—'} · 每 15
          秒自动刷新
        </p>
      </main>
    </div>
  )
}

function StatusBadge({
  loading,
  reachable,
  error,
}: {
  loading: boolean
  reachable: boolean
  error: boolean
}) {
  if (loading) {
    return (
      <Badge variant='outline' className='gap-1.5'>
        <Loader2 className='size-3 animate-spin' />
        读取中
      </Badge>
    )
  }
  if (error) {
    return <Badge variant='destructive'>读取失败</Badge>
  }
  if (!reachable) {
    return <Badge variant='warning'>上游不可达</Badge>
  }
  return <Badge variant='success'>上游正常</Badge>
}

function ProviderCard({
  provider,
  counts,
  ready,
}: {
  provider: PublicUpstreamProvider
  counts: { total: number; available: number }
  ready: boolean
}) {
  const meta = providerMeta[provider]
  const Icon = meta.icon
  const ratio = counts.total > 0 ? counts.available / counts.total : 0
  return (
    <Card>
      <CardContent className='space-y-4 p-5'>
        <div className='flex items-start justify-between gap-3'>
          <div>
            <div className='flex items-center gap-2'>
              <Icon className='size-4 text-primary' />
              <h2 className='font-medium'>{meta.label}</h2>
            </div>
            <p className='mt-1 text-xs text-muted-foreground'>{meta.hint}</p>
          </div>
          <Badge variant='outline'>
            {ready ? percent(counts.available, counts.total) : '—'}
          </Badge>
        </div>
        <ProgressBar
          className='h-2'
          value={ready ? Math.round(ratio * 100) : 0}
        />
        <div className='flex items-center justify-between text-sm'>
          <span className='text-muted-foreground'>可调度</span>
          <span className='tabular-nums'>
            {ready
              ? `${formatNumber(counts.available, 0)} / ${formatNumber(counts.total, 0)}`
              : '—'}
          </span>
        </div>
      </CardContent>
    </Card>
  )
}

function UsageWindowCard({
  title,
  window,
  ready,
  loading,
}: {
  title: string
  window: PublicUpstreamUsageWindow
  ready: boolean
  loading: boolean
}) {
  const usage = window.usage
  const show = ready && !loading
  return (
    <Card>
      <CardHeader>
        <CardTitle className='flex items-center justify-between gap-2 text-base'>
          <span>{title}</span>
          {window.truncated ? <Badge variant='warning'>已截断</Badge> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className='space-y-3'>
        <div className='grid gap-3 sm:grid-cols-2'>
          <CountTile label='请求' value={show ? usage.requests : null} />
          <CountTile
            label='成功 / 失败'
            display={
              show
                ? `${formatNumber(usage.successfulRequests, 0)} / ${formatNumber(usage.failedRequests, 0)}`
                : null
            }
          />
          <CountTile
            label='成功率'
            display={show ? percentValue(usage.successRate) : null}
          />
          <CountTile label='Tokens' value={show ? usage.totalTokens : null} />
          <CountTile label='输入' value={show ? usage.inputTokens : null} />
          <CountTile label='缓存' value={show ? usage.cachedInputTokens : null} />
          <CountTile
            label='缓存命中'
            display={show ? percentValue(usage.cacheHitRate) : null}
          />
          <CountTile label='输出' value={show ? usage.outputTokens : null} />
        </div>
        <p className='text-xs text-muted-foreground'>
          窗口 {show ? formatDate(window.range.start) : '—'} ~{' '}
          {show ? formatDate(window.range.end) : '—'}
        </p>
      </CardContent>
    </Card>
  )
}

function CountTile({
  label,
  value,
  display,
}: {
  label: string
  value?: number | null
  display?: string | null
}) {
  return (
    <div className='rounded-lg border bg-muted/20 px-3 py-3'>
      <div className='text-xs text-muted-foreground'>{label}</div>
      <div className='mt-1 text-xl font-semibold tabular-nums'>
        {display ?? (value == null ? '—' : formatNumber(value, 0))}
      </div>
    </div>
  )
}

function percent(part: number, total: number) {
  if (!total) return '—'
  return `${Math.round((part / total) * 100)}%`
}

function percentValue(value: number) {
  return `${formatNumber(value, 1)}%`
}
