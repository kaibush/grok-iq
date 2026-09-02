import { useEffect, useMemo, useRef, useState } from 'react'
import {
  useIsFetching,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  Loader2,
  RefreshCw,
  ScrollText,
  Search,
  Timer,
  TimerOff,
} from 'lucide-react'
import { toast } from 'sonner'
import { formatAccountSecondaryLabel } from '@/lib/account-label'
import {
  api,
  type CooldownAccount,
  type CooldownReleaseResult,
} from '@/lib/api'
import {
  cn,
  formatDate,
  formatNumber,
  formatRelativeTime,
  getErrorMessage,
} from '@/lib/utils'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { usePaintDeferredValue } from '@/hooks/use-paint-deferred-value'
import { usePersistedViewState } from '@/hooks/use-persisted-view-state'
import { useServerTableLoading } from '@/hooks/use-server-table-loading'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ActionToolbar, ToolbarAction } from '@/components/action-toolbar'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { CopyButton } from '@/components/copy-button'
import { EnabledBadge } from '@/components/enabled-badge'
import { EmptyState, LoadingState, Page, PageHeader } from '@/components/page'
import { PersistedViewNotice } from '@/components/persisted-view-notice'
import { SegmentedControl } from '@/components/segmented-control'
import { SelectionToolbar } from '@/components/selection-toolbar'
import {
  ServerPagination,
  ServerTableLoadingOverlay,
} from '@/components/server-pagination'
import { TablePanel } from '@/components/table-panel'
import {
  formatRemainingDuration,
  isCooldownExpiringSoon,
  remainingForAccount,
} from '@/features/monitor/components/cooldown-remaining'
import { CooldownStatsBoard } from '@/features/monitor/components/cooldown-stats-board'

type CooldownStatusFilter = 'cooling' | 'expired' | 'all'

const COOLDOWN_VIEW_STORAGE_KEY = 'grokiq.monitor.cooldown-view.v1'
const defaultCooldownView = {
  page: 1,
  pageSize: 50,
  search: '',
  status: 'cooling' as CooldownStatusFilter,
}

const statusOptions: Array<{ value: CooldownStatusFilter; label: string }> = [
  { value: 'cooling', label: '冷却中' },
  { value: 'expired', label: '已结束' },
  { value: 'all', label: '全部' },
]

const statusLabels: Record<CooldownStatusFilter, string> = {
  cooling: '冷却中',
  expired: '已结束',
  all: '全部状态',
}

function canReleaseCooldown(account: CooldownAccount) {
  return account.status === 'cooling' && !account.quarantined
}

function accountLabelOf(account: CooldownAccount) {
  return account.name || account.email || `账号 ${account.id}`
}

function uniqueIds(values: Array<number | undefined | null>) {
  return Array.from(
    new Set(
      values.filter(
        (value): value is number =>
          typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      )
    )
  )
}

function releaseToastMessage(result: CooldownReleaseResult) {
  const skippedNotCooling = result.skippedNotCoolingAccountIds ?? []
  const skippedQuarantined = result.skippedQuarantinedAccountIds ?? []
  const skippedGeneric = result.skippedAccountIds ?? []
  const failed = result.failedAccountIds ?? []
  const specificSkipped = new Set([...skippedNotCooling, ...skippedQuarantined])
  const otherSkipped = skippedGeneric.filter((id) => !specificSkipped.has(id))
  const parts = [
    result.reenabled
      ? `已提前结束 ${result.released} 个账号的冷却，重新启用 ${result.reenabled} 个上游`
      : `已提前结束 ${result.released} 个账号的冷却`,
  ]
  if (failed.length) parts.push(`${failed.length} 个结束失败并保留选择`)
  if (skippedQuarantined.length) {
    parts.push(`${skippedQuarantined.length} 个已进入隔离区并跳过`)
  }
  if (skippedNotCooling.length) {
    parts.push(`${skippedNotCooling.length} 个不在冷却中并跳过`)
  }
  if (otherSkipped.length) parts.push(`${otherSkipped.length} 个账号已跳过`)
  return {
    warning:
      failed.length > 0 ||
      skippedQuarantined.length > 0 ||
      skippedNotCooling.length > 0 ||
      otherSkipped.length > 0,
    message: parts.join('；'),
    retainedIds: uniqueIds([
      ...skippedGeneric,
      ...skippedNotCooling,
      ...skippedQuarantined,
      ...failed,
    ]),
  }
}

export function CooldownPage() {
  const client = useQueryClient()
  const statsFetching =
    useIsFetching({ queryKey: ['accounts', 'cooldown-stats'] }) > 0
  const view = usePersistedViewState(
    COOLDOWN_VIEW_STORAGE_KEY,
    defaultCooldownView
  )
  const { page, pageSize, search, status = 'cooling' } = view.value
  const updateView = (patch: Partial<typeof defaultCooldownView>) =>
    view.setValue((current) => ({ ...current, ...patch }))
  const [deferredSearch] = useDebouncedValue(search.trim())
  const committedQuery = useMemo(
    () => ({
      page,
      pageSize,
      search: deferredSearch,
      status,
    }),
    [deferredSearch, page, pageSize, status]
  )
  const tableQuery = usePaintDeferredValue(committedQuery)
  const [selected, setSelected] = useState<number[]>([])
  const [releaseOpen, setReleaseOpen] = useState(false)
  const [releaseIds, setReleaseIds] = useState<number[]>([])
  const [nowMs, setNowMs] = useState(() => Date.now())
  const tableQueryPending =
    tableQuery.page !== committedQuery.page ||
    tableQuery.pageSize !== committedQuery.pageSize ||
    tableQuery.search !== committedQuery.search ||
    tableQuery.status !== committedQuery.status
  const query = useQuery({
    queryKey: [
      'accounts',
      'cooldowns',
      tableQuery.page,
      tableQuery.pageSize,
      tableQuery.search,
      tableQuery.status,
    ],
    queryFn: ({ signal }) =>
      api.cooldownAccounts(
        {
          page: tableQuery.page,
          pageSize: tableQuery.pageSize,
          search: tableQuery.search,
          status: tableQuery.status === 'all' ? '' : tableQuery.status,
        },
        signal
      ),
    placeholderData: (previous) => previous,
    refetchInterval: (current) => {
      const items = current.state.data?.items ?? []
      return items.some((item) => item.status === 'cooling') ? 15_000 : false
    },
  })
  const accounts = useMemo(() => query.data?.items ?? [], [query.data?.items])
  const { beginTableInteraction, tableLoading: showTableLoading } =
    useServerTableLoading({
      isFetching: query.isFetching,
      inputPending: tableQueryPending,
    })
  const tableFilterKey = [tableQuery.search, tableQuery.status].join('|')
  const appliedFilterKeyRef = useRef(tableFilterKey)
  useEffect(() => {
    if (tableQueryPending) {
      beginTableInteraction()
      return
    }
    if (appliedFilterKeyRef.current === tableFilterKey) return
    appliedFilterKeyRef.current = tableFilterKey
    setSelected((current) => (current.length === 0 ? current : []))
  }, [beginTableInteraction, tableFilterKey, tableQueryPending])

  const hasCoolingRows = accounts.some((item) => item.status === 'cooling')
  useEffect(() => {
    if (!hasCoolingRows) return
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [hasCoolingRows])

  const expiredCoolingKey = accounts
    .filter((item) => {
      if (item.status !== 'cooling') return false
      const remaining = remainingForAccount(item, nowMs)
      return remaining != null && remaining <= 0
    })
    .map((item) => item.id)
    .join(',')
  const expireRefetchKeyRef = useRef('')
  useEffect(() => {
    if (!expiredCoolingKey) {
      expireRefetchKeyRef.current = ''
      return
    }
    if (expireRefetchKeyRef.current === expiredCoolingKey) return
    expireRefetchKeyRef.current = expiredCoolingKey
    void query.refetch()
    void client.invalidateQueries({ queryKey: ['accounts', 'cooldown-stats'] })
  }, [client, expiredCoolingKey, query.refetch])

  const selectedIdSet = useMemo(() => new Set(selected), [selected])
  const releasableAccounts = accounts.filter(canReleaseCooldown)
  const releasableIds = releasableAccounts.map((item) => item.id)
  const releasableSelected = selected.filter((id) => releasableIds.includes(id))
  const allChecked =
    releasableIds.length > 0 &&
    releasableIds.every((id) => selectedIdSet.has(id))
  const hasActiveFilters = status !== 'cooling' || Boolean(search.trim())
  const viewSummary = [
    search.trim() ? `搜索“${search.trim()}”` : '',
    statusLabels[status],
    `第 ${page} 页 · 每页 ${pageSize} 条`,
  ]
    .filter(Boolean)
    .join(' · ')

  const syncSelection = (accountIds: number[]) => {
    setSelected((current) => current.filter((id) => accountIds.includes(id)))
  }

  const releaseMutation = useMutation({
    mutationFn: (accountIds: number[]) => api.releaseCooldowns(accountIds),
    onSuccess: (result) => {
      const toastResult = releaseToastMessage(result)
      setReleaseOpen(false)
      setReleaseIds([])
      syncSelection(toastResult.retainedIds)
      if (toastResult.warning) toast.warning(toastResult.message)
      else toast.success(toastResult.message)
    },
    onError: (error) => toast.error(getErrorMessage(error)),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['accounts'] })
      void client.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
  const releasePending = releaseMutation.isPending

  const openRelease = (accountIds: number[]) => {
    const ids = uniqueIds(accountIds)
    if (ids.length === 0) return
    setReleaseIds(ids)
    setReleaseOpen(true)
  }

  const toggleCurrentPageSelection = (checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current)
      for (const id of releasableIds) {
        if (checked) next.add(id)
        else next.delete(id)
      }
      return Array.from(next)
    })
  }

  const toggleAccountSelection = (id: number, checked: boolean) => {
    setSelected((current) => {
      if (checked) {
        return current.includes(id) ? current : [...current, id]
      }
      return current.filter((item) => item !== id)
    })
  }

  return (
    <Page>
      <PageHeader
        title='冷却区'
        description={
          <div className='space-y-2'>
            <p>
              高速 TPS
              连续达到次数后会先临时停用账号，到期自动恢复，不会进入隔离区。这里能看到为什么冷却、开始时间、结束时间和剩余时长。冷却结束后如果再次连续高速
              TPS，才会永久停用并移入隔离区。
            </p>
          </div>
        }
        hintContentClassName='max-w-[28rem]'
        descriptionAsHint
        actions={
          <ActionToolbar label='冷却区操作'>
            <ToolbarAction
              label='刷新冷却页'
              pending={query.isFetching || statsFetching}
              onClick={() => {
                void query.refetch()
                void client.invalidateQueries({
                  queryKey: ['accounts', 'cooldown-stats'],
                })
              }}
            >
              <RefreshCw />
            </ToolbarAction>
            <SelectionToolbar
              wrap={false}
              selectedCount={selected.length}
              entityLabel='账号'
              disabled={releasePending}
              onClear={() => setSelected([])}
            >
              <ToolbarAction
                label={
                  releasableSelected.length
                    ? `提前结束已选 ${releasableSelected.length} 个账号的冷却`
                    : '已选账号不在冷却中，无法提前结束'
                }
                pending={releasePending}
                disabled={releasePending || releasableSelected.length === 0}
                onClick={() => openRelease(releasableSelected)}
              >
                <TimerOff />
              </ToolbarAction>
            </SelectionToolbar>
          </ActionToolbar>
        }
      />
      <CooldownStatsBoard />
      <TablePanel
        toolbar={
          <div className='space-y-2' aria-busy={showTableLoading}>
            <div className='flex flex-col gap-2 sm:flex-row sm:items-center'>
              <SegmentedControl
                ariaLabel='冷却状态'
                value={status}
                onChange={(next) => updateView({ status: next, page: 1 })}
                options={statusOptions}
              />
              <div className='relative min-w-0 flex-1'>
                <Search className='absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground' />
                <Input
                  value={search}
                  onChange={(event) =>
                    updateView({ search: event.target.value, page: 1 })
                  }
                  placeholder='搜索名称、邮箱、账号 ID、请求 ID'
                  className='h-8 pr-8 pl-8'
                />
                {showTableLoading && (
                  <Loader2 className='absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-primary' />
                )}
              </div>
            </div>
            {view.active && (
              <PersistedViewNotice
                restored={view.restored}
                summary={viewSummary}
                onClear={() => {
                  beginTableInteraction()
                  view.clear()
                }}
              />
            )}
          </div>
        }
        footer={
          accounts.length ? (
            <ServerPagination
              page={page}
              pageSize={pageSize}
              total={query.data?.total ?? 0}
              disabled={showTableLoading}
              loading={showTableLoading}
              itemLabel='账号'
              onPageChange={(value) => {
                beginTableInteraction()
                updateView({ page: value })
              }}
              onPageSizeChange={(value) => {
                beginTableInteraction()
                updateView({ pageSize: value, page: 1 })
              }}
            />
          ) : null
        }
      >
        {query.isLoading && !query.data ? (
          <LoadingState />
        ) : query.isError && !query.data ? (
          <EmptyState
            icon={Timer}
            title='无法加载冷却账号'
            description={getErrorMessage(query.error)}
          />
        ) : accounts.length ? (
          <div className='relative min-h-40' aria-busy={showTableLoading}>
            <CooldownTable
              accounts={accounts}
              selected={selected}
              allChecked={allChecked}
              selectDisabled={releasableIds.length === 0}
              nowMs={nowMs}
              releasePending={releasePending}
              onToggleCurrentPage={toggleCurrentPageSelection}
              onToggleAccount={toggleAccountSelection}
              onRelease={(account) => openRelease([account.id])}
            />
            {showTableLoading && (
              <ServerTableLoadingOverlay
                page={page}
                itemLabel='账号'
                message='正在更新冷却筛选结果…'
              />
            )}
          </div>
        ) : (
          <div className='relative min-h-48' aria-busy={showTableLoading}>
            <EmptyState
              icon={Timer}
              title={
                hasActiveFilters ? '没有匹配的冷却记录' : '当前没有冷却中的账号'
              }
              description={
                hasActiveFilters
                  ? '没有匹配当前筛选的冷却记录，请调整条件后重试。'
                  : '高速 TPS 连续达标后会先在这里停用几分钟，到期自动恢复。可切换到「已结束」查看近期记录。'
              }
              action={
                hasActiveFilters ? undefined : (
                  <Button
                    variant='outline'
                    onClick={() => updateView({ status: 'expired', page: 1 })}
                  >
                    查看已结束
                  </Button>
                )
              }
            />
            {showTableLoading && (
              <ServerTableLoadingOverlay
                page={page}
                itemLabel='账号'
                message='正在更新冷却筛选结果…'
              />
            )}
          </div>
        )}
      </TablePanel>
      <ConfirmDialog
        open={releaseOpen}
        onOpenChange={(open) => {
          if (!open && !releasePending) {
            setReleaseOpen(false)
            setReleaseIds([])
          }
        }}
        title={`提前结束 ${releaseIds.length} 个账号的冷却？`}
        desc={
          <div className='space-y-2'>
            <p>
              将提前结束 {releaseIds.length}{' '}
              个账号的冷却并恢复调度。若冷却期间是本系统停用的上游，会重新启用。已进入隔离区的账号会跳过。
            </p>
          </div>
        }
        cancelBtnText='取消'
        confirmText={
          releasePending ? (
            <>
              <Loader2 className='animate-spin' />
              结束中…
            </>
          ) : (
            <>
              <TimerOff />
              确认提前结束
            </>
          )
        }
        isLoading={releasePending}
        disabled={releaseIds.length === 0}
        handleConfirm={() => {
          if (releaseIds.length === 0) return
          releaseMutation.mutate(releaseIds)
        }}
      />
    </Page>
  )
}

function CooldownTable({
  accounts,
  selected,
  allChecked,
  selectDisabled,
  nowMs,
  releasePending,
  onToggleCurrentPage,
  onToggleAccount,
  onRelease,
}: {
  accounts: CooldownAccount[]
  selected: number[]
  allChecked: boolean
  selectDisabled: boolean
  nowMs: number
  releasePending: boolean
  onToggleCurrentPage: (checked: boolean) => void
  onToggleAccount: (id: number, checked: boolean) => void
  onRelease: (account: CooldownAccount) => void
}) {
  const selectedIdSet = useMemo(() => new Set(selected), [selected])
  return (
    <Table
      rememberRowKey='monitor-cooldown'
      className='[&_td]:py-1.5 [&_th]:h-8'
    >
      <TableHeader>
        <TableRow>
          <TableHead className='w-10'>
            <Checkbox
              checked={allChecked}
              disabled={selectDisabled}
              onCheckedChange={(value) => onToggleCurrentPage(value === true)}
              aria-label='选择当前页可提前结束的冷却账号'
            />
          </TableHead>
          <TableHead>账号</TableHead>
          <TableHead>状态</TableHead>
          <TableHead>原因</TableHead>
          <TableHead>连续次数</TableHead>
          <TableHead>峰值 TPS</TableHead>
          <TableHead>开始时间</TableHead>
          <TableHead>结束时间</TableHead>
          <TableHead>剩余</TableHead>
          <TableHead>上游启用</TableHead>
          <TableHead className='text-right'>操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {accounts.map((account) => (
          <CooldownRow
            key={account.id}
            account={account}
            selected={selectedIdSet.has(account.id)}
            nowMs={nowMs}
            releasePending={releasePending}
            onSelectedChange={(checked) => onToggleAccount(account.id, checked)}
            onRelease={() => onRelease(account)}
          />
        ))}
      </TableBody>
    </Table>
  )
}

function CooldownRow({
  account,
  selected,
  nowMs,
  releasePending,
  onSelectedChange,
  onRelease,
}: {
  account: CooldownAccount
  selected: boolean
  nowMs: number
  releasePending: boolean
  onSelectedChange: (checked: boolean) => void
  onRelease: () => void
}) {
  const accountLabel = accountLabelOf(account)
  const secondaryAccountLabel = formatAccountSecondaryLabel({
    id: account.id,
    email: account.email,
    accountLabel,
  })
  const remaining = remainingForAccount(account, nowMs)
  const expiringSoon =
    account.status === 'cooling' && isCooldownExpiringSoon(remaining)
  const canRelease = canReleaseCooldown(account)
  const reason = account.reason?.trim() || account.label?.trim() || '—'
  const peakTps = account.maxTps ?? account.auditTps
  const endedAt = account.cooldownUntil || account.expiredAt
  return (
    <TableRow rowId={account.id}>
      <TableCell>
        <Checkbox
          checked={selected}
          disabled={!canRelease}
          onCheckedChange={(value) => onSelectedChange(value === true)}
          aria-label={`选择账号 ${accountLabel}`}
        />
      </TableCell>
      <TableCell>
        <div className='flex items-start gap-1'>
          <div className='min-w-0'>
            <div className='flex flex-wrap items-center gap-1.5'>
              <div className='font-medium'>{accountLabel}</div>
              {account.quarantined ? (
                <Badge variant='destructive' className='h-5 px-1.5 text-[10px]'>
                  已进入隔离区
                </Badge>
              ) : null}
              {expiringSoon ? (
                <Badge variant='warning' className='h-5 px-1.5 text-[10px]'>
                  即将结束
                </Badge>
              ) : null}
              {!account.quarantined &&
              account.status === 'expired' &&
              account.nextAction === 'isolate' ? (
                <Badge variant='outline' className='h-5 px-1.5 text-[10px]'>
                  下次将停用
                </Badge>
              ) : null}
            </div>
            <div
              className='max-w-80 text-xs text-muted-foreground'
              title={secondaryAccountLabel}
            >
              {secondaryAccountLabel}
            </div>
          </div>
          <CopyButton
            value={account.email?.trim() || String(account.id)}
            className='size-6'
          />
        </div>
      </TableCell>
      <TableCell>
        <Badge
          variant={account.status === 'cooling' ? 'warning' : 'secondary'}
          className='h-5 px-1.5 text-[11px]'
        >
          {account.status === 'cooling' ? '冷却中' : '已结束'}
        </Badge>
      </TableCell>
      <TableCell>
        <div className='max-w-64 text-sm' title={reason}>
          {reason}
        </div>
      </TableCell>
      <TableCell className='tabular-nums'>
        {account.tpsStreak != null || account.tpsMinCount != null
          ? `${formatNumber(account.tpsStreak ?? 0, 0)} / ${formatNumber(account.tpsMinCount ?? 0, 0)}`
          : '—'}
      </TableCell>
      <TableCell className='tabular-nums'>
        {peakTps == null ? '—' : formatNumber(peakTps)}
      </TableCell>
      <TableCell>
        <TimeCell value={account.cooledAt} />
      </TableCell>
      <TableCell>
        <TimeCell value={endedAt} />
      </TableCell>
      <TableCell>
        {account.status === 'expired' ? (
          <span className='text-muted-foreground'>已结束</span>
        ) : (
          <span
            className={cn(
              'tabular-nums',
              expiringSoon && 'text-amber-700 dark:text-amber-300'
            )}
          >
            {formatRemainingDuration(remaining)}
          </span>
        )}
      </TableCell>
      <TableCell>
        {account.missingUpstream ? (
          <Badge variant='outline'>上游缺失</Badge>
        ) : (
          <EnabledBadge enabled={account.enabled} prefix='上游' />
        )}
      </TableCell>
      <TableCell className='text-right'>
        <div className='inline-flex items-center justify-end'>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button asChild size='icon' variant='ghost'>
                <Link
                  to='/request-audits/ledger'
                  search={{ account: String(account.id) } as never}
                  aria-label={`查看 ${accountLabel} 的请求流水`}
                >
                  <ScrollText />
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent>查看请求流水</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size='icon'
                variant='ghost'
                disabled={!canRelease || releasePending}
                onClick={onRelease}
                aria-label={`提前结束 ${accountLabel} 的冷却`}
              >
                <TimerOff />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {account.quarantined
                ? '已进入隔离区，无法提前结束冷却'
                : account.status === 'expired'
                  ? '冷却已结束'
                  : '提前结束冷却'}
            </TooltipContent>
          </Tooltip>
        </div>
      </TableCell>
    </TableRow>
  )
}

function TimeCell({ value }: { value?: string | null }) {
  if (!value) {
    return <span className='text-muted-foreground'>—</span>
  }
  return (
    <div className='min-w-32'>
      <div className='whitespace-nowrap tabular-nums'>{formatDate(value)}</div>
      <div className='text-xs text-muted-foreground'>
        {formatRelativeTime(value)}
      </div>
    </div>
  )
}
