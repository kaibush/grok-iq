import {
  memo,
  useCallback,
  useDeferredValue,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  ChevronDown,
  History,
  Loader2,
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
  HISTORY_SUMMARY_CARDS,
  HISTORY_SWIMLANE_LEGEND,
  filterHistoryAccounts,
  formatHistoryMinutes,
  formatHistoryMinutesCompact,
  formatHistoryTimeRange,
  historyAccountDisplayName,
  historyAccountHasName,
  historyAccountKey,
  historyAxisTicks,
  historyClientKeyLabel,
  historySortOptionsForFilter,
  paintHistorySwimlane,
  resolveHistorySort,
  sortHistoryAccounts,
  type HistorySwimlanePaint,
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
  pending?: boolean
  onPrefetchClientKey?: (value: string) => void
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
  pending = false,
  onPrefetchClientKey,
  onOpenLedger,
}: RequestAuditAccountHistoryBoardProps) {
  const [patternFilter, setPatternFilter] =
    useState<HistoryAccountPatternFilter | null>(null)
  const [sort, setSort] = useState<HistoryAccountSort>(
    DEFAULT_HISTORY_ACCOUNT_SORT
  )
  const sortOptions = historySortOptionsForFilter(patternFilter)
  const effectiveSort = resolveHistorySort(sort, patternFilter)
  const deferredPatternFilter = useDeferredValue(patternFilter)
  const deferredSort = useDeferredValue(effectiveSort)
  const listPending =
    deferredPatternFilter !== patternFilter || deferredSort !== effectiveSort
  const pinnedKey = pinnedAccountId == null ? null : String(pinnedAccountId)
  const [expandedAccountKey, setExpandedAccountKey] = useState<string | null>(
    pinnedKey
  )
  const [seenPinnedKey, setSeenPinnedKey] = useState(pinnedKey)
  if (pinnedKey !== seenPinnedKey) {
    setSeenPinnedKey(pinnedKey)
    if (pinnedKey != null) setExpandedAccountKey(pinnedKey)
  }
  const [optimisticClientKey, setOptimisticClientKey] = useState<string | null>(
    null
  )
  const [optimisticNode, setOptimisticNode] = useState<string | null>(null)
  const [optimisticRisk, setOptimisticRisk] =
    useState<HistoryRiskFilter | null>(null)
  const [localPending, setLocalPending] = useState(false)
  const cancelApplyRef = useRef<(() => void) | null>(null)
  const activeClientKey = optimisticClientKey ?? clientKey
  const activeNode = optimisticNode ?? node
  const activeRisk = optimisticRisk ?? risk
  const switchPending = localPending || pending

  const applyAfterPaint = useCallback((task: () => void) => {
    setLocalPending(true)
    cancelApplyRef.current?.()
    cancelApplyRef.current = runAfterPaint(() => {
      cancelApplyRef.current = null
      task()
    })
  }, [])

  const selectClientKey = useCallback(
    (value: string) => {
      setOptimisticClientKey(value)
      applyAfterPaint(() => onClientKeyChange(value))
    },
    [applyAfterPaint, onClientKeyChange]
  )
  const selectNode = useCallback(
    (value: string) => {
      setOptimisticNode(value)
      applyAfterPaint(() => onNodeChange(value))
    },
    [applyAfterPaint, onNodeChange]
  )
  const selectRisk = useCallback(
    (value: HistoryRiskFilter) => {
      setOptimisticRisk(value)
      applyAfterPaint(() => onRiskChange(value))
    },
    [applyAfterPaint, onRiskChange]
  )

  const parentCaughtUp =
    (optimisticClientKey == null || optimisticClientKey === clientKey) &&
    (optimisticNode == null || optimisticNode === node) &&
    (optimisticRisk == null || optimisticRisk === risk)
  if (localPending && !pending && parentCaughtUp) {
    setLocalPending(false)
    setOptimisticClientKey(null)
    setOptimisticNode(null)
    setOptimisticRisk(null)
  }

  const errorMessage = error?.trim() ?? ''
  const showSkeletons = loading && !data
  const summary = data?.summary
  const paintedAccounts = useMemo(
    () =>
      (data?.accounts ?? []).map((account) => ({
        account,
        key: historyAccountKey(account),
        paint: paintHistorySwimlane(account),
      })),
    [data?.accounts]
  )
  const visibleAccounts = useMemo(() => {
    const filtered = filterHistoryAccounts(
      paintedAccounts.map((item) => item.account),
      { pattern: deferredPatternFilter }
    )
    const ordered = sortHistoryAccounts(filtered, deferredSort)
    const paintByKey = new Map(
      paintedAccounts.map((item) => [item.key, item.paint])
    )
    return ordered.map((account) => ({
      account,
      key: historyAccountKey(account),
      paint:
        paintByKey.get(historyAccountKey(account)) ??
        paintHistorySwimlane(account),
    }))
  }, [deferredPatternFilter, deferredSort, paintedAccounts])
  const axisBuckets = useMemo(() => {
    const fromVisible = visibleAccounts.find(
      (item) => item.account.buckets.length > 0
    )
    if (fromVisible) return fromVisible.account.buckets
    return (
      data?.accounts.find((account) => account.buckets.length > 0)?.buckets ??
      []
    )
  }, [data?.accounts, visibleAccounts])

  const selectedClientKey = clientKeys.find(
    (item) => item.id === activeClientKey
  )
  const selectedNode = nodeOptions.find((item) => item.id === activeNode)
  const resolvedClientKeys = useMemo(() => {
    if (
      activeClientKey === 'all' ||
      clientKeys.some((item) => item.id === activeClientKey)
    ) {
      return clientKeys
    }
    return [{ id: activeClientKey, name: `#${activeClientKey}` }, ...clientKeys]
  }, [activeClientKey, clientKeys])
  const resolvedNodeOptions = useMemo(() => {
    if (
      activeNode === 'all' ||
      nodeOptions.some((item) => item.id === activeNode)
    ) {
      return nodeOptions
    }
    return [{ id: activeNode, name: `节点 #${activeNode}` }, ...nodeOptions]
  }, [activeNode, nodeOptions])

  const riskLabel =
    HISTORY_RISK_FILTER_OPTIONS.find((item) => item.value === activeRisk)
      ?.label ?? '全部'
  const hasActiveFilters =
    Boolean(search.trim()) ||
    activeClientKey !== 'all' ||
    activeNode !== 'all' ||
    (riskEnabled && activeRisk !== 'all') ||
    patternFilter != null

  function clearFilters() {
    onSearchChange('')
    selectClientKey('all')
    selectNode('all')
    selectRisk('all')
    setPatternFilter(null)
  }

  const toggleAccount = useCallback((accountKey: string) => {
    setExpandedAccountKey((current) =>
      current === accountKey ? null : accountKey
    )
  }, [])

  function togglePattern(next: HistoryAccountPatternFilter) {
    setPatternFilter((current) => (current === next ? null : next))
  }

  return (
    <TitledCard
      icon={<History />}
      iconTone='sky'
      title='账号历程'
      description='把每个账号的正常 / 观察 / 高风险过程摊成时间轴，用来区分偶发异常、反复异常、从未正常和已经恢复。'
      hint='灰是没请求，绿是正常，黄是观察，红是高风险。和左侧徽章同一套颜色。'
      contentClassName='relative space-y-4'
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
            <Select value={activeClientKey} onValueChange={selectClientKey}>
              <SelectTrigger
                className='w-full min-w-0'
                aria-label='按客户端 Key 筛选账号历程'
              >
                <KeyRound className='size-4 text-muted-foreground' />
                <SelectValue placeholder='所有客户端 Key' />
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  value='all'
                  onPointerEnter={() => onPrefetchClientKey?.('all')}
                >
                  所有客户端 Key
                </SelectItem>
                {resolvedClientKeys.map((item) => (
                  <SelectItem
                    key={item.id}
                    value={item.id}
                    onPointerEnter={() => onPrefetchClientKey?.(item.id)}
                  >
                    {historyClientKeyLabel(item)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={activeNode} onValueChange={selectNode}>
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
              value={activeRisk}
              disabled={!riskEnabled}
              onValueChange={(value) => selectRisk(value as HistoryRiskFilter)}
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
            {activeClientKey !== 'all' ? (
              <FilterChip
                label={`Key：${selectedClientKey ? historyClientKeyLabel(selectedClientKey) : `#${activeClientKey}`}`}
                onClear={() => selectClientKey('all')}
              />
            ) : null}
            {activeNode !== 'all' ? (
              <FilterChip
                label={`节点：${selectedNode?.name || activeNode}`}
                onClear={() => selectNode('all')}
              />
            ) : null}
            {riskEnabled && activeRisk !== 'all' ? (
              <FilterChip
                label={`风险：${riskLabel}`}
                onClear={() => selectRisk('all')}
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
            <div className='flex items-center gap-2'>
              <span className='text-xs text-muted-foreground'>排序</span>
              <SegmentedControl
                ariaLabel='账号历程排序'
                value={effectiveSort}
                onChange={setSort}
                options={sortOptions}
              />
            </div>
          </div>
          {visibleAccounts.length === 0 ? (
            <EmptyState
              compact
              icon={History}
              title='当前筛选没有账号历程'
              description='换一个时间窗口，或清除筛选后再看。'
            />
          ) : (
            <div className='relative' aria-busy={switchPending || listPending}>
              <div
                className={cn(
                  'space-y-1.5',
                  (switchPending || listPending) &&
                    'pointer-events-none opacity-60'
                )}
              >
                <div className='flex flex-col gap-1.5 xl:flex-row xl:items-end'>
                  <div className={cn('hidden xl:block', IDENTITY_COL)} />
                  <div className='min-w-0 flex-1 space-y-1'>
                    <HistoryTimeAxis buckets={axisBuckets} />
                    <HistoryLegend />
                  </div>
                  <div className={cn('hidden xl:block', STATS_COL)} />
                </div>
                {visibleAccounts.map((item) => (
                  <HistoryAccountRow
                    key={item.key}
                    account={item.account}
                    paint={item.paint}
                    expanded={expandedAccountKey === item.key}
                    pinned={
                      pinnedAccountId != null &&
                      item.account.accountId === pinnedAccountId
                    }
                    onToggle={toggleAccount}
                    onOpenLedger={onOpenLedger}
                  />
                ))}
              </div>
              {switchPending || listPending ? (
                <HistorySwitchOverlay
                  message={
                    switchPending ? '正在加载账号历程' : '正在更新账号历程'
                  }
                />
              ) : null}
            </div>
          )}
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

function runAfterPaint(task: () => void) {
  let innerId = 0
  const outerId = window.requestAnimationFrame(() => {
    innerId = window.requestAnimationFrame(task)
  })
  return () => {
    window.cancelAnimationFrame(outerId)
    window.cancelAnimationFrame(innerId)
  }
}

function HistorySwitchOverlay({ message }: { message: string }) {
  return (
    <div
      className='absolute inset-0 z-20 bg-background/65 backdrop-blur-[1px]'
      role='status'
      aria-live='polite'
    >
      <div className='sticky top-0 flex justify-center px-3 py-2'>
        <div className='flex items-center gap-2 rounded-md border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-sm'>
          <Loader2 className='size-3.5 animate-spin text-primary' />
          {message}
        </div>
      </div>
    </div>
  )
}

const HistoryAccountRow = memo(function HistoryAccountRow({
  account,
  paint,
  expanded,
  pinned,
  onToggle,
  onOpenLedger,
}: {
  account: RequestAuditHistoryAccount
  paint: HistorySwimlanePaint
  expanded: boolean
  pinned: boolean
  onToggle: (accountKey: string) => void
  onOpenLedger: RequestAuditAccountHistoryBoardProps['onOpenLedger']
}) {
  const displayName = historyAccountDisplayName(account)
  const hasName = historyAccountHasName(account)
  const recoveryText = rowRecoveryText(account)
  const accountKey = historyAccountKey(account)
  return (
    <div
      className={cn(
        'rounded-lg border bg-background [contain-intrinsic-size:auto_4.75rem] [content-visibility:auto]',
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
        onClick={() => onToggle(accountKey)}
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
            <HistorySwimlane paint={paint} />
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
              {account.failing
                ? ' HTTP 失败会记在「请求失败多」标签上，不会把时间轴涂成红色。'
                : ''}
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
}, areHistoryAccountRowsEqual)

function areHistoryAccountRowsEqual(
  previous: {
    account: RequestAuditHistoryAccount
    paint: HistorySwimlanePaint
    expanded: boolean
    pinned: boolean
  },
  next: {
    account: RequestAuditHistoryAccount
    paint: HistorySwimlanePaint
    expanded: boolean
    pinned: boolean
  }
) {
  return (
    previous.account === next.account &&
    previous.paint === next.paint &&
    previous.expanded === next.expanded &&
    previous.pinned === next.pinned
  )
}

function HistorySwimlane({ paint }: { paint: HistorySwimlanePaint }) {
  return (
    <div className='relative h-9' title={paint.title}>
      <div className='absolute inset-0 overflow-hidden rounded-md bg-muted/30'>
        <div
          className='absolute inset-0'
          style={{ backgroundImage: paint.statusGradient }}
        />
        {[25, 50, 75].map((percent) => (
          <span
            key={percent}
            className='pointer-events-none absolute inset-y-0 w-px bg-border/70'
            style={{ left: `${percent}%` }}
          />
        ))}
      </div>
    </div>
  )
}

function HistoryTimeAxis({
  buckets,
}: {
  buckets: RequestAuditHistoryBucket[]
}) {
  const ticks = historyAxisTicks(buckets)
  if (ticks.length === 0) return null
  return (
    <div className='relative h-4'>
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
    <div className='flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground'>
      {HISTORY_SWIMLANE_LEGEND.map((item) => (
        <span key={item.key} className='inline-flex items-center gap-1'>
          <span
            className={cn('h-2 w-3 rounded-[2px]', item.swatchClassName)}
          />
          {item.label}
        </span>
      ))}
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
