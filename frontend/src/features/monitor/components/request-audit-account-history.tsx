import { useMemo, useState } from 'react'
import {
  ChevronDown,
  History,
  KeyRound,
  Layers3,
  Search,
  ShieldAlert,
} from 'lucide-react'
import {
  type RequestAuditClientKeyOption,
  type RequestAuditHistoryAccount,
  type RequestAuditHistoryBucket,
  type RequestAuditHistoryEpisode,
  type RequestAuditHistoryResponse,
} from '@/lib/api'
import { cn, formatDate, formatNumber } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/page'
import { SegmentedControl } from '@/components/segmented-control'
import { TitledCard } from '@/components/titled-card'
import { FilterChip } from '@/features/monitor/components/filter-chip'
import {
  DEFAULT_HISTORY_ACCOUNT_SORT,
  HISTORY_EXTRA_CHIP_DESCRIPTIONS,
  HISTORY_EXTRA_CHIP_LABELS,
  HISTORY_EXTRA_CHIP_VARIANTS,
  HISTORY_PATTERN_BADGE_VARIANTS,
  HISTORY_PATTERN_DESCRIPTIONS,
  HISTORY_PATTERN_LABELS,
  HISTORY_RISK_FILTER_OPTIONS,
  HISTORY_RISK_LEVEL_BADGE_VARIANTS,
  HISTORY_RISK_LEVEL_LABELS,
  HISTORY_SORT_OPTIONS,
  HISTORY_SUMMARY_CARDS,
  filterHistoryAccounts,
  formatHistoryMinutes,
  formatHistoryMinutesCompact,
  formatHistoryTimeRange,
  historyAccountDisplayName,
  historyAccountHasName,
  historyAccountKey,
  historyActivityOpacity,
  historyAxisTicks,
  historyBucketIndexAt,
  historyClientKeyLabel,
  historyEpisodeAt,
  historyEpisodePlacement,
  historyFailOpacity,
  historyRowMaxRequests,
  historyWindowRange,
  sortHistoryAccounts,
  type HistoryAccountPatternFilter,
  type HistoryAccountSort,
  type HistoryRiskFilter,
} from './request-audit-account-history-model'

const IDENTITY_COL = 'min-w-0 xl:w-[13.75rem] xl:shrink-0'
const STATS_COL = 'min-w-0 xl:w-[10.25rem] xl:shrink-0'

export type RequestAuditAccountHistoryBoardProps = {
  data?: RequestAuditHistoryResponse
  loading: boolean
  error?: string
  riskEnabled: boolean
  pinnedAccountId: number | null
  search: string
  onSearchChange: (value: string) => void
  clientKey: string
  clientKeys: RequestAuditClientKeyOption[]
  onClientKeyChange: (value: string) => void
  node: string
  nodeOptions: Array<{ id: string; name: string }>
  onNodeChange: (value: string) => void
  risk: HistoryRiskFilter
  onRiskChange: (value: HistoryRiskFilter) => void
  onOpenLedger: (account: {
    accountId: number | null
    accountName: string
  }) => void
}

export function RequestAuditAccountHistoryBoard({
  data,
  loading,
  error,
  riskEnabled,
  pinnedAccountId,
  search,
  onSearchChange,
  clientKey,
  clientKeys,
  onClientKeyChange,
  node,
  nodeOptions,
  onNodeChange,
  risk,
  onRiskChange,
  onOpenLedger,
}: RequestAuditAccountHistoryBoardProps) {
  const [patternFilter, setPatternFilter] =
    useState<HistoryAccountPatternFilter | null>(null)
  const [sort, setSort] = useState<HistoryAccountSort>(
    DEFAULT_HISTORY_ACCOUNT_SORT
  )
  const pinnedKey = pinnedAccountId == null ? null : String(pinnedAccountId)
  const [expandedAccountKey, setExpandedAccountKey] = useState<string | null>(
    pinnedKey
  )
  const [seenPinnedKey, setSeenPinnedKey] = useState(pinnedKey)
  if (pinnedKey !== seenPinnedKey) {
    setSeenPinnedKey(pinnedKey)
    if (pinnedKey != null) setExpandedAccountKey(pinnedKey)
  }

  const errorMessage = error?.trim() ?? ''
  const showSkeletons = loading && !data
  const summary = data?.summary
  const visibleAccounts = useMemo(() => {
    const filtered = filterHistoryAccounts(data?.accounts ?? [], {
      pattern: patternFilter,
    })
    return sortHistoryAccounts(filtered, sort)
  }, [data?.accounts, patternFilter, sort])
  const axisBuckets = useMemo(() => {
    const fromVisible = visibleAccounts.find(
      (account) => account.buckets.length > 0
    )
    if (fromVisible) return fromVisible.buckets
    return (
      data?.accounts.find((account) => account.buckets.length > 0)?.buckets ??
      []
    )
  }, [data?.accounts, visibleAccounts])

  const selectedClientKey = clientKeys.find((item) => item.id === clientKey)
  const selectedNode = nodeOptions.find((item) => item.id === node)
  const resolvedClientKeys = useMemo(() => {
    if (
      clientKey === 'all' ||
      clientKeys.some((item) => item.id === clientKey)
    ) {
      return clientKeys
    }
    return [{ id: clientKey, name: `#${clientKey}` }, ...clientKeys]
  }, [clientKey, clientKeys])
  const resolvedNodeOptions = useMemo(() => {
    if (node === 'all' || nodeOptions.some((item) => item.id === node)) {
      return nodeOptions
    }
    return [{ id: node, name: `节点 #${node}` }, ...nodeOptions]
  }, [node, nodeOptions])

  const riskLabel =
    HISTORY_RISK_FILTER_OPTIONS.find((item) => item.value === risk)?.label ??
    '全部'
  const hasActiveFilters =
    Boolean(search.trim()) ||
    clientKey !== 'all' ||
    node !== 'all' ||
    (riskEnabled && risk !== 'all') ||
    patternFilter != null

  function clearFilters() {
    onSearchChange('')
    onClientKeyChange('all')
    onNodeChange('all')
    onRiskChange('all')
    setPatternFilter(null)
  }

  function togglePattern(next: HistoryAccountPatternFilter) {
    setPatternFilter((current) => (current === next ? null : next))
  }

  return (
    <TitledCard
      icon={<History />}
      iconTone='sky'
      title='账号历程'
      description='把每个账号的正常 / 观察 / 高风险过程摊成时间轴，用来区分偶发异常、反复异常、从未正常和已经恢复。'
      hint='色带是异常段，底轨绿色是这段有请求，底边红线是 HTTP 失败，灰色空档是没请求。'
      contentClassName='space-y-4'
    >
      {errorMessage ? (
        <Card className='border-destructive/30 bg-destructive/5'>
          <CardContent className='p-4 text-sm text-destructive'>
            账号历程读取失败：{errorMessage}
          </CardContent>
        </Card>
      ) : null}

      <div className='space-y-2'>
        <div className='flex flex-col gap-2 xl:flex-row xl:items-center'>
          <div className='relative min-w-0 flex-1'>
            <Search className='absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground' />
            <Input
              className='h-8 pr-3 pl-8'
              placeholder='搜索账号 / 请求'
              aria-label='搜索账号或请求'
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
            />
          </div>
          <div className='grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3 xl:w-[min(42rem,100%)]'>
            <Select value={clientKey} onValueChange={onClientKeyChange}>
              <SelectTrigger
                className='w-full min-w-0'
                aria-label='按客户端 Key 筛选账号历程'
              >
                <KeyRound className='size-4 text-muted-foreground' />
                <SelectValue placeholder='所有客户端 Key' />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='all'>所有客户端 Key</SelectItem>
                {resolvedClientKeys.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {historyClientKeyLabel(item)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={node} onValueChange={onNodeChange}>
              <SelectTrigger
                className='w-full min-w-0'
                aria-label='按代理节点筛选账号历程'
              >
                <Layers3 className='size-4 text-muted-foreground' />
                <SelectValue placeholder='所有代理节点' />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='all'>所有代理节点</SelectItem>
                {resolvedNodeOptions.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={risk}
              disabled={!riskEnabled}
              onValueChange={(value) =>
                onRiskChange(value as HistoryRiskFilter)
              }
            >
              <SelectTrigger
                className='w-full min-w-0'
                aria-label='按风险范围筛选账号历程'
              >
                <ShieldAlert className='size-4 text-muted-foreground' />
                <SelectValue placeholder='全部' />
              </SelectTrigger>
              <SelectContent>
                {HISTORY_RISK_FILTER_OPTIONS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {hasActiveFilters ? (
          <div className='flex flex-wrap items-center gap-1.5'>
            <span className='mr-1 text-xs text-muted-foreground'>当前条件</span>
            {search.trim() ? (
              <FilterChip
                label={`搜索：${search.trim()}`}
                onClear={() => onSearchChange('')}
              />
            ) : null}
            {clientKey !== 'all' ? (
              <FilterChip
                label={`Key：${selectedClientKey ? historyClientKeyLabel(selectedClientKey) : `#${clientKey}`}`}
                onClear={() => onClientKeyChange('all')}
              />
            ) : null}
            {node !== 'all' ? (
              <FilterChip
                label={`节点：${selectedNode?.name || node}`}
                onClear={() => onNodeChange('all')}
              />
            ) : null}
            {riskEnabled && risk !== 'all' ? (
              <FilterChip
                label={`风险：${riskLabel}`}
                onClear={() => onRiskChange('all')}
              />
            ) : null}
            {patternFilter ? (
              <FilterChip
                label={`形态：${patternFilterLabel(patternFilter)}`}
                onClear={() => setPatternFilter(null)}
              />
            ) : null}
            <Button
              type='button'
              variant='ghost'
              size='sm'
              className='h-7 px-2 text-xs'
              onClick={clearFilters}
            >
              清除筛选
            </Button>
          </div>
        ) : null}
      </div>

      {showSkeletons ? (
        <HistoryBoardSkeleton />
      ) : data ? (
        <>
          <HistorySummaryCards
            summary={data.summary}
            selected={patternFilter}
            onToggle={togglePattern}
          />
          <div className='flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between'>
            <div className='flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground'>
              <span>
                {patternFilter
                  ? `筛选后 ${formatNumber(visibleAccounts.length, 0)} 个账号`
                  : `${formatNumber(visibleAccounts.length, 0)} 个账号`}
                {summary && visibleAccounts.length !== summary.accounts
                  ? ` / 共 ${formatNumber(summary.accounts, 0)} 个`
                  : null}
              </span>
              <span>· 每格 {formatNumber(data.bucketMinutes, 0)} 分钟</span>
              {data.truncated ? (
                <span className='text-amber-700 dark:text-amber-300'>
                  仅列出排序最前的 200 个账号
                </span>
              ) : null}
            </div>
            <SegmentedControl
              ariaLabel='账号历程排序'
              value={sort}
              onChange={setSort}
              options={HISTORY_SORT_OPTIONS}
            />
          </div>
          {visibleAccounts.length === 0 ? (
            <EmptyState
              compact
              icon={History}
              title='当前筛选没有账号历程'
              description='换一个时间窗口，或清除筛选后再看。'
            />
          ) : (
            <div className='space-y-1.5'>
              <div className='flex flex-col gap-2 xl:flex-row xl:items-end'>
                <div className={cn('hidden xl:block', IDENTITY_COL)} />
                <div className='min-w-0 flex-1'>
                  <HistoryTimeAxis buckets={axisBuckets} />
                </div>
                <div className={cn('hidden xl:block', STATS_COL)} />
              </div>
              {visibleAccounts.map((account) => {
                const accountKey = historyAccountKey(account)
                return (
                  <HistoryAccountRow
                    key={accountKey}
                    account={account}
                    expanded={expandedAccountKey === accountKey}
                    pinned={
                      pinnedAccountId != null &&
                      account.accountId === pinnedAccountId
                    }
                    onToggle={() =>
                      setExpandedAccountKey((current) =>
                        current === accountKey ? null : accountKey
                      )
                    }
                    onOpenLedger={onOpenLedger}
                  />
                )
              })}
            </div>
          )}
          <HistoryLegend />
        </>
      ) : errorMessage ? null : (
        <EmptyState
          compact
          icon={History}
          title='当前筛选没有账号历程'
          description='换一个时间窗口，或清除筛选后再看。'
        />
      )}
    </TitledCard>
  )
}

function HistorySummaryCards({
  summary,
  selected,
  onToggle,
}: {
  summary: RequestAuditHistoryResponse['summary']
  selected: HistoryAccountPatternFilter | null
  onToggle: (key: HistoryAccountPatternFilter) => void
}) {
  const mainCards = HISTORY_SUMMARY_CARDS.filter((card) => !card.quiet)
  const quietCards = HISTORY_SUMMARY_CARDS.filter(
    (card) => card.quiet && summary[card.countKey] > 0
  )
  return (
    <div className='space-y-2'>
      <div className='grid grid-cols-2 gap-2 lg:grid-cols-3 xl:grid-cols-6'>
        {mainCards.map((card) => {
          const active = selected === card.key
          return (
            <button
              key={card.key}
              type='button'
              aria-pressed={active}
              title={summaryCardTitle(card.key)}
              onClick={() => onToggle(card.key)}
              className={cn(
                'rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                active
                  ? 'border-primary/40 bg-primary/8'
                  : 'bg-muted/20 hover:bg-muted/40'
              )}
            >
              <div className='flex items-center gap-1.5 text-[11px] text-muted-foreground'>
                <span className={cn('size-2 rounded-[3px]', card.swatch)} />
                {card.label}
              </div>
              <div className='mt-1 text-lg font-semibold tabular-nums'>
                {formatNumber(summary[card.countKey], 0)}
              </div>
              {card.key === 'recurrent' && summary.regular > 0 ? (
                <div className='mt-0.5 text-[11px] text-muted-foreground'>
                  其中 {formatNumber(summary.regular, 0)} 个有规律
                </div>
              ) : null}
            </button>
          )
        })}
      </div>
      {quietCards.length > 0 ? (
        <div className='flex flex-wrap gap-1.5'>
          {quietCards.map((card) => {
            const active = selected === card.key
            return (
              <button
                key={card.key}
                type='button'
                aria-pressed={active}
                title={summaryCardTitle(card.key)}
                onClick={() => onToggle(card.key)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  active
                    ? 'border-primary/40 bg-primary/8 text-foreground'
                    : 'bg-muted/20 text-muted-foreground hover:bg-muted/40 hover:text-foreground'
                )}
              >
                <span className={cn('size-1.5 rounded-full', card.swatch)} />
                {card.label}
                <span className='tabular-nums'>
                  {formatNumber(summary[card.countKey], 0)}
                </span>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function HistoryAccountRow({
  account,
  expanded,
  pinned,
  onToggle,
  onOpenLedger,
}: {
  account: RequestAuditHistoryAccount
  expanded: boolean
  pinned: boolean
  onToggle: () => void
  onOpenLedger: RequestAuditAccountHistoryBoardProps['onOpenLedger']
}) {
  const displayName = historyAccountDisplayName(account)
  const hasName = historyAccountHasName(account)
  const rowMaxRequests = historyRowMaxRequests(account)
  const recoveryText = rowRecoveryText(account)
  return (
    <div
      className={cn(
        'rounded-lg border bg-background',
        account.currentState === 'high' && 'border-l-rose-500',
        account.currentState === 'watch' && 'border-l-amber-500',
        account.currentState === 'normal' && 'border-l-emerald-500',
        'border-l-2',
        (expanded || pinned) && 'border-primary/35 bg-primary/[0.04]'
      )}
    >
      <button
        type='button'
        aria-expanded={expanded}
        aria-label={`${expanded ? '收起' : '展开'}${displayName}的历程`}
        onClick={onToggle}
        className='w-full px-3 py-2 text-left transition-colors hover:bg-muted/35 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
      >
        <div className='flex flex-col gap-2 xl:flex-row xl:items-center'>
          <div className={IDENTITY_COL}>
            <div className='flex min-w-0 items-start gap-2'>
              <ChevronDown
                className={cn(
                  'mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform',
                  expanded && 'rotate-180'
                )}
              />
              <div className='min-w-0'>
                <div
                  className={cn(
                    'truncate text-sm font-medium',
                    !hasName && 'font-mono'
                  )}
                >
                  {displayName}
                </div>
                <div className='mt-1 flex flex-wrap items-center gap-1'>
                  <span className='text-[11px] text-muted-foreground tabular-nums'>
                    {formatNumber(account.requests, 0)} 次
                  </span>
                  <Badge
                    variant={HISTORY_PATTERN_BADGE_VARIANTS[account.pattern]}
                    className='h-5 px-1.5 text-[10px]'
                    title={HISTORY_PATTERN_DESCRIPTIONS[account.pattern]}
                  >
                    {HISTORY_PATTERN_LABELS[account.pattern]}
                  </Badge>
                  <Badge
                    variant={
                      HISTORY_RISK_LEVEL_BADGE_VARIANTS[account.currentState]
                    }
                    className='h-5 px-1.5 text-[10px]'
                  >
                    {HISTORY_RISK_LEVEL_LABELS[account.currentState]}
                  </Badge>
                  {account.regular ? (
                    <Badge
                      variant={HISTORY_EXTRA_CHIP_VARIANTS.regular}
                      className='h-5 px-1.5 text-[10px]'
                      title={
                        account.periodMinutes
                          ? `${HISTORY_EXTRA_CHIP_DESCRIPTIONS.regular} · 约 ${formatHistoryMinutes(account.periodMinutes)}`
                          : HISTORY_EXTRA_CHIP_DESCRIPTIONS.regular
                      }
                    >
                      {HISTORY_EXTRA_CHIP_LABELS.regular}
                    </Badge>
                  ) : null}
                  {account.recovered ? (
                    <Badge
                      variant={HISTORY_EXTRA_CHIP_VARIANTS.recovered}
                      className='h-5 px-1.5 text-[10px]'
                      title={HISTORY_EXTRA_CHIP_DESCRIPTIONS.recovered}
                    >
                      {HISTORY_EXTRA_CHIP_LABELS.recovered}
                    </Badge>
                  ) : null}
                  {account.failing ? (
                    <Badge
                      variant={HISTORY_EXTRA_CHIP_VARIANTS.failing}
                      className='h-5 px-1.5 text-[10px]'
                      title={HISTORY_EXTRA_CHIP_DESCRIPTIONS.failing}
                    >
                      {HISTORY_EXTRA_CHIP_LABELS.failing}
                    </Badge>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
          <div className='min-w-0 flex-1'>
            <HistorySwimlane
              buckets={account.buckets}
              episodes={account.episodes}
              rowMaxRequests={rowMaxRequests}
            />
          </div>
          <div
            className={cn(
              STATS_COL,
              'text-[11px] leading-4 text-muted-foreground tabular-nums xl:text-right'
            )}
          >
            <div>
              {account.abnormalEpisodes > 0
                ? `异常 ${formatNumber(account.abnormalEpisodes, 0)} 段 · 最长 ${formatHistoryMinutesCompact(account.longestAbnormalMinutes)}`
                : account.failing
                  ? `成功率 ${formatNumber(account.successRate, 1)}%`
                  : '窗口内无异常段'}
            </div>
            {recoveryText ? <div>{recoveryText}</div> : null}
          </div>
        </div>
      </button>
      {expanded ? (
        <div className='space-y-2 border-t bg-muted/10 px-3 py-3'>
          <div className='flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground'>
            <span>成功率 {formatNumber(account.successRate, 1)}%</span>
            <span>最近见到 {formatDate(account.lastSeenAt)}</span>
            <Button
              type='button'
              size='sm'
              variant='outline'
              className='h-7'
              onClick={() =>
                onOpenLedger({
                  accountId: account.accountId,
                  accountName: account.accountName || displayName,
                })
              }
            >
              查看流水
            </Button>
          </div>
          {account.episodes.length === 0 ? (
            <p className='text-xs text-muted-foreground'>
              当前窗口没有观察 / 高风险段。
              {account.failing ? ' 底边红线是 HTTP 失败，不是风险颜色。' : ''}
            </p>
          ) : (
            <ul className='space-y-2'>
              {account.episodes.map((episode) => {
                const longest = Math.max(account.longestAbnormalMinutes, 1)
                const width = Math.max(
                  8,
                  Math.min(100, (episode.durationMinutes / longest) * 100)
                )
                return (
                  <li
                    key={`${episode.start}-${episode.end}-${episode.severity}`}
                    className='space-y-1'
                  >
                    <div className='flex flex-wrap items-center gap-x-2 gap-y-1 text-xs'>
                      <Badge
                        variant={
                          HISTORY_RISK_LEVEL_BADGE_VARIANTS[episode.severity]
                        }
                        className='h-5 px-1.5 text-[10px]'
                      >
                        {HISTORY_RISK_LEVEL_LABELS[episode.severity]}
                      </Badge>
                      <span className='text-muted-foreground tabular-nums'>
                        {formatHistoryTimeRange(episode.start, episode.end)}
                        {' · '}
                        {formatHistoryMinutes(episode.durationMinutes)}
                        {' · '}
                        {episodeRecoveryText(episode)}
                      </span>
                    </div>
                    <div className='flex items-center gap-2'>
                      <div className='h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted/60'>
                        <div
                          className={cn(
                            'h-full rounded-full',
                            episode.severity === 'high'
                              ? 'bg-rose-500'
                              : 'bg-amber-500'
                          )}
                          style={{ width: `${width}%` }}
                        />
                      </div>
                      <span className='shrink-0 text-[11px] text-muted-foreground tabular-nums'>
                        {formatNumber(episode.requests, 0)} 次
                        {episode.highRiskRequests
                          ? ` · 高风险 ${formatNumber(episode.highRiskRequests, 0)}`
                          : ''}
                      </span>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}

function HistorySwimlane({
  buckets,
  episodes,
  rowMaxRequests,
}: {
  buckets: RequestAuditHistoryBucket[]
  episodes: RequestAuditHistoryEpisode[]
  rowMaxRequests: number
}) {
  const [hover, setHover] = useState<{
    index: number
    x: number
    y: number
  } | null>(null)
  const range = historyWindowRange(buckets)
  const activityGradient = useMemo(
    () =>
      historyLayerGradient(buckets, (bucket) => {
        const alpha = historyActivityOpacity(bucket, rowMaxRequests)
        return bucket.requests > 0
          ? `rgb(16 185 129 / ${alpha})`
          : 'transparent'
      }),
    [buckets, rowMaxRequests]
  )
  const failGradient = useMemo(
    () =>
      historyLayerGradient(buckets, (bucket) => {
        const alpha = historyFailOpacity(bucket)
        return alpha > 0 ? `rgb(244 63 94 / ${alpha})` : 'transparent'
      }),
    [buckets]
  )
  if (buckets.length === 0) {
    return <span className='block h-9 w-full rounded-md bg-muted/30' />
  }
  const hoverBucket = hover ? buckets[hover.index] : null
  const hoverEpisode =
    hoverBucket != null ? historyEpisodeAt(episodes, hoverBucket) : null
  const minPercent = Math.max(0.8, 100 / buckets.length)
  return (
    <div
      className='relative h-9'
      onMouseMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        const ratio =
          rect.width <= 0 ? 0 : (event.clientX - rect.left) / rect.width
        setHover({
          index: historyBucketIndexAt(buckets, ratio),
          x: event.clientX,
          y: event.clientY,
        })
      }}
      onMouseLeave={() => setHover(null)}
    >
      <div className='absolute inset-0 overflow-hidden rounded-md bg-muted/30'>
        <div
          className='absolute inset-0'
          style={{ backgroundImage: activityGradient }}
        />
        <div
          className='absolute inset-x-0 bottom-0 h-[3px]'
          style={{ backgroundImage: failGradient }}
        />
        {[25, 50, 75].map((percent) => (
          <span
            key={percent}
            className='pointer-events-none absolute inset-y-0 w-px bg-border/70'
            style={{ left: `${percent}%` }}
          />
        ))}
        {range
          ? episodes.map((episode) => {
              const place = historyEpisodePlacement(
                episode,
                range.start,
                range.end,
                minPercent
              )
              return (
                <span
                  key={`${episode.start}-${episode.end}-${episode.severity}`}
                  className={cn(
                    'pointer-events-none absolute top-[5px] h-[18px] rounded-sm shadow-sm',
                    episode.severity === 'high'
                      ? 'bg-rose-500'
                      : 'bg-amber-500',
                    !episode.recovered && 'ring-1 ring-foreground/15'
                  )}
                  style={{
                    left: `${place.left}%`,
                    width: `${place.width}%`,
                    opacity: episode.recovered ? 0.82 : 0.95,
                  }}
                />
              )
            })
          : null}
        {hoverBucket ? (
          <span
            className='pointer-events-none absolute inset-y-0 w-px bg-foreground/70'
            style={{
              left: `${((hover?.index ?? 0) + 0.5) * (100 / buckets.length)}%`,
            }}
          />
        ) : null}
      </div>
      {hoverBucket ? (
        <div
          className='pointer-events-none fixed z-50 w-56 rounded-md border bg-popover px-2.5 py-2 text-[11px] leading-4 text-popover-foreground shadow-md'
          style={{
            left: Math.min(hover!.x + 14, window.innerWidth - 240),
            top: Math.max(8, hover!.y - 76),
          }}
        >
          <div className='font-medium text-foreground'>
            {formatHistoryTimeRange(hoverBucket.start, hoverBucket.end)}
          </div>
          <div className='mt-1 text-muted-foreground'>
            {hoverBucket.requests > 0
              ? `${formatNumber(hoverBucket.requests, 0)} 次 · 成功 ${formatNumber(hoverBucket.successfulRequests, 0)} / 失败 ${formatNumber(hoverBucket.failedRequests, 0)}`
              : '空档（没有请求）'}
          </div>
          {hoverBucket.requests > 0 ? (
            <div className='text-muted-foreground'>
              正常 {formatNumber(hoverBucket.normalRequests, 0)} / 观察{' '}
              {formatNumber(hoverBucket.watchRequests, 0)} / 高风险{' '}
              {formatNumber(hoverBucket.highRiskRequests, 0)}
            </div>
          ) : null}
          {hoverEpisode ? (
            <div className='mt-1 text-foreground'>
              {HISTORY_RISK_LEVEL_LABELS[hoverEpisode.severity]}段 ·{' '}
              {formatHistoryMinutes(hoverEpisode.durationMinutes)} ·{' '}
              {episodeRecoveryText(hoverEpisode)}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function historyLayerGradient(
  buckets: RequestAuditHistoryBucket[],
  colorFor: (bucket: RequestAuditHistoryBucket) => string
) {
  if (buckets.length === 0) return undefined
  const stops = buckets.flatMap((bucket, index) => {
    const start = (index / buckets.length) * 100
    const end = ((index + 1) / buckets.length) * 100
    const color = colorFor(bucket)
    return [`${color} ${start}%`, `${color} ${end}%`]
  })
  return `linear-gradient(to right, ${stops.join(', ')})`
}

function HistoryTimeAxis({
  buckets,
}: {
  buckets: RequestAuditHistoryBucket[]
}) {
  const ticks = historyAxisTicks(buckets)
  if (ticks.length === 0) return null
  return (
    <div className='relative mb-1 h-4'>
      {ticks.map((tick) => (
        <span
          key={tick.key}
          className={cn(
            'absolute bottom-0 text-[10px] text-muted-foreground tabular-nums',
            tick.align === 'start' && 'left-0',
            tick.align === 'center' && '-translate-x-1/2',
            tick.align === 'end' && '-translate-x-full'
          )}
          style={
            tick.align === 'start' ? undefined : { left: `${tick.percent}%` }
          }
        >
          {tick.label}
        </span>
      ))}
    </div>
  )
}

function HistoryLegend() {
  return (
    <div className='space-y-1 text-[11px] text-muted-foreground'>
      <div className='flex flex-wrap items-center gap-x-2.5 gap-y-1'>
        <span className='inline-flex items-center gap-1'>
          <span className='h-2 w-4 rounded-[2px] bg-emerald-500/80' />
          有请求
        </span>
        <span className='inline-flex items-center gap-1'>
          <span className='h-2 w-4 rounded-[2px] bg-muted/80' />
          空档
        </span>
        <span className='inline-flex items-center gap-1'>
          <span className='h-2 w-4 rounded-[2px] bg-amber-500' />
          观察段
        </span>
        <span className='inline-flex items-center gap-1'>
          <span className='h-2 w-4 rounded-[2px] bg-rose-500' />
          高风险段
        </span>
        <span className='inline-flex items-center gap-1'>
          <span className='h-1.5 w-4 rounded-[2px] bg-rose-500' />
          HTTP 失败
        </span>
      </div>
      <p>
        色带是连续异常过程；绿色底轨只表示这段有请求。HTTP
        失败不会把账号涂成观察 / 高风险。
      </p>
    </div>
  )
}

function HistoryBoardSkeleton() {
  return (
    <div className='space-y-4'>
      <div className='grid grid-cols-2 gap-2 lg:grid-cols-3 xl:grid-cols-6'>
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className='h-[4.5rem] rounded-lg' />
        ))}
      </div>
      <div className='space-y-1.5'>
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className='h-14 rounded-lg' />
        ))}
      </div>
    </div>
  )
}

function patternFilterLabel(filter: HistoryAccountPatternFilter) {
  if (filter === 'recovered') return HISTORY_EXTRA_CHIP_LABELS.recovered
  if (filter === 'failing') return HISTORY_EXTRA_CHIP_LABELS.failing
  return HISTORY_PATTERN_LABELS[filter]
}

function summaryCardTitle(filter: HistoryAccountPatternFilter) {
  if (filter === 'recovered') return HISTORY_EXTRA_CHIP_DESCRIPTIONS.recovered
  if (filter === 'failing') return HISTORY_EXTRA_CHIP_DESCRIPTIONS.failing
  return HISTORY_PATTERN_DESCRIPTIONS[filter]
}

function rowRecoveryText(account: RequestAuditHistoryAccount) {
  if (account.stillAbnormal) return '未恢复'
  if (account.medianRecoveryMinutes != null) {
    return `恢复中位 ${formatHistoryMinutesCompact(account.medianRecoveryMinutes)}`
  }
  if (account.abnormalEpisodes > 0) return '未恢复'
  return null
}

function episodeRecoveryText(episode: RequestAuditHistoryEpisode) {
  if (episode.recovered) {
    return episode.recoveredAt
      ? `恢复于 ${formatDate(episode.recoveredAt)}`
      : '已恢复'
  }
  return '未恢复'
}
